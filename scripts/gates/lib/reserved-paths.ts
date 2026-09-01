import {
  TOOLCHAIN_DIRS,
  TOOLCHAIN_FILES,
  INSTALLED_TEMPLATE_DIRS,
  isSubjectWorkflowPath,
  isSubjectWorkflowScope,
  subjectWorkflowName,
  subjectWorkflowScopeGlobs,
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
 * WHAT THE SET IS. `installed ∪ governance record ∪ (.github/** minus THIS WORKLOAD'S
 * subject-workflow namespace)`. The subtraction is the ONE structural exception
 * (GHI #174 option C′, FR-069, 2026-08-29), and it is a product convention rather
 * than a configuration: `.github/workflows/<workload-slug>_<name>.yml` is where the
 * operator's OWN deploy workflows live — the software the agents build, not the
 * machinery that judges it — and GitHub runs workflows from nowhere else, so the
 * platform fixes the path. The namespace is disjoint from what `init` installs by
 * construction (no installed template's basename contains `_`, and a slug never
 * contains one either; asserted at product build time in
 * `tests/unit/subject-workflow-namespace.test.ts` and refused at install time by
 * `collectInstallFiles`), so carving it out removes NO installed file from the set.
 *
 * THE SUBTRACTION IS PER WORKLOAD, AND EMPTY BY DEFAULT (operator decision 2026-09-01,
 * T279). Every question here takes an optional `slug`, and WITHOUT ONE THE NAMESPACE IS
 * EMPTY: all of `.github/**` is reserved, exactly as before the carve-out existed. That
 * is deliberate and load-bearing — a caller that has not threaded the slug through gets
 * the strict answer, never the permissive one, so forgetting to pass it can only ever
 * refuse work that would have been allowed, never allow work that should be refused.
 * It also bounds the blast radius: workload `demo7` can be told `demo7_deploy.yml` is
 * not reserved, and is still refused `demo8_deploy.yml` — another workload's file.
 *
 * WHY IT CANNOT BE SHRUNK. There is STILL no configuration knob and no subtract API.
 * A denylist configuration can weaken is not a control — the same escalation-only
 * argument FR-062 makes about merge authority, applied to paths. The namespace is
 * not a knob: its shape is fixed in the install manifest, the only thing runtime
 * supplies is WHICH workload is asking (and an unrecognizable answer means "no
 * workload", which reserves MORE, not less), and an operator who wants the namespace
 * reserved TOO may say
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
 * `.github/workflows/demo7_*.yml` here has reserved it, and the predicate honours
 * that — the carve-out yields to `extra`, never the other way round.
 */
export function withExtraReserved(extra: readonly string[]): string[] {
  return reservedPaths(extra);
}

/**
 * What the reserved questions need beyond the path itself.
 *
 * An options object rather than a second and third positional argument, because the
 * two are not interchangeable and a caller must not be able to pass one where the
 * other was meant: `extra` WIDENS the set, `slug` NARROWS it, and a slug landing in
 * the `extra` position (or an `extra` array landing in the slug's) would be the one
 * mistake with a silent, wrong-direction result.
 *
 * BOTH FIELDS ARE OPTIONAL AND BOTH DEFAULT TO THE STRICT ANSWER: no `extra` adds
 * nothing, and no `slug` means the subject-workflow namespace is EMPTY — every
 * `.github/**` path reserved (T279; see the module docblock). Never give `slug` a
 * default value here.
 */
export interface ReservedPathOptions {
  /** the operator's own additional reserved areas (`withExtraReserved`, FR-068(d)) */
  extra?: readonly string[];
  /**
   * WHICH WORKLOAD is asking — its slug, which is the prefix of the one namespace
   * carved out of `.github/**` for it. Absent, `null`, or not a valid slug all mean
   * the same thing: no namespace, nothing carved out. Callers get it from the plan
   * ref wherever one exists (`slugFromPlanRef`), which is the authoritative source.
   */
  slug?: string | null;
}

/**
 * THE RESERVED DECISION. Is this one path reserved?
 *
 * Order matters and is the whole design: a path inside THIS WORKLOAD'S subject-workflow
 * namespace is NOT reserved by virtue of `.github/workflows` or `.github/**` alone —
 * those two entries are what the namespace is carved out of — but it IS reserved if
 * the operator's `extra` reaches it. Installed files never need the order question
 * answered: none can be in any namespace (disjoint by construction, see the module
 * docblock), so "namespace first, then the list" cannot un-reserve anything `init`
 * wrote. If that invariant ever broke, `collectInstallFiles` would have refused to
 * install and the product's own tests would be red before it did.
 *
 * With no `slug` the first branch is unreachable — the fail-closed default — so this
 * answers `true` for every `.github/**` path, including one that would be in some
 * OTHER workload's namespace. That is the correct answer to "may THIS build write
 * this file", which is the only question anyone asks it.
 *
 * A path that does not stay inside the repository is RESERVED, before any of that
 * (security review 2026-09-01, T279). The namespace branch is the only branch that can
 * answer "not reserved", and `isSubjectWorkflowPath` normalizes a leading `/` away — so
 * `/.github/workflows/demo7_x.yml` reads as in-namespace and would come back
 * un-reserved, while `/.github/workflows/plan-gate.yml` stays reserved. That is exactly
 * the class `isRepoRelative` exists to close (see its docblock: "asking `normalizePath`
 * about `/etc/passwd` yields `etc/passwd`, which looks perfectly repo-relative"), and
 * the carve-out must not re-open it. Refused, never repaired: a path outside the
 * checkout has no meaningful answer to "is it in the namespace?", and today only the
 * ORDER of the deliverable gate's checks keeps it from mattering. `subjectWorkflowPaths`
 * already pre-checks the same thing, so this is also what stops the two readers
 * disagreeing about one string.
 */
export function isReservedPath(path: string, opts: ReservedPathOptions = {}): boolean {
  const { extra = [], slug = null } = opts;
  if (!isRepoRelative(path)) return true;
  if (isSubjectWorkflowPath(path, slug)) return matchesAny(path, extra, true);
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
export function reservedPathsTouched(paths: readonly string[], opts: ReservedPathOptions = {}): string[] {
  return paths.filter((p) => isReservedPath(p, opts));
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
 * THE NAMESPACE, AT PROPOSAL. A scope confined to THIS WORKLOAD'S subject-workflow
 * namespace — an exact `<slug>_<name>.yml` path or one of
 * `subjectWorkflowScopeGlobs(slug)`, and nothing else — does NOT reach the reserved set
 * (unless `extra` reaches it: the carve-out yields to the operator, as in
 * `isReservedPath`). Any other glob under `.github/` still reaches:
 * `.github/workflows/*.yml` would swallow `plan-gate.yml`,
 * `.github/workflows/demo7_*.lock.yml` names compiled agentic locks, which are
 * machinery, and `.github/workflows/demo8_*.yml` is ANOTHER WORKLOAD'S namespace —
 * which this plan has no more authority over than it has over the gates (T279).
 * G16 accepts only what it can prove stays inside the namespace by inspection — an
 * exact string — because a glob it merely BELIEVES stays inside is how an approved
 * scope becomes a licence (the bare-name lesson, Codex on PR #145). With no `slug`
 * nothing is confined to a namespace, so every `.github/` glob reaches.
 */
export function scopeReachesReserved(scope: readonly string[], opts: ReservedPathOptions = {}): string[] {
  const { extra = [], slug = null } = opts;
  const reserved = reservedPaths(extra);
  return scope.filter((glob) => {
    const g = glob.trim();
    if (g.length === 0) return false;
    // A namespace scope is judged against the operator's additions ONLY — the same
    // order `isReservedPath` applies to a real path, so G16 and D5 agree.
    if (isSubjectWorkflowScope(g, slug)) return globReaches(g, extra);
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
 *
 * A FUNCTION OF THE SLUG, because the name it offers must be a name this workload can
 * actually use (T279). Telling `demo7` to write `subject_deploy.yml` — or worse,
 * `demo8_deploy.yml` — sends the operator round the loop again through a second
 * refusal, which is precisely the failure GHI #127 named: a route that is not
 * followable teaches people to disable the check. With no slug to name, it renders the
 * `<workload-slug>` placeholder, which reads as one.
 */
export function subjectWorkflowRoute(slug?: string | null): string {
  // The SCOPE half of the way out. This route is appended to two different refusals: D5
  // refuses a PATH, where naming the file rule is the whole answer, and G16 refuses a
  // declared GLOB — where it is not. A planner told only how to NAME the file still has
  // to guess what scope would be accepted, and the accepted scope is now slug-dependent
  // and therefore unguessable (T279). So the sentence names it, built from
  // `subjectWorkflowScopeGlobs` rather than re-spelled, so the accepted set has exactly
  // one spelling. Omitted when there is no slug: with none, no scope IS accepted, and
  // offering a placeholder glob would be a route that cannot be followed (GHI #127).
  const globs = subjectWorkflowScopeGlobs(slug ?? '');
  return (
    'The operator’s OWN CI/CD for the software the agents build — validate, synth, deploy — may be delivered ' +
    `as a subject workflow: an operator deploy workflow must be named \`.github/workflows/${subjectWorkflowName(slug, '<name>')}\` ` +
    '— this workload’s own slug, then `_`, then lowercase letters, digits and hyphens. The prefix is what records ' +
    'which workload authorized the file, and a workload may deliver under no other prefix. ' +
    (globs.length > 0
      ? `A plan step that will deliver one declares its scope as exactly \`${globs.join('` or `')}\`, or the one ` +
        'file by name — any wider `.github/` glob is refused, and another workload’s prefix is not this plan’s to ' +
        'declare. '
      : '') +
    'Its content is judged ' +
    'by the D6 content guards (read-only repository permissions, OIDC through a protected environment, pinned ' +
    'actions, no secrets, no oversight triggers) and it always waits for the operator’s own merge.'
  );
}

/** The paths a deliverable may never touch, phrased for a human, with the route out.
 *  When an offending path is under `.github/workflows/`, the refusal also names the
 *  namespace: the likeliest reason an agent wrote a workflow file is that it was
 *  asked to deliver a deploy leg, and there IS a right way to do that — under THIS
 *  workload's prefix, which is why the slug is threaded this far (T279). */
export function reservedRefusalDetail(offending: readonly string[], subject = 'the patch', slug: string | null = null): string {
  const underWorkflows = offending.some((p) => normalizePath(p).startsWith('.github/workflows/'));
  return (
    `${subject} touches ${offending.length} reserved path(s): ${offending.join(', ')} — ` +
    'the installed oversight machinery and the governance record, which are what JUDGE this build ' +
    `rather than what it builds (FR-068). ${PRODUCT_PR_ROUTE}` +
    (underWorkflows ? ` ${subjectWorkflowRoute(slug)}` : '')
  );
}

/** Re-exported so callers doing path hygiene need one import, not two. */
export { isRepoRelative };
