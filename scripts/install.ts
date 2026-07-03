import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import type { Octokit } from '@octokit/rest';
import type { RepoRef } from '../dashboard/lib/github/client';

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

/** Directories vendored recursively + single files, all relative to the product root. */
const TOOLCHAIN_DIRS = ['schemas', 'scripts', 'dashboard/lib'] as const;
const TOOLCHAIN_FILES = [
  'package.json',
  'package-lock.json',
  'tsconfig.json',
  'tsconfig.base.json',
  'dashboard/package.json',
  'dashboard/tsconfig.json',
] as const;

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else out.push(full);
  }
  return out;
}

/** target-repo path → file content, from the local product checkout. */
export function collectInstallFiles(productRoot: string = PRODUCT_ROOT): Map<string, string> {
  const files = new Map<string, string>();
  for (const templateDir of ['workflows', 'ISSUE_TEMPLATE'] as const) {
    const src = join(productRoot, 'templates', templateDir);
    for (const file of walk(src)) {
      files.set(`.github/${templateDir}/${relative(src, file)}`, readFileSync(file, 'utf8'));
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
