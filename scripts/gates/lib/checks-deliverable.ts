import type { Octokit } from '@octokit/rest';
import type { RepoRef } from '../../../dashboard/lib/github/client';
import { readPlanAtRef, slugFromPlanRef, tagTargetSha } from '../../../dashboard/lib/github/plans';
import { parseDeliverableMarker, type DeliverableMarker } from '../../../dashboard/lib/github/markers';
import { errorMessage, errorStatus } from '../../../dashboard/lib/github/errors';
import type { PlanDoc, PlanStep } from '../../../schemas/plan';
import type { MergeAuthority } from '../../../schemas/executor';
import { pathsOutside, isRepoRelative, normalizePath } from './globs';
import { reservedPathsTouched, reservedRefusalDetail } from './reserved-paths';
import { ApiUnavailableError, type GateResult } from './runner';

/**
 * Deliverable-gate checks (gate-checks-cli.md §2b) — the required status check on
 * every `build/<slug>/<step-id>` pull request. This is the gate that decides whether
 * an agent's actual work may land, and the only gate in the system that reads a patch.
 *
 *   D1  the PR corresponds to a VALIDATED deliverable patch from a build run on the
 *       frozen tag: the marker's plan_ref/step/run are recorded, the run really was
 *       this build, and the head is a DESCENDANT of the frozen tag's commit (FR-060,
 *       FR-007 as amended — a deliverable descends from the frozen plan, never
 *       alters it)
 *   D2  every path falls inside the DECLARED SCOPE of the one step it delivers;
 *       a straying path fails and is named (FR-061)
 *   D3  merge authority is satisfied — pre-authorized by the approved plan, or the
 *       operator's own merge where configuration demands a checkpoint or the step
 *       carries a recorded external confirmation. Escalation-only (FR-062, FR-024)
 *   D4  executor provenance is recorded on the PR (FR-065)
 *   D5  no path is inside the RESERVED SET — the installed oversight machinery and
 *       the governance record. Read from the patch ALONE; D5 never consults the
 *       declared scope (FR-068)
 *
 * WHY D5 SITS NEXT TO D2 AND IGNORES IT. D2 is an inclusion allowlist: it asks "did
 * the patch stay inside what the plan declared?", which a plan aimed at the wrong
 * subject answers perfectly. The property D5 holds is different in kind — "the system
 * did not rewrite its own controls" — and it cannot be expressed over a scope the
 * plan itself authors. If a step's scope could satisfy D5, a proposal would simply
 * declare `.github/workflows/**` and the boundary would be gone. Live evidence that
 * this is not theoretical: the first agent build here to clear every gate built a
 * change to the installed dashboard, and D1–D4 as specified would all have been
 * green (run 32658500322, GHI #141).
 */

/** What the gate reads off a deliverable pull request. Assembled once by the CLI so
 *  five checks cannot disagree about which PR they are judging. */
export interface DeliverablePr {
  number: number;
  headRef: string;
  headSha: string;
  body: string;
  labels: string[];
  /** every path the PR's diff touches — added, modified, removed, renamed */
  paths: string[];
}

/**
 * D1 — provenance.
 *
 * Three separable claims, and the order matters because each later one needs the
 * earlier to have held:
 *   (a) the PR carries a `deliverable:v1` marker at all. Only `build-publish` writes
 *       one, and it holds the write scope the executor does not, so the marker's
 *       presence is what distinguishes a deliverable PR from any branch a human
 *       happened to name `build/…`.
 *   (b) the marker's `plan_ref` parses as a frozen plan ref and its tag resolves.
 *   (c) the head commit DESCENDS from that tag's commit — FR-007 as amended. A
 *       deliverable is a descendant of the frozen plan, never an alteration of it,
 *       so `compareCommits(tag…head)` must report `ahead` (or `identical`, which is
 *       an empty deliverable and fails D2 anyway rather than here).
 *
 * The descendancy check is the one that cannot be faked from inside the executor:
 * it is a property of the git graph the deterministic writer built.
 */
