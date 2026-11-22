import { createPublicKey, sign, type KeyObject } from 'node:crypto';
import type { Octokit } from '@octokit/rest';
import { z } from 'zod';
import { AuthorityRepository, ProposalBinding, SecondHumanReview, SignInApp, TrialAuthorization } from '../../schemas/agent-loop-authority';
import { Digest, GitSha, Instant } from '../../schemas/agent-loop';
import { ProducerBinding, type AuthorityPayload } from '../../schemas/agent-loop-state';
import { brokerDigest } from '../control-plane/broker';
import { GitAuditAnchor, GitAuditLog } from './audit';
import { GitDocument, gitBlob } from './git-document';
import { GitTransactionJournal } from './journal';
import { budgetAvailable, envelopeAic, generationsAvailable, StateRefusal } from './ledger';
import type { StateTransactionResult } from './native-store';
import { journalDocument, ProvisionRequest, storeConfig } from './provision';
import { INTAKE_WORKFLOW, intakeKey, reconcileRequests, refusalSubject, requestSubject, scanRequestSources, TypedRequest, type IntakeReport, type RequestSource } from './requests';
import { createNativeTrialRuntime } from './runtime';
import { admissionGate, readRateLimit, readSafetyConfig, recheckSafety, storeLimits, type RateSnapshot, type SafetyRead } from './safety-config';

export const REMAINING_WITNESSES = ['single_use_run_attempt_claim', 'governed_token_cannot_write_state_or_audit',
  'bounded_capacity_and_rate_headroom', 'dropped_request_recovered_once', 'independent_signed_audit_readback'] as const;
export type RemainingWitness = typeof REMAINING_WITNESSES[number];
export const PILOT_STATE_BYTES = 524288;
const id = z.number().int().positive().safe(), name = z.string().min(1).max(200).regex(/^[A-Za-z0-9][A-Za-z0-9:._/-]*$/);
/** Everything one two-run native trial does, fixed before consent. Its digest is
 * one of the trial proposal's approved subjects, so the operator's exact-head
 * review covers the runs, limits, probes and anchors named here. */
const PlanShape = z.object({
  schema_version: z.literal(1), purpose: z.literal('t124_native_witnesses'),
  /** 1 for the first try. A later attempt is a new plan with its own names, workload,
   * live runs, requests and consent. It never resumes or repeats an earlier one. */
  attempt: z.number().int().min(1).max(9),
  provisioning: z.object({ request: ProvisionRequest, audit: z.object({ chain_commit_sha: GitSha, anchor_commit_sha: GitSha }).strict(),
    state: z.object({ control_commit_sha: GitSha, journal_commit_sha: GitSha }).strict() }).strict(),
  audit_key: z.object({ key_id: name, public_key_spki: z.string().regex(/^[A-Za-z0-9+/]+=*$/).max(200) }).strict(),
  safety: z.object({ repository: AuthorityRepository, environment: z.literal('broker-credentials') }).strict(),
  authority: z.object({ proposal: TrialAuthorization, binding: ProposalBinding.nullable(), consent_comment_id: id.nullable(), sign_in_app: SignInApp }).strict(),
  /** Live no-model governed runs: the controller's request run and two competing executors. */
  runs: z.object({ controller: ProducerBinding, executors: z.tuple([ProducerBinding, ProducerBinding]) }).strict(),
  episode: z.object({ episode_id: name, policy_digest: Digest, context_digest: Digest, deadline: Instant, limit_aic: id, limit_generations: id }).strict(),
  admission: z.object({ admission_id: name, generation_id: name, cap_manifest_digest: Digest, resource_lock_keys: z.array(name).min(1).max(10), expires_at: Instant }).strict(),
  requests: z.array(TypedRequest).length(3),
}).strict();
export const WitnessPlan = PlanShape.superRefine((plan, context) => {
  const p = plan.authority.proposal, r = plan.provisioning.request, runs = [plan.runs.controller, ...plan.runs.executors];
  const same = (a: { id: number; full_name: string }, b: { id: number; full_name: string }) => a.id === b.id && a.full_name === b.full_name;
  if (!same(p.governed_repository, r.governed_repository) || !same(p.state_repository, r.state_repository) || !same(p.audit_repository, r.audit_repository) ||
      !same(p.control_repository, r.control_repository) || !same(plan.safety.repository, r.control_repository) || brokerDigest(p.writer) !== brokerDigest(r.writer) ||
      new Set(runs.map(x => x.run_id)).size !== 3 || runs.some(x => x.repository_id !== r.governed_repository.id || x.repository !== r.governed_repository.full_name) ||
      plan.requests.some(q => q.workload !== p.workload) || new Set(plan.requests.map(q => q.request_id)).size !== 3 ||
      Date.parse(plan.admission.expires_at) > Date.parse(p.expires_at) || Date.parse(plan.admission.expires_at) > Date.parse(plan.episode.deadline)) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'Plan repositories, writer, runs, requests and expiry must agree with the provisioning record and trial proposal.' });
  }
});
export type WitnessPlan = z.infer<typeof WitnessPlan>;

const intake = (plan: WitnessPlan, limits: { maximum_sources: number; overlap_seconds: number; maximum_pages: number }) => ({
  governed_repository: plan.provisioning.request.governed_repository, workflow_path: INTAKE_WORKFLOW, workloads: [plan.authority.proposal.workload],
  // Only this plan's request IDs may be accepted. An earlier attempt's dispatch or a stray one is refused explicitly.
  request_ids: plan.requests.map(r => r.request_id), ...limits });
const episode = (plan: WitnessPlan) => { const p = plan.authority.proposal; return { schema_version: 1 as const, episode_id: plan.episode.episode_id,
  repository_id: p.governed_repository.id, workload: p.workload, kind: 'build' as const, work_item: p.work_item, plan_ref: p.plan_ref.slice('refs/tags/'.length),
  plan_sha: p.plan_sha, request_actor: 't124-native-witness', automation_principal: `app:${p.writer.principal_id}`, revision: 1, parent_digest: null,
  policy_digest: plan.episode.policy_digest, context_digest: plan.episode.context_digest, status: 'ready' as const, generation_count: 0, deadline: plan.episode.deadline,
  active_compute_ms: 0, reserved_aic: 0, settled_aic: 0, unchanged_failure_count: 0, last_outcome: 'ready', reason_code: 'ready', next_action: 'Reserve the no-model witness admission.', evidence: [] }; };
const requested = (plan: WitnessPlan) => { const p = plan.authority.proposal; return { admission_id: plan.admission.admission_id, generation_id: plan.admission.generation_id,
  episode_id: plan.episode.episode_id, producer: plan.runs.controller, policy_digest: plan.episode.policy_digest, plan_sha: p.plan_sha,
  context_digest: plan.episode.context_digest, cap_manifest_digest: plan.admission.cap_manifest_digest, components: p.components,
  resource_lock_keys: plan.admission.resource_lock_keys, expires_at: plan.admission.expires_at }; };
const claim = (plan: WitnessPlan, producer: ProducerBinding) => ({ admission_id: plan.admission.admission_id, producer });
const rerun = (producer: ProducerBinding): ProducerBinding => ({ ...producer, run_attempt: producer.run_attempt + 1 });
/** Operation IDs and note keys carry the attempt, so a later attempt never replays an earlier one's operations. */
const scope = (plan: WitnessPlan) => plan.attempt === 1 ? 't124' : `t124-a${plan.attempt}`;
const operations = (plan: WitnessPlan) => { const s = scope(plan); return { episode: `${s}:episode`, reserve: `${s}:reserve`, capacityRecord: `${s}:capacity-record`,
  dispatchAck: `${s}:dispatch-acknowledged`, requestConsumed: `${s}:request-consumed`, blocked: `${s}:blocked-by-archive-outage` }; };
