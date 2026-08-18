import type { Octokit } from '@octokit/rest';
import type { RepoRef } from './client';
import { errorStatus } from './errors';
import { HIGH_STAKES_LABELS } from './labels';
import type { PlanDoc } from '../../../schemas/plan';

/**
 * The `high-stakes:<authority>` family's only writer.
 *
 * It used to live inside the review page's high-stakes panel, where a single
 * caller justified keeping the write beside the UI that made it (the per-surface
 * split runs/actions.tsx already makes). A second caller ended that: re-linking a
 * step to a different backlog item moves the label as surely as flagging the step
 * does, and two writers of one label family is how a board comes to disagree with
 * itself. So the rule moved here, to the layer that owns every other GitHub write.
 */

/** 404 only — the label is already gone, which is the outcome we wanted anyway.
 *  Anything else fails loudly, the andon.ts stance: a swallowed 5xx would report
 *  success while a stale route lingers. */
async function removeLabelIfPresent(gh: Octokit, repo: RepoRef, issueNumber: number, name: string): Promise<void> {
  try {
    await gh.issues.removeLabel({ ...repo, issue_number: issueNumber, name });
  } catch (error: unknown) {
    if (errorStatus(error) !== 404) throw error;
  }
}

/**
 * Bring `high-stakes:*` on the named issues into line with what the plan now says.
 *
 * DERIVED FROM THE PLAN, never from what the caller thinks it changed: the label
 * belongs on the tracking issue of the step that is flagged, so the truth is
 * always "which step names this issue, and is it flagged?". That one rule is
 * correct for both writers — flagging a step (the issue is fixed, the authority
 * moves) and re-linking a step to a different backlog item (the authority is
 * fixed, the issue moves) — and for a swap, where each issue's correct label is
 * the OTHER step's authority and a per-issue fix would get one of them wrong.
 *
 * The re-link case is why this is shared (PR #111 review). Re-linking used to
 * change only `tracking_issue`, so the OLD item kept `high-stakes:customer` —
 * permanently claiming a risk that had moved — while the newly linked item read
 * as unrouted. Neither the flagging action nor the confirmation workflow re-runs
 * on a plan edit, so nothing reconciled it.
 *
 * Add before remove, the crash-safe ordering openAndon uses (GHI #48): a partial
 * failure leaves an issue over-routed, which is visible and harmless, rather than
 * routed nowhere while the plan says it is high-stakes.
 *
 * `confirmed:<authority>` is deliberately untouched. The authority matrix
 * (issue-tracker-contract.md) gives that family to the confirmation workflow
 * alone, and a dashboard that could apply it could claim a sign-off nobody gave;
 * `clearOrphanedLabels` reconciles it against the OFFICIAL plans, which is the
 * right authority for a label about a recorded answer. What nothing yet does is
 * TRIGGER that sweep when a freeze moves a binding under it — GHI #112.
 *
 * `null`/`undefined` are ordinary inputs, not something a caller must filter: a
 * step with no binding, or the empty side of a link that was cleared.
 */
export async function reconcileHighStakesRouting(
  gh: Octokit,
  repo: RepoRef,
  plan: PlanDoc,
  issueNumbers: (number | null | undefined)[],
): Promise<void> {
  // Deduped and ordered so a run over the same edit is byte-identical in the log,
  // and so a swap cannot depend on which side the caller listed first.
  const affected = [...new Set(issueNumbers.filter((n): n is number => typeof n === 'number'))].sort((a, b) => a - b);
  for (const issueNumber of affected) {
    const owner = plan.steps.find((s) => s.tracking_issue === issueNumber);
    const wanted = owner?.high_stakes && owner.authority ? `high-stakes:${owner.authority}` : null;
    if (wanted) await gh.issues.addLabels({ ...repo, issue_number: issueNumber, labels: [wanted] });
    for (const stale of HIGH_STAKES_LABELS) {
      if (stale !== wanted) await removeLabelIfPresent(gh, repo, issueNumber, stale);
    }
  }
}
