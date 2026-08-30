import {
  TOOLCHAIN_DIRS,
  TOOLCHAIN_FILES,
  INSTALLED_TEMPLATE_DIRS,
  isSubjectWorkflowPath,
  isSubjectWorkflowScope,
} from '../../install-manifest';
import { matchesAny, normalizePath, isRepoRelative } from './globs';

/**
 * THE RESERVED PATH SET (T238, FR-068) — what a plan may not aim at and a
 * deliverable may not touch.
 *
 * WHY THIS EXISTS. A governed repo holds two different kinds of thing on one
 * default branch: the operator's own software, which is what plans are ABOUT, and
 * the oversight machinery plus the governance record, which is what GOVERNS plans.
 * `init` puts the second kind there by design (the product/target split), so
 * nothing about the file layout distinguishes instrument from subject. Without an
 * assertion, an agent planning against that checkout sees the machinery first and
 * plans against it — which is not hypothetical: the first agent build here to clear
 * every gate wrote its work into `dashboard/lib/` and `page.tsx`, the installed
 * dashboard, and D1–D4 as specified would all have reported green (GHI #141).
 *
 * WHY IT IS DERIVED AND NOT LISTED. `collectInstallFiles` globs DIRECTORIES. A list
 * restated here would go stale the first time a new directory is vendored, and the
 * failure mode is a permanently-open hole nobody notices — the same asymmetry
 * `tests/unit/vendored-toolchain.test.ts` exists to close (T237, which is why
 * `TOOLCHAIN_DIRS` is exported in the first place). So the set is computed from the
 * installer's own manifest: whatever `init` installs is, by construction, reserved.
 *
 * WHAT THE SET IS. `installed ∪ governance record ∪ (.github/** minus the
 * subject-workflow namespace)`. The subtraction is the ONE structural exception
 * (GHI #174 option C′, FR-069, 2026-08-29), and it is a product convention rather
 * than a configuration: `.github/workflows/subject_<name>.yml` is where the operator's
 * OWN deploy workflows live — the software the agents build, not the machinery that
 * judges it — and GitHub runs workflows from nowhere else, so the platform fixes the
 * path. The namespace is disjoint from what `init` installs by construction (no
 * installed template's basename contains `_`; asserted at product build time in
 * `tests/unit/subject-workflow-namespace.test.ts` and refused at install time by
 * `collectInstallFiles`), so carving it out removes NO installed file from the set.
 *
 * WHY IT CANNOT BE SHRUNK. There is STILL no configuration knob and no subtract API.
 * A denylist configuration can weaken is not a control — the same escalation-only
 * argument FR-062 makes about merge authority, applied to paths. The namespace is
 * not a knob: its prefix is fixed in the install manifest, nothing at runtime can
 * move it or widen it, and an operator who wants the namespace reserved TOO may say
 * so through `withExtraReserved` — the one direction that is legitimate, an operator
 * adding their own protected areas.
 *
 * LIST VERSUS DECISION. `reservedPaths()` is the LIST — what the set is made of, kept
 * for tests and for anyone who needs to print it. The reserved DECISION is the
 * predicate `isReservedPath`, and every question this module answers
 * (`reservedPathsTouched`, `scopeReachesReserved`) goes through the predicate, because
 * the namespace carve-out cannot be expressed as a list entry: `.github/**` stays in
 * the list and the predicate is what knows a path matching the namespace is not
 * reserved by virtue of `.github/**` or `.github/workflows` alone.
 *
 * WHO ASKS. Two gates, one module, deliberately: `plan-gate` **G16** asks it of a
 * step's DECLARED scope (cheap, refuses before anyone is asked to approve a
 * self-modification), and `deliverable-gate` **D5** asks it of the patch's ACTUAL
 * paths (load-bearing — it holds when the plan is wrong, when the step declares no
 * scope at all, and when the executor misreports which step it built). D5 never
 * consults the declared scope: D2 already asks the allowlist question, and a plan
 * aimed at the wrong subject answers that one perfectly. A subject workflow passes
 * both — and is then judged on its CONTENT by D6, and always waits for the operator's
 * own merge (D3 by path class, GHI #163 option 3).
 */

/**
 * The governance record — the paths the oversight machinery reads as TRUTH.
 *
 * Not installed by `init` (they accumulate as the system runs), so they cannot be
 * derived from the manifest and are the one part of this set written down. Each is
 * here because a build that could write it could forge the thing it was judged by:
 *
 *   plans/**          the frozen plan documents. A deliverable that edits a plan
 *                     rewrites what it was approved against (FR-007).
 *   confirmations/**  external authority sign-offs. A build that could write one
 *                     could manufacture a clinician's or a lawyer's answer (FR-024).
 *   evidence/**       the append-only audit record (FR-021, GHI #134).
 *   runs/**           the run pointers the monitor reads (FR-031).
 */
export const GOVERNANCE_RECORD_PATHS = ['plans/**', 'confirmations/**', 'evidence/**', 'runs/**'] as const;

