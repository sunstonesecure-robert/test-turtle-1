import { z } from 'zod';

export { AuthorityRecord, TrialAuthorization } from './agent-loop-authority';

export const Digest = z.string().regex(/^[a-f0-9]{64}$/);
export const GitSha = z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/);
export const Instant = z.string().datetime();
const text = z.string().min(1).max(2048).regex(/\S/);
const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const positive = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const slug = z.string().max(100).regex(/^[a-z0-9][a-z0-9-]*$/);
export const Mode = z.enum(['off', 'observe', 'enforce']);
export const EvidenceRef = z.object({
  kind: text, ref: text, sha256: Digest.optional(), status: count.optional(), retry_after_seconds: count.optional(),
}).strict();
export type EvidenceRef = z.infer<typeof EvidenceRef>;
export const Fact = z.discriminatedUnion('state', [
  z.object({ state: z.literal('known'), value: z.union([z.string(), z.number(), z.boolean(), z.null(), z.array(z.unknown()), z.record(z.string(), z.unknown())]), observed_at: Instant, source: text }).strict(),
  z.object({ state: z.literal('unknown'), reason: text, evidence: z.array(EvidenceRef).max(100) }).strict(),
]);
export type Fact = z.infer<typeof Fact>;
export type Facts = Record<string, Fact>;

export const PolicySnapshot = z.object({
  schema_version: z.literal(1), repository_id: positive, revision: text, sha256: Digest, mode: Mode,
  loops: z.object({ execution: Mode, repair: Mode, remediation: Mode, optimization: Mode }).strict(),
  workloads: z.array(slug).max(100), kinds: z.array(z.enum(['plan', 'revision', 'build', 'remediation'])).max(4),
  episode_limits: z.object({
    generations: positive, agent_aic_cap: positive, detector_aic_cap: positive, episode_aic_basis: positive,
    tool_turns: positive, active_compute_minutes: positive, deadline_hours: positive,
    transport_retries: count, identical_failure_stop: positive,
  }).strict(),
  daily_aic: positive, artifact_retention_days: positive, recovery_window_minutes: positive,
  tool_manifest_digest: Digest, profile_digest: Digest.optional(), authority_record_ref: EvidenceRef,
  approved_by: text, approved_at: Instant,
}).strict();
export type PolicySnapshot = z.infer<typeof PolicySnapshot>;

export const Status = z.enum([
  'ready', 'running', 'validating', 'ready_to_publish', 'waiting_for_review', 'waiting_for_checks',
  'waiting_for_merge', 'verifying_merge', 'retry_wait', 'action_required', 'preparing_prototype',
  'diagnosing', 'waiting_for_authority', 'waiting_for_harness', 'waiting_for_budget', 'searching',
  'deploying', 'awaiting_deployment', 'conforming', 'complete', 'stopped', 'superseded',
]);
export const EpisodeCheckpoint = z.object({
  schema_version: z.literal(1), episode_id: text, repository_id: positive, workload: slug,
  kind: z.enum(['plan', 'revision', 'build', 'remediation']), work_item: positive.optional(), step_id: text.optional(),
  plan_ref: text, plan_sha: GitSha, request_actor: text, automation_principal: text,
  revision: positive, parent_digest: Digest.nullable(), policy_digest: Digest, context_digest: Digest,
  status: Status, generation_count: count, current_generation_id: text.optional(), not_before: Instant.optional(),
  deadline: Instant, active_compute_ms: count, reserved_aic: count, settled_aic: count,
  failure_fingerprint: Digest.optional(), unchanged_failure_count: count, pending_effect_id: text.optional(),
  last_outcome: text, reason_code: text, next_action: text, evidence: z.array(EvidenceRef).max(100),
}).strict();
export type EpisodeCheckpoint = z.infer<typeof EpisodeCheckpoint>;

