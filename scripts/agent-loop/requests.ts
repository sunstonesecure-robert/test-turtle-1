import { createHash } from 'node:crypto';
import type { Octokit } from '@octokit/rest';
import { z } from 'zod';
import { GitSha, Instant } from '../../schemas/agent-loop';
import { ProducerBinding, type AuthorityPayload, type RequestCursor, type RequestReceipt } from '../../schemas/agent-loop-state';
import { brokerDigest } from '../control-plane/broker';
import { StateRefusal } from './ledger';
import type { StateTransactionResult } from './native-store';

export const INTAKE_WORKFLOW = '.github/workflows/agent-loop.yml';
/** The installed intake workflow names its run from its typed inputs. The broker
 * parses this title itself; the governed job's own validation is not trusted. */
export const requestTitle = (r: TypedRequest) => `agent-loop:${r.action}:${r.workload ?? '-'}:${r.request_id}`;
const TITLE = /^agent-loop:(observe|reconcile|start|resume|stop):([a-z0-9][a-z0-9-]{0,99}|-):([A-Za-z0-9][A-Za-z0-9._-]{7,63})$/;
const id = z.number().int().positive().safe();
const repository = z.object({ id, full_name: z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/) }).strict();
export const TypedRequest = z.object({ request_id: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{7,63}$/),
  action: z.enum(['observe', 'reconcile', 'start', 'resume', 'stop']), workload: z.string().regex(/^[a-z0-9][a-z0-9-]{0,99}$/).optional() }).strict();
export type TypedRequest = z.infer<typeof TypedRequest>;
export const IntakeConfig = z.object({ governed_repository: repository, workflow_path: z.literal(INTAKE_WORKFLOW),
  workloads: z.array(z.string().regex(/^[a-z0-9][a-z0-9-]{0,99}$/)).max(100),
  maximum_sources: z.number().int().min(1).max(20), overlap_seconds: z.number().int().min(60).max(86400),
  maximum_pages: z.number().int().min(1).max(10),
  /** A bounded authorization names the only request IDs it may accept. Any other
   * typed dispatch is refused explicitly under the refusal subject, so an earlier
   * attempt's dispatch or a stray click cannot stop intake or be accepted. */
  request_ids: z.array(TypedRequest.shape.request_id).min(1).max(100).optional() }).strict();
export type IntakeConfig = z.infer<typeof IntakeConfig>;
const Actor = z.object({ id, login: z.string().min(1).max(100), type: z.enum(['User', 'Bot']) });
/** What must be readable to account for a dispatch at all. */
const RunIdentity = z.object({ id, run_attempt: id, created_at: Instant });
const NativeRun = RunIdentity.extend({ event: z.string().max(100), head_branch: z.string().max(256).nullable(),
  head_sha: GitSha, path: z.string().max(256), display_title: z.string(), actor: Actor, repository: z.object({ id, full_name: z.string() }) });
export interface RequestSource {
  run_id: number; run_attempt: number; created_at: string; url: string;
  /** Null when GitHub lists the run without a readable actor; such a dispatch is refused. */
  actor: { id: number; login: string; type: 'User' | 'Bot' } | null;
  /** Null when the native run cannot be read as a typed request; `refusal` says why. */
  request: TypedRequest | null; refusal: string | null; title_sha256: string;
}
export interface Acknowledgement {
  run_id: number; request_id: string | null; source_ref: string; receipt_key: string; operation_id: string;
  /** accepted | refused | linked are durable receipts. blocked | unknown | pending are not acceptance. */
  outcome: 'accepted' | 'refused' | 'linked' | 'blocked' | 'unknown' | 'pending';
  code: string; recorded: 'now' | 'earlier' | 'no'; transaction?: StateTransactionResult['status']; commit_sha?: string;
}
export interface IntakeReport {
  status: 'complete' | 'partial' | 'blocked' | 'unknown'; code: string; scanned: number; api_requests: number;
  acknowledgements: Acknowledgement[]; remaining: number; cursor: RequestCursor | null;
}
export interface IntakePorts {
  /** Governed-repository read transport; never a state or audit writer. */
  gh: Octokit; now(): string;
  read(): Promise<{ state: { payload: AuthorityPayload; applied_operations: Record<string, unknown> } }>;
  transact(intent: unknown, compute: (draft: AuthorityPayload, now: string, revision: number) => void): Promise<StateTransactionResult>;
}
const Binding = z.object({ producer: ProducerBinding, authority_ref: z.string().min(1).max(2048) }).strict();
const fact: (value: unknown, code: string) => asserts value = (value, code) => { if (!value) throw new StateRefusal(code); };
export const intakeKey = (runId: number) => `intake:${runId}`;
/** False when a bounded authorization does not name this dispatch's request ID. */
const named = (config: IntakeConfig, request: TypedRequest) => !config.request_ids || config.request_ids.includes(request.request_id);
/** Authority binds what a receipt transaction is about: one typed request from
 * this workflow, or a refusal of an unreadable dispatch. Run IDs are not part of
 * the subject, so a re-dispatch of the same request is the same subject. */
