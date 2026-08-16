import type { Octokit } from '@octokit/rest';
import type { RepoRef } from './client';
import { findLiveAndonsBySlug, withdrawProposal } from './andon';
import { reopenPlan, type ReopenResult } from './plans';
import { cancelWorkloadRuns, type CanceledRun } from './runs';
import { applyLifecycleTransition, type Workload } from './workloads';
import type { WorkloadAction } from './markers';

/**
 * Post-gate lifecycle effects (gate-checks-cli.md §3 "Post-gate effects") —
 * performed ONLY after lifecycle-gate passes, by the workload-lifecycle
 * workflow (via scripts/lifecycle-apply.ts) or the dashboard actions, which
 * share this seam so UX and enforcement cannot drift. Beyond the label flip +
 * event comment every action gets:
 *
 * cancel (FR-038, SC-014):
 *   1. in-flight runs are canceled via the REST cancel endpoint — canceled and
 *      KEPT, never deleted (FR-042). Always scanned, whatever the from-state:
 *      a run started before a defer can still be in flight when the deferred
 *      workload is canceled.
 *   2. every LIVE Andon break of the workload closes as andon:superseded with
 *      the cancellation as its recorded cause — resolved is approval-only
 *      (T198) — and each break's open corrections cascade to withdrawn,
 *      causes recorded (no correction:open outlives its break).
 *   3. label flip + event comment (reason + actor + timestamp).
 *
 * reactivate (FR-040): when the gate's L8 scan reported requires_review, the
 * plan is re-opened FIRST (the FR-008 path — a fresh version + Andon break),
 * so the workload returns to review before any unattended run may resume; the
 * event comment records why. Re-open before flip: a crash between the two
 * leaves a live review and a still-deferred workload — safe to retry, and the
 * retry's "already re-opened" IS the converged state (a review is open).
 */

const PAST_TENSE: Record<string, Exclude<WorkloadAction, 'introduced' | 'edited'>> = {
  activate: 'activated',
  complete: 'completed',
  cancel: 'canceled',
  defer: 'deferred',
  reactivate: 'reactivated',
  archive: 'archived',
};

export interface LifecycleEffects {
  workload: Workload;
  canceledRuns: CanceledRun[];
  supersededBreaks: number[];
  reopened: ReopenResult | null;
}

export async function performLifecycleTransition(
  gh: Octokit,
  repo: RepoRef,
  input: {
    slug: string;
    action: string; // imperative: activate|complete|cancel|defer|reactivate|archive
    actor: string;
    at: string;
    reason?: string;
    revisit?: string;
    /** the gate report's requires_review (reactivate only, L8) */
    requiresReview?: boolean;
  },
): Promise<LifecycleEffects> {
  const eventAction = PAST_TENSE[input.action];
  if (!eventAction) throw new Error(`unknown lifecycle action: ${input.action} (no delete exists — FR-042)`);

  let canceledRuns: CanceledRun[] = [];
  let supersededBreaks: number[] = [];
  let reopened: ReopenResult | null = null;
  let reason = input.reason;

  if (input.action === 'cancel') {
    canceledRuns = await cancelWorkloadRuns(gh, repo, input.slug);
    supersededBreaks = await findLiveAndonsBySlug(gh, repo, input.slug);
    for (const andonIssue of supersededBreaks) {
      await withdrawProposal(gh, repo, andonIssue, {
        by: input.actor,
        at: input.at,
        cause: `workload ${input.slug} canceled: ${input.reason ?? '(no reason recorded)'}`,
      });
    }
  }

  if (input.action === 'reactivate' && input.requiresReview) {
    try {
      reopened = await reopenPlan(gh, repo, { slug: input.slug, actor: input.actor, at: input.at });
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      // "already re-opened": a review is already open — the return-to-review
      // guarantee holds (and this is also the crash-retry convergence).
      // "nothing to re-open": no frozen plan exists, so the contradiction came
      // from a flag, not a frozen assumption — there is no plan to re-open and
      // the flag itself keeps builds blocked (B6).
      if (!message.startsWith('already re-opened') && !message.startsWith('nothing to re-open')) throw error;
    }
    reason = [
      'contradicting evidence arrived during deferral — returned to review before unattended runs resume (FR-040)',
      ...(input.reason ? [input.reason] : []),
    ].join('; ');
  }

  const workload = await applyLifecycleTransition(gh, repo, {
    slug: input.slug,
    action: eventAction,
    actor: input.actor,
    at: input.at,
    ...(reason !== undefined ? { reason } : {}),
    ...(input.revisit !== undefined ? { revisit: input.revisit } : {}),
  });

  return { workload, canceledRuns, supersededBreaks, reopened };
}