export const EffectIntent = z.object({
  effect_id: text, kind: z.enum(['dispatch', 'publish', 'merge', 'deploy', 'poll_deploy', 'verify', 'record']),
  target: z.record(z.string(), z.unknown()).optional(),
  generation: z.object({ id: text, ordinal: positive, feedback_digest: Digest, prior_candidate_digest: Digest }).strict().optional(),
}).strict();
export type EffectIntent = z.infer<typeof EffectIntent>;
export const Decision = z.object({
  episode_id: text.optional(), workload: slug.optional(), mode: Mode, status: Status, reason_code: text, next_action: text,
  not_before: Instant.optional(), effects: z.array(EffectIntent).max(100), evidence: z.array(EvidenceRef).max(100),
  unknown: z.array(text).max(100), observed_at: Instant, policy_digest: Digest.nullable(),
}).strict();
export type Decision = z.infer<typeof Decision>;
export const Summary = z.object({
  total: count, action_required: count, waiting: count, proposed_effects: count, executed_effects: z.literal(0),
  unknown_facts: z.array(text), cost: z.literal('unknown'),
}).strict();
export const ControllerOutput = z.object({
  schema_version: z.literal(1), mode: Mode, repository_id: positive.nullable(), decisions: z.array(Decision), summary: Summary,
}).strict();
export type ControllerOutput = z.infer<typeof ControllerOutput>;

export const W0_BOUNDARIES = ['generator', 'detector', 'gate', 'repair', 'publisher', 'plan_approval', 'automatic_merge', 'resume', 'merged_verification'] as const;
export const WaveProof = z.object({
  schema_version: z.literal(1), result: z.enum(['pass', 'fail', 'incomplete', 'error']),
  claim_scope: z.enum(['protocol', 'effectiveness', 'release_cycle']), wave_id: z.string().regex(/^W[0-8]$/), tracer_id: text,
  source_sha: GitSha, policy_digest: Digest, input_digest: Digest, candidate_digest: Digest,
  command: text, exit_code: z.number().int(), started_at: Instant, completed_at: Instant,
  boundaries: z.array(z.object({ component: text, actual_or_simulated: z.enum(['actual', 'simulated']), fixture_digest: Digest.optional(), initiated_by: text.optional() }).strict()).min(1).max(100),
  gate_results: z.array(z.object({ check: text, first: text, after_repair: text, failing_input: text, fixture_digest: Digest.optional() }).strict()).max(100),
  actual_model_calls: count, simulated_generations: count, actual_effects: count, simulated_effects: count,
  receipts: z.array(EvidenceRef).max(100), operator_outcome: text, next_action: text,
}).strict();
export type WaveProof = z.infer<typeof WaveProof>;

/** Structural W0 protocol check only. Native receipts still need trusted readback;
 * this function never grants activation, spend, or publication authority. */
export function checkWaveProof(record: unknown): { accepted: boolean; kind: 'wave_proof' | 'test_run'; result: 'pass' | 'fail' | 'incomplete' | 'error'; unwitnessed: string[] } {
  const parsed = WaveProof.safeParse(record);
  if (!parsed.success) return { accepted: false, kind: 'test_run', result: 'error', unwitnessed: [...W0_BOUNDARIES] };
  const p = parsed.data;
  const unwitnessed = W0_BOUNDARIES.filter(component => {
    const boundary = p.boundaries.filter(b => b.component === component);
    const receipts = p.receipts.filter(r => r.kind === component && r.sha256);
    return boundary.length !== 1 || boundary[0]!.actual_or_simulated !== 'actual' || !!boundary[0]!.fixture_digest || receipts.length !== 1 ||
      (component === 'resume' && boundary[0]!.initiated_by !== 'controller') ||
      (component === 'automatic_merge' && boundary[0]!.initiated_by !== 'broker');
  });
  const unique = new Set(p.boundaries.map(b => b.component)).size === p.boundaries.length &&
    new Set(p.receipts.map(r => r.kind)).size === p.receipts.length && new Set(p.receipts.map(r => r.ref)).size === p.receipts.length;
  const accepted = p.wave_id === 'W0' && p.tracer_id === 'TB-W0' && p.claim_scope === 'protocol' && p.result === 'pass' && p.exit_code === 0 &&
    Date.parse(p.completed_at) >= Date.parse(p.started_at) && p.actual_model_calls >= 2 && p.actual_effects > 0 &&
    p.simulated_generations === 0 && p.simulated_effects === 0 && unique && unwitnessed.length === 0 &&
    p.boundaries.every(b => b.actual_or_simulated === 'actual' && !b.fixture_digest) &&
    p.gate_results.length > 0 && p.gate_results.every(g => g.first === 'fail' && g.after_repair === 'pass' && g.failing_input === 'agent_output' && !g.fixture_digest);
  return { accepted, kind: accepted ? 'wave_proof' : 'test_run', result: accepted ? 'pass' : p.result === 'error' ? 'error' : 'incomplete', unwitnessed };
}

