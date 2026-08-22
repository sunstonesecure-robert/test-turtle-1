import type { Octokit } from '@octokit/rest';
import type { RepoRef } from './client';
import { errorStatus } from './errors';

/**
 * Where evidence records live: a dedicated `evidence` branch, not the default
 * branch (GHI #134, operator decision 2026-08-22).
 *
 * `init` installs the ruleset **`oversight: require plan-gate on main`** on
 * `~DEFAULT_BRANCH` whose only bypass actor is the repository-admin role. The
 * `evidence-collect` workflow runs as `github-actions[bot]`, which holds no
 * repository role, and a direct push can never carry a `plan-gate` check run —
 * so every write it attempted to the default branch was refused 409 in every
 * repository this product initializes (first observed live on run 32525285904,
 * PB-011 step 1). The scheduled half of evidence collection had never worked.
 *
 * Of the three workable fixes, this is the one that keeps the security boundary
 * intact. Adding the Actions token as a bypass actor would have been three
 * lines, but every workflow shares that token: the plan gate would stop being
 * physically binding on automation, one week after GHI #130 showed a
 * deterministic workflow can be turned into an injection surface. Routing each
 * batch through a pull request needs a repository setting that is off by default
 * and produces a review nobody reads, weekly. Narrowing the ruleset by path is
 * not buildable at all — ruleset conditions are ref-based, and a
 * `required_status_checks` rule cannot be scoped to paths.
 *
 * So the record moves instead, and the append-only claim gets STRONGER rather
 * than weaker: this branch carries its own `non_fast_forward` + `deletion`
 * ruleset (`oversight: protect the evidence branch`), which the default branch's
 * ruleset never gave the records. Nothing merges this branch — its root commit
 * is an orphan, so it shares no history with the default branch and no pull
 * request from it could revert anything.
 *
 * **Legacy records stay readable.** Batches committed before this change live at
 * `evidence/<date>.json` on the default branch. `readEvidenceFile` prefers this
 * branch and falls back to the default branch, the same shape as the pre-#79
 * plan-document fallback — records are not migrated, because moving a committed
 * record is a rewrite of history that buys nothing a fallback read does not.
 */
export const EVIDENCE_BRANCH = 'evidence';

/** Directory every batch record is committed under, on the branch above. */
export const EVIDENCE_DIR = 'evidence';

/**
 * The one file the branch is created with. Operator-visible, so it explains the
 * branch in the operator's terms rather than naming requirements or gates — a
 * reader who lands here from a commit link should learn what they are looking at
 * and why it is not on the default branch.
 */
const BRANCH_README = `# Evidence records

This branch is the append-only store for **evidence batches**: real-world data —
customer feedback, analytics, test results — recorded as dated records that plans
can be checked against.

- One file per batch: \`evidence/<date>-<source>.json\`.
- Each batch also has an issue labelled \`evidence:batch\`, which is where it is
  reviewed and where a contradiction is recorded.
- Recording the same date and source again **appends** to that batch's file; a
  different source on the same date starts a new one.

**Why this branch and not the main one.** The main branch requires a passing plan
check on every push, and the scheduled collector holds no credential that can
satisfy it — so its records were refused, every time. Keeping them here means the
main branch stays strict: no automation is granted a way around that check.

Nothing merges this branch. Its history starts fresh here and only ever grows:
force-pushes and deletion are blocked, so a record that has been written cannot
be quietly rewritten or removed.

Read the batches from the dashboard's **Evidence** page — that is where they are
reviewed and where a batch is marked as contradicting a plan.
`;

/** A record read back from the store, with where it was found. */
export interface StoredEvidenceFile {
  content: string;
  /**
   * The blob sha to pass back when overwriting — `null` when the file was found
   * on the DEFAULT branch, where that sha is meaningless for a write to this
   * branch. A null sha means "create it here", which is what superseding a
   * legacy record correctly does.
   */
  sha: string | null;
  ref: typeof EVIDENCE_BRANCH | 'default';
}