/**
 * `.github/` beyond what init installs.
 *
 * The manifest covers `.github/workflows/**` and `.github/ISSUE_TEMPLATE/**`
 * because those are what `init` writes. The rest of `.github/` — `CODEOWNERS`,
 * `dependabot.yml`, action definitions — is not installed and so is not derived,
 * but it is repository CONTROL surface all the same: a deliverable that adds a
 * CODEOWNERS entry or an unpinned composite action has changed who reviews and what
 * runs, which is the same class of act as editing a workflow. Reserved wholesale,
 * because the cost of being wrong here is asymmetric — with the one carve-out the
 * predicate below applies, the subject-workflow namespace (FR-069).
 */
export const REPOSITORY_CONTROL_PATHS = ['.github/**'] as const;

/**
 * The full reserved set AS A LIST: what `init` installs ∪ the governance record ∪ the
 * rest of the repository's control surface ∪ whatever the operator added.
 *
 * A function rather than a constant so the derivation is re-evaluated (and so tests
 * can prove it derives — extend `TOOLCHAIN_DIRS` and this grows with no edit here).
 *
 * This is the LIST, not the DECISION. The subject-workflow namespace is carved out
 * of `.github/**` by `isReservedPath`, not by an entry here — a list cannot say
 * "everything under X except Y". Ask the predicate, never match this list directly.
 */
export function reservedPaths(extra: readonly string[] = []): string[] {
  const installed = [
    // Vendored directories: `schemas`, `scripts`, `dashboard/lib`. Bare directory
    // names, which the matcher reads as "this directory and everything under it".
    ...TOOLCHAIN_DIRS,
    // Vendored files: the package manifests and tsconfigs the whole toolchain runs on.
    ...TOOLCHAIN_FILES,
    // Where the templates land in the target: `.github/workflows`, `.github/ISSUE_TEMPLATE`.
    ...INSTALLED_TEMPLATE_DIRS,
  ];
  return [...installed, ...GOVERNANCE_RECORD_PATHS, ...REPOSITORY_CONTROL_PATHS, ...extra];
}

/**
 * Additive only (FR-068(d)). The operator's own protected areas may JOIN the set;
 * nothing removes from it. There is deliberately no counterpart to this function.
 *
 * This includes the namespace: an operator who lists
 * `.github/workflows/subject_*.yml` here has reserved it, and the predicate honours
 * that — the carve-out yields to `extra`, never the other way round.
 */
export function withExtraReserved(extra: readonly string[]): string[] {
  return reservedPaths(extra);
}

/**
 * THE RESERVED DECISION. Is this one path reserved?
 *
 * Order matters and is the whole design: a path inside the subject-workflow
 * namespace is NOT reserved by virtue of `.github/workflows` or `.github/**` alone —
 * those two entries are what the namespace is carved out of — but it IS reserved if
 * the operator's `extra` reaches it. Installed files never need the order question
 * answered: none can be in the namespace (disjoint by construction, see the module
 * docblock), so "namespace first, then the list" cannot un-reserve anything `init`
 * wrote. If that invariant ever broke, `collectInstallFiles` would have refused to
 * install and the product's own tests would be red before it did.
 */
export function isReservedPath(path: string, extra: readonly string[] = []): boolean {
  if (isSubjectWorkflowPath(path)) return matchesAny(path, extra, true);
  return matchesAny(path, reservedPaths(extra), true);
}

/**
 * Which of these paths are reserved — the refusal's own list.
 *
 * Returns the offending paths rather than a boolean because every refusal in this
 * system names them, and a caller that recomputes them will phrase it differently
 * from the gate that decided (the `refusalDetail` lesson, GHI #127). Goes through
 * the predicate so D5 and `isReservedPath` cannot disagree about the namespace.
 */
export function reservedPathsTouched(paths: readonly string[], extra: readonly string[] = []): string[] {
  return paths.filter((p) => isReservedPath(p, extra));
}

/** Does one declared glob reach any of these reserved patterns? The two-direction
 *  question `scopeReachesReserved` documents, factored so it can be asked of the
 *  full set or of `extra` alone. */
function globReaches(g: string, reserved: readonly string[]): boolean {
  // Direction 0: a glob whose FIRST segment is a wildcard (`**/*.yml`, `*.md`) reaches
  // everything by construction — it can match `.github/workflows/plan-gate.yml` while
  // matching none of the representative paths direction 2 tries (which carry no
  // extension). Refused outright: G16 accepts only what it can prove stays out of the
  // reserved set (security review 2026-08-29; the D6.2 `paths:` guard says the same).
  const first = normalizePath(g).split('/')[0] ?? '';
  if (/[*?]/.test(first)) return true;
  // Direction 1: the declared glob names something already reserved.
  if (matchesAny(g.replace(/\*+$/, '').replace(/\/$/, '') || g, reserved, true)) return true;
  if (matchesAny(g, reserved, true)) return true;
  // Direction 2: the declared glob would swallow a reserved location. Compare
  // against a representative concrete path per reserved pattern — the directory
  // itself plus one file inside it — because a glob cannot be matched against a
  // glob, only against paths.
  return reserved.some((r) => {
    const base = r.replace(/\/?\*+$/, '');
    // The declared glob is the pattern here, so it takes the SCOPE reading — a
    // bare `docs` in a scope no longer swallows `docs/lib`, and G16 must agree with
    // D2 about that or a plan could pass one and fail the other.
    return matchesAny(base, [g]) || matchesAny(`${base}/anything`, [g]) || matchesAny(`${base}/nested/anything`, [g]);
  });
}