/** Hosting readiness report for one governed repository: what the host actually
 * grants, read natively. It has no waiver, override or approval field on purpose;
 * `ready` follows only from four passing checks, and a report whose result
 * disagrees with its own checks does not parse. */
export const HOSTING_CHECK_IDS = ['repository_identity', 'hosting_plan', 'default_branch_protection', 'plan_tag_protection'] as const;
export const HostingCheck = z.object({
  id: z.enum(HOSTING_CHECK_IDS), result: z.enum(['pass', 'fail', 'unsupported', 'unknown']),
  code: z.string().regex(/^[a-z][a-z0-9_]{2,63}$/), next_action: text, http_status: z.number().int().min(100).max(599).optional(),
}).strict();
export type HostingCheck = z.infer<typeof HostingCheck>;
export const HostingCapabilityReport = z.object({
  schema_version: z.literal(1), purpose: z.literal('hosting_capability_readiness'),
  repository: z.object({
    id: positive.nullable(), full_name: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9-]*\/[A-Za-z0-9._-]+$/),
    visibility: z.enum(['public', 'private', 'internal', 'unknown']), owner_type: z.enum(['User', 'Organization', 'unknown']),
    plan: z.enum(['free', 'pro', 'team', 'enterprise', 'unknown']), default_branch: text.nullable(),
  }).strict(),
  trusted_merge_principal: z.object({ actor_type: z.literal('Integration'), actor_id: positive }).strict().nullable(),
  /** Entitlement only: whether this host can require environment reviewers at all.
   * `available` is never evidence that a reviewer is configured. */
  native_environment_reviewers: z.enum(['available', 'unavailable', 'unknown']),
  rulesets: z.array(z.object({
    id: positive, name: text, target: text, source_type: text, enforcement: text,
    applies_to: z.enum(['default_branch', 'plan_tags', 'not_counted']), rule_types: z.array(text).max(100),
    bypass_actors: z.array(z.object({ actor_type: text, actor_id: z.number().int().nullable(), bypass_mode: text }).strict()).max(100).nullable(),
  }).strict()).max(100),
  checks: z.array(HostingCheck).length(HOSTING_CHECK_IDS.length),
  result: z.enum(['ready', 'blocked']), blocked_by: z.array(z.enum(HOSTING_CHECK_IDS)).max(HOSTING_CHECK_IDS.length),
  waivers: z.literal(0), api_effect: z.literal('none'), api_requests: count, observed_at: Instant,
}).strict().superRefine((report, context) => {
  const blocked = report.checks.filter(c => c.result !== 'pass').map(c => c.id);
  if (report.checks.some((c, i) => c.id !== HOSTING_CHECK_IDS[i]) || JSON.stringify(blocked) !== JSON.stringify(report.blocked_by) ||
      (report.result === 'ready') !== (blocked.length === 0)) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'Hosting result must follow from its own four checks.' });
  }
});
export type HostingCapabilityReport = z.infer<typeof HostingCapabilityReport>;