async function getFileAt(
  gh: Octokit,
  repo: RepoRef,
  path: string,
  ref: string | undefined,
): Promise<{ content: string; sha: string } | null> {
  try {
    const { data } = await gh.repos.getContent({ ...repo, path, ...(ref ? { ref } : {}) });
    if (Array.isArray(data) || !('content' in data)) return null;
    return { content: Buffer.from(data.content, 'base64').toString('utf8'), sha: data.sha };
  } catch (error: unknown) {
    // 404 covers both a missing file and a missing branch — either way this
    // store has no record at that path, which is not an error.
    if (errorStatus(error) === 404) return null;
    throw error;
  }
}

/**
 * One record, preferring this branch and falling back to the default branch.
 *
 * The order is load-bearing, not a nicety: appending to a batch whose only copy
 * is a legacy default-branch file writes the merged record HERE, so from that
 * moment two files share one path on two refs. Preferring this branch is what
 * makes the merged record the one every reader resolves.
 */
export async function readEvidenceFile(gh: Octokit, repo: RepoRef, path: string): Promise<StoredEvidenceFile | null> {
  const onBranch = await getFileAt(gh, repo, path, EVIDENCE_BRANCH);
  if (onBranch) return { ...onBranch, ref: EVIDENCE_BRANCH };
  const legacy = await getFileAt(gh, repo, path, undefined);
  return legacy ? { content: legacy.content, sha: null, ref: 'default' } : null;
}

export interface EnsureEvidenceBranchResult {
  created: boolean;
}

/**
 * The branch, created if absent — an ORPHAN root commit holding only the README.
 *
 * Self-healing on purpose. `init` creates the branch (and its protection
 * ruleset), but a repository initialized before GHI #134 has neither, and the
 * first thing that would notice is a refused record — the same silent failure
 * this fix exists to end. Both writers hold `contents: write`, and this branch
 * is covered by no required-check rule, so either can create it and converge.
 * Protection still needs an admin credential: `init --verify` reports it (I7).
 *
 * A concurrent creator (init and a dashboard write racing) loses the createRef
 * with 422 and reports `created: false` — the branch exists, which is all the
 * caller needed.
 */
export async function ensureEvidenceBranch(gh: Octokit, repo: RepoRef): Promise<EnsureEvidenceBranchResult> {
  try {
    await gh.git.getRef({ ...repo, ref: `heads/${EVIDENCE_BRANCH}` });
    return { created: false };
  } catch (error: unknown) {
    if (errorStatus(error) !== 404) throw error;
  }

  // No `base_tree`, no `parents`: an orphan root commit. The branch shares no
  // history with the default branch, so it can never be merged into it and a
  // pull request opened from it by accident has nothing to revert.
  const { data: tree } = await gh.git.createTree({
    ...repo,
    tree: [{ path: `${EVIDENCE_DIR}/README.md`, mode: '100644', type: 'blob', content: BRANCH_README }],
  });
  const { data: commit } = await gh.git.createCommit({
    ...repo,
    message: 'evidence: start the append-only record store',
    tree: tree.sha,
    parents: [],
  });
  try {
    await gh.git.createRef({ ...repo, ref: `refs/heads/${EVIDENCE_BRANCH}`, sha: commit.sha });
  } catch (error: unknown) {
    if (errorStatus(error) === 422) return { created: false }; // someone else got there first
    throw error;
  }
  return { created: true };
}

/**
 * Commit one record to the store, creating the branch if it is not there yet.
 *
 * `sha` is the blob being replaced ON THIS BRANCH (`readEvidenceFile` supplies
 * it); omitted, this creates the file. Passing a default-branch sha would be
 * rejected, which is why the read models that as `null`.
 */
export async function commitEvidenceFile(
  gh: Octokit,
  repo: RepoRef,
  input: { path: string; content: string; message: string; sha?: string | null },
): Promise<{ commitSha: string | undefined }> {
  await ensureEvidenceBranch(gh, repo);
  const { data } = await gh.repos.createOrUpdateFileContents({
    ...repo,
    path: input.path,
    message: input.message,
    content: Buffer.from(input.content).toString('base64'),
    branch: EVIDENCE_BRANCH,
    ...(input.sha ? { sha: input.sha } : {}),
  });
  return { commitSha: data.commit.sha };
}