export const requestSubject = (rawConfig: unknown, rawRequest: unknown) => {
  const config = IntakeConfig.parse(rawConfig);
  return brokerDigest({ purpose: 'request_receipt', repository_id: config.governed_repository.id, workflow_path: config.workflow_path, request: TypedRequest.parse(rawRequest) });
};
export const refusalSubject = (rawConfig: unknown) => {
  const config = IntakeConfig.parse(rawConfig);
  return brokerDigest({ purpose: 'request_refusal', repository_id: config.governed_repository.id, workflow_path: config.workflow_path });
};
const after = (a: { created_at: string; run_id: number }, b: { created_at: string; run_id: number }) =>
  Date.parse(a.created_at) - Date.parse(b.created_at) || a.run_id - b.run_id;

/** The durable request source is GitHub's own list of dispatches of the installed
 * intake workflow, not a wake-up. A dropped, cancelled or coalesced run is still
 * listed with its authenticated actor and typed title. An unreadable or
 * incomplete listing throws: a missing item never proves that nothing was asked. */
export async function scanRequestSources(gh: Octokit, rawConfig: unknown, cursor: RequestCursor): Promise<{ sources: RequestSource[]; api_requests: number }> {
  const config = IntakeConfig.parse(rawConfig), [owner, repo] = config.governed_repository.full_name.split('/') as [string, string];
  fact(cursor.workflow_path === config.workflow_path, 'request_cursor_missing');
  // Re-scan a little behind the cursor for late-listed runs, but never before the provisioned floor.
  const floor = Date.parse(cursor.not_before);
  const since = new Date(Math.max(Date.parse(cursor.created_at) - config.overlap_seconds * 1000, floor)).toISOString().replace(/\.\d{3}Z$/, 'Z');
  const seen = new Map<number, RequestSource>(); let requests = 0;
  try {
    for (let page = 1; ; page++) {
      fact(page <= config.maximum_pages, 'request_scan_incomplete'); requests++;
      const response = await gh.request('GET /repos/{owner}/{repo}/actions/workflows/{workflow_id}/runs', { owner, repo,
        workflow_id: config.workflow_path.split('/').at(-1)!, event: 'workflow_dispatch', created: `>=${since}`, per_page: 100, page,
        headers: { 'cache-control': 'no-cache', 'x-github-api-version': '2026-03-10' }, request: { timeout: 15000 } });
      const runs = z.object({ workflow_runs: z.array(z.unknown()).max(100) }).parse(response.data).workflow_runs;
      for (const raw of runs) {
        const identity = RunIdentity.parse(raw), url = `https://github.com/${config.governed_repository.full_name}/actions/runs/${identity.id}`;
        if (Date.parse(identity.created_at) < floor) continue;
        const parsed = NativeRun.safeParse(raw);
        if (!parsed.success) {
          // One malformed listing entry is refused by itself; it never stops intake for the dispatches around it.
          seen.set(identity.id, { run_id: identity.id, run_attempt: identity.run_attempt, created_at: identity.created_at, url, actor: null, request: null,
            refusal: 'request_run_unreadable', title_sha256: createHash('sha256').update(JSON.stringify((raw as { display_title?: unknown })?.display_title ?? null)).digest('hex') });
          continue;
        }
        const run = parsed.data;
        fact(run.repository.id === config.governed_repository.id && run.repository.full_name === config.governed_repository.full_name &&
          run.path === config.workflow_path, 'request_source_mismatch');
        const match = TITLE.exec(run.display_title);
        const request = match ? TypedRequest.parse({ action: match[1], request_id: match[3], ...(match[2] === '-' ? {} : { workload: match[2] }) }) : null;
        // A dispatch on another ref runs that ref's workflow file, not the installed one.
        const refusal = run.event !== 'workflow_dispatch' ? 'request_event_invalid' : run.head_branch !== 'main' ? 'request_ref_untrusted' :
          !request ? 'request_title_invalid' : null;
        seen.set(run.id, { run_id: run.id, run_attempt: run.run_attempt, created_at: run.created_at, url, actor: run.actor,
          request: refusal ? null : request, refusal, title_sha256: createHash('sha256').update(run.display_title).digest('hex') });
      }
      if (!/rel="next"/.test(response.headers.link ?? '')) break;
    }
  } catch (error) { throw error instanceof StateRefusal ? error : new StateRefusal('request_source_unreadable'); }
  return { sources: [...seen.values()].sort(after), api_requests: requests };
}

