import type { Octokit } from '@octokit/rest';
import { z } from 'zod';
import type { RepoRef } from '../../dashboard/lib/github/client';
import { listWorkloads } from '../../dashboard/lib/github/workloads';
import { resolveCurrent, tagTargetSha } from '../../dashboard/lib/github/plans';
import { Digest, GitSha, PolicySnapshot, type Facts, type Fact } from '../../schemas/agent-loop';
import { hashBytes, known, readEvidence, readFailure, unknown } from './store';

const Sidecar = z.object({
  schema_version: z.literal(1), repository_id: z.number().int().positive(), workload: z.string(), kind: z.literal('build'),
  work_item: z.number().int().positive(), step_id: z.string().min(1), plan_ref: z.string(), plan_sha: GitSha,
  episode_id: z.string().min(1), generation_id: z.string().min(1), ordinal: z.number().int().positive(),
  run_id: z.number().int().positive(), run_attempt: z.number().int().positive(), workflow_path: z.literal('.github/workflows/build-template.lock.yml'),
  source_sha: GitSha, candidate_digest: Digest, feedback_digest: Digest,
}).strict();
const Feedback = z.object({
  candidate_digest: Digest, repairability: z.enum(['candidate_fix', 'transport_wait', 'harness_diagnosis', 'authority_diagnosis', 'policy_boundary', 'terminal']),
  fingerprint: Digest, checks: z.array(z.object({ check: z.string(), result: z.string() }).passthrough()).min(1),
}).strict();

export interface Observation {
  repository_id: number | null; policy: PolicySnapshot | null; policy_fact: Fact;
  workloads: Array<{ workload: string; facts: Facts }>; errors: Facts;
}

/** Trusted API reads only. No environment/vars-context fallback and no write or
 * paid adapter is available here. Cache state is never approval or spend authority. */