const consumeOperation = (plan: WitnessPlan, p: ProducerBinding) => `${scope(plan)}:consume:${p.run_id}:${p.run_attempt}`;
/** Journal outcomes each run may add. Nothing compacts the journal yet, and a full
 * one fails only after the state write (GHI #362), so a run refuses to start without this room. */
const JOURNAL_ROOM = { run_a: 30, run_b: 10 } as const;
/** Most intake cycles spent refusing dispatches that are not this plan's before its own cycle. */
const DRAIN_CYCLES = 10;
const purpose = (value: string, plan: WitnessPlan) => brokerDigest({ purpose: value, admission_id: plan.admission.admission_id });

/** The plan digest that consent covers. Fields only known after the proposal PR
 * exists (its binding, the consent comment and the subject list itself) are excluded. */
export function witnessScope(rawPlan: unknown): string {
  const plan = WitnessPlan.parse(rawPlan);
  return brokerDigest({ ...plan, authority: { sign_in_app: plan.authority.sign_in_app, proposal: { ...plan.authority.proposal, subjects: [] } } });
}
/** Every subject the trial proposal must approve for this plan, and nothing dynamic. */
export function witnessSubjects(rawPlan: unknown, requests = { maximum_sources: 2, overlap_seconds: 600, maximum_pages: 2 }): string[] {
  const plan = WitnessPlan.parse(rawPlan), config = intake(plan, requests), [first, second] = plan.runs.executors;
  return [witnessScope(plan), brokerDigest({ purpose: 't124_episode', episode: episode(plan) }), brokerDigest(requested(plan)),
    brokerDigest(claim(plan, first)), brokerDigest(claim(plan, second)), brokerDigest(claim(plan, rerun(first))), brokerDigest(claim(plan, rerun(second))),
    ...plan.requests.map(r => requestSubject(config, r)), refusalSubject(config),
    purpose('t124_capacity_record', plan), purpose('t124_dispatch_acknowledged', plan), purpose('t124_request_consumed', plan), purpose('t124_blocked_by_archive_outage', plan)];
}

export interface WitnessStep { witness: RemainingWitness; id: string; pass: boolean; expected: string; observed: Record<string, unknown> }
export interface WitnessReport {
  schema_version: 1; task: 'T124'; purpose: 't124_native_witness_run'; phase: 'run_a' | 'run_b'; result: 'pass' | 'fail' | 'error'; code: string;
  plan_sha256: string; proposal_sha256: string; consent_url: string | null; broker_run: ProducerBinding; started_at: string; completed_at: string;
  /** The plan's attempt. Evidence from different attempts is never combined. */
  attempt: number;
  /** The approved proposal's own policy. `deferred` is reported beside the witnesses, never as one of them. */
  second_human_review: SecondHumanReview;
  /** The repositories this run acted on; every other retained report must name the same ones. */
  repositories: { governed: string; state: string; audit: string; control: string };
  safety_sha256: string | null;
  /** Re-reads of the safety setting before new admissions, and why new work stopped if one differed. */
  safety_rechecks: number; safety_changed: string | null;
  rate: RateSnapshot | null; steps: WitnessStep[]; probe_refs: Array<{ repository: string; ref: string; expect: string }>;
  commits: Array<{ repository: string; path: string; commit_sha: string; author_id: number | null; author_type: string | null; verified: boolean }>;
  response_loss: 'client_discarded_response'; archive_outage: 'not_induced' | 'audit_token_revoked'; model_calls: 0; cloud_operations: 0; enrollment: 'off';
}
export interface WitnessPorts {
  now(): string;
  /** Separately scoped native clients. `state` and `audit` are the only writers. */
  clients: { governed: Octokit; control: Octokit; safety: Octokit; audit: Octokit; state(): Octokit };
  audit_key: KeyObject; broker_run: ProducerBinding;
  /** Natively revoke the audit writer's token: a real archive outage for this process. */
  revokeAudit(): Promise<void>;
}
type Result = StateTransactionResult & { audit_outcome: string };
const statusOf = (error: unknown) => (error as { status?: number })?.status;
const headers = { 'cache-control': 'no-cache', 'x-github-api-version': '2026-03-10' };
const brief = (r: StateTransactionResult & { audit_outcome?: string }) => ({ status: r.status, code: r.code, native_outcome: r.native_outcome,
  audit_outcome: r.audit_outcome ?? null, api_requests: r.api_requests, git_write_attempts: r.git_write_attempts,
  ...(r.receipt ? { commit_sha: r.receipt.commit_sha, revision: r.receipt.revision } : {}) });

/** Route each request to the client scoped to that repository; anything else fails closed. */
function routed(clients: Record<string, Octokit>): Octokit {
  return { request: (route: string, params: Record<string, unknown>) => {
    const client = clients[`${params.owner}/${params.repo}`];
    if (!client) throw new StateRefusal('transport_scope_missing');
    return client.request(route, params);
  } } as unknown as Octokit;
}
/** Discard (never retry) the response of one accepted canonical-state write, or run a hook after it. */
function afterStateWrite(client: Octokit, operation: string, effect: 'discard' | (() => Promise<void>)) {
  let used = false;
  client.hook.wrap('request', async (request, options) => {
    const response = await request(options);
    const o = options as { method?: string; path?: string; message?: string };
    if (!used && o.method === 'PUT' && o.path === 'state/control.json' && o.message === `Authority transaction ${operation}`) {
      used = true;
      if (effect === 'discard') throw new Error('client_discarded_response');
      await effect();
    }
    return response;
  });
  return client;
}

/** Runs the remaining T124 witnesses against the real authority, journal, store,
 * request and audit adapters. No model, cloud operation, dispatch, merge,
 * overwrite, deletion or force update. Run A must complete before the
 * independent verifier acknowledges; run B is a separate process after it. */