/** What a caller may be told about one dispatch. No receipt is `pending`: an
 * accepted dispatch API response alone is never an accepted request. */
export function requestAcknowledgement(payload: AuthorityPayload, source: Pick<RequestSource, 'run_id' | 'url' | 'request'>): Acknowledgement {
  const key = intakeKey(source.run_id), receipt = payload.requests[key];
  const base = { run_id: source.run_id, request_id: source.request?.request_id ?? null, source_ref: source.url, receipt_key: key, operation_id: key };
  if (!receipt) return { ...base, outcome: 'pending', code: 'request_receipt_missing', recorded: 'no' };
  return { ...base, recorded: 'earlier', outcome: receipt.linked_to ? 'linked' : receipt.status === 'refused' ? 'refused' : 'accepted',
    code: receipt.reason_code ?? 'request_accepted' };
}

function decide(draft: AuthorityPayload, config: IntakeConfig, source: RequestSource, now: string): RequestReceipt {
  const key = intakeKey(source.run_id);
  fact(!draft.requests[key], 'request_receipt_exists');
  const origin = { repository_id: config.governed_repository.id, run_id: source.run_id, run_attempt: source.run_attempt,
    actor_id: source.actor?.id ?? null, actor_login: source.actor?.login ?? null, created_at: source.created_at };
  const refused = (request_id: string, digest: string, reason_code: string, extra: Partial<RequestReceipt> = {}): RequestReceipt =>
    ({ request_id, source_ref: source.url, digest, status: 'refused', source: origin, recorded_at: now, reason_code, ...extra });
  // An unreadable dispatch keeps only a digest of its title, never the free text.
  if (!source.request) return refused(`run-${source.run_id}`, source.title_sha256, source.refusal ?? 'request_title_invalid');
  const request = source.request, digest = requestSubject(config, request);
  const typed = { action: request.action, ...(request.workload ? { workload: request.workload } : {}) };
  // Not one of the request IDs this authorization names: refused before any link or acceptance.
  if (!named(config, request)) return refused(request.request_id, digest, 'request_outside_scope', typed);
  const prior = Object.entries(draft.requests).filter(([, r]) => r.source && r.request_id === request.request_id && !r.linked_to && r.reason_code !== 'request_identity_conflict');
  if (prior.some(([, r]) => r.digest !== digest)) return refused(request.request_id, digest, 'request_identity_conflict', typed);
  const original = prior.find(([, r]) => r.status !== 'refused');
  // The same request ID is idempotent: a later dispatch links the first receipt.
  if (original) return refused(request.request_id, digest, 'duplicate_request', { ...typed, linked_to: original[0] });
  if (!request.workload && ['start', 'resume', 'stop'].includes(request.action)) return refused(request.request_id, digest, 'request_workload_required', typed);
  if (request.workload && !config.workloads.includes(request.workload)) return refused(request.request_id, digest, 'request_outside_scope', typed);
  return { request_id: request.request_id, source_ref: source.url, digest, status: 'accepted', source: origin, recorded_at: now, ...typed };
}

/** One reconcile cycle. Each unrecorded dispatch gets one conditional state
 * transaction that writes its receipt and moves the cursor together, oldest
 * first, before anything is acknowledged. Replay after a restart, a lost
 * response or a duplicate wake-up finds the same operation ID and records
 * nothing twice. The first unresolved outcome stops the cycle in order. */
