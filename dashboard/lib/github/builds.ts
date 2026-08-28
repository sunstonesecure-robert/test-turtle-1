import type { Octokit } from '@octokit/rest';
import type { RepoRef } from './client';
import { errorStatus } from './errors';
import { parseDeliverableMarker, type DeliverableMarker } from './markers';
import { readPlanAtRef, slugFromPlanRef } from './plans';
import type { PlanStep } from '../../../schemas/plan';
import type { MergeAuthority } from '../../../schemas/executor';

/**
 * Deliverable pull requests as a lifecycle object (US18 — FR-064, FR-065, and the
 * FR-034 amendment).
 *
 * The sole reader-side module for the deliverable path: the portfolio's
 * action-required rollup, the builds page, and lifecycle-gate **L3** all resolve
 * "what did this workload actually build, and where is it?" through here. One
 * module because the alternative is three answers to that question — and the one
 * that matters most, L3's, would be the one nobody looked at.
 */

/**
 * Merge authority (T209, FR-062) — DERIVED, never configured.
 *
 * Escalation-only, and the asymmetry is the whole rule: configuration may ADD a
 * checkpoint and may never remove one a gate demands.
 *
 *   high-stakes step with a recorded confirmation → operator-merge-required, always
 *   per-workflow checkpoint configured             → operator-merge-required
 *   otherwise                                      → pre-authorized by the approved plan
 *
 * WHY THE HIGH-STAKES BRANCH IS NOT CONFIGURABLE. A step reaches B5 because a
 * customer, clinician, or lawyer answered a question about *that step* (GHI #87
 * scoped the gate to the step for this reason). Pre-authorizing its landing would
 * spend a real authority's answer on a diff no human read — the confirmation would
 * attest to an intent while the code went unreviewed.
 */
export function resolveMergeAuthority(step: PlanStep | null, opts: { requiresOperatorMerge?: boolean } = {}): {
  authority: MergeAuthority;
  reason: string;
} {
  if (step?.high_stakes) {
    return {
      authority: 'operator-merge-required',
      reason:
        `step ${step.id} is high-stakes (${step.authority ?? 'authority unset'}) and carries an external authority's ` +
        'confirmation — its deliverable always waits for the operator\'s own merge, regardless of configuration ' +
        '(FR-062 is escalation-only: config may add a checkpoint, never remove one a gate demands)',
    };
  }
  if (opts.requiresOperatorMerge) {
    return {
      authority: 'operator-merge-required',
      reason: 'the workflow is configured with requires_operator_merge — this deliverable waits for the operator\'s own merge',
    };
  }
  return {
    authority: 'pre-authorized',
    reason: 'the approved plan pre-authorizes this deliverable\'s merge (FR-062 default) — no per-step checkpoint is configured',
  };
}

export type BuildState = 'awaiting-merge' | 'merged' | 'refused' | 'unknown';

export interface DeliverablePrView {
  number: number;
  title: string;
  url: string;
  branch: string;
  state: BuildState;
  merged: boolean;
  /** the merge commit — the code verification runs against and completion is earned from */
  mergeCommitSha: string | null;
  /** WHEN it merged — immutable, unlike `updatedAt` (Codex on PR #145). This is the
   *  ordering key for "which deliverable is newest", because a label change or a body
   *  edit on an older pull request moves `updatedAt` and would otherwise make the
   *  wrong merge commit look like the latest delivered tree. */
  mergedAt: string | null;
  marker: DeliverableMarker | null;
  /** derived: awaiting an OPERATOR merge specifically, which is what the portfolio
   *  surfaces as action-required (FR-064). A pre-authorized PR awaiting the
   *  deterministic merger is not the operator's problem and is not flagged. */
  actionRequired: boolean;
  mergeAuthority: 'pre-authorized' | 'operator-merge-required' | 'unknown';
  updatedAt: string;
}

/**
 * The plan step a deliverable delivers, for the live merge-authority derivation.
 *
 * Cached per listing: a workload's deliverables share a plan ref, so a multi-step
 * plan would otherwise re-read the same document once per pull request.
 */