export async function runNativeWitnesses(rawPlan: unknown, phase: 'run_a' | 'run_b', ports: WitnessPorts): Promise<WitnessReport> {
  const plan = WitnessPlan.parse(rawPlan), p = plan.authority.proposal, request = plan.provisioning.request, OPERATIONS = operations(plan);
  const report: WitnessReport = { schema_version: 1, task: 'T124', purpose: 't124_native_witness_run', phase, result: 'error', code: 'witness_run_incomplete',
    plan_sha256: witnessScope(plan), proposal_sha256: brokerDigest(p), consent_url: null, broker_run: ports.broker_run, started_at: ports.now(), completed_at: ports.now(),
    attempt: plan.attempt, second_human_review: p.second_human_review ?? 'required',
    repositories: { governed: request.governed_repository.full_name, state: request.state_repository.full_name, audit: request.audit_repository.full_name, control: request.control_repository.full_name },
    safety_sha256: null, safety_rechecks: 0, safety_changed: null, rate: null, steps: [], probe_refs: [], commits: [], response_loss: 'client_discarded_response', archive_outage: 'not_induced',
    model_calls: 0, cloud_operations: 0, enrollment: 'off' };
  const step = (witness: RemainingWitness, stepId: string, pass: boolean, expected: string, observed: Record<string, unknown>) => {
    report.steps.push({ witness, id: stepId, pass, expected, observed }); return pass;
  };
  const finish = (result: WitnessReport['result'], code: string) => ({ ...report, result, code, completed_at: ports.now() });
  try {
    if (!plan.authority.binding || !plan.authority.consent_comment_id) return finish('error', 'trial_not_authorized');
    if (!p.subjects.includes(report.plan_sha256) || witnessSubjects(plan).some(s => !p.subjects.includes(s))) return finish('error', 'plan_outside_approved_subjects');
    const binding = plan.authority.binding, consent = `https://github.com/${binding.repository.full_name}/pull/${binding.pull_number}#issuecomment-${plan.authority.consent_comment_id}`;
    report.consent_url = consent;
    const publicKey = createPublicKey({ key: Buffer.from(plan.audit_key.public_key_spki, 'base64'), format: 'der', type: 'spki' });
    const coordinates = (repository: { full_name: string }) => { const [owner, repo] = repository.full_name.split('/') as [string, string]; return { owner, repo }; };

    // Missing, unreadable or malformed safety settings stop here: no store is ever built.
    const safetySource = { repository: plan.safety.repository, environment: plan.safety.environment,
      governed_repository_id: request.governed_repository.id, state_repository_id: request.state_repository.id };
    const safety: SafetyRead = await readSafetyConfig(ports.clients.safety, safetySource);
    if (safety.status !== 'ready') { step('bounded_capacity_and_rate_headroom', 'safety.settings_ready', false, 'readable strict safety settings', { ...safety }); return finish('fail', safety.code); }
    report.safety_sha256 = safety.sha256;
    const settings = safety.settings, requestLimits = settings.requests;
    if (witnessSubjects(plan, requestLimits).some(s => !p.subjects.includes(s))) return finish('error', 'plan_outside_approved_subjects');
    const anchorDocument = new GitDocument(ports.clients.audit, { repository: request.audit_repository, branch: 'main', path: 'audit/acknowledged.json',
      writer_id: request.verifier_principal_id, anchor_commit_sha: plan.provisioning.audit.anchor_commit_sha, maximum_bytes: settings.documents.maximum_audit_bytes });
    const anchor = new GitAuditAnchor(anchorDocument, request.writer.principal_id);
    const chainDocument = new GitDocument(ports.clients.audit, { repository: request.audit_repository, branch: 'main', path: 'audit/chain.json',
      writer_id: request.writer.principal_id, anchor_commit_sha: plan.provisioning.audit.chain_commit_sha, maximum_bytes: settings.documents.maximum_audit_bytes });
    const audit = new GitAuditLog(chainDocument, { governed_repository_id: request.governed_repository.id, state_repository_id: request.state_repository.id,
      control_repository_id: request.control_repository.id, key_id: plan.audit_key.key_id, private_key: ports.audit_key, public_keys: { [plan.audit_key.key_id]: publicKey }, anchor });
    // The setting is read again before each new admission. Once it differs, is gone or cannot
    // be read, nothing further is admitted in this run; stop and receipt work goes on.
    const recheck = async (): Promise<string | null> => {
      if (report.safety_changed) return report.safety_changed;
      report.safety_rechecks++;
      const fresh = await recheckSafety(ports.clients.safety, safetySource, safety);
      if (fresh.status === 'blocked') report.safety_changed = fresh.code;
      return report.safety_changed;
    };
    const readerState = ports.clients.state();
    const journal = new GitTransactionJournal(journalDocument(readerState, request, plan.provisioning.state, settings.documents.maximum_journal_bytes));
    // All state clients use the same installation quota. Track requests across
    // concurrent executors and include journal/authority calls outside the store's
    // own counter. A fresh snapshot may lower this balance; only a reset raises it.
    let rateBalance: RateSnapshot | null = null;
    const observeRate = (fresh: RateSnapshot | null) => {
      if (!fresh) return null;
      if (!rateBalance || Date.parse(fresh.reset_at) > Date.parse(rateBalance.reset_at)) rateBalance = { ...fresh };
      else rateBalance.remaining = Math.min(rateBalance.remaining, fresh.remaining);
      return { ...rateBalance };
    };
    /** A fresh runtime over the same native documents, as a separate executor or process would hold. */
    const open = (stateClient = ports.clients.state(), limits = storeLimits(settings)) => {
      let receiptWork = false;
      stateClient.hook.wrap('request', async (send, options) => {
        // GitHub excludes /rate_limit from the primary quota. Every other call,
        // including a failed or lost response, consumes this conservative balance.
        if (!options.url.endsWith('/rate_limit') && rateBalance) {
          if (!receiptWork && rateBalance.remaining <= settings.api.minimum_remaining) throw new StateRefusal('api_rate_headroom_exhausted');
          rateBalance.remaining--;
        }
        const response = await send(options);
        const remaining = response.headers['x-ratelimit-remaining'];
        if (rateBalance && remaining !== undefined && /^\d+$/.test(remaining)) rateBalance.remaining = Math.min(rateBalance.remaining, Number(remaining));
        return response;
      });
      const runtime = createNativeTrialRuntime({ gh: routed({ [request.state_repository.full_name]: stateClient, [request.governed_repository.full_name]: ports.clients.governed }),
        authorityClients: { governed: ports.clients.governed, control: ports.clients.control, state: stateClient, audit: ports.clients.audit }, now: ports.now,
        store: storeConfig(request, plan.provisioning.state, limits), journal: journalDocument(stateClient, request, plan.provisioning.state, settings.documents.maximum_journal_bytes),
        audit, authority: { proposal: p, binding, consent_comment_id: plan.authority.consent_comment_id, sign_in_app: plan.authority.sign_in_app, broker_run: ports.broker_run } });
      // New work passes the safety gate first; stop and receipt work keeps its reserve.
      const gated = async <T extends { status: string }>(kind: 'reserve' | 'consume' | 'record' | 'receipt', operation_id: string, run: () => Promise<T>) => {
        const changed = kind === 'receipt' ? null : await recheck();
        const gate = changed ? { allowed: false as const, code: changed } : admissionGate(safety, kind, kind === 'receipt' ? null : observeRate(await readRateLimit(stateClient)));
        if (!gate.allowed) return { status: 'refused', code: gate.code, operation_id, api_requests: 0, git_write_attempts: 0, native_outcome: 'not_attempted', audit_outcome: 'not_required' } as unknown as T;
        receiptWork = kind === 'receipt';
        try { return await run(); } finally { receiptWork = false; }
      };
      return { read: runtime.read,
        transact: (intent: { operation_id: string; kind: 'record' | 'receipt'; subject_sha256: string }, compute: (draft: AuthorityPayload, now: string) => void) =>
          gated(intent.kind, intent.operation_id, () => runtime.transact({ ...intent, producer: plan.runs.controller, authority_ref: consent }, compute)) as Promise<Result>,
        reserve: () => gated('reserve', OPERATIONS.reserve, () => runtime.reserve({ ...requested(plan), operation_id: OPERATIONS.reserve, authority_ref: consent })) as Promise<Result>,
        consume: async (producer: ProducerBinding) => {
          const result = await gated('consume', consumeOperation(plan, producer), async () =>
            (await runtime.consume({ ...claim(plan, producer), operation_id: consumeOperation(plan, producer), authority_ref: consent })).result) as Result;
          return { allowed: result.status === 'won' && result.audit_outcome === 'acknowledged', result };
        },
        // Recording a request is new work: it passes the same safety gate as every other record.
        intake: (limits = requestLimits) => reconcileRequests({ gh: ports.clients.governed, now: ports.now, read: runtime.read,
          transact: (intent, compute) => gated('record', String((intent as { operation_id?: unknown })?.operation_id ?? '<invalid>'), () => runtime.transact(intent, compute)) },
          intake(plan, limits), { producer: plan.runs.controller, authority_ref: consent }) };
    };
    const subject = (value: string) => ({ subject_sha256: purpose(value, plan) });
    const main = open(readerState);
    report.rate = observeRate(await readRateLimit(readerState));
    const initialGate = admissionGate(safety, 'record', report.rate);
    step('bounded_capacity_and_rate_headroom', 'safety.settings_ready', initialGate.allowed,
      'strict settings read by API; variable and API headroom above the stop/receipt reserve', { sha256: safety.sha256, admission_block: safety.admission_block,
        variables: safety.variables, rate: report.rate, minimum_remaining: settings.api.minimum_remaining, state_limits: settings.state });
    if (!initialGate.allowed && initialGate.code.startsWith('api_rate_')) return finish('fail', initialGate.code);
    const [first, second] = plan.runs.executors;
    // Before any write. A plan that already ran, names that collide with an earlier
    // attempt, or too little room all stop here: the next step is a fresh attempt
    // (a new plan with its own names and consent), never a repeat of this one.
    const start = (await main.read()).state, room = await journal.capacity();
    if (room.outcomes + JOURNAL_ROOM[phase] > room.maximum) return finish('error', 'attempt_journal_room_insufficient');

    if (phase === 'run_a') {
      const lockKeys = [...plan.admission.resource_lock_keys, `workload:${p.governed_repository.id}:${p.workload}`];
      if (start.payload.episodes[plan.episode.episode_id] || start.payload.admissions[plan.admission.admission_id] || start.applied_operations[OPERATIONS.episode]) return finish('error', 'attempt_already_started');
      if (lockKeys.some(k => start.payload.locks[k])) return finish('error', 'attempt_lock_held');
      if (Object.entries(start.payload.ledger.accounts).some(([accountId, account]) => account.kind !== 'episode' &&
        (budgetAvailable(start.payload.ledger, accountId, ports.now()) < envelopeAic(p.components) || generationsAvailable(start.payload.ledger, accountId, ports.now()) < 1))) return finish('error', 'attempt_budget_insufficient');
      const created = await main.transact({ operation_id: OPERATIONS.episode, kind: 'record', subject_sha256: brokerDigest({ purpose: 't124_episode', episode: episode(plan) }) }, draft => {
        if (draft.episodes[plan.episode.episode_id] || draft.ledger.accounts[`episode:${plan.episode.episode_id}`]) throw new StateRefusal('episode_already_exists');
        draft.episodes[plan.episode.episode_id] = episode(plan);
        draft.ledger.accounts[`episode:${plan.episode.episode_id}`] = { kind: 'episode', episode_id: plan.episode.episode_id, limit_aic: plan.episode.limit_aic, limit_generations: plan.episode.limit_generations };
      });
      if (!step('single_use_run_attempt_claim', 'episode.recorded', created.status === 'won' && created.audit_outcome === 'acknowledged', 'won and audit-acknowledged', brief(created))) return finish('fail', 'episode_not_recorded');

      // One-use consume. The reservation's write response is discarded by this client.
      const lossy = await open(afterStateWrite(ports.clients.state(), OPERATIONS.reserve, 'discard')).reserve();
      step('single_use_run_attempt_claim', 'reserve.lost_response', lossy.status === 'reconciled' && lossy.native_outcome === 'committed' && lossy.git_write_attempts === 1,
        'reconciled from native history after one write, no second write', brief(lossy));
      const again = await open().reserve();
      step('single_use_run_attempt_claim', 'reserve.redelivery', again.status === 'replayed' && again.git_write_attempts === 0, 'replayed, no write', brief(again));
      const race = await Promise.all([open().consume(first), open().consume(second)]);
      const winners = race.filter(r => r.allowed), winner = race[0]!.allowed ? first : second, loser = race[0]!.allowed ? second : first;
      step('single_use_run_attempt_claim', 'consume.competing', winners.length === 1 && winners[0]!.result.status === 'won',
        'exactly one start permission across two live executor runs; the other is refused or held before any state write', { results: race.map(r => ({ allowed: r.allowed, ...brief(r.result) })), winner_run_id: winners.length === 1 ? winner.run_id : null });
      const retry = await open().consume(loser);
      step('single_use_run_attempt_claim', 'consume.loser_retry', !retry.allowed && retry.result.status === 'refused' && retry.result.native_outcome === 'not_attempted',
        'refused, no write', { allowed: retry.allowed, ...brief(retry.result) });
      const duplicate = await open().consume(winner);
      step('single_use_run_attempt_claim', 'consume.duplicate_delivery', !duplicate.allowed && duplicate.result.status === 'replayed', 'replayed, no start', { allowed: duplicate.allowed, ...brief(duplicate.result) });

      // Request recovery. Dispatches not yet recorded, oldest first, as the next intake cycle will take them.
      const expectedIds = plan.requests.map(r => r.request_id), ours = (s: RequestSource) => !!s.request && expectedIds.includes(s.request.request_id);
      const unrecorded = async () => {
        const state = (await main.read()).state, cursor = state.payload.request_cursor;
        const listed = cursor ? (await scanRequestSources(ports.clients.governed, intake(plan, requestLimits), cursor)).sources : [];
        return listed.filter(s => !state.applied_operations[intakeKey(s.run_id)]);
      };
      // An earlier attempt's dispatches, or a stray one, precede this plan's own. Each is refused
      // explicitly first, never more per cycle than the safety settings allow, so the witness
      // cycle starts at this plan's requests.
      let sources = await unrecorded(), drained: IntakeReport['acknowledgements'] = [];
      for (let round = 0; round < DRAIN_CYCLES; round++) {
        const lead = sources.findIndex(ours);
        if (lead <= 0) break;
        const cycle = await open().intake({ ...requestLimits, maximum_sources: Math.min(requestLimits.maximum_sources, lead) });
        drained = drained.concat(cycle.acknowledgements.filter(a => a.recorded === 'now'));
        if (cycle.status === 'blocked' || cycle.status === 'unknown') break;
        sources = await unrecorded();
      }
      if (drained.length || sources.findIndex(ours) > 0) step('dropped_request_recovered_once', 'requests.outside_plan_refused',
        sources.findIndex(ours) === 0 && drained.every(a => a.outcome === 'refused'), 'every dispatch that is not this plan\'s is refused explicitly before its own requests are read',
        { refused: drained.map(a => ({ run_id: a.run_id, request_id: a.request_id, outcome: a.outcome, code: a.code })), still_ahead: Math.max(sources.findIndex(ours), 0) });
      // First cycle: the settings bound leaves the newest dispatch for the next process. The last readable one of those it records loses its write response.
      const lostRun = sources.slice(0, requestLimits.maximum_sources).filter(s => s.request).at(-1)?.run_id;
      const cycle = lostRun ? await open(afterStateWrite(ports.clients.state(), intakeKey(lostRun), 'discard')).intake() : null;
      step('dropped_request_recovered_once', 'requests.first_cycle', !!cycle && cycle.status === 'partial' && cycle.remaining >= 1 && accepted(cycle).length >= 1 &&
        cycle.acknowledgements.every(a => a.recorded !== 'no' && ['accepted', 'refused', 'linked'].includes(a.outcome)) &&
        cycle.acknowledgements.some(a => a.run_id === lostRun && a.transaction === 'reconciled' && a.recorded !== 'no'),
        'receipt before acknowledgement; one through a discarded response; the rest left for the next process', { sources: sources.map(s => ({ run_id: s.run_id, request_id: s.request?.request_id ?? null, refusal: s.refusal })), cycle });

      // Capacity: a document at the pilot size round-trips, and a store whose limit is already reached refuses new work but keeps receipt room.
      step('bounded_capacity_and_rate_headroom', 'capacity.pilot_size_roundtrip', ...await pilotRoundTrip(readerState, request.state_repository, `w0-capacity-probe-${ports.broker_run.run_id}`, report));
      const before = await main.read(), reserve = settings.state.receipt_reserve_bytes;
      const full = open(ports.clients.state(), { ...storeLimits(settings), maximum_state_bytes: before.bytes + reserve });
      const refused = await full.transact({ operation_id: OPERATIONS.capacityRecord, kind: 'record', ...subject('t124_capacity_record') }, draft => {
        draft.outbox[`${scope(plan)}-capacity-note`] = { effect_id: `${scope(plan)}-capacity-note`, admission_id: plan.admission.admission_id, episode_id: plan.episode.episode_id, kind: 'record', intent_digest: purpose('t124_capacity_record', plan), status: 'pending' };
      });
      step('bounded_capacity_and_rate_headroom', 'capacity.admission_blocked', refused.status === 'refused' && refused.code === 'state_capacity_exhausted' && refused.native_outcome === 'not_attempted',
        'state_capacity_exhausted, nothing written', { limit_bytes: before.bytes + reserve, state_bytes: before.bytes, receipt_reserve_bytes: reserve, ...brief(refused) });
      const receipt = await full.transact({ operation_id: OPERATIONS.dispatchAck, kind: 'receipt', ...subject('t124_dispatch_acknowledged') }, draft => {
        draft.outbox[`dispatch-${plan.admission.admission_id}`]!.status = 'acknowledged';
      });
      const after = await main.read();
      step('bounded_capacity_and_rate_headroom', 'capacity.receipt_committed', receipt.status === 'won' && after.bytes > before.bytes && after.bytes <= before.bytes + reserve,
        'a receipt still commits inside the reserved bytes', { state_bytes: after.bytes, limit_bytes: before.bytes + reserve, ...brief(receipt) });

      await provenance(ports, plan, report);
      step('governed_token_cannot_write_state_or_audit', 'isolation.commit_provenance', report.commits.length >= 4 && report.commits.every(c => c.verified),
        'every stored commit by the expected App bot with a verified signature', { commits: report.commits.length, unverified: report.commits.filter(c => !c.verified) });
      const blind = await Promise.all([request.state_repository, request.audit_repository].map(async repository => {
        try { await ports.clients.control.request('GET /repos/{owner}/{repo}', { ...coordinates(repository), headers }); return 200; } catch (error) { return statusOf(error) ?? 0; }
      }));
      step('governed_token_cannot_write_state_or_audit', 'isolation.broker_job_token_blind', blind.every(s => s === 404 || s === 403),
        'the workflow\'s own token cannot even read the state or audit repository', { http_status: blind });

      // Archive outage last: the audit writer's token is revoked the moment the state write lands.
      // One of this plan's own accepted requests; an earlier attempt's receipts are listed too and are not its to consume.
      const firstKey = intakeKey(cycle?.acknowledgements.find(a => a.outcome === 'accepted' && !!a.request_id && expectedIds.includes(a.request_id))?.run_id ?? 0);
      const outage = await open(afterStateWrite(ports.clients.state(), OPERATIONS.requestConsumed, async () => { await ports.revokeAudit(); report.archive_outage = 'audit_token_revoked'; }))
        .transact({ operation_id: OPERATIONS.requestConsumed, kind: 'receipt', ...subject('t124_request_consumed') }, draft => {
          if (draft.requests[firstKey]?.status !== 'accepted') throw new StateRefusal('request_receipt_missing');
          draft.requests[firstKey]!.status = 'consumed';
        });
      const pending = await journal.unarchivedReceipts();
      step('independent_signed_audit_readback', 'audit.outage_retains_receipt', outage.status === 'unknown' && outage.native_outcome === 'committed' && outage.audit_outcome === 'pending' &&
        !!outage.receipt && pending.some(r => r.operation_id === OPERATIONS.requestConsumed),
        'committed receipt kept in the journal with its audit copy pending', { ...brief(outage), archive_outage: report.archive_outage, unarchived: pending.map(r => r.operation_id) });
      const revision = (await main.read()).state.revision;
      const blocked = await open().transact({ operation_id: OPERATIONS.blocked, kind: 'record', ...subject('t124_blocked_by_archive_outage') }, draft => {
        draft.outbox[`${scope(plan)}-blocked-note`] = { effect_id: `${scope(plan)}-blocked-note`, admission_id: plan.admission.admission_id, episode_id: plan.episode.episode_id, kind: 'record', intent_digest: purpose('t124_blocked_by_archive_outage', plan), status: 'pending' };
      });
      step('independent_signed_audit_readback', 'audit.outage_blocks_admission', blocked.status === 'unknown' && blocked.native_outcome === 'not_attempted' && (await main.read()).state.revision === revision,
        'later work is held while a receipt copy is pending; state unchanged', { ...brief(blocked), revision });
    } else {
      // Run B is a new process after the independent verifier acknowledged run A's history.
      const acknowledged = await anchor.read(), unarchived = await journal.unarchivedReceipts();
      // This attempt's own admission; an earlier attempt's admission and claim stay in state and are not this plan's.
      const priorClaim = start.payload.claims[plan.admission.admission_id];
      if (!priorClaim) return finish('fail', 'single_claim_missing');
      const winner = priorClaim.producer.run_id === first.run_id ? first : second;
      // The winning executor's run was re-run: its new attempt is live and asks again.
      const attempt = await open().consume(rerun(winner));
      const copied = await journal.unarchivedReceipts(), chain = await audit.read();
      step('independent_signed_audit_readback', 'audit.pending_receipt_copied', unarchived.some(r => r.operation_id === OPERATIONS.requestConsumed) && copied.length === 0 &&
        chain.some(e => e.record.event_id === `receipt:${OPERATIONS.requestConsumed}`), 'the retained receipt is archived before any later work in the new process',
        { unarchived_before: unarchived.map(r => r.operation_id), unarchived_after: copied.length });
      step('independent_signed_audit_readback', 'audit.acknowledged_history', acknowledged.sequence >= 1 && chain[acknowledged.sequence - 1]?.sha256 === acknowledged.sha256,
        'the writer reads its chain against the verifier\'s acknowledged sequence and digest', { acknowledged, records: chain.length });
      step('single_use_run_attempt_claim', 'consume.rerun_attempt', !attempt.allowed && attempt.result.status === 'refused' && attempt.result.code === 'admission_already_consumed_or_missing' &&
        attempt.result.native_outcome === 'not_attempted', 'a live re-run attempt of the winning executor is refused, no write',
        { run_id: winner.run_id, run_attempt: winner.run_attempt + 1, allowed: attempt.allowed, ...brief(attempt.result) });
      const recovered = await open().consume(winner);
      step('single_use_run_attempt_claim', 'consume.lost_response_recovery', !recovered.allowed && recovered.result.status === 'replayed',
        'a client that never saw its answer re-sends the same operation after restart: replayed, no start', { allowed: recovered.allowed, ...brief(recovered.result) });
      // Claims are keyed by admission, so this admission has at most one. The start permission is
      // single when that claim is the winner's and no claim anywhere names either executor run again.
      const state = (await main.read()).state, mine = state.payload.claims[plan.admission.admission_id];
      const executorClaims = Object.values(state.payload.claims).filter(c => [first.run_id, second.run_id].includes(c.producer.run_id));
      step('single_use_run_attempt_claim', 'consume.single_claim', executorClaims.length === 1 && state.payload.admissions[plan.admission.admission_id]?.status === 'consumed' &&
        mine?.producer.run_id === winner.run_id && mine.producer.run_attempt === winner.run_attempt, 'one admission, one claim, bound to the winning run and attempt',
        { admissions: state.payload.admissions[plan.admission.admission_id] ? 1 : 0, claims: executorClaims.length, winner_run_id: winner.run_id, winner_run_attempt: winner.run_attempt,
          earlier_attempt_admissions: Object.keys(state.payload.admissions).length - (state.payload.admissions[plan.admission.admission_id] ? 1 : 0) });

      const cycle = await open().intake(), payload = (await main.read()).state.payload;
      const intakeReceipts = Object.values(payload.requests).filter(x => x.source);
      const receipts = plan.requests.map(r => intakeReceipts.filter(x => x.request_id === r.request_id && ['accepted', 'consumed'].includes(x.status)).length);
      // A dispatch GitHub lists without its typed title cannot be matched to a request; it must then carry its own explicit refusal.
      const unreadable = intakeReceipts.filter(x => x.status === 'refused' && ['request_title_invalid', 'request_run_unreadable'].includes(x.reason_code ?? '')).length;
      step('dropped_request_recovered_once', 'requests.across_restart', cycle.status === 'complete' && receipts.every(n => n <= 1) && receipts.some(n => n === 1) &&
        receipts.filter(n => n === 0).length <= unreadable && cycle.acknowledgements.some(a => a.recorded === 'now') &&
        cycle.acknowledgements.filter(a => a.recorded === 'earlier').length >= requestLimits.maximum_sources && cycle.acknowledgements.every(a => ['accepted', 'refused', 'linked'].includes(a.outcome)),
        'every dispatch has one durable receipt; no request is accepted twice; a request with no accepted receipt has an explicit refusal', { accepted_receipts_per_request: receipts, explicit_refusals_of_unreadable_dispatches: unreadable, cycle });

      // Probe refs for the independent verifier: each must be refused, and main must still verify.
      const snapshot = await chainDocument.read(), records = (snapshot.value as { records: Array<Record<string, unknown>> }).records;
      const variants = auditVariants(snapshot.value as never, acknowledged.sequence, plan.audit_key.key_id, ports.audit_key);
      for (const [label, value, expect] of variants) {
        const ref = `w0-audit-${label}-${ports.broker_run.run_id}`;
        await probeRef(ports.clients.audit, request.audit_repository, ref, 'audit/chain.json', JSON.stringify(value) + '\n', snapshot.blob_sha);
        report.probe_refs.push({ repository: request.audit_repository.full_name, ref, expect });
      }
      step('independent_signed_audit_readback', 'audit.probe_refs', report.probe_refs.length === 3 && records.length >= acknowledged.sequence,
        'tampered, rolled-back and conflicting-but-signed histories published on probe refs only', { refs: report.probe_refs, records: records.length });
      await provenance(ports, plan, report);
      step('governed_token_cannot_write_state_or_audit', 'isolation.commit_provenance', report.commits.length >= 4 && report.commits.every(c => c.verified),
        'every stored commit by the expected App bot with a verified signature', { commits: report.commits.length, unverified: report.commits.filter(c => !c.verified) });
    }
    return report.steps.every(s => s.pass) ? finish('pass', 'native_witness_steps_passed') : finish('fail', 'native_witness_step_failed');
  } catch (error) {
    return finish('error', error instanceof StateRefusal ? error.code : statusOf(error) === 429 ? 'native_rate_limited' : 'native_witness_run_failed');
  }
}
const accepted = (cycle: IntakeReport) => cycle.acknowledgements.filter(a => a.outcome === 'accepted' && a.recorded !== 'no');