export async function reconcileRequests(ports: IntakePorts, rawConfig: unknown, rawBinding: unknown): Promise<IntakeReport> {
  const report: IntakeReport = { status: 'unknown', code: 'request_state_unreadable', scanned: 0, api_requests: 0, acknowledgements: [], remaining: 0, cursor: null };
  let config: IntakeConfig, binding: z.infer<typeof Binding>;
  try { config = IntakeConfig.parse(rawConfig); binding = Binding.parse(rawBinding); }
  catch { return { ...report, status: 'blocked', code: 'request_intake_config_invalid' }; }
  try {
    let snapshot = (await ports.read()).state;
    const cursor = snapshot.payload.request_cursor ?? null; report.cursor = cursor;
    // Intake starts at an explicit provisioned cursor, never from all history.
    if (!cursor || cursor.workflow_path !== config.workflow_path) return { ...report, status: 'blocked', code: 'request_cursor_missing' };
    const scan = await scanRequestSources(ports.gh, config, cursor);
    report.scanned = scan.sources.length; report.api_requests = scan.api_requests;
    let processed = 0;
    for (const source of scan.sources) {
      const key = intakeKey(source.run_id);
      if (snapshot.applied_operations[key]) { report.acknowledgements.push(requestAcknowledgement(snapshot.payload, source)); continue; }
      if (processed === config.maximum_sources) { report.remaining++; continue; }
      processed++;
      let decided: RequestReceipt | undefined;
      const result = await ports.transact({ operation_id: key, kind: 'record', producer: binding.producer, authority_ref: binding.authority_ref,
        subject_sha256: source.request && named(config, source.request) ? requestSubject(config, source.request) : refusalSubject(config) }, (draft, now) => {
        decided = decide(draft, config, source, now); draft.requests[key] = decided;
        const held = draft.request_cursor;
        fact(held && held.workflow_path === config.workflow_path, 'request_cursor_missing');
        if (after({ created_at: source.created_at, run_id: source.run_id }, held) > 0) draft.request_cursor = { ...held, created_at: source.created_at, run_id: source.run_id };
      });
      const base = { run_id: source.run_id, request_id: source.request?.request_id ?? null, source_ref: source.url, receipt_key: key, operation_id: key, transaction: result.status };
      if (result.status === 'won' && decided) {
        report.acknowledgements.push({ ...base, recorded: 'now', outcome: decided.linked_to ? 'linked' : decided.status === 'refused' ? 'refused' : 'accepted',
          code: decided.reason_code ?? 'request_accepted', ...(result.receipt ? { commit_sha: result.receipt.commit_sha } : {}) });
        continue;
      }
      if (result.status === 'replayed' || result.status === 'reconciled') {
        // Already committed, possibly by this call with its response lost: the
        // durable receipt, not this process's memory, is what is acknowledged.
        snapshot = (await ports.read()).state;
        const stored = requestAcknowledgement(snapshot.payload, source);
        report.acknowledgements.push({ ...stored, transaction: result.status, ...(result.receipt ? { commit_sha: result.receipt.commit_sha } : {}) });
        if (stored.outcome !== 'pending') continue;
        return { ...report, status: 'unknown', code: 'request_receipt_missing', cursor: snapshot.payload.request_cursor ?? cursor };
      }
      // Nothing durable was recorded for this dispatch: say so and stop in order.
      const blocked = result.status === 'refused';
      report.acknowledgements.push({ ...base, recorded: 'no', outcome: blocked ? 'blocked' : 'unknown', code: result.code });
      report.remaining += scan.sources.filter(s => after(s, source) > 0 && !snapshot.applied_operations[intakeKey(s.run_id)]).length;
      return { ...report, status: blocked ? 'blocked' : 'unknown', code: result.code };
    }
    if (processed) report.cursor = (await ports.read()).state.payload.request_cursor ?? cursor;
    return { ...report, status: report.remaining ? 'partial' : 'complete', code: report.remaining ? 'request_cycle_bound_reached' : 'requests_reconciled' };
  } catch (error) {
    return { ...report, code: error instanceof StateRefusal ? error.code : 'request_state_unreadable',
      status: error instanceof StateRefusal && ['request_cursor_missing'].includes(error.code) ? 'blocked' : 'unknown' };
  }
}