export async function observe(gh: Octokit, repo: RepoRef, now: string): Promise<Observation> {
  const result: Observation = { repository_id: null, policy: null, policy_fact: known(null, now, 'AGENT_LOOP_POLICY'), workloads: [], errors: {} };
  try {
    const { data } = await gh.repos.get({ ...repo });
    if (!Number.isSafeInteger(data.id) || data.id <= 0) throw new Error('repository identity unavailable');
    result.repository_id = data.id;
  } catch (error) { result.errors.repository = readFailure(error, 'repository'); return result; }
  try {
    const { data } = await gh.actions.getRepoVariable({ ...repo, name: 'AGENT_LOOP_POLICY' });
    const parsed = PolicySnapshot.safeParse(JSON.parse(data.value));
    if (!parsed.success || parsed.data.repository_id !== result.repository_id) {
      result.policy_fact = unknown('policy_invalid'); return result;
    }
    result.policy = parsed.data;
    result.policy_fact = known(parsed.data, now, 'AGENT_LOOP_POLICY');
  } catch (error) {
    if ((error as { status?: number })?.status === 404) return result;
    result.policy_fact = error instanceof SyntaxError ? unknown('policy_invalid') : readFailure(error, 'AGENT_LOOP_POLICY');
    return result;
  }
  if (result.policy.mode === 'off') return result;
  let workloads: Awaited<ReturnType<typeof listWorkloads>>;
  try { workloads = await listWorkloads(gh, repo); }
  catch (error) { result.errors.workload = readFailure(error, 'issues'); return result; }
  let runs: Awaited<ReturnType<typeof gh.actions.listWorkflowRunsForRepo>>['data']['workflow_runs'] = [];
  let runError: Fact | null = null;
  try { runs = await gh.paginate(gh.actions.listWorkflowRunsForRepo, { ...repo, per_page: 100 }); }
  catch (error) { runError = readFailure(error, 'actions/runs'); }
  for (const workload of result.policy.workloads) {
    const matches = workloads.filter(w => w.slug === workload);
    const facts: Facts = {
      workload: matches.length === 1 ? known({ slug: workload, lifecycle: matches[0]!.state }, now, 'issues') : unknown('workload_missing_or_ambiguous'),
      stop: known({ stopped: false }, now, 'AGENT_LOOP_POLICY'),
      // Observe has no access to the canonical writer; these are explicitly unknown.
      ledger: unknown('state_not_configured'), outbox: unknown('state_not_configured'), wave_proofs: unknown('proof_not_read'),
    };
    result.workloads.push({ workload, facts });
    if (runError) { facts.candidate = runError; continue; }
    const possible = runs.filter(r => (r.head_branch ?? '').startsWith(`plan/${workload}/`) || (r.name ?? '').includes(` — ${workload} · `));
    possible.sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at) || b.id - a.id);
    const run = possible[0];
    if (!run) { facts.candidate = known(null, now, 'actions/runs'); facts.plan = unknown('plan_not_read'); continue; }
    const runSource = `https://github.com/${repo.owner}/${repo.repo}/actions/runs/${run.id}`;
    const refuse = (reason: string) => { facts.candidate = unknown(reason, [{ kind: 'run', ref: runSource }]); };
    try {
      if (run.path !== '.github/workflows/build-template.lock.yml' || run.event !== 'workflow_dispatch' ||
        !new RegExp(`^plan/${workload}/v[1-9][0-9]*$`).test(run.head_branch ?? '') || !run.head_sha || !GitSha.safeParse(run.head_sha).success) {
        refuse('candidate_producer_mismatch'); continue;
      }
      const planSha = await tagTargetSha(gh, repo, run.head_branch!);
      facts.plan = known({ ref: run.head_branch, sha: planSha, frozen: true }, now, `refs/tags/${run.head_branch}`);
      if (await resolveCurrent(gh, repo, workload) !== run.head_branch) { refuse('plan_superseded'); continue; }
      if (planSha !== run.head_sha) { refuse('candidate_ref_mismatch'); continue; }
      try {
        const checks = await gh.paginate(gh.checks.listForRef, { ...repo, ref: run.head_sha, per_page: 100 });
        facts.required_checks = known(checks.map(c => ({ name: c.name, status: c.status, conclusion: c.conclusion })), now, `commits/${run.head_sha}/check-runs`);
      } catch (error) { facts.required_checks = readFailure(error, 'check-runs'); }
      if (run.status !== 'completed') { facts.candidate = unknown('candidate_running', [{ kind: 'run', ref: runSource }]); continue; }
      const artifacts = await gh.paginate(gh.actions.listWorkflowRunArtifacts, { ...repo, run_id: run.id, per_page: 100 });
      const read = async (name: string, entry: string, sha256?: string): Promise<Fact> => {
        const matches = artifacts.filter(a => a.name === name);
        if (matches.length !== 1) return unknown('evidence_missing_or_ambiguous', [{ kind: 'run', ref: runSource }]);
        return readEvidence(gh, repo, { run_id: run.id, run_attempt: run.run_attempt!, artifact_id: matches[0]!.id, name, entry, sha256 }, now);
      };
      const sidecar = await read('loop-candidate', 'loop-candidate.json');
      if (sidecar.state === 'unknown') { facts.candidate = sidecar; continue; }
      const manifest = Sidecar.safeParse(JSON.parse((sidecar.value as { content: string }).content));
      if (!manifest.success) { refuse('candidate_manifest_invalid'); continue; }
      const m = manifest.data;
      if (m.repository_id !== result.repository_id || m.workload !== workload || m.run_id !== run.id || m.run_attempt !== run.run_attempt ||
        m.source_sha !== run.head_sha || m.plan_sha !== planSha || m.plan_ref !== run.head_branch ||
        run.name !== `build-template — ${workload} · #${m.work_item} on ${m.plan_ref}`) { refuse('candidate_binding_mismatch'); continue; }
      const payload = await read('deliverable', 'deliverable.patch', m.candidate_digest);
      if (payload.state === 'unknown') { facts.candidate = payload; continue; }
      const feedback = await read('loop-feedback', 'loop-feedback.json', m.feedback_digest);
      if (feedback.state === 'unknown') { facts.candidate = feedback; continue; }
      const feedbackText = (feedback.value as { content: string }).content;
      const f = Feedback.safeParse(JSON.parse(feedbackText));
      if (!f.success || f.data.candidate_digest !== m.candidate_digest || !f.data.checks.some(c => c.result === 'fail')) { refuse('feedback_invalid'); continue; }
      facts.candidate = known({ digest: m.candidate_digest, ordinal: m.ordinal, producer_run_id: run.id, run_attempt: run.run_attempt,
        validation: 'fail', feedback: { ...f.data, feedback_digest: hashBytes(feedbackText) } }, now, runSource);
    } catch (error) { facts.candidate = error instanceof SyntaxError ? unknown('evidence_json_invalid', [{ kind: 'run', ref: runSource }]) : readFailure(error, runSource); }
  }
  return result;
}