/** Three histories the verifier must refuse: a changed record, a history shorter
 * than the acknowledged one, and a validly signed alternative at the acknowledged sequence. */
export function auditVariants(chain: { records: Array<Record<string, unknown>> } & Record<string, unknown>, acknowledged: number, keyId: string, key: KeyObject) {
  if (acknowledged < 1 || chain.records.length < acknowledged) throw new StateRefusal('audit_acknowledgement_missing');
  const copy = () => structuredClone(chain);
  const tampered = copy(); (tampered.records[0]!.record as Record<string, unknown>).event_id = `${String((tampered.records[0]!.record as Record<string, unknown>).event_id)}x`;
  const rolledBack = copy(); rolledBack.records = rolledBack.records.slice(0, acknowledged - 1);
  const forked = copy(); forked.records = forked.records.slice(0, acknowledged);
  const original = forked.records[acknowledged - 1]!, record = { ...(original.record as Record<string, unknown>), event_id: `${String((original.record as Record<string, unknown>).event_id)}:fork` };
  const signed = { repository_id: original.repository_id, sequence: original.sequence, previous_sha256: original.previous_sha256, record_sha256: brokerDigest(record), key_id: keyId, record };
  const hash = brokerDigest(signed);
  forked.records[acknowledged - 1] = { ...signed, sha256: hash, signature: sign(null, Buffer.from(hash, 'hex'), key).toString('base64') };
  return [['tamper', tampered, 'audit_signature_or_hash_invalid'], ['rollback', rolledBack, 'audit_rollback'], ['fork', forked, 'audit_history_conflict']] as const;
}
/** Publish bytes on a new non-default ref. Never touches `main`, never forces. */
async function probeRef(gh: Octokit, repository: { full_name: string }, ref: string, path: string, bytes: string, replaces: string | null) {
  const [owner, repo] = repository.full_name.split('/') as [string, string];
  const head = z.object({ object: z.object({ sha: GitSha }) }).parse((await gh.request('GET /repos/{owner}/{repo}/git/ref/{ref}', { owner, repo, ref: 'heads/main', headers })).data).object.sha;
  await gh.request('POST /repos/{owner}/{repo}/git/refs', { owner, repo, ref: `refs/heads/${ref}`, sha: head, headers });
  await gh.request('PUT /repos/{owner}/{repo}/contents/{path}', { owner, repo, path, branch: ref, message: `T124 probe ${ref}`, content: Buffer.from(bytes).toString('base64'),
    ...(replaces ? { sha: replaces } : {}), headers });
  return { owner, repo };
}
/** A canonical-size document written and read back byte-exact through the store's own read bounds. */
async function pilotRoundTrip(gh: Octokit, repository: { full_name: string }, ref: string, report: WitnessReport): Promise<[boolean, string, Record<string, unknown>]> {
  const shell = JSON.stringify({ schema_version: 1, purpose: 't124_capacity_probe', padding: '' }) + '\n';
  const bytes = JSON.stringify({ schema_version: 1, purpose: 't124_capacity_probe', padding: 'a'.repeat(PILOT_STATE_BYTES - Buffer.byteLength(shell)) }) + '\n';
  const path = 'probes/pilot-size.json', { owner, repo } = await probeRef(gh, repository, ref, path, bytes, null);
  report.probe_refs.push({ repository: repository.full_name, ref, expect: 'pilot_size_document' });
  const file = z.object({ type: z.literal('file'), encoding: z.literal('base64'), sha: GitSha, size: z.number().int().max(PILOT_STATE_BYTES), content: z.string().max(750000) })
    .safeParse((await gh.request('GET /repos/{owner}/{repo}/contents/{path}', { owner, repo, path, ref, headers })).data);
  const read = file.success ? Buffer.from(file.data.content.replace(/\s/g, ''), 'base64').toString('utf8') : '';
  return [file.success && read === bytes && file.data.sha === gitBlob(bytes) && file.data.size === PILOT_STATE_BYTES,
    `a ${PILOT_STATE_BYTES}-byte document is stored and read back byte-exact inside the store's read bounds`,
    { ref, path, bytes: Buffer.byteLength(bytes), read_bytes: Buffer.byteLength(read), blob_sha: gitBlob(bytes), within_read_bounds: file.success }];
}
/** Native author and signature of the commits behind each stored document. */
async function provenance(ports: WitnessPorts, plan: WitnessPlan, report: WitnessReport) {
  const request = plan.provisioning.request, state = ports.clients.state();
  report.commits = [];
  for (const [gh, repository, path, principal] of [[state, request.state_repository, 'state/control.json', request.writer.principal_id],
    [state, request.state_repository, 'state/journal.json', request.writer.principal_id], [ports.clients.audit, request.audit_repository, 'audit/chain.json', request.writer.principal_id],
    [ports.clients.audit, request.audit_repository, 'audit/acknowledged.json', request.verifier_principal_id]] as const) {
    const [owner, repo] = repository.full_name.split('/') as [string, string];
    const commits = z.array(z.object({ sha: GitSha, author: z.object({ id: z.number(), type: z.string() }).nullable(),
      commit: z.object({ verification: z.object({ verified: z.boolean(), reason: z.string() }) }) })).max(100)
      .parse((await gh.request('GET /repos/{owner}/{repo}/commits', { owner, repo, sha: 'main', path, per_page: 100, headers })).data);
    for (const c of commits) report.commits.push({ repository: repository.full_name, path, commit_sha: c.sha, author_id: c.author?.id ?? null, author_type: c.author?.type ?? null,
      verified: c.author?.id === principal && c.author.type === 'Bot' && c.commit.verification.verified && c.commit.verification.reason === 'valid' });
  }
}