export async function checkD1Provenance(
  gh: Octokit,
  repo: RepoRef,
  pr: DeliverablePr,
): Promise<GateResult & { marker?: DeliverableMarker }> {
  const marker = parseDeliverableMarker(pr.body);
  if (!marker) {
    return {
      id: 'D1',
      status: 'fail',
      requirement: 'FR-060',
      detail:
        `pull request #${pr.number} carries no deliverable:v1 marker. Only the deterministic writer ` +
        '(build-publish) emits one, so a build/** branch without it was not produced by a validated ' +
        'deliverable patch — nothing here can be bound to a build run, a plan, or a step',
    };
  }
  const slug = slugFromPlanRef(marker.planRef);
  if (slug === null) {
    return {
      id: 'D1',
      status: 'fail',
      requirement: 'FR-007',
      detail: `the marker names plan_ref "${marker.planRef}", which is not a frozen plan ref (plan/<slug>/v<N>)`,
      marker,
    };
  }
  const tagSha = await tagTargetSha(gh, repo, marker.planRef).catch((error: unknown) => {
    throw new ApiUnavailableError(errorMessage(error));
  });
  if (tagSha === null) {
    return {
      id: 'D1',
      status: 'fail',
      requirement: 'FR-007',
      detail: `the marker names ${marker.planRef}, but no such frozen tag exists — a deliverable must descend from an approved plan`,
      marker,
    };
  }
  let status: string;
  try {
    const { data } = await gh.repos.compareCommits({ ...repo, base: tagSha, head: pr.headSha });
    status = data.status;
  } catch (error: unknown) {
    if (errorStatus(error) === 404) {
      return {
        id: 'D1',
        status: 'fail',
        requirement: 'FR-007',
        detail: `the head commit ${pr.headSha.slice(0, 8)} and the frozen tag ${marker.planRef} share no history at all`,
        marker,
      };
    }
    throw new ApiUnavailableError(errorMessage(error));
  }
  if (status !== 'ahead' && status !== 'identical') {
    return {
      id: 'D1',
      status: 'fail',
      requirement: 'FR-007',
      detail:
        `the head commit ${pr.headSha.slice(0, 8)} is "${status}" relative to ${marker.planRef}, not a descendant of it. ` +
        'A deliverable is produced FROM the frozen plan and lands on its own branch — it never alters the frozen ' +
        'commit, and it never comes from somewhere else (FR-007)',
      marker,
    };
  }
  return { id: 'D1', status: 'pass', requirement: 'FR-060', marker };
}

/**
 * The scope question as a pure function (T206), so it is testable without a PR and
 * so the gate and any preview ask it identically.
 *
 * Returns the STRAYING paths, not a boolean: every refusal in this system names the
 * offending paths, and a caller that recomputes them phrases it differently from the
 * gate that decided (the GHI #127 lesson).
 */
export function patchPathsWithinStepScope(paths: readonly string[], scope: readonly string[]): string[] {
  return pathsOutside(paths, scope);
}

/**
 * D2 — scope containment (FR-061).
 *
 * NOT-APPLICABLE, NAMING THE ABSENT FIELD, for a step that declares no scope. Every
 * plan frozen before 2026-08-24 is in that position and must stay buildable
 * (constitution: Frozen-Artifact Compatibility), but "the plan made no containment
 * promise" is a different fact from "the patch stayed inside it" and the report says
 * which one it is. That is only safe because **D5 is unconditional**: the subject
 * boundary does not depend on this field, so a scope-less plan is still governed.
 */
export function checkD2ScopeContainment(pr: DeliverablePr, step: PlanStep | null): GateResult {
  if (!step) {
    return {
      id: 'D2',
      status: 'fail',
      requirement: 'FR-061',
      detail: 'the delivering step could not be resolved (see D1), so there is no declared scope to validate against',
    };
  }
  const scope = step.scope ?? [];
  if (scope.length === 0) {
    return {
      id: 'D2',
      status: 'not-applicable',
      requirement: 'FR-061',
      detail:
        `step ${step.id} declares no \`scope\` — the plan was frozen before the field existed, so it makes no ` +
        'containment promise for this gate to check. The patch is still bound by D5 (the reserved paths), which ' +
        'does not read this field. Re-open the plan (FR-008) to add a scope if containment matters here',
    };
  }
  const traversal = pr.paths.filter((p) => !isRepoRelative(p));
  if (traversal.length > 0) {
    return {
      id: 'D2',
      status: 'fail',
      requirement: 'FR-061',
      detail: `patch names path(s) that are not repo-relative: ${traversal.join(', ')} — refused, never normalized into safety`,
    };
  }
  const straying = patchPathsWithinStepScope(pr.paths, scope);
  if (straying.length > 0) {
    return {
      id: 'D2',
      status: 'fail',
      requirement: 'FR-061',
      detail:
        `${straying.length} path(s) fall outside step ${step.id}'s declared scope [${scope.join(', ')}]: ` +
        `${straying.join(', ')}. Work outside the step is work no authority was asked about — the pull request is ` +
        'refused rather than silently trimmed',
    };
  }
  return { id: 'D2', status: 'pass', requirement: 'FR-061', detail: `${pr.paths.length} path(s) inside [${scope.join(', ')}]` };
}

/**
 * D5 — the subject boundary (FR-068). **Reads the patch alone.**
 *
 * Note what is NOT a parameter: the step, and therefore the declared scope. That is
 * the check, not an omission. A boundary a plan can widen is not a boundary, and D2
 * above already asks the question a scope can answer.
 */
export function checkD5SubjectBoundary(pr: DeliverablePr, extraReserved: readonly string[] = []): GateResult {
  const traversal = pr.paths.filter((p) => !isRepoRelative(p));
  if (traversal.length > 0) {
    return {
      id: 'D5',
      status: 'fail',
      requirement: 'FR-068',
      detail: `patch names path(s) that escape the repository: ${traversal.join(', ')} — refused outright`,
    };
  }
  const offending = reservedPathsTouched(pr.paths.map(normalizePath), extraReserved);
  if (offending.length > 0) {
    return { id: 'D5', status: 'fail', requirement: 'FR-068', detail: reservedRefusalDetail(offending) };
  }
  return {
    id: 'D5',
    status: 'pass',
    requirement: 'FR-068',
    detail: `${pr.paths.length} path(s), none inside the installed machinery or the governance record`,
  };
}

