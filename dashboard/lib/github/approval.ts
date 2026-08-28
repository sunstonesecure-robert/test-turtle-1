import type { Octokit } from '@octokit/rest';
import type { RepoRef } from './client';
import { APPROVAL_PR_LABEL } from './labels';

/**
 * Approval flow (T045 tracer surface): "Commit for approval" opens the PR from
 * the plan branch; the go-ahead is the merge, executed AS the operator — the
 * App token must never merge (SC-003). The dashboard only deep-links to the PR.
 */

/** The open approval PR for a plan version, when one exists — the review page's
 *  "merge it as yourself" indicator (live finding, PB run 2026-08-16: Approve
 *  plan created PR #31 and the page showed nothing). Read-only. */
export async function findOpenApprovalPr(
  gh: Octokit,
  repo: RepoRef,
  input: { slug: string; version: number },
): Promise<{ number: number; url: string } | null> {
  const head = `plan/${input.slug}/v${input.version}`;
  const { data } = await gh.pulls.list({ ...repo, state: 'open', head: `${repo.owner}:${head}`, base: 'main' });
  return data[0] ? { number: data[0].number, url: data[0].html_url } : null;
}

/**
 * Tag the pull request as an approval, so a governed repo's pull request list says
 * what KIND each row is (operator finding, 2026-08-28).
 *
 * Applied on BOTH paths below — the create and the reuse — because `openApprovalPr` is
 * idempotent and a resubmit must not leave the pull request it returns untagged.
 *
 * IT IS NOT A MIGRATION, and an earlier version of this comment claimed it was (Codex
 * on PR #170). The Andon page renders the approve form only under `!approvalPr`
 * (`app/andon/[issue]/page.tsx`) — once a pull request exists the page shows a merge
 * link instead — so for an approval pull request opened BEFORE this label existed, the
 * reuse branch is never reached through the dashboard at all. Those pull requests stay
 * unlabelled until someone labels them, and that is fine: the label is display, so the
 * cost of an old row without one is that it looks like an old row without one. What
 * would NOT be fine is a reconciliation sweep invented to write a decoration.
 *
 * BEST EFFORT, AND THAT IS THE CORRECT SEVERITY. Nothing reads this label: the approval
 * pull request is found by its head ref and its authority is the merge itself. So a
 * failure here costs a piece of decoration, and taking down the operator's "Commit for
 * approval" over decoration would be the worse trade. Reported rather than swallowed —
 * a silent no-op would leave someone hunting for why one row has no tag.
 */
async function tagAsApproval(gh: Octokit, repo: RepoRef, prNumber: number): Promise<void> {
  try {
    await gh.issues.addLabels({ ...repo, issue_number: prNumber, labels: [APPROVAL_PR_LABEL] });
  } catch (error: unknown) {
    console.warn(
      `Could not label approval pull request #${prNumber} as ${APPROVAL_PR_LABEL} ` +
        `(${error instanceof Error ? error.message : String(error)}). The pull request is unaffected — ` +
        'the label is display only. If the label does not exist in this repository, re-run `npm run init`.',
    );
  }
}

export async function openApprovalPr(
  gh: Octokit,
  repo: RepoRef,
  input: { slug: string; version: number; base?: string },
): Promise<{ number: number; url: string }> {
  const head = `plan/${input.slug}/v${input.version}`;
  const base = input.base ?? 'main';
  // Exactly one approval PR per plan version — a resubmit, or a PR left open by
  // a prior session, is reused rather than surfacing GitHub's create-422.
  const { data: existing } = await gh.pulls.list({ ...repo, state: 'open', head: `${repo.owner}:${head}`, base });
  if (existing[0]) {
    await tagAsApproval(gh, repo, existing[0].number);
    return { number: existing[0].number, url: existing[0].html_url };
  }
  const { data: pr } = await gh.pulls.create({
    ...repo,
    title: `Approve plan ${head}`,
    head,
    base,
    body: `Approval PR for \`${head}\`. Merging this PR is the operator's go-ahead: it freezes the plan (FR-006).`,
  });
  await tagAsApproval(gh, repo, pr.number);
  return { number: pr.number, url: pr.html_url };
}

/** Approval record (FR-026): merged_by + merged_at + merge SHA, straight from the PR. */
export async function getApprovalRecord(
  gh: Octokit,
  repo: RepoRef,
  prNumber: number,
): Promise<{ approver: string; approvedAt: string; mergeSha: string } | null> {
  const { data: pr } = await gh.pulls.get({ ...repo, pull_number: prNumber });
  if (!pr.merged_at || !pr.merge_commit_sha) return null;
  return {
    approver: pr.merged_by?.login ?? 'unknown',
    approvedAt: pr.merged_at,
    mergeSha: pr.merge_commit_sha,
  };
}