const PlanInput = z.object({
  attempt: PlanShape.shape.attempt,
  provisioning: PlanShape.shape.provisioning, audit_key: PlanShape.shape.audit_key, sign_in_app: SignInApp,
  trial: z.object({ trial_id: name, workload: z.string().regex(/^[a-z0-9][a-z0-9-]*$/), work_item: id, plan_ref: z.string(), plan_sha: GitSha,
    engine: z.enum(['copilot', 'claude', 'codex']), components: z.object({ generator: id, detector: id }).strict(), expires_at: Instant,
    /** Stated, never defaulted: the consented proposal says whether a second person is required. */
    second_human_review: SecondHumanReview }).strict(),
  runs: PlanShape.shape.runs, episode: PlanShape.shape.episode, admission: PlanShape.shape.admission,
  requests: z.array(TypedRequest).length(3),
}).strict();
/** Engineer-side, offline and deterministic: the trial proposal to publish for
 * consent and the plan it approves. The live run IDs are inputs because the
 * reservation and claim subjects bind them. One admission, no model spend. */
export function buildWitnessPlan(raw: unknown): { proposal: TrialAuthorization; plan: WitnessPlan } {
  const given = PlanInput.parse(raw);
  // A later attempt gets its own names. An earlier attempt's episode, admission and
  // locks stay held (nothing releases them), and its workload lock is one of them,
  // so the workload is renamed too and this attempt's dispatches must name it.
  const mark = (value: string) => given.attempt === 1 ? value : `${value}-a${given.attempt}`;
  const input = { ...given, trial: { ...given.trial, trial_id: mark(given.trial.trial_id), workload: mark(given.trial.workload) },
    episode: { ...given.episode, episode_id: mark(given.episode.episode_id) },
    admission: { ...given.admission, admission_id: mark(given.admission.admission_id), generation_id: mark(given.admission.generation_id),
      resource_lock_keys: given.admission.resource_lock_keys.map(mark) } };
  if (input.requests.some(r => r.workload !== input.trial.workload)) throw new StateRefusal('plan_requests_name_another_workload');
  const request = input.provisioning.request, runs = [input.runs.controller, ...input.runs.executors];
  const producers = [...new Map(runs.map(r => [`${r.source_sha}:${r.workflow_path}`, { repository_id: r.repository_id, repository: r.repository, source_sha: r.source_sha, workflow_path: r.workflow_path }])).values()];
  const draft = { schema_version: 1, purpose: 'trial', sandbox: true, governed_repository: request.governed_repository, state_repository: request.state_repository,
    audit_repository: request.audit_repository, control_repository: request.control_repository, writer: request.writer, ...input.trial,
    total_cap_aic: input.trial.components.generator + input.trial.components.detector, maximum_generations: 1,
    operations: ['record', 'reserve', 'consume', 'receipt'], producers, unproven_seam: 'w0_closure',
    // Declared references only: this no-model trial exercises none of them.
    capabilities: { primitive_sha256: brokerDigest({ t124: 'three_native_primitives' }), sandbox_sha256: brokerDigest({ sandbox: request.governed_repository }), detector_sha256: brokerDigest({ detector: 'not_exercised_no_model' }) } };
  const shell = { schema_version: 1, purpose: 't124_native_witnesses', attempt: input.attempt, provisioning: input.provisioning, audit_key: input.audit_key,
    safety: { repository: request.control_repository, environment: 'broker-credentials' }, runs: input.runs, episode: input.episode, admission: input.admission, requests: input.requests };
  const subjects = witnessSubjects({ ...shell, authority: { proposal: { ...draft, subjects: ['0'.repeat(64)] }, binding: null, consent_comment_id: null, sign_in_app: input.sign_in_app } });
  const proposal = TrialAuthorization.parse({ ...draft, subjects });
  return { proposal, plan: WitnessPlan.parse({ ...shell, authority: { proposal, binding: null, consent_comment_id: null, sign_in_app: input.sign_in_app } }) };
}
/** After the proposal PR has its exact-head review and consent comment. */
export const bindWitnessPlan = (rawPlan: unknown, binding: unknown, consentCommentId: unknown) => {
  const plan = WitnessPlan.parse(rawPlan);
  return WitnessPlan.parse({ ...plan, authority: { ...plan.authority, binding: ProposalBinding.parse(binding), consent_comment_id: id.parse(consentCommentId) } });
};

