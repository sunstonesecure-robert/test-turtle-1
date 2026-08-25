import { TOOLCHAIN_DIRS, TOOLCHAIN_FILES, INSTALLED_TEMPLATE_DIRS } from '../../install';
import { matchesAny, pathsInside, isRepoRelative } from './globs';

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
 * WHY IT CANNOT BE SHRUNK. There is no configuration knob and no subtract API. A
 * denylist configuration can weaken is not a control — the same escalation-only
 * argument FR-062 makes about merge authority, applied to paths. `withExtraReserved`
 * exists for the one direction that is legitimate: an operator adding their own
 * protected areas.
 *
 * WHO ASKS. Two gates, one module, deliberately: `plan-gate` **G16** asks it of a
 * step's DECLARED scope (cheap, refuses before anyone is asked to approve a
 * self-modification), and `deliverable-gate` **D5** asks it of the patch's ACTUAL
 * paths (load-bearing — it holds when the plan is wrong, when the step declares no
 * scope at all, and when the executor misreports which step it built). D5 never
 * consults the declared scope: D2 already asks the allowlist question, and a plan
 * aimed at the wrong subject answers that one perfectly.
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
 * because the cost of being wrong here is asymmetric.
 */
export const REPOSITORY_CONTROL_PATHS = ['.github/**'] as const;

/**
 * The full reserved set: what `init` installs ∪ the governance record ∪ the rest of
 * the repository's control surface.
 *
 * A function rather than a constant so the derivation is re-evaluated (and so tests
 * can prove it derives — extend `TOOLCHAIN_DIRS` and this grows with no edit here).
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
 */
export function withExtraReserved(extra: readonly string[]): string[] {
  return reservedPaths(extra);
}

/** Is this one path reserved? */
export function isReservedPath(path: string, extra: readonly string[] = []): boolean {
  return matchesAny(path, reservedPaths(extra));
}

/**
 * Which of these paths are reserved — the refusal's own list.
 *
 * Returns the offending paths rather than a boolean because every refusal in this
 * system names them, and a caller that recomputes them will phrase it differently
 * from the gate that decided (the `refusalDetail` lesson, GHI #127).
 */
export function reservedPathsTouched(paths: readonly string[], extra: readonly string[] = []): string[] {
  return pathsInside(paths, reservedPaths(extra));
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
 */
export function scopeReachesReserved(scope: readonly string[], extra: readonly string[] = []): string[] {
  const reserved = reservedPaths(extra);
  return scope.filter((glob) => {
    const g = glob.trim();
    if (g.length === 0) return false;
    // Direction 1: the declared glob names something already reserved.
    if (matchesAny(g.replace(/\*+$/, '').replace(/\/$/, '') || g, reserved)) return true;
    if (matchesAny(g, reserved)) return true;
    // Direction 2: the declared glob would swallow a reserved location. Compare
    // against a representative concrete path per reserved pattern — the directory
    // itself plus one file inside it — because a glob cannot be matched against a
    // glob, only against paths.
    return reserved.some((r) => {
      const base = r.replace(/\/?\*+$/, '');
      return matchesAny(base, [g]) || matchesAny(`${base}/anything`, [g]) || matchesAny(`${base}/nested/anything`, [g]);
    });
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

/** The paths a deliverable may never touch, phrased for a human, with the route out. */
export function reservedRefusalDetail(offending: readonly string[], subject = 'the patch'): string {
  return (
    `${subject} touches ${offending.length} reserved path(s): ${offending.join(', ')} — ` +
    'the installed oversight machinery and the governance record, which are what JUDGE this build ' +
    `rather than what it builds (FR-068). ${PRODUCT_PR_ROUTE}`
  );
}

/** Re-exported so callers doing path hygiene need one import, not two. */
export { isRepoRelative };
