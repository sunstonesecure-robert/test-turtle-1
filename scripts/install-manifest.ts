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
 * THE SUBJECT-WORKFLOW NAMESPACE — `.github/workflows/<workload-slug>_<name>.yml`
 * (GHI #174 option C′, FR-069, T270; slug-scoped by operator decision 2026-09-01, T279).
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
 * WHY THE PREFIX IS THE WORKLOAD SLUG AND NOT THE LITERAL `subject_`. The literal was
 * never meant to be a literal, and reading it as one cost two things:
 *
 *   1. BLAST RADIUS, PER WORKLOAD. Under one shared prefix ANY workload may deliver
 *      `subject_deploy.yml` — including the name another workload's operator believes
 *      they own, whose deploy leg it would silently replace. Under the slug rule a
 *      workload can write only its own prefix, and the FILENAME RECORDS WHICH
 *      WORKLOAD AUTHORIZED IT: `demo7` owns `demo7_*.yml` and nothing else.
 *   2. A LIVE DEFECT IT FIXES. `listSubjectWorkflows` had no slug to filter on, so the
 *      completion hook for workload A dispatched EVERY `subject_*` workflow in the
 *      repository — including one delivered by workload B, with A's plan ref and
 *      commit as inputs. Scoping the namespace to the slug is what closes that.
 *
 * WHY IT IS STILL SAFE — the SEPARATOR, not the word, was always the mechanism. A slug
 * matches `SUBJECT_WORKFLOW_SLUG_RE` (kebab-case: no `_`, no `.`, no `/`, and no regex
 * metacharacter at all), and no installed template basename contains `_`. So
 * `<slug>_<name>.yml` is disjoint from everything `init` writes BY CONSTRUCTION, for
 * every slug at once — asserted at product build time by
 * `tests/unit/subject-workflow-namespace.test.ts` and refused at install time by
 * `collectInstallFiles`.
 *
 * VALIDATE, NEVER ESCAPE. A slug reaches a regex or a glob only after it has matched
 * `SUBJECT_WORKFLOW_SLUG_RE`; a slug that fails is treated as NO SLUG. Nothing here
 * quotes or escapes a slug, because nothing here ever interpolates an unvalidated one.
 *
 * FAIL CLOSED WHEN THE SLUG IS UNKNOWN. No slug ⇒ the namespace is EMPTY ⇒ every
 * `.github/**` path is reserved, exactly as before the carve-out existed. That is the
 * DEFAULT of every signature in this file and of every predicate derived from them
 * (`scripts/gates/lib/reserved-paths.ts`), so a caller that forgets to thread the slug
 * gets the strict behaviour and never the permissive one.
 *
 * Lowercase only, no dots and no second underscore in the name, so `demo7_x.lock.yml`
 * (a compiled agentic lock is machinery), `Demo7_x.yml`, `demo7_.yml` and
 * `.github/workflows/sub/demo7_x.yml` are all OUTSIDE the namespace and therefore
 * still reserved.
 *
 * What a subject workflow may CONTAIN is a separate question, answered by the D6
 * content guards (`scripts/gates/lib/checks-subject-workflow.ts`); this module only
 * says which files the question is asked of.
 */

/**
 * The workload slug's shape — the SAME shape as `SLUG_RE` in
 * `dashboard/lib/github/workloads.ts`, which is the original.
 *
 * Re-spelled here rather than imported because this module is bundled into the
 * dashboard and keeps a no-imports promise (see the module docblock; the same
 * precedent `schemas/confirmation.ts` sets for the zod mirror of a JSON Schema
 * pattern). Kebab-case, leading `[a-z0-9]`: no underscore, no dot, no slash, no regex
 * metacharacter — which is exactly why a validated slug can be interpolated.
 */
export const SUBJECT_WORKFLOW_SLUG_RE = /^[a-z0-9][a-z0-9-]*$/;

/**
 * What the namespace copy calls the prefix when there is no slug to name.
 *
 * A refusal names this workload's own prefix wherever the slug is known (GHI #127:
 * name the offending thing and the way out). Where it is not — the fail-closed case —
 * copy still has to be followable, so it renders a placeholder that reads as one.
 */
export const SUBJECT_WORKFLOW_SLUG_PLACEHOLDER = '<workload-slug>';

/** A regex that matches nothing at all: an empty negative lookahead always fails.
 *  This is what "no slug ⇒ the namespace is empty" IS, expressed as a value, so an
 *  unknown slug can never yield a regex built from an unvalidated string. */
const NEVER_MATCHES = /(?!)/;

/** The validated slug, or `null` for "no slug" — an absent, non-string, or
 *  `SUBJECT_WORKFLOW_SLUG_RE`-failing value are all the same answer (fail closed). */
function validSlug(slug: string | null | undefined): string | null {
  return typeof slug === 'string' && SUBJECT_WORKFLOW_SLUG_RE.test(slug) ? slug : null;
}

/** The `normalizePath` trimming from `scripts/gates/lib/globs.ts`, restated rather
 *  than imported so this module keeps its no-imports promise (see the module
 *  docblock: it is bundled into the dashboard). Forward slashes, no leading `./` or
 *  `/`, no doubled separators. */
function normalizeForNamespace(path: string): string {
  return path.trim().replace(/\\/g, '/').replace(/^\.\//, '').replace(/^\/+/, '').replace(/\/+/g, '/');
}

/**
 * The namespace regex FOR ONE WORKLOAD — the single source of truth for the
 * separation, now that there is one namespace per workload rather than one in total.
 *
 * Built only from a slug that has already matched `SUBJECT_WORKFLOW_SLUG_RE`; an
 * invalid or absent slug yields `NEVER_MATCHES`, so the caller gets the empty
 * namespace instead of a regex assembled from whatever it was handed.
 */
export function subjectWorkflowRe(slug: string): RegExp {
  const valid = validSlug(slug);
  if (valid === null) return NEVER_MATCHES;
  return new RegExp(`^\\.github/workflows/${valid}_[a-z0-9][a-z0-9-]*\\.ya?ml$`);
}

/**
 * Is this ONE PATH a subject workflow of THIS workload — i.e. inside its namespace?
 * Normalizes the way every gate does before asking, so
 * `./.github/workflows/demo7_x.yml` and the bare form answer alike.
 *
 * `slug` is optional so the fail-closed default is the one a forgetful caller gets:
 * no slug ⇒ no namespace ⇒ `false` for every path ⇒ all of `.github/**` stays
 * reserved. It is never "any workload's namespace".
 */
export function isSubjectWorkflowPath(path: string, slug?: string | null): boolean {
  const valid = validSlug(slug);
  if (valid === null) return false;
  return subjectWorkflowRe(valid).test(normalizeForNamespace(path));
}

/**
 * The scope globs G16 accepts from THIS workload as "aimed at its namespace and
 * nothing else" — EXACT strings after normalization. A plan step that wants to deliver
 * a subject workflow declares one of these (or the exact file path). Any other glob
 * under `.github/` — `.github/workflows/*.yml`, `.github/**`,
 * `.github/workflows/demo7_*.lock.yml`, and the bare `.github/workflows/demo7_*` —
 * reaches the reserved set and is refused, because a glob cannot be proven to stay
 * inside the namespace by inspection and G16 refuses what it cannot prove.
 *
 * An invalid or absent slug yields NO globs: there is nothing to accept when there is
 * no namespace.
 *
 * THE RESIDUAL, STATED (Codex P2 on PR #175, 2026-08-30). Even `demo7_*.yml` is wider
 * than `subjectWorkflowRe('demo7')`: the glob matcher lets `*` span `x.lock`, so
 * `demo7_x.lock.yml` and `demo7_X.yml` sit INSIDE the accepted scope and OUTSIDE the
 * namespace. G16 cannot enumerate the files a step will one day write, so such a file
 * is refused where it appears — at delivery, by `build-publish` and D5, as reserved,
 * with the naming rule named. The bare `demo7_*` glob was dropped because it widened
 * that residual to every extension for no reason a plan could want.
 */
export function subjectWorkflowScopeGlobs(slug: string): readonly string[] {
  const valid = validSlug(slug);
  if (valid === null) return [];
  return [`.github/workflows/${valid}_*.yml`, `.github/workflows/${valid}_*.yaml`];
}

/** Is this ONE SCOPE GLOB confined to THIS workload's namespace? True for an exact
 *  namespace path or one of `subjectWorkflowScopeGlobs(slug)`, nothing else — and
 *  false for everything when the slug is absent or invalid (fail closed). */
export function isSubjectWorkflowScope(glob: string, slug?: string | null): boolean {
  const valid = validSlug(slug);
  if (valid === null) return false;
  const g = normalizeForNamespace(glob);
  return isSubjectWorkflowPath(g, valid) || subjectWorkflowScopeGlobs(valid).includes(g);
}

/**
 * The BASENAME a subject workflow of this workload must carry — `<slug>_<name>.yml`.
 *
 * For COPY, which is why it returns the basename rather than the full path: every
 * refusal and every doc renders it under `.github/workflows/`, and `name` is as often
 * the literal placeholder `<name>` as it is a real one, so neither part is validated
 * here. What IS enforced is the prefix: a refusal names THIS workload's prefix
 * (`demo7_<name>.yml`), never a generic one, because a generic prefix is a name the
 * reader would be refused for using. With no slug to name — the fail-closed case —
 * it renders `SUBJECT_WORKFLOW_SLUG_PLACEHOLDER`, which reads as a placeholder.
 */
export function subjectWorkflowName(slug: string | null | undefined, name: string): string {
  return `${validSlug(slug) ?? SUBJECT_WORKFLOW_SLUG_PLACEHOLDER}_${name}.yml`;
}
