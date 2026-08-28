/**
 * WHAT `init` VENDORS — the manifest, and nothing else.
 *
 * Split out of `install.ts` deliberately. The manifest is the single statement of
 * one fact with two consumers that could not be further apart: the installer, which
 * reads the filesystem and talks to GitHub, and the RESERVED path set
 * (`scripts/gates/lib/reserved-paths.ts`, FR-068), which derives "what an agent build
 * may not touch" from "what init installs" so the two cannot drift.
 *
 * That second consumer is reached from the dashboard (`dashboard/lib/gate-preview.ts`
 * → `checks-scope` → `reserved-paths`), which webpack bundles for the browser. Left
 * in `install.ts`, the constants dragged `node:fs`, `@octokit/rest` and an
 * `import.meta.url` asset reference into that bundle — the build failed with
 * `Module not found: Can't resolve '..'` pointing at the installer's `PRODUCT_ROOT`.
 * Constants only here, no imports and no side effects: the derivation stays honest
 * and the dashboard stays buildable.
 */

/** Directories vendored recursively, relative to the product root. */
/** Exported so the drift guard can assert what is vendored rather than restate it
 *  (`tests/unit/vendored-toolchain.test.ts`, GHI #143): these directories are
 *  globed wholesale, so a new cross-boundary import joins every governed repo
 *  automatically — the guard is what notices. */
export const TOOLCHAIN_DIRS = ['schemas', 'scripts', 'dashboard/lib', 'executors'] as const;

/** Product-side `templates/<dir>` walked into the target's `.github/<dir>`. */
export const TEMPLATE_DIRS = ['workflows', 'ISSUE_TEMPLATE'] as const;

/** Where those template directories LAND in a governed repo — the reserved-path
 *  set needs the target-side paths, not the product-side ones, and deriving them
 *  from `TEMPLATE_DIRS` keeps the two from drifting (FR-068). */
export const INSTALLED_TEMPLATE_DIRS = TEMPLATE_DIRS.map((d) => `.github/${d}`);

/** Single files vendored verbatim. Exported for the same reason as
 *  `TOOLCHAIN_DIRS` (T237): the reserved path set DERIVES from this manifest
 *  rather than restating it, so a file added here becomes off-limits to every
 *  agent build with no second edit (`scripts/gates/lib/reserved-paths.ts`,
 *  FR-068). */
export const TOOLCHAIN_FILES = [
  'package.json',
  'package-lock.json',
  'tsconfig.json',
  'tsconfig.base.json',
  'dashboard/package.json',
  'dashboard/tsconfig.json',
] as const;
