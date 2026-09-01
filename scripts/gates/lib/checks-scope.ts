import type { PlanDoc } from '../../../schemas/plan';
import type { GateResult } from './runner';
import { slugFromPlanRef } from '../../../dashboard/lib/github/plans';
import { isSubjectWorkflowScope, subjectWorkflowName } from '../../install-manifest';
import { scopeReachesReserved, subjectWorkflowRoute, PRODUCT_PR_ROUTE } from './reserved-paths';
import { normalizePath } from './globs';

/**
 * Scope-commitment checks G2–G4 (gate-checks-cli.md §1, US2: FR-009…FR-012).
 * commitmentScope is the FR-010 derivation — the dashboard scope panel reuses
 * it (Shared conventions) so the preview and the gate cannot drift.
 */

export interface MustCoverage {
  stepId: string;
  /** ids of the verification targets mapping to this step, in verification_targets order */
  vtIds: string[];
}

export interface CommitmentScope {
  /** the explicitly bounded commitment scope: MUST step ids in plan order (FR-010) */
  mustStepIds: string[];
  /** coverage view per MUST step, plan order (FR-012 input; dashboard scope panel) */
  coverage: MustCoverage[];
  /** MUST steps in the coverage gap — G3's fail set, plan order */
  unmappedMustStepIds: string[];
}

export function commitmentScope(plan: PlanDoc): CommitmentScope {
  const mustStepIds = plan.steps.filter((s) => s.priority === 'MUST').map((s) => s.id);
  const coverage = mustStepIds.map((stepId) => ({
    stepId,
    vtIds: plan.verification_targets.filter((vt) => vt.maps_to.includes(stepId)).map((vt) => vt.id),
  }));
  return {
    mustStepIds,
    coverage,
    unmappedMustStepIds: coverage.filter((c) => c.vtIds.length === 0).map((c) => c.stepId),
  };
}

const PRIORITIES = new Set(['MUST', 'SHOULD', 'COULD']);

export function checkG2ExactlyOnePriority(rawPlan: unknown): GateResult {
  // Takes the RAW plan, not the parsed PlanDoc: G1's Zod enum already forces a
  // valid priority, so a post-parse G2 could never fail and would be
  // untestable. Re-validating the raw shape keeps G2 independently
  // failure-testable, and in the wired gate it runs after G1 as
  // defense-in-depth — the same stance as build-preflight's B2 re-validating
  // schema (FR-009).
  const steps = (rawPlan as { steps?: unknown } | null | undefined)?.steps;
  if (!Array.isArray(steps)) {
    return { id: 'G2', status: 'fail', requirement: 'FR-009', detail: 'plan has no steps array' };
  }
  const offending = steps.flatMap((raw: unknown, i: number) => {
    const step = (typeof raw === 'object' && raw !== null ? raw : {}) as { id?: unknown; priority?: unknown };
    const label = typeof step.id === 'string' ? step.id : `steps[${i}]`;
    const priority = step.priority;
    if (priority === undefined || priority === null) return [`${label}: priority missing`];
    if (typeof priority !== 'string') return [`${label}: priority is not a string`];
    if (!PRIORITIES.has(priority)) return [`${label}: priority '${priority}' is not exactly one of MUST/SHOULD/COULD`];
    return [];
  });
  return offending.length === 0
    ? { id: 'G2', status: 'pass', requirement: 'FR-009' }
    : { id: 'G2', status: 'fail', requirement: 'FR-009', detail: offending.join('; ') };
}

export function checkG3MustCoverage(plan: PlanDoc): GateResult {
  // Detail phrasing is the contract's example ("MUST step 'step-x' has no
  // verification target"), one clause per gap in plan order (FR-012, SC-002).
  const { unmappedMustStepIds } = commitmentScope(plan);
  return unmappedMustStepIds.length === 0
    ? { id: 'G3', status: 'pass', requirement: 'FR-012' }
    : {
        id: 'G3',
        status: 'fail',
        requirement: 'FR-012',
        detail: unmappedMustStepIds.map((id) => `MUST step '${id}' has no verification target`).join('; '),
      };
}

