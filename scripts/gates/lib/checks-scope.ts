import type { PlanDoc } from '../../../schemas/plan';
import type { GateResult } from './runner';
import { scopeReachesReserved, PRODUCT_PR_ROUTE } from './reserved-paths';

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
 * NOT-APPLICABLE FOR A SCOPE-LESS STEP, NAMING THE ABSENT FIELD — and this is the
 * one place in the gate set where a not-applicable is load-bearing enough to be
 * worth stating twice. Every plan frozen before `PlanStep.scope` existed declares no
 * scope, and refusing them all would make each one permanently unapprovable
 * (constitution: Frozen-Artifact Compatibility). Reporting not-applicable here is
 * honest ONLY BECAUSE **D5 is unconditional**: the deliverable gate reads the
 * patch's actual paths and does not consult this field, so a scope-less plan is
 * still governed at the moment it matters.
 *
 * IF D5 EVER BECOMES SCOPE-DEPENDENT, THIS TURNS SILENTLY INTO A PASS FOR THE
 * ABSENT CASE — the absent-≠-success mistake this project refuses everywhere else
 * (GHI #108). `tests/unit/subject-boundary.test.ts` pins the coupling for exactly
 * that reason; do not weaken one without the other.
 */
export function checkG16SubjectBoundary(plan: PlanDoc, extraReserved: readonly string[] = []): GateResult {
  const scoped = plan.steps.filter((s) => (s.scope ?? []).length > 0);
  if (scoped.length === 0) {
    return {
      id: 'G16',
      status: 'not-applicable',
      requirement: 'FR-068',
      detail:
        'no step declares a `scope`, so there is nothing here to compare against the reserved paths. The plan is ' +
        'still bound at delivery by D5, which reads the patch itself and does not consult this field — that is ' +
        'what makes reporting not-applicable honest rather than an absent-≠-success pass (GHI #108)',
    };
  }
  const offenders: string[] = [];
  for (const step of scoped) {
    const reaching = scopeReachesReserved(step.scope ?? [], extraReserved);
    for (const glob of reaching) offenders.push(`${step.id} → ${glob}`);
  }
  if (offenders.length > 0) {
    return {
      id: 'G16',
      status: 'fail',
      requirement: 'FR-068',
      detail:
        `${offenders.length} declared scope(s) reach the installed oversight machinery or the governance record: ` +
        `${offenders.join('; ')}. A plan's subject is the operator's OWN software; approving this one would ` +
        `authorize the system to change the gates, workflows, schemas, or records that govern it. ${PRODUCT_PR_ROUTE}`,
    };
  }
  return {
    id: 'G16',
    status: 'pass',
    requirement: 'FR-068',
    detail: `${scoped.length} scoped step(s), none reaching the installed machinery or the governance record`,
  };
}