const planCache = new Map<string, Promise<PlanStep[] | null>>();

async function stepForMarker(gh: Octokit, repo: RepoRef, marker: DeliverableMarker): Promise<PlanStep | null> {
  const key = `${repo.owner}/${repo.repo}@${marker.planRef}`;
  let steps = planCache.get(key);
  if (!steps) {
    steps = readPlanAtRef(gh, repo, marker.planRef)
      .then((plan) => plan.steps)
      .catch(() => null);
    planCache.set(key, steps);
  }
  return (await steps)?.find((s) => s.id === marker.stepId) ?? null;
}

function stateFromLabels(labels: string[], merged: boolean): BuildState {
  if (labels.includes('build:merged') || merged) return 'merged';
  if (labels.includes('build:refused')) return 'refused';
  if (labels.includes('build:awaiting-merge')) return 'awaiting-merge';
  return 'unknown';
}

/**
 * Every deliverable pull request, newest first — optionally narrowed to one workload.
 *
 * Identified by the `deliverable:v1` marker rather than by the branch name. A branch
 * called `build/anything` is just a branch; only the deterministic writer emits the
 * marker, and it holds a write scope the executor does not. Reading the marker is
 * therefore the difference between "this looks like a deliverable" and "this is one".
 */
/**
 * The FR-062 merge checkpoint, read from where the operator actually sets it.
 *
 * IT IS AN ACTIONS REPOSITORY VARIABLE (Codex on PR #153). `CONFIGURATION_GUIDE.md` §3
 * documents it as one, and `build-publish`, `deliverable-gate` and `build-merge` all
 * receive it as `${{ vars.BUILD_REQUIRES_OPERATOR_MERGE }}`. This module used to read
 * `process.env` — which, in a dashboard deployment, is the DASHBOARD's environment and
 * has nothing to do with the repository variable. An operator who set the checkpoint as
 * documented got the gate and the merger correctly waiting for a human, while this
 * reader defaulted to `false`, classified the pull request as pre-authorized, left it
 * out of Action Required and offered no merge link. A checkpoint nobody is told about
 * is an invisible stall — the same failure `actionRequired` exists to prevent.
 *
 * `process.env` stays as an explicit override so the CLIs, which run INSIDE Actions and
 * already receive the variable in their environment, keep working unchanged — and so a
 * local dashboard can exercise the path without touching the target's settings.
 *
 * UNREADABLE IS NOT UNSET (operator finding, 2026-08-28; GHI #150). This used to
 * answer `false` for every failure, and `false` here means *pre-authorized* — so a
 * repository whose checkpoint is set to `true`, read with a token that cannot see
 * repository variables, produced the exact invisible stall the paragraph above says
 * this function exists to prevent. That is how it was found: the documented dashboard
 * token carries **Actions read**, and GitHub gates `actions/variables` behind a
 * SEPARATE *Variables* permission, so a correctly-configured target answered `403` and
 * this reader called it "not set".
 *
 * The distinction is the one T260 drew for `readExecutorConfig` on this same pull
 * request, one function away, and the one the listing below already makes about an
 * unreadable PLAN: only a verified 404 is absence. Everything else is `'unreadable'`,
 * and a caller that cannot tell must not guess — `listDeliverablePrs` reports every
 * deliverable's authority as `unknown` rather than inventing `pre-authorized`.
 *
 * Still no throw: this value renders a listing, and taking the whole Builds view down
 * because one settings read failed would be a worse outcome than the value it was
 * fetching. It degrades to "I could not tell", which is honest and visible.
 */
export type MergeCheckpoint = boolean | 'unreadable';

/** Warned-about repositories, so a per-render read does not print once per workload. */
const checkpointWarned = new Set<string>();