const REQUIRED_STEPS: Record<'run_a' | 'run_b', Record<RemainingWitness, string[]>> = {
  run_a: { single_use_run_attempt_claim: ['episode.recorded', 'reserve.lost_response', 'reserve.redelivery', 'consume.competing', 'consume.loser_retry', 'consume.duplicate_delivery'],
    governed_token_cannot_write_state_or_audit: ['isolation.commit_provenance', 'isolation.broker_job_token_blind'],
    bounded_capacity_and_rate_headroom: ['safety.settings_ready', 'capacity.pilot_size_roundtrip', 'capacity.admission_blocked', 'capacity.receipt_committed'],
    dropped_request_recovered_once: ['requests.first_cycle'], independent_signed_audit_readback: ['audit.outage_retains_receipt', 'audit.outage_blocks_admission'] },
  run_b: { single_use_run_attempt_claim: ['consume.rerun_attempt', 'consume.lost_response_recovery', 'consume.single_claim'], governed_token_cannot_write_state_or_audit: ['isolation.commit_provenance'],
    bounded_capacity_and_rate_headroom: ['safety.settings_ready'], dropped_request_recovered_once: ['requests.across_restart'],
    independent_signed_audit_readback: ['audit.pending_receipt_copied', 'audit.acknowledged_history', 'audit.probe_refs'] } };
