import type { Octokit } from '@octokit/rest';
import type { RepoRef } from './client';

/**
 * Approval flow (T045 tracer surface): "Commit for approval" opens the PR from
 * the plan branch; the go-ahead is the merge, executed AS the operator — the
 * App token must never merge (SC-003). The dashboard only deep-links to the PR.
 */

export async function openApprovalPr(
  gh: Octokit,
  repo: RepoRef,
  input: { slug: string; version: number; base?: string },
): Promise<{ number: number; url: string }> {
  const head = `plan/${input.slug}/v${input.version}`;
  const { data: pr } = await gh.pulls.create({
    ...repo,
    title: `Approve plan ${head}`,
    head,
    base: input.base ?? 'main',
    body: `Approval PR for \`${head}\`. Merging this PR is the operator's go-ahead: it freezes the plan (FR-006).`,
  });
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
