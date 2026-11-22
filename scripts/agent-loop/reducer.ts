import { z } from 'zod';
import { Decision, EpisodeCheckpoint, Fact, PolicySnapshot, checkWaveProof, type EffectIntent, type Facts } from '../../schemas/agent-loop';

const checksSchema = z.array(z.object({ name: z.string(), status: z.string(), conclusion: z.string().nullable() }).passthrough());
const candidateSchema = z.object({
  digest: z.string().regex(/^[0-9a-f]{64}$/), validation: z.enum(['pass', 'fail', 'unknown']),
  ordinal: z.number().int().positive().optional(),
  feedback: z.object({ candidate_digest: z.string(), feedback_digest: z.string().regex(/^[0-9a-f]{64}$/), repairability: z.string(), fingerprint: z.string(), checks: z.array(z.unknown()).min(1) }).passthrough().optional(),
}).passthrough();
const modes = ['off', 'observe', 'enforce'] as const;

/** Observation-only: no IO, clock, ledger changes or executable effects. Even a
 * well-shaped trial/proof is insufficient to enable the unimplemented admission path. */
export function decideNext(rawState: unknown, rawFacts: unknown, rawPolicy: unknown, now: string): {
  nextState: EpisodeCheckpoint | null; effects: EffectIntent[]; decision: Decision;
} {
  z.string().datetime().parse(now);
  const state = rawState === null ? null : EpisodeCheckpoint.safeParse(rawState);
  const p = rawPolicy === null ? null : PolicySnapshot.safeParse(rawPolicy);
  const policy = p?.success ? p.data : null;
  const checkpoint = state?.success ? state.data : null;
  const facts: Facts = {};
  if (rawFacts && typeof rawFacts === 'object' && !Array.isArray(rawFacts)) {
    for (const [key, value] of Object.entries(rawFacts)) {
      const parsed = Fact.safeParse(value);
      facts[key] = parsed.success ? parsed.data : { state: 'unknown', reason: 'fact_invalid', evidence: [] };
    }
  }
  const get = (key: string): unknown => facts[key]?.state === 'known' ? facts[key].value : undefined;
  const unknown = Object.keys(facts).filter(key => facts[key]!.state === 'unknown').sort();
  const evidence = Object.values(facts).flatMap(f => f.state === 'unknown' ? f.evidence : [{ kind: 'observation', ref: f.source }]);
  let mode: 'off' | 'observe' = 'off';
  const finish = (status: Decision['status'], reason_code: string, next_action: string, effects: EffectIntent[] = [], not_before?: string) => {
    const decision = Decision.parse({
      ...(checkpoint ? { episode_id: checkpoint.episode_id } : {}), mode, status, reason_code, next_action,
      effects, evidence: evidence.slice(0, 100), unknown, observed_at: now, policy_digest: policy?.sha256 ?? null,
      ...(not_before ? { not_before } : {}),
    });
    return { nextState: checkpoint ? { ...checkpoint, status, reason_code, next_action } : null, effects: [], decision };
  };
  if (p && !p.success) return finish('action_required', 'policy_invalid', 'Correct the versioned AGENT_LOOP_POLICY configuration.');
  if (!policy) return finish('stopped', 'not_enrolled', 'Configure observe policy before inspecting this workload.');
  if (state && !state.success) return finish('action_required', 'state_invalid', 'Reconcile the invalid checkpoint; preserve its reservations.');
  if (policy.mode === 'off' || (get('stop') as { stopped?: boolean } | undefined)?.stopped) return finish('stopped', 'kill_switch', 'The loop is stopped; retain unresolved liabilities.');
  const workload = z.object({ slug: z.string(), lifecycle: z.string().nullable() }).safeParse(get('workload'));
  if (!workload.success) {
    mode = 'observe';
    if (!unknown.includes('workload')) unknown.push('workload');
    return finish('action_required', 'workload_unknown', 'Read the workload lifecycle before proposing work.');
  }
  const kind = checkpoint?.kind ?? 'build';
  if (!policy.workloads.includes(workload.data.slug) || !policy.kinds.includes(kind)) return finish('stopped', 'not_enrolled', 'This workload or episode kind is outside the policy.');
  if (checkpoint && (checkpoint.repository_id !== policy.repository_id || checkpoint.workload !== workload.data.slug)) return finish('action_required', 'identity_mismatch', 'Reconcile repository/workload provenance.');
  const loop = kind === 'remediation' ? 'remediation' : 'repair';
  if (Math.min(modes.indexOf(policy.mode), modes.indexOf(policy.loops[loop])) === 0) return finish('stopped', 'loop_disabled', 'Enable this loop in observe mode to inspect decisions.');
  mode = 'observe';
  if (checkpoint && ['complete', 'stopped', 'superseded'].includes(checkpoint.status)) return finish(checkpoint.status, 'episode_terminal', 'Retain the terminal episode and its evidence.');
  if (checkpoint?.not_before && Date.parse(checkpoint.not_before) > Date.parse(now)) return finish('retry_wait', 'backoff_pending', 'Wait until the recorded backoff expires.', [], checkpoint.not_before);
  const candidate = get('candidate');
  if (policy.mode === 'enforce') {
    const proofs = get('wave_proofs');
    if (!checkpoint && candidate === null && (!Array.isArray(proofs) || !proofs.some(p => checkWaveProof(p).accepted))) return finish('action_required', 'real_closure_missing', 'Run the bounded real W0 closure on the approved sandbox before expansion.');
    return finish('action_required', 'enforce_unavailable', 'Complete native authority, admission, budget, custody and live W0 proofs before enforcement.');
  }
  if (workload.data.lifecycle !== 'active') return finish('action_required', 'workload_inactive', 'The workload must be active before proposing work.');
  const plan = z.object({ ref: z.string(), sha: z.string(), frozen: z.literal(true) }).safeParse(get('plan'));
  if (!plan.success || (checkpoint && (plan.data.ref !== checkpoint.plan_ref || plan.data.sha !== checkpoint.plan_sha))) return finish('action_required', 'plan_unknown', 'Read the exact current frozen plan and reconcile its identity.');
  if (unknown.includes('required_checks')) {
    const f = facts.required_checks!;
    const delay = f.state === 'unknown' ? Math.max(60, ...f.evidence.map(e => e.retry_after_seconds ?? 0)) : 60;
    return finish('retry_wait', f.state === 'unknown' ? f.reason : 'checks_unknown', 'Read required checks after the GitHub backoff.', [], new Date(Date.parse(now) + delay * 1000).toISOString());
  }
  const required = checksSchema.safeParse(get('required_checks'));
  if (!required.success) {
    if (!unknown.includes('required_checks')) unknown.push('required_checks');
    return finish('action_required', 'checks_unknown', 'Read required checks; unreadable is not passed.');
  }
  const outbox = get('outbox');
  if (Array.isArray(outbox)) {
    const record = outbox.find((e: unknown) => typeof e === 'object' && e !== null && (e as { kind?: string }).kind === 'record' && (e as { status?: string }).status === 'pending') as { effect_id: string; transport_attempts?: number; last_error?: { status?: number } } | undefined;
    if (record?.last_error && (record.last_error.status ?? 0) >= 500) return finish('retry_wait', 'report_retry', 'Replay the same report upload after backoff.', [{ effect_id: record.effect_id, kind: 'record' }], new Date(Date.parse(now) + 60_000).toISOString());
  }
  if (required.data.some(c => c.status !== 'completed')) return finish('waiting_for_checks', 'checks_pending', 'Wait for the required checks.');
  if (!required.data.length) return finish('action_required', 'required_checks_empty', 'Declare and execute a nonempty required check set.');
  if (unknown.includes('candidate')) return finish('action_required', 'candidate_unknown', 'Reconcile the missing or invalid immutable candidate evidence.');
  if (candidate === null) return finish('ready', 'no_candidate', 'No candidate is present; paid work requires proven admission.');
  const c = candidateSchema.safeParse(candidate);
  if (!c.success) {
    if (!unknown.includes('candidate')) unknown.push('candidate');
    return finish('action_required', 'candidate_unknown', 'Read candidate and bound typed feedback from the trusted producer.');
  }
  if (checkpoint && (Date.parse(checkpoint.deadline) <= Date.parse(now) || checkpoint.generation_count >= policy.episode_limits.generations || checkpoint.unchanged_failure_count >= policy.episode_limits.identical_failure_stop)) return finish('action_required', 'episode_limit', 'Review the episode limit without resetting charges or holds.');
  const feedback = c.data.feedback;
  if (c.data.validation === 'fail' && feedback?.repairability === 'candidate_fix' && feedback.candidate_digest === c.data.digest) {
    const ordinal = (checkpoint?.generation_count ?? c.data.ordinal ?? 0) + 1;
    if (ordinal < 2 || ordinal > policy.episode_limits.generations) return finish('action_required', 'generation_unknown', 'Reconcile the generation lineage before proposing repair.');
    const id = `${checkpoint?.episode_id ?? 'observed'}-repair-${ordinal}-${c.data.digest}`;
    return finish('ready', 'candidate_repair', 'Would start a repair generation using the failed check and same candidate; admission remains required.', [{
      effect_id: id, kind: 'dispatch', target: { workload: workload.data.slug },
      generation: { id, ordinal, feedback_digest: feedback.feedback_digest, prior_candidate_digest: c.data.digest },
    }]);
  }
  return finish('action_required', 'validation_authority_required', 'Obtain independent same-candidate validation and detection; a run conclusion alone is insufficient.');
}
