import { createHash } from 'node:crypto';
import type { Octokit } from '@octokit/rest';
import { z } from 'zod';
import { BrokerBootstrap, commitSha, sha256 } from '../../schemas/control-plane';
import { brokerDigest } from '../control-plane/broker';

export const PROBE_SOURCE_REPOSITORY = 'SunStone-Secure-LLC/agentic-turtles';
export const KEYLESS_WITNESSES = ['expected_blob_sha_conflict', 'initial_create_collision', 'lost_response_history_readback'] as const;
export const T124_WITNESSES = [...KEYLESS_WITNESSES, 'single_use_run_attempt_claim',
  'governed_token_cannot_write_state_or_audit', 'bounded_capacity_and_rate_headroom',
  'dropped_request_recovered_once', 'independent_signed_audit_readback'] as const;
const MAX_API_REQUESTS = 96;
const id = z.number().int().positive().safe();
const consentUrl = z.string().regex(/^https:\/\/github\.com\/SunStone-Secure-LLC\/agentic-turtles\/pull\/[1-9]\d*#(?:pullrequestreview|issuecomment)-[1-9]\d*$/);

/** This is an engineer's inert probe document, never an AuthorityTransaction. */
export const NativeProbeRequest = z.object({
  schema_version: z.literal(1), status: z.literal('proposed'), purpose: z.literal('native_git_probe'), task: z.literal('T124'),
  governed_repository_id: id, control_repository_id: id, state_repository_id: id, audit_repository_id: id,
  probe_repository_id: id, probe_branch: z.literal('w0-native-probe'), probe_path: z.literal('state/control.json'),
  model_calls: z.literal(0), cloud_operations: z.literal(0), maximum_git_writes: z.number().int().min(7).max(32),
  maximum_state_bytes: z.number().int().min(2048).max(524288),
  required_witnesses: z.array(z.enum(T124_WITNESSES)).length(T124_WITNESSES.length),
  trusted_source_sha: commitSha.nullable(), native_consent_receipt: consentUrl.nullable(),
  expires_at: z.string().datetime().nullable(), result: z.literal('not_run'),
}).strict().superRefine((r, context) => {
  if (r.probe_repository_id !== r.state_repository_id || new Set(r.required_witnesses).size !== T124_WITNESSES.length) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'Probe repository and witness set must match T124.' });
  }
});
type ProbeRequest = z.infer<typeof NativeProbeRequest>;
const Approval = z.object({ schema_version: z.literal(1), purpose: z.literal('t124_keyless_probe'),
  source_sha: commitSha, scope_sha256: sha256, expires_at: z.string().datetime() }).strict();
const User = z.object({ id, login: z.string().regex(/^[a-zA-Z0-9-]+$/), type: z.literal('User') });
const ProbeState = z.object({ schema_version: z.literal(1), purpose: z.literal('t124_probe'),
  scope_sha256: sha256, source_sha: commitSha, revision: z.number().int().min(1).max(4),
  parent_blob_sha: commitSha.nullable(), operation_id: z.string().max(120),
  scenario: z.enum(['initial_create_collision', 'expected_blob_sha_conflict', 'stale_loser_recomputed', 'lost_response_history_readback']),
}).strict();
type State = z.infer<typeof ProbeState>;
type Witness = { id: typeof T124_WITNESSES[number]; result: 'pass' | 'not_run'; code: string };
export interface NativeProbeReport {
  schema_version: 1; task: 'T124'; scope: 'contents_api_primitives'; result: 'incomplete';
  partial_result: 'pass' | 'not_run' | 'error'; execution: 'plan' | 'github'; code: string;
  source_sha: string; scope_sha256: string; config_sha256: string; observed_at: string | null;
  target: { repository_id: number; full_name: string; branch: string; path: string };
  limits: { git_writes: number; state_bytes: number; api_requests: number };
  api_requests: number; git_write_attempts: number; git_writes_confirmed: number;
  principal: { id: number; login: string } | null;
  second_human_review: 'deferred';
  approval: { receipt_url: string; receipt_kind: 'pull_request_review' | 'issue_comment';
    signer_id: number; signer_login: string; signer_is_pr_author: boolean; expires_at: string } | null;
  response_loss: 'not_injected' | 'client_discarded_response' | 'write_response_error';
  conflicts: Array<{ scenario: string; operation_id: string; http_status: number }>;
  operations: Array<{ operation_id: string; revision: number; blob_sha: string; commit_sha: string;
    parent_commit_sha: string; state_sha256: string }>;
  unresolved_operations: string[]; witnesses: Witness[];
  keys_allowed: false; enrollment: 'off'; model_calls: 0; cloud_operations: 0;
}

