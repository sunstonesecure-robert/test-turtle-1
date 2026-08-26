import { createClient, type RepoRef } from '../dashboard/lib/github/client';
import { errorMessage } from '../dashboard/lib/github/errors';
import { planRefForMergedCommit } from './build-verify';
import { listDeliverablePrs } from '../dashboard/lib/github/builds';
import { deriveCompletionStatus, listVtCheckRuns } from '../dashboard/lib/github/checks';
import { readPlanAtRef, slugFromPlanRef } from '../dashboard/lib/github/plans';
import { commitmentScope } from './gates/lib/checks-scope';
import type { Octokit } from '@octokit/rest';

/**
 * WHICH COMMIT does this verify run judge, and of which frozen plan? Two lines of
 * stdout — `<sha>` and `<plan_ref>` — both empty when the answer is "nothing".
 *
 * A separate entry point rather than a mode of `build-verify.ts` because the verify
 * workflow needs the answer as STEP OUTPUTS before it decides whether to check
 * anything out, and a script whose job is "print two values" must not also be the
 * script that writes a results file. Exits 0 either way: "no deliverable to verify"
 * is the ordinary case, not a failure.
 *
 * TWO MODES, and the second one exists because of a platform fact (found live,
 * 2026-08-25):
 *
 *   `--commit <sha>`  a PUSH to the default branch. Fires when a HUMAN merges — the
 *                     operator-required checkpoint path — and the pushed commit is
 *                     the subject.
 *
 *   `--sweep`         a `workflow_run` from `build-merge`. Needed because the
 *                     PRE-AUTHORIZED merge is performed by `build-merge` using
 *                     GITHUB_TOKEN, and GitHub emits no `push` event for actions
 *                     taken with that token — so the default path produced a merged
 *                     deliverable that nothing ever verified, silently. The sweep
 *                     asks the question directly: which merged deliverable has no
 *                     `vt-*` check run on its merge commit yet?
 *
 * The sweep is the third place this token restriction has had to be worked around
 * (the gate's verdict, the merge, and now the verification). Each one is a sweep for
 * the same reason: a question asked of repository state cannot miss an event.
 */

/**
 * The newest merged deliverable whose verification is not COMPLETE — not merely
 * "has no check runs".
 *
 * THE DIFFERENCE IS THE WHOLE RECOVERY PATH (Codex on PR #145, 2026-08-25). The first
 * version asked whether ANY `vt-*` check run existed and skipped the merge if one
 * did. So a target that concluded `failure`, or timed out, or a run that reported one
 * optional target and died, permanently disqualified that merge from every sweep —
 * including the `workflow_dispatch` whose documented purpose is *"re-verify after a
 * flaky target or a runner outage"*. The one thing the manual path existed for was
 * the one thing it could not do, and `vt-report` is explicitly built to let a later
 * run supersede via a newer same-named check run.
 *
 * So eligibility is now "are the MUST-mapped targets all green?", which is exactly
 * the question completion (L3) asks. `deriveCompletionStatus` answers it, and reusing
 * it means the sweep cannot disagree with the gate about whether a deliverable still
 * needs verifying.
 *
 * Ordered by MERGE TIME, which is immutable — an edit to an older pull request must
 * not make it look like the newest delivered tree.
 */
export async function sweepUnverifiedMerge(
  gh: Octokit,
  repo: RepoRef,
): Promise<{ sha: string; planRef: string } | null> {
  const prs = await listDeliverablePrs(gh, repo);
  const merged = prs
    .filter((p) => p.merged && p.mergeCommitSha && p.marker)
    .sort((a, b) => (a.mergedAt ?? '').localeCompare(b.mergedAt ?? '') * -1);
  for (const pr of merged) {
    const sha = pr.mergeCommitSha!;
    const planRef = pr.marker!.planRef;
    const slug = slugFromPlanRef(planRef);
    if (slug === null) continue;
    // Asked of the check runs themselves, not of a label or a stored flag: the check
    // runs ARE the record completion reads, so they are the only honest answer.
    const verdict = deriveCompletionStatus(slug, commitmentScope(await readPlanAtRef(gh, repo, planRef)), await listVtCheckRuns(gh, repo, sha));
    if (!verdict.complete) return { sha, planRef };
  }
  return null;
}

const argv = process.argv.slice(2);
const get = (name: string): string | undefined => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : undefined;
};
const [owner, repo] = (get('repo') ?? '').split('/');
const commit = get('commit');
const sweep = argv.includes('--sweep');
if (!owner || !repo || (!commit && !sweep)) {
  console.error('usage: build-verify-subject --repo <owner/repo> (--commit <sha> | --sweep)');
  process.exit(2);
}

const gh = createClient();
const ref = { owner, repo };
const resolved = sweep
  ? sweepUnverifiedMerge(gh, ref)
  : planRefForMergedCommit(gh, ref, commit!).then((planRef) => (planRef === null ? null : { sha: commit!, planRef }));

resolved
  .then((subject) => {
    // stdout carries the values the workflow captures; everything explanatory goes to
    // stderr so a step output can never accidentally contain prose.
    if (subject === null) {
      console.error(
        sweep
          ? 'no merged deliverable is awaiting verification — nothing to do'
          : `commit ${commit!.slice(0, 8)} is not a merged deliverable — nothing to verify`,
      );
      process.stdout.write('\n\n');
      return;
    }
    console.error(`verifying ${subject.sha.slice(0, 8)}, the merged deliverable of ${subject.planRef}`);
    process.stdout.write(`${subject.sha}\n${subject.planRef}\n`);
  })
  .catch((error) => {
    console.error(errorMessage(error));
    process.exit(1);
  });