// Minimal deterministic heuristic for "single pass/fail assertion"
// (data-model.md: check "non-empty and singular (one assertion, no 'and
// then')"): reject a check that is empty after trim, or that chains a second
// assertion with an "and then" conjunction — matched across any interior
// whitespace or comma ("and then", "and,  then", "and\nthen": the target
// editor's textarea admits newlines), but never inside a double-quoted
// literal: an exact-copy target's check quotes its copy string verbatim, and
// words INSIDE the copy are data, not assertion structure (reading recorded
// in data-model.md's VerificationTarget validation, 2026-07-19). Ordinary
// conditional phrasing ("when X then Y") stays legal (FR-011).
const CHAINED_ASSERTION = /\band[\s,]+then\b/i;
// Escape-aware so a copy string with an INNER escaped quote around an "and
// then" phrase (e.g. an agent-authored `equals "x \"and then\" y"`) is blanked
// as one literal — the naive /"[^"]*"/g mis-pairs the quotes there and leaves
// the copy's "and then" exposed, a false-positive gate block (PR #53 review).
const QUOTED_LITERAL = /"(?:[^"\\]|\\.)*"/g;

export function checkG4SinglePassFail(plan: PlanDoc): GateResult {
  const offending = plan.verification_targets.flatMap((vt) => {
    if (vt.check.trim().length === 0) return [`${vt.id}: check is empty`];
    if (CHAINED_ASSERTION.test(vt.check.replace(QUOTED_LITERAL, '""'))) {
      return [`${vt.id}: check chains a second assertion ("and then")`];
    }
    return [];
  });
  return offending.length === 0
    ? { id: 'G4', status: 'pass', requirement: 'FR-011' }
    : { id: 'G4', status: 'fail', requirement: 'FR-011', detail: offending.join('; ') };
}

/**
 * G16 — the SUBJECT boundary, asked of a plan before anyone is asked to approve it
 * (FR-068, added 2026-08-24).
 *
 * WHAT IT ASKS. Not "is this plan well-formed?" — every other G gate asks that. It
 * asks what the plan is ABOUT: does any step's declared `scope` reach into the
 * installed oversight machinery or the governance record? A plan that does is asking
 * the operator to approve the system rewriting its own controls, and the honest
 * moment to refuse that is at the review, not after an agent has spent a run
 * building it.
 *
 * EVERY STEP MUST DECLARE A SCOPE, and the first version of this gate got that wrong
 * (Codex on PR #145, 2026-08-25). It reported **not-applicable** for a plan with no
 * scopes and silently ignored the un-scoped steps of a partly-scoped plan, on
 * Frozen-Artifact Compatibility grounds. That reasoning does not apply here at all:
 *
 * **G16 runs at APPROVAL, and every plan reaching approval is new.** G9 requires
 * `version = max + 1` with the tag absent, so there is no such thing as re-approving
 * an already-frozen plan — a re-open mints v N+1, which is also new. The compatibility
 * carve-out is about builds of plans frozen BEFORE the field existed, and that is
 * **D2's** problem, which is where the not-applicable stance belongs and stays.
 *
 * What the old stance actually permitted: `plan-propose.md` tells the agent every step
 * must carry a scope, and nothing enforced it — so a proposal omitting it sailed
 * through approval, after which `build-publish` and D2 both skip containment for that
 * step and its deliverable may touch any non-reserved path. The operator approved a
 * step whose blast radius was undeclared.
 *
 * D5 still backs this up unconditionally, so the machinery is safe either way. But
 * "the reserved paths are safe" is a much weaker promise than "the deliverable stays
 * where the plan said", and only this gate can require the second.
 *
 * WHOSE NAMESPACE (T279, operator decision 2026-09-01). The one carve-out from the
 * reserved set is per workload — `.github/workflows/<workload-slug>_<name>.yml` — so
 * this gate cannot ask "is that glob in the namespace?" without knowing WHICH WORKLOAD
 * this plan belongs to. Two sources, in order:
 *
 *   1. `opts.planRef`, the plan ref the gate is judging (`plan/<slug>/v<N>`), threaded
 *      in from `plan-gate.ts`. AUTHORITATIVE wherever it exists: the ref is the branch
 *      and the tag the approval merges, so it is a fact about the workload rather than
 *      a field inside the document being judged.
 *   2. `plan.feature`, which `plan-propose` requires to be exactly the workload slug and
 *      the publisher refuses otherwise — the fallback for a caller that has only the
 *      document: a direct `plan-gate` CLI call outside Actions, or a unit call. No
 *      dashboard code calls this check, so nothing else is holding the fallback open
 *      (corrected 2026-09-01: the earlier note claimed a dashboard preview did).
 *
 * If neither is a valid slug the answer is null, which is the empty namespace: every
 * `.github/` glob then reaches the reserved set and the plan is refused. Strict by
 * default, like every other reader (see `reserved-paths.ts`).
 *
 * This is a per-workload BLAST RADIUS, not just ergonomics: workload `demo7` may
 * declare `.github/workflows/demo7_*.yml` and is refused `.github/workflows/demo8_*.yml`
 * — another workload's deploy leg, which this plan has no more authority over than it
 * has over the gates.
 */