/**
 * The same question asked of a step's DECLARED scope rather than of real paths
 * (G16). A glob is not a path, so it cannot simply be matched: `dashboard/**`
 * declares an intent to write reserved files without naming one.
 *
 * Two directions, both of which mean the scope reaches the machinery:
 *   - the glob is itself inside the reserved set (`scripts/gates/foo.ts`,
 *     `dashboard/lib/**`), or
 *   - a reserved pattern is inside the glob (`dashboard/**` contains
 *     `dashboard/lib`; `**` contains everything).
 *
 * The second direction is what catches the wide declarations, and it is why this is
 * not `reservedPathsTouched` with a different argument.
 *
 * THE NAMESPACE, AT PROPOSAL. A scope confined to the subject-workflow namespace —
 * an exact `subject_<name>.yml` path or one of `SUBJECT_WORKFLOW_SCOPE_GLOBS`, and
 * nothing else — does NOT reach the reserved set (unless `extra` reaches it: the
 * carve-out yields to the operator, as in `isReservedPath`). Any other glob under
 * `.github/` still reaches: `.github/workflows/*.yml` would swallow `plan-gate.yml`,
 * and `.github/workflows/subject_*.lock.yml` names compiled agentic locks, which are
 * machinery. G16 accepts only what it can prove stays inside the namespace by
 * inspection — an exact string — because a glob it merely BELIEVES stays inside is
 * how an approved scope becomes a licence (the bare-name lesson, Codex on PR #145).
 */
export function scopeReachesReserved(scope: readonly string[], extra: readonly string[] = []): string[] {
  const reserved = reservedPaths(extra);
  return scope.filter((glob) => {
    const g = glob.trim();
    if (g.length === 0) return false;
    // A namespace scope is judged against the operator's additions ONLY — the same
    // order `isReservedPath` applies to a real path, so G16 and D5 agree.
    if (isSubjectWorkflowScope(g)) return globReaches(g, extra);
    return globReaches(g, reserved);
  });
}

/**
 * Where a genuine machinery change belongs — appended to every refusal this module
 * produces (FR-068(e)).
 *
 * A wall is routed around; a redirect is followed. An operator whose gate really is
 * wrong, or whose workflow really does need a step, has a legitimate need, and a
 * refusal that leaves it nowhere to go teaches them to disable the check.
 */
export const PRODUCT_PR_ROUTE =
  'A change to the oversight machinery itself — a gate, a workflow, a schema, the dashboard, the ' +
  'toolchain manifests — is a pull request against the PRODUCT repository (agentic-turtles), reviewed ' +
  'and released, then re-installed here by `npm run init`. It is never an agent build inside a governed ' +
  'repo: a build that edits the controls that judge it is the one thing this system exists to prevent.';

/**
 * The OTHER way out, for the one legitimate reason to want a workflow file in a
 * deliverable (FR-069, GHI #174 C′): the operator's own deploy pipeline. A refusal
 * that only offered the product-PR route would teach an operator whose agent is
 * building their LZA deploy leg that the product forbids it — it does not; it
 * forbids it under the wrong name.
 */
export const SUBJECT_WORKFLOW_ROUTE =
  'The operator’s OWN CI/CD for the software the agents build — validate, synth, deploy — may be delivered ' +
  'as a subject workflow: an operator deploy workflow must be named `.github/workflows/subject_<name>.yml` ' +
  '(lowercase letters, digits and hyphens in the name). Its content is judged by the D6 content guards ' +
  '(read-only repository permissions, OIDC through a protected environment, pinned actions, no secrets, ' +
  'no oversight triggers) and it always waits for the operator’s own merge.';

/** The paths a deliverable may never touch, phrased for a human, with the route out.
 *  When an offending path is under `.github/workflows/`, the refusal also names the
 *  namespace: the likeliest reason an agent wrote a workflow file is that it was
 *  asked to deliver a deploy leg, and there IS a right way to do that. */
export function reservedRefusalDetail(offending: readonly string[], subject = 'the patch'): string {
  const underWorkflows = offending.some((p) => normalizePath(p).startsWith('.github/workflows/'));
  return (
    `${subject} touches ${offending.length} reserved path(s): ${offending.join(', ')} — ` +
    'the installed oversight machinery and the governance record, which are what JUDGE this build ' +
    `rather than what it builds (FR-068). ${PRODUCT_PR_ROUTE}` +
    (underWorkflows ? ` ${SUBJECT_WORKFLOW_ROUTE}` : '')
  );
}

/** Re-exported so callers doing path hygiene need one import, not two. */
export { isRepoRelative };