export async function readOperatorMergeCheckpoint(gh: Octokit, repo: RepoRef): Promise<MergeCheckpoint> {
  const truthy = (v: string | undefined): boolean => /^(1|true|yes)$/i.test(v ?? '');
  if (process.env.BUILD_REQUIRES_OPERATOR_MERGE !== undefined) {
    return truthy(process.env.BUILD_REQUIRES_OPERATOR_MERGE);
  }
  try {
    const { data } = await gh.actions.getRepoVariable({ ...repo, name: 'BUILD_REQUIRES_OPERATOR_MERGE' });
    return truthy(data.value);
  } catch (error: unknown) {
    // 404 is the ordinary unset case — the FR-062 default is pre-authorized.
    if (errorStatus(error) === 404) return false;
    const key = `${repo.owner}/${repo.repo}`;
    if (!checkpointWarned.has(key)) {
      checkpointWarned.add(key);
      // Said once, and said with the remedy: a status code alone sends the operator
      // to the network tab to work out which setting it was about.
      console.warn(
        `Could not read the BUILD_REQUIRES_OPERATOR_MERGE repository variable of ${key} ` +
          `(${errorStatus(error) ?? 'no status'}). Merge authority is reported as "unknown" rather than ` +
          'guessed. A 403 means the token lacks the fine-grained "Variables" read permission — grant it, ' +
          'or set BUILD_REQUIRES_OPERATOR_MERGE in the dashboard environment to state the answer directly.',
      );
    }
    return 'unreadable';
  }
}

export async function listDeliverablePrs(gh: Octokit, repo: RepoRef, slug?: string): Promise<DeliverablePrView[]> {
  const prs = await gh.paginate(gh.pulls.list, { ...repo, state: 'all', sort: 'updated', direction: 'desc', per_page: 100 });
  // Read ONCE for the whole listing: the checkpoint is a repository-wide setting, and
  // re-reading it per pull request would let one page report two different answers.
  const checkpoint = await readOperatorMergeCheckpoint(gh, repo);
  const requiresOperatorMerge = checkpoint === true;
  const views: DeliverablePrView[] = [];
  for (const pr of prs) {
    if (!pr.head.ref.startsWith('build/')) continue;
    const marker = parseDeliverableMarker(pr.body ?? '');
    if (slug !== undefined) {
      const prSlug = marker ? slugFromPlanRef(marker.planRef) : pr.head.ref.split('/')[1];
      if (prSlug !== slug) continue;
    }
    const labels = pr.labels.map((l) => (typeof l === 'string' ? l : (l.name ?? '')));
    const merged = Boolean(pr.merged_at);
    const state = stateFromLabels(labels, merged);
    // MERGE AUTHORITY IS DERIVED LIVE, not parsed out of the pull request body
    // (Codex on PR #145). The body records what the writer computed at PUBLICATION
    // time, and `BUILD_REQUIRES_OPERATOR_MERGE` is a mutable repository variable: flip
    // it while a deliverable is open and the gate and the merger start refusing to
    // auto-merge while this reader kept reporting `pre-authorized`. The portfolio then
    // calls the pull request "in flight" and nothing ever asks the operator to merge
    // it — an invisible stall, which is the same failure `actionRequired` exists to
    // prevent.
    //
    // So it goes through `resolveMergeAuthority` — the SAME function the gate and the
    // merger call — with the step read from the plan the marker names. One rule, one
    // implementation, three callers. An unreadable plan yields `unknown` rather than a
    // guess: reporting `pre-authorized` because we could not tell would be the
    // absent-≠-success mistake applied to a merge decision.
    //
    // An unreadable CHECKPOINT degrades to `unknown` for the same reason — except where
    // the checkpoint does not decide the answer. A HIGH-STAKES step is
    // `operator-merge-required` whatever the configuration says (FR-062 is
    // escalation-only), so its authority is fully knowable with the setting unread, and
    // reporting `unknown` there would HIDE the one class of deliverable that certainly
    // waits for a human — worse than the guess this change removes (Codex on PR #166).
    // So: always read the step; consult the checkpoint only when it is what the answer
    // depends on.
    let authority: DeliverablePrView['mergeAuthority'] = 'unknown';
    if (marker) {
      const step = await stepForMarker(gh, repo, marker);
      if (step && checkpoint === 'unreadable') {
        // No opts: the high-stakes branch of the shared rule is reached without
        // supplying a checkpoint we do not have. A step that is not high-stakes has an
        // authority that genuinely depends on the unread setting — that is `unknown`.
        if (step.high_stakes) authority = resolveMergeAuthority(step).authority;
      } else if (step) {
        authority = resolveMergeAuthority(step, { requiresOperatorMerge }).authority;
      }
    }
    views.push({
      number: pr.number,
      title: pr.title,
      url: pr.html_url,
      branch: pr.head.ref,
      state,
      merged,
      mergeCommitSha: pr.merge_commit_sha ?? null,
      mergedAt: pr.merged_at ?? null,
      marker,
      // NOT the pre-authorized case: a pre-authorized PR waiting on the deterministic
      // merger is in progress, not blocked on a human — flagging it would teach the
      // operator that action-required sometimes means "wait".
      //
      // `unknown` DOES belong here (Codex on PR #166). It is not "wait", it is "we
      // could not tell whether this waits for you", and the surface that leaves it out
      // files it under In flight, where the card reads *"Nothing is asked of you
      // here."* — the permissive answer this whole change exists to stop reporting,
      // arriving one layer up. Asking a human to look at a deliverable that might be
      // stalled is the cheap error; leaving it silent is the expensive one.
      actionRequired: state === 'awaiting-merge' && authority !== 'pre-authorized',
      mergeAuthority: authority,
      updatedAt: pr.updated_at,
    });
  }
  return views;
}