/** Auth placeholders are filled in a local execution copy after exact-head review.
 * Everything else, including the config and the implemented subset, is digest-bound. */
export function nativeProbeScope(rawConfig: unknown, rawRequest: unknown) {
  const config = BrokerBootstrap.parse(rawConfig); const request = NativeProbeRequest.parse(rawRequest);
  if (request.state_repository_id !== config.state.id || request.governed_repository_id !== config.governed.id ||
      request.audit_repository_id !== config.audit.id || request.control_repository_id !== config.broker.id) throw new ProbeFailure('repository_binding_mismatch');
  const { trusted_source_sha: _source, native_consent_receipt: _receipt, expires_at: _expiry, ...scopeRequest } = request;
  const scope = { request: scopeRequest, config, implemented_witnesses: [...KEYLESS_WITNESSES], maximum_api_requests: MAX_API_REQUESTS,
    human_approval_policy: { second_human_review: 'deferred', receipt_kinds: ['pull_request_review', 'issue_comment'] } };
  return { config, request, scope, sha256: brokerDigest(scope) };
}

export function nativeProbePlan(rawConfig: unknown, rawRequest: unknown, sourceSha: string): NativeProbeReport {
  const { config, request, sha256: scopeDigest } = nativeProbeScope(rawConfig, rawRequest);
  commitSha.parse(sourceSha);
  return { schema_version: 1, task: 'T124', scope: 'contents_api_primitives', result: 'incomplete',
    partial_result: 'not_run', execution: 'plan', code: 'plan_only', source_sha: sourceSha,
    scope_sha256: scopeDigest, config_sha256: brokerDigest(config), observed_at: null,
    target: { repository_id: config.state.id, full_name: config.state.full_name, branch: request.probe_branch, path: request.probe_path },
    limits: { git_writes: request.maximum_git_writes, state_bytes: request.maximum_state_bytes, api_requests: MAX_API_REQUESTS },
    api_requests: 0, git_write_attempts: 0, git_writes_confirmed: 0, principal: null, approval: null, second_human_review: 'deferred',
    response_loss: 'not_injected', conflicts: [], operations: [], unresolved_operations: [],
    witnesses: T124_WITNESSES.map(id => ({ id, result: 'not_run', code: 'not_run' })),
    keys_allowed: false, enrollment: 'off', model_calls: 0, cloud_operations: 0 };
}

class ProbeFailure extends Error { constructor(readonly code: string) { super(code); } }
function requireFact(value: unknown, code: string): asserts value { if (!value) throw new ProbeFailure(code); }
const hash = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex');
const gitBlob = (bytes: Buffer) => createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
const statusOf = (error: unknown): number | undefined => {
  const parsed = z.object({ status: z.number().int() }).safeParse(error); return parsed.success ? parsed.data.status : undefined;
};

/** No auto-retry, force update, deletion, token mint, workflow dispatch or model path.
 * Native review + reviewed source/scope are checked before the first mutation;
 * review/head/permissions/expiry and target identity are refreshed before each group. */
