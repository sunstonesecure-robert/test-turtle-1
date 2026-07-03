import type { Octokit } from '@octokit/rest';
import type { RepoRef } from './client';
import { PlanDoc } from '../../../schemas/plan';
import { errorMessage, errorStatus } from './errors';

/**
 * Plan module (T033 tracer surface): read plan.json from a ref, resolve the
 * CURRENT pointer, derive lifecycle state, and perform the post-merge freeze
 * that the plan-post-merge single-writer workflow runs (T038 logic).
 */

export type PlanLifecycle = 'proposed' | 'under_review' | 'frozen' | 're_opened';

export function planBranch(slug: string, version: number): string {
  return `plan/${slug}/v${version}`;
}

export async function readPlanAtRef(gh: Octokit, repo: RepoRef, ref: string): Promise<PlanDoc> {
  const { data } = await gh.repos.getContent({ ...repo, path: 'plan.json', ref });
  if (Array.isArray(data) || data.type !== 'file' || !('content' in data)) {
    throw new Error(`plan.json is not a file at ref ${ref}`);
  }
  const raw = Buffer.from(data.content, 'base64').toString('utf8');
  return PlanDoc.parse(JSON.parse(raw));
}

/** Untrusted-input variant for gates: returns issues instead of throwing on schema failure. */
export async function tryReadPlanAtRef(
  gh: Octokit,
  repo: RepoRef,
  ref: string,
): Promise<{ plan: PlanDoc | null; errors: string[] }> {
  try {
    const { data } = await gh.repos.getContent({ ...repo, path: 'plan.json', ref });
    if (Array.isArray(data) || !('content' in data)) return { plan: null, errors: ['plan.json is not a file'] };
    const parsed = PlanDoc.safeParse(JSON.parse(Buffer.from(data.content, 'base64').toString('utf8')));
    if (!parsed.success) {
      return { plan: null, errors: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`) };
    }
    return { plan: parsed.data, errors: [] };
  } catch (error: unknown) {
    return { plan: null, errors: [errorMessage(error)] };
  }
}

/** Resolve plans/<slug>/CURRENT on the default branch; null when no version is frozen yet. */
export async function resolveCurrent(gh: Octokit, repo: RepoRef, slug: string): Promise<string | null> {
  try {
    const { data } = await gh.repos.getContent({ ...repo, path: `plans/${slug}/CURRENT` });
    if (Array.isArray(data) || !('content' in data)) return null;
    return Buffer.from(data.content, 'base64').toString('utf8').trim();
  } catch (error: unknown) {
    if (errorStatus(error) === 404) return null;
    throw error;
  }
}

export async function tagExists(gh: Octokit, repo: RepoRef, tagRef: string): Promise<boolean> {
  try {
    await gh.git.getRef({ ...repo, ref: `tags/${tagRef}` });
    return true;
  } catch (error: unknown) {
    if (errorStatus(error) === 404) return false;
    throw error;
  }
}

/** Highest frozen version for a slug, from existing plan/<slug>/v* tags. */
export async function maxFrozenVersion(gh: Octokit, repo: RepoRef, slug: string): Promise<number> {
  try {
    const { data } = await gh.git.listMatchingRefs({ ...repo, ref: `tags/plan/${slug}/` });
    let max = 0;
    for (const ref of data) {
      const m = /refs\/tags\/plan\/[a-z0-9-]+\/v(\d+)$/.exec(ref.ref);
      if (m) max = Math.max(max, Number(m[1]));
    }
    return max;
  } catch (error: unknown) {
    if (errorStatus(error) === 404) return 0;
    throw error;
  }
}

/** Commit SHA a plan tag ultimately points at (dereferencing the annotated tag); null when absent. */
async function tagTargetSha(gh: Octokit, repo: RepoRef, tagRef: string): Promise<string | null> {
  try {
    const { data } = await gh.git.getRef({ ...repo, ref: `tags/${tagRef}` });
    if (data.object.type !== 'tag') return data.object.sha;
    const { data: tag } = await gh.git.getTag({ ...repo, tag_sha: data.object.sha });
    return tag.object.sha;
  } catch (error: unknown) {
    if (errorStatus(error) === 404) return null;
    throw error;
  }
}

/**
 * Post-merge freeze (single writer, FR-006/FR-007/FR-027):
 * 1. annotated tag plan/<slug>/vN at the merge SHA — first writer wins: exactly
 *    one official version (SC-008). A tag already at THIS merge SHA is our own
 *    earlier partial freeze (e.g. the CURRENT write was blocked) and is resumed,
 *    never raced against.
 * 2. plans/<slug>/CURRENT ← the tag ref
 * 3. andon:resolved on the Andon issue + close it (FR-006: closed, not locked —
 *    the break stays a searchable record; closure is never deletion)
 * Every step is idempotent, so a partially-applied freeze can always be re-run.
 */
export async function freezeApprovedPlan(
  gh: Octokit,
  repo: RepoRef,
  input: { slug: string; version: number; mergeSha: string; andonIssue: number; approver: string; approvedAt: string },
): Promise<{ tagRef: string }> {
  const tagRef = planBranch(input.slug, input.version);

  const existingTarget = await tagTargetSha(gh, repo, tagRef);
  if (existingTarget === null) {
    const { data: tag } = await gh.git.createTag({
      ...repo,
      tag: tagRef,
      message: `Frozen plan ${tagRef} approved by @${input.approver} at ${input.approvedAt}`,
      object: input.mergeSha,
      type: 'commit',
    });
    try {
      // Atomic: createRef 422s if refs/tags/<tagRef> appeared since the check.
      await gh.git.createRef({ ...repo, ref: `refs/tags/${tagRef}`, sha: tag.sha });
    } catch (error: unknown) {
      // Lost a live race — only the writer freezing this same merge may continue.
      if (errorStatus(error) !== 422 || (await tagTargetSha(gh, repo, tagRef)) !== input.mergeSha) throw error;
    }
  } else if (existingTarget !== input.mergeSha) {
    throw new Error(
      `refusing to freeze ${tagRef}: tag already exists at ${existingTarget}, not merge ${input.mergeSha} — exactly one official version (SC-008)`,
    );
  }

  const path = `plans/${input.slug}/CURRENT`;
  let existingSha: string | undefined;
  let existingContent: string | undefined;
  try {
    const { data } = await gh.repos.getContent({ ...repo, path });
    if (!Array.isArray(data) && 'sha' in data) {
      existingSha = data.sha;
      if ('content' in data && typeof data.content === 'string') {
        existingContent = Buffer.from(data.content, 'base64').toString('utf8').trim();
      }
    }
  } catch (error: unknown) {
    if (errorStatus(error) !== 404) throw error;
  }
  if (existingContent !== tagRef) {
    await gh.repos.createOrUpdateFileContents({
      ...repo,
      path,
      message: `plans: ${input.slug} CURRENT → ${tagRef}`,
      content: Buffer.from(`${tagRef}\n`).toString('base64'),
      ...(existingSha ? { sha: existingSha } : {}),
    });
  }

  await gh.issues.removeLabel({ ...repo, issue_number: input.andonIssue, name: 'andon:under-review' }).catch(() => {});
  await gh.issues.removeLabel({ ...repo, issue_number: input.andonIssue, name: 'andon:open' }).catch(() => {});
  await gh.issues.addLabels({ ...repo, issue_number: input.andonIssue, labels: ['andon:resolved'] });
  await gh.issues.update({ ...repo, issue_number: input.andonIssue, state: 'closed' });

  return { tagRef };
}