const RunEvidence = z.object({ purpose: z.literal('t124_native_witness_run'), phase: z.enum(['run_a', 'run_b']), result: z.string(), plan_sha256: Digest, proposal_sha256: Digest,
  archive_outage: z.string(), broker_run: ProducerBinding, model_calls: z.literal(0), cloud_operations: z.literal(0), second_human_review: SecondHumanReview,
  attempt: z.number().int().min(1).max(9),
  repositories: z.object({ governed: z.string(), state: z.string(), audit: z.string(), control: z.string() }).strict(),
  steps: z.array(z.object({ witness: z.enum(REMAINING_WITNESSES), id: z.string(), pass: z.boolean() }).passthrough()).max(100),
  probe_refs: z.array(z.object({ repository: z.string(), ref: z.string(), expect: z.string() }).strict()).max(10) }).passthrough();
const Verification = z.object({ purpose: z.literal('audit_verification'), repository: z.string(), ref: z.string(), result: z.string(), code: z.string(), sequence: z.number().int().nonnegative(),
  advanced: z.boolean(), acknowledged: z.object({ sequence: z.number().int().nonnegative(), sha256: z.string().nullable() }).nullable() }).passthrough();
const Isolation = z.object({ purpose: z.literal('governed_isolation_probe'), repository: z.string(), state_repository: z.string(), audit_repository: z.string(),
  control_repository: z.string(), result: z.literal('pass'), hosted_secret_bytes_visible: z.literal(0),
  attempts: z.array(z.object({ target: z.string(), http_status: z.number().int() }).strict()).min(9).max(20) }).passthrough();