export async function runNativeProbe(gh: Octokit, rawConfig: unknown, rawRequest: unknown,
  options: { sourceSha: string; now?: () => string }): Promise<NativeProbeReport> {
  // A malformed request cannot manufacture a real target or a successful report.
  let report: NativeProbeReport;
  try { report = nativeProbePlan(rawConfig, rawRequest, options.sourceSha); }
  catch { return { ...invalidReport(options.sourceSha), code: 'invalid_probe_input' }; }
  report.execution = 'github';
  const { config, request } = nativeProbeScope(rawConfig, rawRequest);
  const clock = options.now ?? (() => new Date().toISOString());
  const [owner, repo] = config.state.full_name.split('/') as [string, string];
  const target = { owner, repo };
  let receiptNumber = 0; let receiptKind: 'pull_request_review' | 'issue_comment' = 'pull_request_review';
  let pullNumber = 0; let baseCommit = '';
  const pending = new Set<string>();
  const confirmed: Array<{ state: State; bytes: Buffer; blob: string; commit?: string }> = [];
  function time() {
    const value = clock(); const parsed = z.string().datetime().safeParse(value);
    requireFact(parsed.success && Number.isFinite(Date.parse(value)), 'invalid_clock');
    report.observed_at = value;
    requireFact(request.expires_at && Date.parse(request.expires_at) > Date.parse(value), 'trial_expired');
    return Date.parse(value);
  }
  async function api(route: string, parameters: Record<string, unknown> = {}) {
    requireFact(report.api_requests < MAX_API_REQUESTS, 'api_budget_exhausted');
    report.api_requests++;
    return gh.request(route, { ...parameters, headers: { 'x-github-api-version': '2026-03-10' }, request: { timeout: 15000 } });
  }
  async function paged(route: string, parameters: Record<string, unknown>, maximum: number) {
    const values: unknown[] = [];
    for (let page = 1; page <= maximum; page++) {
      const response = await api(route, { ...parameters, per_page: 100, page });
      requireFact(Array.isArray(response.data), 'native_response_invalid'); values.push(...response.data);
      const more = /rel="next"/.test(response.headers.link ?? '');
      if (!more) return values;
    }
    throw new ProbeFailure('native_pagination_incomplete');
  }
  async function file(repository: string, path: string, ref: string): Promise<{ bytes: Buffer; sha: string }> {
    const [fileOwner, fileRepo] = repository.split('/');
    const response = await api('GET /repos/{owner}/{repo}/contents/{path}', { owner: fileOwner, repo: fileRepo, path, ref });
    const parsed = z.object({ type: z.literal('file'), path: z.literal(path), encoding: z.literal('base64'),
      size: z.number().int().min(0).max(request.maximum_state_bytes), sha: commitSha, content: z.string().max(750000) }).safeParse(response.data);
    requireFact(parsed.success, 'native_file_invalid');
    const encoded = parsed.data.content.replace(/\s/g, ''); const bytes = Buffer.from(encoded, 'base64');
    requireFact(bytes.toString('base64') === encoded && bytes.length === parsed.data.size && gitBlob(bytes) === parsed.data.sha, 'native_blob_mismatch');
    return { bytes, sha: parsed.data.sha };
  }
  async function mustBeMissing(path: string, ref: string, code: string) {
    try { await api('GET /repos/{owner}/{repo}/contents/{path}', { ...target, path, ref }); }
    catch (error) { if (statusOf(error) === 404) return; throw error; }
    throw new ProbeFailure(code);
  }
  async function checkTarget() {
    const response = await api('GET /repos/{owner}/{repo}', target);
    const native = z.object({ id, full_name: z.string(), private: z.literal(true), archived: z.literal(false),
      disabled: z.literal(false), default_branch: z.literal(config.branch) }).safeParse(response.data);
    requireFact(native.success && native.data.id === config.state.id && native.data.full_name === config.state.full_name, 'state_repository_mismatch');
  }
  async function permission(repository: string, login: string) {
    const [permissionOwner, permissionRepo] = repository.split('/');
    const response = await api('GET /repos/{owner}/{repo}/collaborators/{username}/permission',
      { owner: permissionOwner, repo: permissionRepo, username: login });
    const parsed = z.object({ permission: z.enum(['admin', 'maintain', 'write']) }).safeParse(response.data);
    requireFact(parsed.success, 'native_permission_refused');
  }
  async function consent() {
    const timestamp = time();
    const [sourceOwner, sourceRepo] = PROBE_SOURCE_REPOSITORY.split('/');
    const binding = { owner: sourceOwner, repo: sourceRepo, pull_number: pullNumber };
    const pull = await api('GET /repos/{owner}/{repo}/pulls/{pull_number}', binding);
    const pr = z.object({ head: z.object({ sha: commitSha, repo: z.object({ full_name: z.literal(PROBE_SOURCE_REPOSITORY) }) }),
      base: z.object({ repo: z.object({ full_name: z.literal(PROBE_SOURCE_REPOSITORY) }) }), user: User, draft: z.literal(false) }).safeParse(pull.data);
    requireFact(pr.success && pr.data.head.sha === options.sourceSha, 'review_head_mismatch');
    let signer: z.infer<typeof User>; let receiptBody: string; let approvedAt: string;
    if (receiptKind === 'issue_comment') {
      const response = await api('GET /repos/{owner}/{repo}/issues/comments/{comment_id}',
        { owner: sourceOwner, repo: sourceRepo, comment_id: receiptNumber });
      const comment = z.object({ id: z.literal(receiptNumber), user: User,
        issue_url: z.literal(`https://api.github.com/repos/${PROBE_SOURCE_REPOSITORY}/issues/${pullNumber}`),
        html_url: z.literal(request.native_consent_receipt!), body: z.string().max(4096),
        created_at: z.string().datetime(), updated_at: z.string().datetime() }).safeParse(response.data);
      requireFact(comment.success && Date.parse(comment.data.created_at) <= timestamp &&
        Date.parse(comment.data.updated_at) >= Date.parse(comment.data.created_at) &&
        Date.parse(comment.data.updated_at) <= timestamp, 'native_approval_refused');
      signer = comment.data.user; receiptBody = comment.data.body; approvedAt = comment.data.updated_at;
    } else {
      const reviews = await paged('GET /repos/{owner}/{repo}/pulls/{pull_number}/reviews', binding, 5);
      const selected = reviews.find(r => z.object({ id: z.literal(receiptNumber) }).safeParse(r).success);
      const review = z.object({ id: z.literal(receiptNumber), user: User, state: z.literal('APPROVED'), commit_id: z.literal(options.sourceSha),
        submitted_at: z.string().datetime(), body: z.string().max(4096), html_url: z.literal(request.native_consent_receipt!) }).safeParse(selected);
      requireFact(review.success && Date.parse(review.data.submitted_at) <= timestamp, 'native_approval_refused');
      const relevant = reviews.filter(r => z.object({ user: z.object({ id: z.literal(review.data.user.id) }),
        state: z.enum(['APPROVED', 'CHANGES_REQUESTED', 'DISMISSED']) }).safeParse(r).success);
      requireFact(z.object({ id: z.literal(receiptNumber) }).safeParse(relevant.at(-1)).success, 'native_approval_superseded');
      signer = review.data.user; receiptBody = review.data.body; approvedAt = review.data.submitted_at;
    }
    let body: unknown; try { body = JSON.parse(receiptBody); } catch { throw new ProbeFailure('approval_scope_invalid'); }
    const approved = Approval.safeParse(body);
    requireFact(approved.success && approved.data.source_sha === options.sourceSha && approved.data.scope_sha256 === report.scope_sha256 &&
      approved.data.expires_at === request.expires_at && Date.parse(approvedAt) < Date.parse(approved.data.expires_at), 'approval_scope_mismatch');
    await permission(PROBE_SOURCE_REPOSITORY, signer.login);
    await permission(config.state.full_name, signer.login);
    await permission(config.state.full_name, report.principal!.login);
    await checkTarget(); time();
    report.approval = { receipt_url: request.native_consent_receipt!, receipt_kind: receiptKind,
      signer_id: signer.id, signer_login: signer.login, signer_is_pr_author: signer.id === pr.data.user.id, expires_at: request.expires_at! };
  }
  function state(revision: number, parent: string | null, scenario: State['scenario'], suffix = ''): State {
    return ProbeState.parse({ schema_version: 1, purpose: 't124_probe', scope_sha256: report.scope_sha256,
      source_sha: options.sourceSha, revision, parent_blob_sha: parent,
      operation_id: `t124-${options.sourceSha.slice(0, 12)}-${report.scope_sha256.slice(0, 12)}-${revision}${suffix}`, scenario });
  }
  async function put(value: State, discardResponse = false) {
    const bytes = Buffer.from(JSON.stringify(value) + '\n');
    requireFact(bytes.length <= request.maximum_state_bytes, 'state_byte_budget_exhausted');
    time(); requireFact(report.git_write_attempts < request.maximum_git_writes, 'git_write_budget_exhausted');
    report.git_write_attempts++; pending.add(value.operation_id);
    try {
      const response = await api('PUT /repos/{owner}/{repo}/contents/{path}', { ...target, path: request.probe_path,
        branch: request.probe_branch, message: `T124 probe ${value.operation_id}`, content: bytes.toString('base64'),
        ...(value.parent_blob_sha ? { sha: value.parent_blob_sha } : {}) });
      if (discardResponse) return { kind: 'withheld' as const, mode: 'client_discarded_response' as const, state: value, bytes };
      const result = z.object({ content: z.object({ sha: commitSha }), commit: z.object({ sha: commitSha }) }).safeParse(response.data);
      requireFact(result.success && result.data.content.sha === gitBlob(bytes), 'write_receipt_invalid');
      pending.delete(value.operation_id); report.git_writes_confirmed++;
      const entry = { state: value, bytes, blob: result.data.content.sha, commit: result.data.commit.sha };
      confirmed.push(entry); return { kind: 'written' as const, ...entry };
    } catch (error) {
      const status = statusOf(error);
      if (status && status >= 400 && status < 500 && status !== 408) {
        pending.delete(value.operation_id);
        return { kind: 'refused' as const, status, state: value };
      }
      if (discardResponse) return { kind: 'withheld' as const, mode: 'write_response_error' as const, state: value, bytes };
      throw error;
    }
  }
  async function collision(first: State, second: State) {
    const results = await Promise.allSettled([put(first), put(second)]);
    const values = results.filter(r => r.status === 'fulfilled').map(r => r.value);
    const winner = values.find(v => v.kind === 'written'); const loser = values.find(v => v.kind === 'refused');
    requireFact(results.every(r => r.status === 'fulfilled') && winner?.kind === 'written' && loser?.kind === 'refused' &&
      (loser.status === 409 || (first.revision === 1 && loser.status === 422)), 'collision_not_proved');
    const current = await file(config.state.full_name, request.probe_path, request.probe_branch);
    requireFact(current.sha === winner.blob && current.bytes.equals(winner.bytes), 'collision_readback_mismatch');
    report.conflicts.push({ scenario: first.scenario, operation_id: loser.state.operation_id, http_status: loser.status });
    return { ...current, loser: loser.state };
  }
  try {
    requireFact(request.trusted_source_sha === options.sourceSha && request.native_consent_receipt && request.expires_at, 'trial_not_authorized');
    time();
    const match = request.native_consent_receipt.match(/\/pull\/(\d+)#(pullrequestreview|issuecomment)-(\d+)$/)!;
    pullNumber = Number(match[1]); receiptKind = match[2] === 'issuecomment' ? 'issue_comment' : 'pull_request_review'; receiptNumber = Number(match[3]);
    requireFact(Number.isSafeInteger(pullNumber) && Number.isSafeInteger(receiptNumber), 'native_receipt_invalid');
    const principal = User.safeParse((await api('GET /user')).data);
    requireFact(principal.success, 'engineer_identity_refused');
    report.principal = { id: principal.data.id, login: principal.data.login };
    const nativeConfig = await file(PROBE_SOURCE_REPOSITORY, 'control-plane/broker-bootstrap.json', options.sourceSha);
    const nativeRequest = await file(PROBE_SOURCE_REPOSITORY, 'control-plane/trials/t124.request.json', options.sourceSha);
    requireFact(nativeProbeScope(JSON.parse(nativeConfig.bytes.toString('utf8')), JSON.parse(nativeRequest.bytes.toString('utf8'))).sha256 === report.scope_sha256, 'reviewed_scope_mismatch');
    await consent();
    // Fresh branch only. Even a prior successful probe must be inspected and
    // separately authorized, never reset or silently reused.
    let exists = true;
    try { await api('GET /repos/{owner}/{repo}/git/ref/{ref}', { ...target, ref: `heads/${request.probe_branch}` }); }
    catch (error) { if (statusOf(error) === 404) exists = false; else throw error; }
    requireFact(!exists, 'probe_branch_exists');
    await mustBeMissing(request.probe_path, config.branch, 'canonical_state_present');
    const base = z.object({ ref: z.literal(`refs/heads/${config.branch}`), object: z.object({ type: z.literal('commit'), sha: commitSha }) })
      .parse((await api('GET /repos/{owner}/{repo}/git/ref/{ref}', { ...target, ref: `heads/${config.branch}` })).data);
    baseCommit = base.object.sha;
    time(); report.git_write_attempts++; pending.add('create_probe_branch');
    try {
      const created = await api('POST /repos/{owner}/{repo}/git/refs', { ...target, ref: `refs/heads/${request.probe_branch}`, sha: baseCommit });
      const ref = z.object({ ref: z.literal(`refs/heads/${request.probe_branch}`), object: z.object({ type: z.literal('commit'), sha: z.literal(baseCommit) }) }).safeParse(created.data);
      requireFact(ref.success, 'branch_receipt_invalid'); pending.delete('create_probe_branch'); report.git_writes_confirmed++;
    } catch (error) {
      const status = statusOf(error); if (status && status >= 400 && status < 500 && status !== 408) pending.delete('create_probe_branch');
      throw error;
    }
    await consent();
    const initial = await collision(state(1, null, 'initial_create_collision', '-a'), state(1, null, 'initial_create_collision', '-b'));
    await consent();
    const updated = await collision(state(2, initial.sha, 'expected_blob_sha_conflict', '-a'), state(2, initial.sha, 'expected_blob_sha_conflict', '-b'));
    await consent();
    const recomputed = await put({ ...state(3, updated.sha, 'stale_loser_recomputed'), operation_id: updated.loser.operation_id });
    requireFact(recomputed.kind === 'written', 'recomputed_write_not_proved');
    await consent();
    const lost = await put(state(4, recomputed.blob, 'lost_response_history_readback'), true);
    requireFact(lost.kind === 'withheld', 'lost_response_write_refused');
    report.response_loss = lost.mode;
    // Do not use or retry the withheld response. Pin the observed head and walk
    // native commit + Contents snapshots to find this exact operation/bytes.
    const head = z.object({ ref: z.literal(`refs/heads/${request.probe_branch}`), object: z.object({ type: z.literal('commit'), sha: commitSha }) })
      .parse((await api('GET /repos/{owner}/{repo}/git/ref/{ref}', { ...target, ref: `heads/${request.probe_branch}` })).data);
    const history = await paged('GET /repos/{owner}/{repo}/commits', { ...target, sha: head.object.sha, path: request.probe_path }, 2);
    requireFact(history.length === 4, 'operation_history_incomplete');
    const ordered = history.map(item => z.object({ sha: commitSha, parents: z.array(z.object({ sha: commitSha })).length(1) }).parse(item)).reverse();
    requireFact(ordered.at(-1)?.sha === head.object.sha, 'probe_head_not_operation');
    const expected = [...confirmed, { state: lost.state, bytes: lost.bytes, blob: gitBlob(lost.bytes) }];
    requireFact(expected.length === ordered.length, 'operation_history_incomplete');
    for (let i = 0; i < ordered.length; i++) {
      const commit = ordered[i]!; const entry = expected[i]!;
      const snapshot = await file(config.state.full_name, request.probe_path, commit.sha);
      const decoded = ProbeState.parse(JSON.parse(snapshot.bytes.toString('utf8')));
      requireFact(snapshot.bytes.equals(entry.bytes) && snapshot.sha === entry.blob && decoded.operation_id === entry.state.operation_id &&
        commit.parents[0]!.sha === (i === 0 ? baseCommit : ordered[i - 1]!.sha) && (!entry.commit || entry.commit === commit.sha), 'operation_history_mismatch');
      report.operations.push({ operation_id: decoded.operation_id, revision: decoded.revision, blob_sha: snapshot.sha,
        commit_sha: commit.sha, parent_commit_sha: commit.parents[0]!.sha, state_sha256: hash(snapshot.bytes) });
    }
    const current = await file(config.state.full_name, request.probe_path, request.probe_branch);
    requireFact(current.bytes.equals(lost.bytes), 'lost_operation_not_reconciled');
    const finalHead = await api('GET /repos/{owner}/{repo}/git/ref/{ref}', { ...target, ref: `heads/${request.probe_branch}` });
    requireFact(z.object({ object: z.object({ sha: z.literal(head.object.sha) }) }).safeParse(finalHead.data).success, 'probe_head_changed');
    pending.delete(lost.state.operation_id); report.git_writes_confirmed++;
    report.witnesses = T124_WITNESSES.map(id => ({ id, result: KEYLESS_WITNESSES.some(k => k === id) ? 'pass' : 'not_run',
      code: KEYLESS_WITNESSES.some(k => k === id) ? 'native_history_verified' : 'outside_keyless_slice' }));
    report.partial_result = 'pass'; report.code = 'keyless_slice_passed';
  } catch (error) {
    report.partial_result = report.git_write_attempts ? 'error' : 'not_run';
    report.code = error instanceof ProbeFailure ? error.code : statusOf(error) === 429 ? 'native_rate_limited' : 'native_probe_failed';
  }
  report.unresolved_operations = [...pending];
  return report;
}

function invalidReport(sourceSha: string): NativeProbeReport {
  return { schema_version: 1, task: 'T124', scope: 'contents_api_primitives', result: 'incomplete', partial_result: 'not_run',
    execution: 'plan', code: 'invalid_probe_input', source_sha: commitSha.safeParse(sourceSha).success ? sourceSha : '0'.repeat(40),
    scope_sha256: '0'.repeat(64), config_sha256: '0'.repeat(64), observed_at: null,
    target: { repository_id: 0, full_name: '<invalid-request>', branch: '', path: '' },
    limits: { git_writes: 0, state_bytes: 0, api_requests: 0 }, api_requests: 0, git_write_attempts: 0, git_writes_confirmed: 0,
    principal: null, approval: null, second_human_review: 'deferred', response_loss: 'not_injected', conflicts: [], operations: [], unresolved_operations: [],
    witnesses: T124_WITNESSES.map(id => ({ id, result: 'not_run', code: 'invalid_probe_input' })),
    keys_allowed: false, enrollment: 'off', model_calls: 0, cloud_operations: 0 };
}
