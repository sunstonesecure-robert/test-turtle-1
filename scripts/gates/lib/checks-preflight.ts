import type { Octokit } from '@octokit/rest';
import type { RepoRef } from '../../../dashboard/lib/github/client';
import { resolveCurrent, tagExists, tryReadPlanAtRef } from '../../../dashboard/lib/github/plans';
import { getWorkload } from '../../../dashboard/lib/github/workloads';
import { getChunk, findIntentConfirmation } from '../../../dashboard/lib/github/chunks';
import { errorMessage, errorStatus } from '../../../dashboard/lib/github/errors';
import { ConfirmationRecord } from '../../../schemas/confirmation';
import type { GateResult } from './runner';

/**
 * Build-preflight checks (gate-checks-cli.md §2):
 *   B1  --plan-ref tag exists AND is the newest frozen plan/<slug>/v* tag —
 *       the derived official version (FR-007; CURRENT eliminated 2026-07-11)
 *   B2  plan at that tag re-validates against the schema (integrity)
 *   B3  chunk is chunk:ready with intent + testable outcome metric + acceptance (FR-017)
 *   B4  unattended runs require a WELL-FORMED intent-confirmed comment (FR-018)
 *   B5  every high-stakes step in the build carries a valid, authority-matching
 *       confirmation record (FR-024, SC-006)
 *   B6  no flagged:wrong-assumption on the chunk — reconcile first (FR-022)
 *   B7  the workload carries workload:active (FR-033/038/039/041)
 *   B8  the run was DISPATCHED ON the frozen tag — GITHUB_REF names --plan-ref
 *       (FR-007; decided 2026-07-28, GHI #72 option A)
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

export function confirmationPath(stepId: string): string {
  return `confirmations/${stepId}.json`;
}

/** One file at one ref, or null when absent. Local rather than reusing plans.ts's
 *  private reader: that one resolves the PLAN document (canonical path, guarded
 *  legacy fallback), and a confirmation has exactly one path with no history. */
async function readTextAtRef(gh: Octokit, repo: RepoRef, path: string, ref: string): Promise<string | null> {
  try {
    const { data } = await gh.repos.getContent({ ...repo, path, ref });
    if (Array.isArray(data) || !('content' in data)) return null;
    return Buffer.from(data.content, 'base64').toString('utf8');
  } catch (error: unknown) {
    if (errorStatus(error) === 404) return null;
    throw error;
  }
}

/** Valid record, or the reason it is not one. Exported so the confirm-record
 *  workflow's validator (scripts/confirm-record.ts) admits EXACTLY the records B5
 *  accepts: a second definition of "valid" would let a record earn the
 *  confirmed:<authority> label and still block the build it was recorded for. */
export function parseConfirmation(raw: string, stepId: string): { record: ConfirmationRecord } | { reason: string } {
  let doc: unknown;
  try {
    doc = JSON.parse(raw);
  } catch (error: unknown) {
    return { reason: `unparseable JSON (${errorMessage(error)})` };
  }
  const parsed = ConfirmationRecord.safeParse(doc);
  if (!parsed.success) {
    return { reason: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ') };
  }
  // A record whose step_id disagrees with its filename was copied from another
  // step: the authority answered a different question, so it attributes nothing
  // to the step being built.
  if (parsed.data.step_id !== stepId) {
    return { reason: `its step_id is "${parsed.data.step_id}", not "${stepId}" — a record copied from another step confirms nothing` };
  }
  return { record: parsed.data };
}

/**
 * B5 — the build stays blocked until an attributable external confirmation exists
 * for every high-stakes step it builds (FR-024, SC-006).
 *
 * WHERE IT READS IS THE CHECK. The plan comes from `planRef`, the frozen tag; the
 * confirmation comes from the repository's DEFAULT BRANCH HEAD. FR-024 blocks the
 * build "even on an approved plan", which means the confirmation is recorded AFTER
 * the freeze — so the frozen tag cannot contain it by construction, and a B5 that
 * read `confirmations/<step-id>.json` at planRef would be unpassable: every
 * high-stakes build would block forever and the only way out would be to stop
 * flagging steps. Approval freezes the plan; the confirmation unblocks the build;
 * the two act on different objects and the gate reads each where it lives.
 *
 * Step set: the steps this build NAMES (`--step`, repeatable) when it names any,
 * otherwise every high_stakes step in the plan. A named step the plan does not
 * contain FAILS — a typo must not silently skip the gate on the step it names —
 * and an empty list is not a selection, so a caller forwarding zero --step
 * arguments falls back to the whole plan rather than disarming the check.
 *
 * The three causes are reported apart because they are three different operator
 * actions: chase the authority, fix the record you have, or get the RIGHT
 * authority. One message for all three would send the operator to the wrong place
 * twice out of three times. Ordering is PLAN order, never discovery order
 * (gate-checks-cli.md "Shared conventions").
 */
export async function checkB5ConfirmationRecorded(
  gh: Octokit,
  repo: RepoRef,
  planRef: string,
  stepIds?: string[],
): Promise<GateResult> {
  // The same read B2 makes: one way to resolve plan.json, so the gate that blocks
  // and the gate that validates can never disagree about which document is frozen.
  const { plan, errors } = await tryReadPlanAtRef(gh, repo, planRef);
  if (!plan) {
    return { id: 'B5', status: 'fail', requirement: 'FR-024', detail: `cannot read the plan at ${planRef}: ${errors.join('; ')}` };
  }

  const named = stepIds !== undefined && stepIds.length > 0 ? stepIds : null;
  const unknown = named ? [...new Set(named.filter((id) => !plan.steps.some((s) => s.id === id)))] : [];
  const inScope = plan.steps.filter((s) => s.high_stakes && (named === null || named.includes(s.id)));

  if (unknown.length === 0 && inScope.length === 0) {
    // Explained, not silent: a green on a gate this consequential reads like a
    // gate that never ran.
    return {
      id: 'B5',
      status: 'pass',
      requirement: 'FR-024',
      detail: 'no high-stakes step in this build — nothing to confirm',
    };
  }

  const blocked = unknown.map((id) => `${id}: named by this build but absent from the plan at ${planRef}`);
  if (inScope.length > 0) {
    const { data: repoInfo } = await gh.repos.get({ ...repo });
    const branch = repoInfo.default_branch;
    for (const step of inScope) {
      const path = confirmationPath(step.id);
      const raw = await readTextAtRef(gh, repo, path, branch);
      if (raw === null) {
        blocked.push(`${step.id}: no confirmation recorded — ${path} does not exist on ${branch}; route it to the ${step.authority} authority and commit the answer`);
        continue;
      }
      const parsed = parseConfirmation(raw, step.id);
      if ('reason' in parsed) {
        blocked.push(`${step.id}: ${path} is not a valid confirmation record — ${parsed.reason}`);
        continue;
      }
      // authority is non-null on any high_stakes step that survived the schema
      // (plan.ts's superRefine, FR-023), so the route is always something to match.
      if (parsed.record.authority !== step.authority) {
        blocked.push(`${step.id}: confirmed by ${parsed.record.authority}, but the step routes to ${step.authority} — an answer from another authority leaves the risk this step named unreviewed`);
      }
    }
  }

  return blocked.length === 0
    ? { id: 'B5', status: 'pass', requirement: 'FR-024' }
    : { id: 'B5', status: 'fail', requirement: 'FR-024', detail: blocked.join('; ') };
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
