import type { Octokit } from '@octokit/rest';
import type { RepoRef } from '../../../dashboard/lib/github/client';
import { resolveCurrent, tagExists, tryReadPlanAtRef } from '../../../dashboard/lib/github/plans';
import { getWorkload } from '../../../dashboard/lib/github/workloads';
import { getChunk, findIntentConfirmation } from '../../../dashboard/lib/github/chunks';
import type { GateResult } from './runner';

/**
 * Build-preflight checks (gate-checks-cli.md §2):
 *   B1  --plan-ref tag exists AND is the newest frozen plan/<slug>/v* tag —
 *       the derived official version (FR-007; CURRENT eliminated 2026-07-11)
 *   B2  plan at that tag re-validates against the schema (integrity)
 *   B3  chunk is chunk:ready with intent + testable outcome metric + acceptance (FR-017)
 *   B4  unattended runs require a WELL-FORMED intent-confirmed comment (FR-018)
 *   B6  no flagged:wrong-assumption on the chunk — reconcile first (FR-022)
 *   B7  the workload carries workload:active (FR-033/038/039/041)
 *   B8  the run was DISPATCHED ON the frozen tag — GITHUB_REF names --plan-ref
 *       (FR-007; decided 2026-07-28, GHI #72 option A)
 * B5 arrives with US6.
 */

export async function checkB1FrozenCurrent(
  gh: Octokit,
  repo: RepoRef,
  planRef: string,
  slug: string,
): Promise<GateResult> {
  if (!(await tagExists(gh, repo, planRef))) {
    return { id: 'B1', status: 'fail', requirement: 'FR-007', detail: `tag ${planRef} does not exist` };
  }
  const current = await resolveCurrent(gh, repo, slug);
  if (current !== planRef) {
    return { id: 'B1', status: 'fail', requirement: 'FR-007', detail: `official version is ${current ?? 'unset (nothing frozen)'}, not ${planRef}` };
  }
  return { id: 'B1', status: 'pass', requirement: 'FR-007' };
}

export async function checkB2PlanRevalidates(gh: Octokit, repo: RepoRef, planRef: string): Promise<GateResult> {
  const { plan, errors } = await tryReadPlanAtRef(gh, repo, planRef);
  return plan
    ? { id: 'B2', status: 'pass', requirement: 'integrity' }
    : { id: 'B2', status: 'fail', requirement: 'integrity', detail: errors.join('; ') };
}

/**
 * B8 — the build must be DISPATCHED ON the frozen tag, not merely handed it as an
 * input (FR-007; GHI #72 option A, decided 2026-07-28).
 *
 * Three guarantees rest on the dispatch ref, and every one of them was broken while
 * builds were dispatched on `main` with the tag passed only as an input:
 *   1. the agent's worktree IS the frozen commit — `actions/checkout` follows
 *      `github.ref`, so dispatching on the tag makes "build only from frozen"
 *      structural instead of aspirational. Dispatched on main, the agent verified
 *      its targets against unapproved code while the reporter stamped those
 *      conclusions onto the frozen commit.
 *   2. `vt-report` gets TRUSTED provenance — `workflow_run.head_sha` is the frozen
 *      commit, which is the only thing an agent-authored artifact can be bound
 *      against (the workflow_run payload cannot see dispatch inputs).
 *   3. `cancelWorkloadRuns` finds the run at all — it matches in-flight runs by
 *      `head_branch == plan/<slug>/v<N>` (runs.ts). Dispatched on main, head_branch
 *      is `main`, nothing matches, and cancel silently stops nothing (FR-038,
 *      SC-014).
 *
 * Read from the environment, not a CLI flag: GITHUB_REF is set by Actions itself on
 * every step, so it cannot be spoofed by the caller the way an argument could — and
 * being env-borne means this check needed no change to the compiled workflow.
 *
 * WHY THE `plan_ref` INPUT STAYS (GHI #66 proposed dropping it as redundant once
 * dispatch-on-tag was enforced — that reading was wrong): this check compares two
 * INDEPENDENT sources, the caller's declared intent (`--plan-ref`, from the dispatch
 * input) against what Actions actually did (`GITHUB_REF`). Deriving the plan ref from
 * `github.ref` would make the comparison tautological — B8 would assert the ref
 * equals itself and catch nothing. The input's redundancy is the whole point of it.
 *
 * Absent GITHUB_REF (a local run of the CLI) is NOT a failure: the check reports
 * pass with a detail saying it was unenforceable, because failing closed here would
 * make the preflight unrunnable outside Actions for no security gain — the guarantee
 * only means anything on a runner.
 */
export function checkB8DispatchedOnFrozenRef(planRef: string, githubRef: string | undefined): GateResult {
  if (githubRef === undefined || githubRef.trim().length === 0) {
    return {
      id: 'B8',
      status: 'pass',
      requirement: 'FR-007',
      detail: 'GITHUB_REF is unset — not an Actions run, so the dispatch ref is unenforceable here',
    };
  }
  // Accept the full ref or the short form: Actions sets refs/tags/<tag> for a tag
  // dispatch, and comparing both ways keeps this honest whichever GitHub sends.
  const ref = githubRef.trim();
  if (ref === `refs/tags/${planRef}` || ref === planRef) {
    return { id: 'B8', status: 'pass', requirement: 'FR-007' };
  }
  return {
    id: 'B8',
    status: 'fail',
    requirement: 'FR-007',
    detail:
      `dispatched on ${ref}, not the frozen tag ${planRef} — re-run this build selecting the TAG ` +
      `${planRef} in the ref picker. Dispatching elsewhere means the agent checks out that ref instead ` +
      `of the approved commit (FR-007), the results cannot be bound to this build, and a cancel of the ` +
      `workload would not find this run (FR-038)`,
  };
}