/**
 * THE VERIFIED COMMIT for a workload — what L3 reads check runs on (FR-034 as
 * amended, FR-063).
 *
 * Before US18 this was simply the frozen tag's commit, and that was defensible only
 * while a build verified the frozen TREE and produced nothing. Once a build produces
 * a deliverable, results on the frozen commit describe code the repository has never
 * contained — a completion earned on a lie (GHI #141).
 *
 * So: the newest MERGED deliverable whose marker names the workload's OFFICIAL plan
 * ref. Two properties follow, both wanted:
 *   • a re-opened plan (new version, new tag) invalidates old deliverables for
 *     completion purposes without deleting anything — their marker names the
 *     superseded ref and stops matching.
 *   • a workload with no merged deliverable falls back to the frozen SHA, which is
 *     the pre-US18 COMPATIBILITY SHIM and nothing more. It is what keeps plans
 *     frozen before 2026-08-24 completable; it is not a licence to complete a
 *     US18-era workload that never built anything, because such a workload has no
 *     `vt-*` check runs on the frozen commit either — `build-publish` refuses to
 *     create anything for a build with no deliverable, and nothing else writes them.
 */
export async function resolveVerifiedCommit(
  gh: Octokit,
  repo: RepoRef,
  planRef: string,
  frozenSha: string,
): Promise<{ sha: string; source: 'merged-deliverable' | 'frozen-plan'; prNumber?: number }> {
  const slug = slugFromPlanRef(planRef);
  if (slug === null) return { sha: frozenSha, source: 'frozen-plan' };
  const prs = await listDeliverablePrs(gh, repo, slug);
  const merged = prs
    .filter((p) => p.merged && p.mergeCommitSha && p.marker?.planRef === planRef)
    // BY MERGE TIME, which is immutable (Codex on PR #145). Sorting by `updatedAt`
    // meant a label change or a body edit on an OLDER deliverable could make it sort
    // newest, and L3 would then read `vt-*` check runs from the wrong merge commit —
    // completing against a stale tree, or refusing a completion that was valid. For a
    // multi-step plan with several merged deliverables that is reachable, and
    // `build-publish` itself edits bodies on re-delivery.
    .sort((a, b) => (a.mergedAt ?? '').localeCompare(b.mergedAt ?? '') * -1);
  const newest = merged[0];
  return newest?.mergeCommitSha
    ? { sha: newest.mergeCommitSha, source: 'merged-deliverable', prNumber: newest.number }
    : { sha: frozenSha, source: 'frozen-plan' };
}
