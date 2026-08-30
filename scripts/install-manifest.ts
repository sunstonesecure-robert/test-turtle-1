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

/**
 * THE SUBJECT-WORKFLOW NAMESPACE (GHI #174 option C′, FR-069, T270).
 *
 * `.github/workflows/` holds two kinds of thing GitHub cannot tell apart and this
 * product must: the oversight machinery `init` installs from `templates/workflows/`
 * (MANAGEMENT action content — kebab-case, never containing `_`), and the operator's
 * own CI/CD for the software the agents build (governed product OUTPUT action
 * content — a "subject workflow"). GitHub runs workflows only from that one
 * directory, so a deploy workflow cannot be relocated out of the reserved set; the
 * north-star deliverable (an agent builds the LZA config, the CDK, AND the workflow
 * that deploys them) was unreachable by design until the two kinds were separable
 * by NAME.
 *
 * This regex is the single source of truth for that separation. It lives here, in
 * the install manifest, because the property it rests on is a manifest property:
 * no installed template's basename contains `_`, so the namespaces are DISJOINT BY
 * CONSTRUCTION — asserted at product build time by
 * `tests/unit/subject-workflow-namespace.test.ts` and refused at install time by
 * `collectInstallFiles`. The reserved-path set (`scripts/gates/lib/reserved-paths.ts`)
 * carves the namespace out of `.github/**`; there is no knob to move the prefix and
 * no API to widen the carve-out. Lowercase only, no dots or extra underscores in the
 * name, so `subject_x.lock.yml` (a compiled agentic lock is machinery), `Subject_x.yml`,
 * `subject_.yml` and `.github/workflows/sub/subject_x.yml` are all OUTSIDE the
 * namespace and therefore still reserved.
 *
 * What a subject workflow may CONTAIN is a separate question, answered by the D6
 * content guards (`scripts/gates/lib/checks-subject-workflow.ts`); this module only
 * says which files the question is asked of.
 */
export const SUBJECT_WORKFLOW_RE = /^\.github\/workflows\/subject_[a-z0-9][a-z0-9-]*\.ya?ml$/;

/** The `normalizePath` trimming from `scripts/gates/lib/globs.ts`, restated rather
 *  than imported so this module keeps its no-imports promise (see the module
 *  docblock: it is bundled into the dashboard). Forward slashes, no leading `./` or
 *  `/`, no doubled separators. */
function normalizeForNamespace(path: string): string {
  return path.trim().replace(/\\/g, '/').replace(/^\.\//, '').replace(/^\/+/, '').replace(/\/+/g, '/');
}

/** Is this ONE PATH a subject workflow — i.e. inside the namespace? Normalizes the
 *  way every gate does before asking, so `./.github/workflows/subject_x.yml` and the
 *  bare form answer alike. */
export function isSubjectWorkflowPath(path: string): boolean {
  return SUBJECT_WORKFLOW_RE.test(normalizeForNamespace(path));
}

/**
 * The scope globs G16 accepts as "aimed at the namespace and nothing else" — EXACT
 * strings after normalization. A plan step that wants to deliver a subject workflow
 * declares one of these (or the exact file path). Any other glob under `.github/`
 * — `.github/workflows/*.yml`, `.github/**`, `.github/workflows/subject_*.lock.yml`,
 * and the bare `.github/workflows/subject_*` — reaches the reserved set and is refused,
 * because a glob cannot be proven to stay inside the namespace by inspection and G16
 * refuses what it cannot prove.
 *
 * THE RESIDUAL, STATED (Codex P2 on PR #175, 2026-08-30). Even `subject_*.yml` is wider
 * than `SUBJECT_WORKFLOW_RE`: the glob matcher lets `*` span `x.lock`, so
 * `subject_x.lock.yml` and `subject_X.yml` sit INSIDE the accepted scope and OUTSIDE
 * the namespace. G16 cannot enumerate the files a step will one day write, so such a
 * file is refused where it appears — at delivery, by `build-publish` and D5, as
 * reserved, with the naming rule named. The bare `subject_*` glob was dropped because
 * it widened that residual to every extension for no reason a plan could want.
 */
export const SUBJECT_WORKFLOW_SCOPE_GLOBS = ['.github/workflows/subject_*.yml', '.github/workflows/subject_*.yaml'] as const;

/** Is this ONE SCOPE GLOB confined to the namespace? True for an exact namespace
 *  path or one of `SUBJECT_WORKFLOW_SCOPE_GLOBS`, nothing else. */
export function isSubjectWorkflowScope(glob: string): boolean {
  const g = normalizeForNamespace(glob);
  return isSubjectWorkflowPath(g) || (SUBJECT_WORKFLOW_SCOPE_GLOBS as readonly string[]).includes(g);
}
