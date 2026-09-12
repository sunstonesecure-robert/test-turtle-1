import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import type { Octokit } from '@octokit/rest';
import type { RepoRef } from '../dashboard/lib/github/client';
import { errorStatus } from '../dashboard/lib/github/errors';
import { TOOLCHAIN_DIRS, TEMPLATE_DIRS, TOOLCHAIN_FILES, RETIRED_TEMPLATES } from './install-manifest';

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
/** The retirement list (GHI #228) is a manifest fact for the same reason the rest are —
 *  it says what a governed repo carries, this time by saying what it must NOT. Re-exported
 *  on its own line, like the namespace helpers below, because the drift guard in
 *  `tests/unit/dashboard-bundle-boundary.test.ts` pins the line above verbatim. */
export { RETIRED_TEMPLATES } from './install-manifest';
/** The subject-workflow namespace (GHI #174 C′, FR-069) lives in the manifest for the
 *  same reason: it is a manifest property (disjoint from what init installs), and the
 *  dashboard bundle reads it through `reserved-paths`. Re-exported on its own line so
 *  the drift guard in `tests/unit/dashboard-bundle-boundary.test.ts`, which pins the
 *  line above verbatim, keeps holding. */
export { SUBJECT_WORKFLOW_SLUG_RE, subjectWorkflowRe, isSubjectWorkflowPath } from './install-manifest';

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
 * `init` must never install INTO A SUBJECT-WORKFLOW NAMESPACE (GHI #174 C′, FR-069).
 *
 * The reserved-path set carves `.github/workflows/<workload-slug>_<name>.yml` out of
 * `.github/**` on the strength of one invariant: nothing `init` installs can be in
 * ANY workload's namespace, because no installed template's basename contains `_`. The
 * product's own tests assert that (`tests/unit/subject-workflow-namespace.test.ts`),
 * but a test guards the product repo, not the checkout `npm run init` is actually run
 * from — so the installer refuses too. Refusing here, before any tree is built, is
 * what makes "namespace first, then the list" in `isReservedPath` safe: an installed
 * file could otherwise be un-reserved by its own name and an agent build could
 * overwrite it.
 *
 * THE RULE IS THE UNDERSCORE, AND IT HAS TO BE (T279). The namespace check this used to
 * ALSO run needed a slug, and the installer has none: `init` vendors one file set into a
 * repository that may hold any number of workloads, none of which exist yet at install
 * time. So the slug-shaped question is unanswerable here — and unnecessary, because the
 * `_` rule is strictly stronger than every namespace at once. A slug can never contain
 * `_` (`SUBJECT_WORKFLOW_SLUG_RE`), so `<slug>_<name>.yml` always contains one, so a
 * basename with no `_` is outside every namespace for every slug, present and future.
 * That is the whole disjointness argument, and it is why dropping the slug-dependent
 * half of this check loses nothing: the half that remains is the half that was doing
 * the work. It is also broader than any regex — a template named `sub_ject.yml` would
 * match no namespace and still erode the convention the gates read by eye.
 */
function refuseIfInsideSubjectNamespace(targetPath: string, sourcePath: string): void {
  const basename = targetPath.slice(targetPath.lastIndexOf('/') + 1);
  if (basename.includes('_')) {
    throw new Error(
      `init refuses to install ${sourcePath} as ${targetPath}: installed template names are kebab-case and never ` +
        'contain `_`, because `.github/workflows/<workload-slug>_<name>.yml` is the namespace reserved for the ' +
        'operator’s own deploy workflows (delivered by agent builds, judged by D6) and the two must stay disjoint. ' +
        'Rename the template.',
    );
  }
}

/**
 * `init` must never INSTALL a path it also RETIRES (GHI #228).
 *
 * One `createTree` cannot both write and delete the same path: the two entries would
 * resolve by whichever came last in the array, so the manifest would decide the outcome
 * by accident of ordering. The realistic way in is a retirement that is later reversed —
 * the template comes back under its old name and the retirement line is forgotten — and
 * the symptom would be a file that installs, deletes, or flickers depending on nothing an
 * operator can see. Refuse it here, before any tree is built, exactly as the subject-
 * namespace rule above does.
 */
function refuseIfRetired(targetPath: string, sourcePath: string): void {
  const retired = RETIRED_TEMPLATES.find((r) => r.path === targetPath);
  if (retired) {
    throw new Error(
      `init refuses to install ${sourcePath} as ${targetPath}: that path is in RETIRED_TEMPLATES ` +
        `(retired ${retired.retired}) and every init DELETES it from the target. A path cannot be both ` +
        'installed and retired. Remove the retirement entry if the template is genuinely back, or give ' +
        'the new template a different name.',
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
      refuseIfRetired(target, relative(productRoot, file));
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
  /** Retired templates this install actually REMOVED from the target (GHI #228) —
   *  empty on a target that never had them, and empty on every run after the first. */
  deletedPaths: string[];
}

/**
 * Which retired templates this target still carries — asked of the target's tree, one
 * 404-tolerant probe per entry.
 *
 * ASKED RATHER THAN ASSUMED, because `createTree` is not forgiving of a delete entry for
 * a path that is not in `base_tree`, and because emitting one unconditionally would make
 * EVERY init produce a new tree and therefore a new commit — destroying the tree-SHA
 * idempotency the installer's whole contract rests on. Probing keeps both properties: a
 * target that has already been cleaned yields no entries, so its tree is unchanged and
 * nothing is committed.
 *
 * The list is tiny by construction (one entry today), so this is a per-path probe rather
 * than a recursive tree read — which would be a single call but is truncated at 100,000
 * entries, and a governed LZA repository is exactly the shape that approaches such a limit.
 */
export async function retiredPathsPresent(gh: Octokit, repo: RepoRef, ref: string): Promise<string[]> {
  const present: string[] = [];
  for (const { path } of RETIRED_TEMPLATES) {
    try {
      await gh.repos.getContent({ ...repo, path, ref });
      present.push(path);
    } catch (error: unknown) {
      // 404 is the ordinary answer: the target never had it, or a previous init
      // removed it. Anything else is a real failure and must not read as "absent".
      if (errorStatus(error) !== 404) throw error;
    }
  }
  return present;
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

  // The retirement half (GHI #228). `sha: null` is the API's delete form — the one
  // shape this installer could not previously express, which is why removing a
  // template from the product removed it from no target that had already been
  // initialised.
  const deletedPaths = await retiredPathsPresent(gh, repo, headSha);

  const { data: tree } = await gh.git.createTree({
    ...repo,
    base_tree: headCommit.tree.sha,
    tree: [
      ...[...files.entries()].map(([path, content]) => ({
        path,
        mode: '100644' as const,
        type: 'blob' as const,
        content,
      })),
      ...deletedPaths.map((path) => ({
        path,
        mode: '100644' as const,
        type: 'blob' as const,
        sha: null,
      })),
    ],
  });

  // Idempotency: identical content dedupes to the head's own tree — nothing to commit.
  if (tree.sha === headCommit.tree.sha) {
    return { committed: false, fileCount: files.size, deletedPaths: [] };
  }

  const { data: commit } = await gh.git.createCommit({
    ...repo,
    message:
      deletedPaths.length > 0
        ? `oversight: install/update framework files (init); retire ${deletedPaths.join(', ')}`
        : 'oversight: install/update framework files (init)',
    tree: tree.sha,
    parents: [headSha],
  });
  await gh.git.updateRef({ ...repo, ref: `heads/${branch}`, sha: commit.sha });
  return { committed: true, fileCount: files.size, commitSha: commit.sha, deletedPaths };
}
