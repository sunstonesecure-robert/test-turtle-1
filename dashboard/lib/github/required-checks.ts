import type { Octokit } from '@octokit/rest';
import type { RepoRef } from './client';

/**
 * THE REQUIRED CHECK CONTEXTS, and whether they have finished running (GHI #236).
 *
 * Lives here — beside `checks.ts`, on the light side of the dashboard bundle
 * boundary — rather than in `scripts/gates/lib/readiness.ts`, which is where the
 * constant used to sit. `readiness.ts` reaches Octokit, the install manifest and the
 * environment tables, and the Builds page now needs this predicate: importing it
 * from there would drag all of that into a page's module graph, which is the class
 * of break `dashboard-bundle-boundary.test.ts` exists to catch. `readiness.ts`
 * re-exports the constant, so there is still exactly ONE definition and
 * `setup-repo.ts` keeps registering the ruleset from the same list the gates
 * publish under.
 *
 * WHY THIS EXISTS AT ALL. `build-merge` is started by the `workflow_run` completion
 * of `deliverable-gate` — but `deliverable-gate` runs TWICE on a deliverable pull
 * request: once on the `pull_request` event against the PR head, and once in the
 * sweep. The SWEEP copy's completion is what starts the merger; the `pull_request`
 * copy is the one whose check-run context the default-branch ruleset requires. Live
 * on 2026-09-12 the second was still `in_progress` when `pulls.merge` was called 27 s
 * into its 31 s job, GitHub refused the merge as a rule violation, and the refusal
 * was recorded as terminal. A green run, a pre-authorized deliverable, and 101
 * minutes of nothing (PB-017 finding 14).
 *
 * So the merger asks this question BEFORE it asks GitHub to merge, and the Builds
 * page asks it to tell "in flight" from "should have merged and did not" — one
 * predicate, two readers, no possibility of them disagreeing about what "the gate has
 * finished" means.
 */

/**
 * The check-run names the default-branch ruleset requires (`setup-repo.ts` registers
 * the ruleset FROM this list, and `deliverable-gate` publishes under these names, so
 * a rename cannot leave the ruleset requiring a context nothing reports).
 */
export const REQUIRED_CHECK_CONTEXTS = ['plan-gate', 'deliverable-gate'] as const;

/** Only the check-run fields this derivation reads. */
export interface RequiredCheckRun {
  /** the check-run name — compared against REQUIRED_CHECK_CONTEXTS */
  name: string;
  /** GitHub's check-run status: queued | in_progress | completed */
  status: string;
  /** null until the run reaches a conclusion */
  conclusion: string | null;
}

/** A required context with a run that has not finished. */
export interface PendingRequiredCheck {
  context: string;
  /** `queued` or `in_progress` — what the unfinished run was doing */
  status: string;
}

/**
 * PURE: which required contexts have a run that has NOT concluded.
 *
 * A CONTEXT WITH NO RUN AT ALL IS NOT PENDING HERE, and that is a decision rather
 * than an oversight. On deliverable PR #93 nothing but the sweep ever claimed the
 * required name — the `pull_request` gate copies sat in the approval-required state,
 * executed no jobs and published no check run — and the pre-authorized merge
 * SUCCEEDED. Treating an absent context as pending would have blocked that, and
 * would block forever on any context that legitimately never runs on a `build/**`
 * branch, since nothing would ever arrive to un-block it. GitHub's ruleset remains
 * the authority on whether a missing context refuses a merge; all this function
 * removes is the RACE, which by definition is about a run that EXISTS and is still
 * going.
 *
 * Every run is examined, not merely the newest per name: the required context is
 * satisfied by NAME, so two runs sharing a name both hold it, and the one still in
 * progress is precisely the one that refused the merge live.
 */
export function pendingRequiredChecks(runs: readonly RequiredCheckRun[]): PendingRequiredCheck[] {
  const required = new Set<string>(REQUIRED_CHECK_CONTEXTS);
  return runs
    .filter((run) => required.has(run.name) && run.status !== 'completed')
    .map((run) => ({ context: run.name, status: run.status }));
}

/** The pending contexts as one phrase, for a log line or an operator-facing row. */
export function pendingPhrase(pending: readonly PendingRequiredCheck[]): string {
  return pending.map((p) => `${p.context} (${p.status})`).join(', ');
}

/**
 * Every check run on one commit whose name is a required context.
 *
 * Paginated for the same reason `listVtCheckRuns` is: a silently truncated page here
 * would report a pending gate as settled, which is the exact failure this module
 * exists to prevent — and it would fail OPEN, straight back into the race.
 */
export async function listRequiredCheckRuns(gh: Octokit, repo: RepoRef, sha: string): Promise<RequiredCheckRun[]> {
  const required = new Set<string>(REQUIRED_CHECK_CONTEXTS);
  const listed = await gh.paginate(gh.checks.listForRef, { ...repo, ref: sha, per_page: 100 });
  return listed
    .filter((raw) => required.has(raw.name))
    .map((raw) => ({ name: raw.name, status: raw.status, conclusion: raw.conclusion ?? null }));
}