const named = z.object({ full_name: z.string() }).passthrough();
const Provisioned = z.object({ purpose: z.literal('broker_provision_state'), result: z.literal('provisioned'),
  request: z.object({ governed_repository: named, state_repository: named, audit_repository: named, control_repository: named }).passthrough(),
  safety_gate: z.object({ status: z.literal('blocked'), code: z.literal('safety_setting_missing'), execution: z.literal('blocked') }).passthrough() }).passthrough();

/** Pure reading of retained native reports. A missing, mismatched or failing
 * report leaves its witness `not_run` or `fail`; nothing here infers a pass. */
export function assembleRemainingWitnesses(raw: { provision?: unknown; run_a?: unknown; run_b?: unknown; verifications?: unknown; isolation?: unknown }) {
  const a = RunEvidence.safeParse(raw.run_a), b = RunEvidence.safeParse(raw.run_b), provision = Provisioned.safeParse(raw.provision), isolation = Isolation.safeParse(raw.isolation);
  const verifications = z.array(Verification).max(20).safeParse(raw.verifications), checks = verifications.success ? verifications.data : [];
  const paired = a.success && b.success && a.data.phase === 'run_a' && b.data.phase === 'run_b' && a.data.plan_sha256 === b.data.plan_sha256 &&
    a.data.proposal_sha256 === b.data.proposal_sha256 && a.data.broker_run.run_id !== b.data.broker_run.run_id && a.data.archive_outage === 'audit_token_revoked' &&
    brokerDigest(a.data.repositories) === brokerDigest(b.data.repositories);
  // Every other report must be about the same repositories the broker runs acted on.
  const repos = a.success ? a.data.repositories : null;
  const isolated = isolation.success && !!repos && isolation.data.repository === repos.governed && isolation.data.state_repository === repos.state &&
    isolation.data.audit_repository === repos.audit && isolation.data.control_repository === repos.control && isolation.data.attempts.every(x => [401, 403, 404].includes(x.http_status));
  const provisioned = provision.success && !!repos && provision.data.request.governed_repository.full_name === repos.governed && provision.data.request.state_repository.full_name === repos.state &&
    provision.data.request.audit_repository.full_name === repos.audit && provision.data.request.control_repository.full_name === repos.control;
  const steps = (witness: RemainingWitness): 'pass' | 'fail' | 'not_run' => {
    if (!a.success || !b.success) return 'not_run';
    const ok = ([['run_a', a.data], ['run_b', b.data]] as const).every(([phase, run]) => run.result === 'pass' &&
      REQUIRED_STEPS[phase][witness].every(stepId => run.steps.filter(s => s.id === stepId && s.witness === witness).length === 1 && run.steps.find(s => s.id === stepId)!.pass));
    return ok && paired ? 'pass' : 'fail';
  };
  const audit = b.success ? b.data.probe_refs.filter(r => r.ref.startsWith('w0-audit-')) : [];
  const refused = audit.length === 3 && audit.every(probe => checks.some(v => v.repository === probe.repository && v.ref === probe.ref && v.result === 'refused' && v.code === probe.expect && !v.advanced));
  const acknowledged = checks.some(v => v.repository === repos?.audit && v.ref === 'main' && v.result === 'verified' && v.advanced && (v.acknowledged?.sequence ?? 0) >= 1);
  const witness = (witnessId: RemainingWitness, extra: boolean | null, missing: string) => {
    const base = steps(witnessId);
    return { id: witnessId, result: base !== 'pass' ? base : extra === null ? 'not_run' as const : extra ? 'pass' as const : 'fail' as const,
      code: base === 'not_run' ? 'native_runs_missing' : base === 'fail' ? 'native_step_failed_or_runs_unpaired' : extra === null ? missing : extra ? 'native_reports_verified' : missing };
  };
  const witnesses = [witness('single_use_run_attempt_claim', true, ''),
    witness('governed_token_cannot_write_state_or_audit', raw.isolation === undefined ? null : isolated, 'governed_isolation_probe_missing_or_not_refused'),
    witness('bounded_capacity_and_rate_headroom', raw.provision === undefined ? null : provisioned, 'missing_safety_settings_block_not_retained'),
    witness('dropped_request_recovered_once', true, ''),
    witness('independent_signed_audit_readback', raw.verifications === undefined ? null : verifications.success && refused && acknowledged, 'independent_verifier_reports_missing_or_unexpected')];
  return { schema_version: 1 as const, task: 'T124' as const, purpose: 't124_remaining_witnesses' as const,
    result: witnesses.every(w => w.result === 'pass') ? 'pass' as const : 'incomplete' as const, witnesses, model_calls: 0 as const, cloud_operations: 0 as const,
    // Stated beside the technical result, as the keyless probe's report does. A
    // deferred second-human review is not one of the five witnesses and never passes.
    second_human_review: a.success ? a.data.second_human_review : 'unknown' as const,
    // One attempt's evidence only: both runs must carry the same plan, so they carry the same attempt.
    attempt: a.success ? a.data.attempt : null };
}
