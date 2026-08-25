import type { Octokit } from '@octokit/rest';
import type { RepoRef } from './client';
import { parseDeliverableMarker, type DeliverableMarker } from './markers';
import { slugFromPlanRef } from './plans';

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
  marker: DeliverableMarker | null;
  /** derived: awaiting an OPERATOR merge specifically, which is what the portfolio
   *  surfaces as action-required (FR-064). A pre-authorized PR awaiting the
   *  deterministic merger is not the operator's problem and is not flagged. */
  actionRequired: boolean;
  mergeAuthority: 'pre-authorized' | 'operator-merge-required' | 'unknown';
  updatedAt: string;
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
export async function listDeliverablePrs(gh: Octokit, repo: RepoRef, slug?: string): Promise<DeliverablePrView[]> {
  const prs = await gh.paginate(gh.pulls.list, { ...repo, state: 'all', sort: 'updated', direction: 'desc', per_page: 100 });
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
    // Merge authority is re-derived by the gate on every run; the PR body records
    // what it said. Reading it back rather than recomputing keeps this module free
    // of the plan (and of a second copy of the escalation-only rule).
    const authority = /Merge authority:\*{0,2}\s*`?operator-merge-required/i.test(pr.body ?? '')
      ? ('operator-merge-required' as const)
      : /Merge authority:\*{0,2}\s*`?pre-authorized/i.test(pr.body ?? '')
        ? ('pre-authorized' as const)
        : ('unknown' as const);
    views.push({
      number: pr.number,
      title: pr.title,
      url: pr.html_url,
      branch: pr.head.ref,
      state,
      merged,
      mergeCommitSha: pr.merge_commit_sha ?? null,
      marker,
      // ONLY the operator-required case. A pre-authorized PR waiting on the
      // deterministic merger is in progress, not blocked on a human — flagging it
      // would teach the operator that action-required sometimes means "wait".
      actionRequired: state === 'awaiting-merge' && authority === 'operator-merge-required',
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
    .sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
  const newest = merged[0];
  return newest?.mergeCommitSha
    ? { sha: newest.mergeCommitSha, source: 'merged-deliverable', prNumber: newest.number }
    : { sha: frozenSha, source: 'frozen-plan' };
}