export function checkG16SubjectBoundary(
  plan: PlanDoc,
  opts: {
    /** the operator's own additional reserved areas (`withExtraReserved`, FR-068(d)) */
    extra?: readonly string[];
    /** the plan ref being judged (`plan/<slug>/v<N>`) — the authoritative source of the
     *  workload slug; `plan.feature` is the fallback. See the docblock. */
    planRef?: string | null;
  } = {},
): GateResult {
  const { extra = [], planRef = null } = opts;
  // Both candidates are handed to the namespace helpers UNVALIDATED and validated
  // there, in the one place a slug is ever judged (`install-manifest.ts`): anything
  // that is not a slug is the same answer as no slug at all — the empty namespace.
  const slug = slugFromPlanRef(planRef) ?? plan.feature ?? null;
  // A step with no scope makes no containment promise, and at approval time there is
  // no compatibility reason to accept one.
  const unscoped = plan.steps.filter((s) => (s.scope ?? []).length === 0).map((s) => s.id);
  if (unscoped.length > 0) {
    return {
      id: 'G16',
      status: 'fail',
      requirement: 'FR-068',
      detail:
        `${unscoped.length} step(s) declare no \`scope\`: ${unscoped.join(', ')}. A step without one makes no ` +
        'containment promise — D2 cannot check what a deliverable for it touches, so the operator would be ' +
        'approving work whose blast radius is undeclared. Add the path globs each step may write (e.g. ' +
        '`["docs/**"]`, `["src/app.py", "tests/test_app.py"]`) and keep them as narrow as the acceptance requires. ' +
        'Note a bare `docs` means the FILE `docs`; write `docs/**` for the directory.',
    };
  }
  const scoped = plan.steps;
  const offenders: string[] = [];
  const offendingGlobs: string[] = [];
  for (const step of scoped) {
    const reaching = scopeReachesReserved(step.scope ?? [], { extra, slug });
    for (const glob of reaching) {
      offenders.push(`${step.id} → ${glob}`);
      offendingGlobs.push(glob);
    }
  }
  if (offenders.length > 0) {
    // A scope aimed under `.github/` gets the namespace route as well as the product-PR
    // one, and the route names THIS workload's prefix (GHI #127, T279): the likeliest
    // reason a step declares a workflow glob is that it was asked to deliver a deploy
    // leg, and there is a right way to do that. Offering a prefix this workload cannot
    // use — a generic one, or another workload's — sends the operator round the loop
    // into a second refusal, which is how a route that is not followable teaches people
    // to disable the check.
    const underGithub = offendingGlobs.some((g) => normalizePath(g).startsWith('.github/'));
    return {
      id: 'G16',
      status: 'fail',
      requirement: 'FR-068',
      detail:
        `${offenders.length} declared scope(s) reach the installed oversight machinery or the governance record: ` +
        `${offenders.join('; ')}. A plan's subject is the operator's OWN software; approving this one would ` +
        `authorize the system to change the gates, workflows, schemas, or records that govern it. ${PRODUCT_PR_ROUTE}` +
        (underGithub ? ` ${subjectWorkflowRoute(slug)}` : ''),
    };
  }
  // A namespace scope is accepted by NAME, and the name is a glob wider than the rule
  // (`demo7_*.yml` covers `demo7_x.lock.yml`, which the namespace does not) — so the
  // pass says what the delivery gate will hold the step to (Codex on PR #175), and says
  // it with THIS workload's own prefix rather than a generic one (T279).
  const namespaced = scoped.filter((s) => (s.scope ?? []).some((g) => isSubjectWorkflowScope(g, slug))).map((s) => s.id);
  return {
    id: 'G16',
    status: 'pass',
    requirement: 'FR-068',
    detail:
      `${scoped.length} scoped step(s), none reaching the installed machinery or the governance record` +
      (namespaced.length > 0
        ? `. ${namespaced.join(', ')} may deliver a subject workflow: the file must be named .github/workflows/${subjectWorkflowName(slug, '<name>')} — this workload's own slug, then \`_\`, then lowercase letters, digits and hyphens, no other dot — or D5 refuses it at delivery as reserved`
        : ''),
  };
}
