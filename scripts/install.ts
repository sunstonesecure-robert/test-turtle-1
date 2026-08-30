import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import type { Octokit } from '@octokit/rest';
import type { RepoRef } from '../dashboard/lib/github/client';
import { TOOLCHAIN_DIRS, TEMPLATE_DIRS, TOOLCHAIN_FILES, SUBJECT_WORKFLOW_RE } from './install-manifest';

/**
 * Product/target install step (T178, research.md "Product/target split"):
 * vendors the governed-repo artifacts from this product checkout into the
 * TARGET repo as ONE git-tree commit —
 *   templates/workflows/*      → .github/workflows/*
 *   templates/ISSUE_TEMPLATE/* → .github/ISSUE_TEMPLATE/*
 *   gate toolchain             → same paths (package manifests, schemas/,
 *                                scripts/, dashboard/lib + manifests)
 * Idempotent by tree-SHA equality: an unchanged file set produces the same
 * tree as the target's head and no commit is created.
 */

const PRODUCT_ROOT = resolve(new URL('..', import.meta.url).pathname);

/** The manifest of what `init` vendors lives in its own import-free module so the
 *  reserved-path set can derive from it without pulling this installer (and
 *  `node:fs`, Octokit, `import.meta.url`) into the dashboard's browser bundle.
 *  Re-exported here because callers have always read it from `scripts/install`. */
export { TOOLCHAIN_DIRS, TEMPLATE_DIRS, INSTALLED_TEMPLATE_DIRS, TOOLCHAIN_FILES } from './install-manifest';
/** The subject-workflow namespace (GHI #174 C′, FR-069) lives in the manifest for the
 *  same reason: it is a manifest property (disjoint from what init installs), and the
 *  dashboard bundle reads it through `reserved-paths`. Re-exported on its own line so
 *  the drift guard in `tests/unit/dashboard-bundle-boundary.test.ts`, which pins the
 *  line above verbatim, keeps holding. */
export { SUBJECT_WORKFLOW_RE, isSubjectWorkflowPath } from './install-manifest';

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else out.push(full);
  }
  return out;
}

/**
 * `init` must never install INTO the subject-workflow namespace (GHI #174 C′, FR-069).
 *
 * The reserved-path set carves `.github/workflows/subject_<name>.yml` out of
 * `.github/**` on the strength of one invariant: nothing `init` installs can be in
 * the namespace, because no installed template's basename contains `_`. The product's
 * own tests assert that (`tests/unit/subject-workflow-namespace.test.ts`), but a test
 * guards the product repo, not the checkout `npm run init` is actually run from — so
 * the installer refuses too. Refusing here, before any tree is built, is what makes
 * "namespace first, then the list" in `isReservedPath` safe: an installed file could
 * otherwise be un-reserved by its own name and an agent build could overwrite it.
 *
 * The `_` rule is the broader of the two on purpose. `SUBJECT_WORKFLOW_RE` is what
 * the gates read; the no-underscore convention is what keeps the two namespaces
 * separable by eye, and a template named `sub_ject.yml` that happened to miss the
 * regex would still erode it.
 */
function refuseIfInsideSubjectNamespace(targetPath: string, sourcePath: string): void {
  const basename = targetPath.slice(targetPath.lastIndexOf('/') + 1);
  if (SUBJECT_WORKFLOW_RE.test(targetPath) || basename.includes('_')) {
    throw new Error(
      `init refuses to install ${sourcePath} as ${targetPath}: installed template names are kebab-case and never ` +
        'contain `_`, because `.github/workflows/subject_<name>.yml` is the namespace reserved for the operator’s own ' +
        'deploy workflows (delivered by agent builds, judged by D6) and the two must stay disjoint. Rename the template.',
    );
  }
}

/** target-repo path → file content, from the local product checkout. */
export function collectInstallFiles(productRoot: string = PRODUCT_ROOT): Map<string, string> {
  const files = new Map<string, string>();
  for (const templateDir of TEMPLATE_DIRS) {
    const src = join(productRoot, 'templates', templateDir);
    for (const file of walk(src)) {
      const target = `.github/${templateDir}/${relative(src, file).replace(/\\/g, '/')}`;
      refuseIfInsideSubjectNamespace(target, relative(productRoot, file));
      files.set(target, readFileSync(file, 'utf8'));
    }
  }
  for (const dir of TOOLCHAIN_DIRS) {
    for (const file of walk(join(productRoot, dir))) {
      files.set(relative(productRoot, file), readFileSync(file, 'utf8'));
    }
  }
  for (const file of TOOLCHAIN_FILES) {
    files.set(file, readFileSync(join(productRoot, file), 'utf8'));
  }
  return files;
}

export interface InstallResult {
  committed: boolean;
  fileCount: number;
  commitSha?: string;
}

export async function installOversightFiles(
  gh: Octokit,
  repo: RepoRef,
  opts: { branch?: string; productRoot?: string } = {},
): Promise<InstallResult> {
  const branch = opts.branch ?? 'main';
  const files = collectInstallFiles(opts.productRoot);

  const { data: headRef } = await gh.git.getRef({ ...repo, ref: `heads/${branch}` });
  const headSha = headRef.object.sha;
  const { data: headCommit } = await gh.git.getCommit({ ...repo, commit_sha: headSha });

  const { data: tree } = await gh.git.createTree({
    ...repo,
    base_tree: headCommit.tree.sha,
    tree: [...files.entries()].map(([path, content]) => ({
      path,
      mode: '100644' as const,
      type: 'blob' as const,
      content,
    })),
  });

  // Idempotency: identical content dedupes to the head's own tree — nothing to commit.
  if (tree.sha === headCommit.tree.sha) {
    return { committed: false, fileCount: files.size };
  }

  const { data: commit } = await gh.git.createCommit({
    ...repo,
    message: 'oversight: install/update framework files (init)',
    tree: tree.sha,
    parents: [headSha],
  });
  await gh.git.updateRef({ ...repo, ref: `heads/${branch}`, sha: commit.sha });
  return { committed: true, fileCount: files.size, commitSha: commit.sha };
}