/** B3 — the chunk carries a full, testable requirement (FR-017): label chunk:ready
 *  AND every body section (Intent / outcome metric / Acceptance) non-empty. Both are
 *  checked — a hand-applied label without the fields is exactly what this gate exists
 *  to catch. The chunk must also be BOUND to the frozen plan (a step's
 *  tracking_issue): without the binding, a ready+confirmed chunk from an unrelated
 *  workload would satisfy B3/B4, and naming an unflagged bystander chunk would
 *  bypass B6's contradiction block on the real work item (PR #74 bot finding). */
export async function checkB3ChunkReady(
  gh: Octokit,
  repo: RepoRef,
  chunkIssue: number,
  planRef: string,
): Promise<GateResult> {
  const chunk = await getChunk(gh, repo, chunkIssue);
  if (!chunk) {
    return { id: 'B3', status: 'fail', requirement: 'FR-017', detail: `issue #${chunkIssue} is not a chunk (no chunk:* label)` };
  }
  if (chunk.state !== 'ready') {
    return { id: 'B3', status: 'fail', requirement: 'FR-017', detail: `chunk #${chunkIssue} is chunk:${chunk.state} — promote it with the full requirement before handing it to an agent` };
  }
  const missing = (['intent', 'outcomeMetric', 'acceptance'] as const).filter((f) => chunk[f] === null);
  if (missing.length > 0) {
    return { id: 'B3', status: 'fail', requirement: 'FR-017', detail: `chunk #${chunkIssue} is labeled ready but missing section(s): ${missing.join(', ')}` };
  }
  const { plan } = await tryReadPlanAtRef(gh, repo, planRef);
  if (!plan || !plan.steps.some((s) => s.tracking_issue === chunkIssue)) {
    return {
      id: 'B3',
      status: 'fail',
      requirement: 'FR-017',
      detail: `chunk #${chunkIssue} is not a tracking issue of any step in ${planRef} — the build's chunk must be the plan's chunk, or the gates on it gate nothing`,
    };
  }
  return { id: 'B3', status: 'pass', requirement: 'FR-017' };
}

/** B4 — unattended runs need the operator's confirmation on record (FR-018): the
 *  intent:confirmed label AND a well-formed intent-confirmed comment naming this
 *  chunk. The comment is the confirmation — it carries identity + timestamp; the
 *  label alone is just a light. */
export async function checkB4IntentConfirmed(gh: Octokit, repo: RepoRef, chunkIssue: number): Promise<GateResult> {
  const chunk = await getChunk(gh, repo, chunkIssue);
  if (!chunk) {
    return { id: 'B4', status: 'fail', requirement: 'FR-018', detail: `issue #${chunkIssue} is not a chunk (no chunk:* label)` };
  }
  if (!chunk.intentConfirmed) {
    return { id: 'B4', status: 'fail', requirement: 'FR-018', detail: `chunk #${chunkIssue} lacks intent:confirmed — an unattended run cannot begin until the operator confirms intent alignment` };
  }
  const confirmation = await findIntentConfirmation(gh, repo, chunkIssue);
  if (!confirmation) {
    return { id: 'B4', status: 'fail', requirement: 'FR-018', detail: `chunk #${chunkIssue} carries intent:confirmed but no well-formed confirmation comment (by:@login at:ISO8601) — the label without the record does not authorize an unattended run` };
  }
  return { id: 'B4', status: 'pass', requirement: 'FR-018' };
}

/** B6 — a chunk flagged wrong-assumption builds on contradicted ground; the flag
 *  must be reconciled (US5) before any build (FR-022). */
export async function checkB6NotFlagged(gh: Octokit, repo: RepoRef, chunkIssue: number): Promise<GateResult> {
  const { data: issue } = await gh.issues.get({ ...repo, issue_number: chunkIssue });
  const labels = (issue.labels ?? []).map((l) => (typeof l === 'string' ? l : (l.name ?? '')));
  return labels.includes('flagged:wrong-assumption')
    ? { id: 'B6', status: 'fail', requirement: 'FR-022', detail: `chunk #${chunkIssue} carries flagged:wrong-assumption — reconcile the contradicting evidence before building` }
    : { id: 'B6', status: 'pass', requirement: 'FR-022' };
}

export async function checkB7WorkloadActive(gh: Octokit, repo: RepoRef, slug: string): Promise<GateResult> {
  const workload = await getWorkload(gh, repo, slug);
  if (!workload) {
    return { id: 'B7', status: 'fail', requirement: 'FR-033', detail: `workload not found: ${slug}` };
  }
  return workload.state === 'active'
    ? { id: 'B7', status: 'pass', requirement: 'FR-033' }
    : { id: 'B7', status: 'fail', requirement: 'FR-033', detail: `workload ${slug} is workload:${workload.state}, not active` };
}