/**
 * Merge authority (T209, FR-062) — DERIVED, never configured.
 *
 * Escalation-only, and the asymmetry is the whole rule: configuration may ADD a
 * checkpoint and may never remove one a gate demands.
 *
 *   high-stakes step with a recorded confirmation → operator-merge-required, always
 *   per-workflow checkpoint configured             → operator-merge-required
 *   otherwise                                      → pre-authorized by the approved plan
 *
 * WHY THE HIGH-STAKES BRANCH IS NOT CONFIGURABLE. A step reaches B5 because a
 * customer, clinician, or lawyer answered a question about *that step* (GHI #87
 * scoped the gate to the step for this reason). Pre-authorizing its landing would
 * spend a real authority's answer on a diff no human read — the confirmation would
 * attest to an intent while the code went unreviewed.
 */
export function resolveMergeAuthority(step: PlanStep | null, opts: { requiresOperatorMerge?: boolean } = {}): {
  authority: MergeAuthority;
  reason: string;
} {
  if (step?.high_stakes) {
    return {
      authority: 'operator-merge-required',
      reason:
        `step ${step.id} is high-stakes (${step.authority ?? 'authority unset'}) and carries an external authority's ` +
        'confirmation — its deliverable always waits for the operator\'s own merge, regardless of configuration ' +
        '(FR-062 is escalation-only: config may add a checkpoint, never remove one a gate demands)',
    };
  }
  if (opts.requiresOperatorMerge) {
    return {
      authority: 'operator-merge-required',
      reason: 'the workflow is configured with requires_operator_merge — this deliverable waits for the operator\'s own merge',
    };
  }
  return {
    authority: 'pre-authorized',
    reason: 'the approved plan pre-authorizes this deliverable\'s merge (FR-062 default) — no per-step checkpoint is configured',
  };
}

/** D3 — merge authority is satisfied. Reports which authority applies and why; it
 *  fails only when the authority cannot be resolved at all. Whether the operator has
 *  yet PERFORMED an operator-required merge is the merge event's business, not the
 *  gate's: blocking here would make a PR that is correctly waiting for a human look
 *  broken. */
export function checkD3MergeAuthority(step: PlanStep | null, opts: { requiresOperatorMerge?: boolean } = {}): GateResult {
  if (!step) {
    return {
      id: 'D3',
      status: 'fail',
      requirement: 'FR-062',
      detail: 'the delivering step could not be resolved (see D1), so merge authority cannot be determined — refusing rather than defaulting to pre-authorized',
    };
  }
  const { authority, reason } = resolveMergeAuthority(step, opts);
  return { id: 'D3', status: 'pass', requirement: 'FR-062', detail: `${authority}: ${reason}` };
}

/** D4 — executor provenance recorded (FR-065). */
export function checkD4ExecutorProvenance(marker: DeliverableMarker | undefined): GateResult {
  if (!marker) {
    return { id: 'D4', status: 'fail', requirement: 'FR-065', detail: 'no deliverable:v1 marker (see D1), so no provenance is recorded' };
  }
  const missing: string[] = [];
  if (!marker.executorId) missing.push('executor id');
  if (!marker.tier) missing.push('tier');
  if (marker.tier === 'in-sandbox' && !marker.engine) missing.push('engine (in-sandbox tier)');
  if (marker.tier === 'spawned' && !marker.image) missing.push('image (spawned tier)');
  if (missing.length > 0) {
    return {
      id: 'D4',
      status: 'fail',
      requirement: 'FR-065',
      detail: `executor provenance incomplete — missing ${missing.join(', ')}. A landed deliverable must be correlatable with the agent that produced it`,
    };
  }
  const parts = [
    `executor ${marker.executorId}`,
    `tier ${marker.tier}`,
    marker.engine ? `engine ${marker.engine}` : '',
    marker.image ? `image ${marker.image}` : '',
    marker.model ? `model ${marker.model}` : '',
  ].filter(Boolean);
  return { id: 'D4', status: 'pass', requirement: 'FR-065', detail: parts.join(', ') };
}

/**
 * The step this deliverable delivers, resolved from the PLAN rather than believed
 * from the marker where possible.
 *
 * The marker's `step_id` originates in the executor's own envelope (GHI #116 — the
 * step id is executor-authored with no trusted binding). Here it is checked against
 * the plan: the id must name a step that exists. That is as far as this can go
 * without the work item, which the deliverable PR does not carry; `build-publish`
 * performs the stronger derivation at write time, when the build run's `--chunk`
 * input is still reachable.
 */
export async function resolveDeliveringStep(
  gh: Octokit,
  repo: RepoRef,
  marker: DeliverableMarker | undefined,
): Promise<{ plan: PlanDoc | null; step: PlanStep | null }> {
  if (!marker) return { plan: null, step: null };
  try {
    const plan = await readPlanAtRef(gh, repo, marker.planRef);
    return { plan, step: plan.steps.find((s) => s.id === marker.stepId) ?? null };
  } catch {
    return { plan: null, step: null };
  }
}
