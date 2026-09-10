import type { Octokit } from '@octokit/rest';
import type { RepoRef } from '../../../dashboard/lib/github/client';
import { getChunk } from '../../../dashboard/lib/github/chunks';
import { errorStatus } from '../../../dashboard/lib/github/errors';
import type { PlanDoc } from '../../../schemas/plan';
import type { GateResult } from './runner';

/**
 * Approval-readiness checks G17 and G18 (gate-checks-cli.md §1; decision D6 of the
 * 2026-09-08 shared-understanding session, GHI #146 and #197, ADR-0002).
 *
 * Both ask the same kind of question, and it is a question no other G gate asks: not
 * "is this plan well-formed?" (G1–G4), not "has the operator finished judging it?"
 * (G7, G8, G11), not "what is it about?" (G16) — but **can what it promises actually
 * be built and then verified once it is frozen?** A plan can clear every earlier gate
 * and still be a dead end after approval, and that dead end was met live:
 *
 *   - `plan/lza-phase0/v1` froze with three MUST steps that tracked no work item.
 *     Every build dispatch is per work item (D4) and preflight B3 binds the build to
 *     the step that tracks it, so nothing could ever be dispatched for that plan
 *     without re-opening it (2026-09-05, GHI #197).
 *   - `run` is optional in the schema and only SHOULD in the proposing prompt, so a
 *     MUST target typed as prose freezes fine, is never executed by `build-verify`,
 *     and the completion gate L3 then fails closed — the workload is uncompletable,
 *     and the operator finds out after the build (GHI #146).
 *
 * WHY NEW IDS RATHER THAN WIDER G3/G4 (D6, option b rejected). G3 asks whether a MUST
 * step has a target at all; G4 whether a target is one assertion. Each is a distinct
 * remedy for the operator, and a gate id is the name of a remedy — folding "…and it
 * has a run command" into G4 would make one red row mean two different fixes.
 * G16 was the maximum; G12 stays reserved and unreused (GHI #28). These take G17
 * and G18.
 *
 * WHY A SEPARATE MODULE. `checks-core.ts` is G1 plus the checks that read the Andon
 * break and the tag history; `checks-scope.ts` is the commitment-scope derivation;
 * `checks-binding.ts` is the cross-plan claims on a work item. The two CHECKS read
 * only the document, are shared with the review page's preview (`gate-preview.ts`),
 * and hand the Commit-for-approval action the derivations it refuses on — one
 * predicate, imported by every caller, never restated. `verifyTrackedWorkItems`
 * below is the one async companion, and it is kept apart from `checkG17…` on
 * purpose: the preview imports the pure check synchronously, and a gate that reads
 * the tracker cannot be previewed on every render of a live review.
 *
 * NOT RE-JUDGED ON OLD TAGS. Both run when `plan-gate` runs, which is on an approval
 * pull request — a plan frozen before 2026-09-08 is never handed to them, and its
 * exemption is the gate-set stamp's business (GHI #151), not a carve-out here.
 */

/** MUST steps that track no work item, plan order — G17's fail set. Exported so the
 *  Commit-for-approval action (D2/D4) refuses on the very list the gate will judge. */
export function untrackedMustSteps(plan: PlanDoc): string[] {
  return plan.steps
    .filter((s) => s.priority === 'MUST' && typeof s.tracking_issue !== 'number')
    .map((s) => s.id);
}

/**
 * G17 — every MUST step tracks a work item (FR-017; decision D4).
 *
 * `pendingStepIds` is for the PREVIEW, and only the preview: under D2 the Commit-for-
 * approval click is what creates the pending work items and writes the links, so
 * before that click a new plan's MUST steps are all `null` BY DESIGN. A preview that
 * judged the document as it stands would be red on every new plan and would disable
 * the one button that fixes it. The review page therefore names the steps whose items
 * the commit is about to create, and those count as tracked here. The wired gate
 * passes nothing: on the approval PR the links must already be on the document.
 */
export function checkG17MustStepsTracked(
  plan: PlanDoc,
  opts: { pendingStepIds?: Iterable<string> } = {},
): GateResult {
  const pending = new Set(opts.pendingStepIds ?? []);
  const untracked = untrackedMustSteps(plan).filter((id) => !pending.has(id));
  return untracked.length === 0
    ? { id: 'G17', status: 'pass', requirement: 'FR-017' }
    : {
        id: 'G17',
        status: 'fail',
        requirement: 'FR-017',
        // One clause per step, each carrying its own remedy: the operator's fix is
        // per step, and a build is dispatched per work item, so a summary count would
        // make them reconstruct the list this gate already has.
        detail: untracked
          .map(
            (id) =>
              `MUST step '${id}' tracks no work item — create or link a work item for step ${id} on the review before committing for approval`,
          )
          .join('; '),
      };
}

/** The remedy every clause below ends with. There is exactly one: a binding written
 *  after Commit for approval is a binding nothing validated, and the only path that
 *  validates one is the commit itself. */
const REBIND = 're-open the plan and bind the step to a complete work item at Commit for approval';

/**
 * G17's second half, on the approval PR only: does each MUST binding RESOLVE to a
 * complete work item? (PR #204 review finding F7.)
 *
 * The pure check above asks whether `tracking_issue` is a number. On the approval PR
 * that is not enough: an approval branch is an ordinary branch, and a plan edited after
 * Commit for approval can name an issue that does not exist, an issue that is not a
 * work item at all, a legacy title-only item, or a `chunk:ready` item whose requirement
 * sections are empty. Every one of those passes "is a number", freezes, and then can
 * never pass preflight B3 — the lza-phase0 dead end (GHI #197) reached by a different
 * door, discovered only when the first build is dispatched.
 *
 * SAME READER AS B3, NOT A RESTATEMENT. `getChunk` is the label reader and body parser
 * B3 resolves the build's chunk with, so what this refuses at approval is exactly what
 * B3 would refuse at dispatch — one predicate about "a complete work item", two gates.
 * The plan-binding half of B3 (does the FROZEN plan claim the chunk?) is not asked:
 * there is no frozen plan yet, this document is the one about to become it.
 *
 * ONLY A VERIFIED 404 IS "ABSENT". Any other error — a 5xx, a rate limit, a read scope
 * missing from the job and answering 403 — is the gate being unable to read, not the
 * item being missing, and it THROWS: a fail clause about an item this gate never saw
 * would be a verdict nobody made (the GHI #108 stance), and the run going red says
 * "could not read", which is the truth.
 *
 * Returns one clause per offending binding, plan order, each carrying the remedy; empty
 * means every MUST binding resolves to a complete work item. The caller (plan-gate)
 * turns a non-empty list into a G17 fail.
 */
export async function verifyTrackedWorkItems(gh: Octokit, repo: RepoRef, plan: PlanDoc): Promise<string[]> {
  const problems: string[] = [];
  for (const step of plan.steps) {
    if (step.priority !== 'MUST' || typeof step.tracking_issue !== 'number') continue;
    const issue = step.tracking_issue;
    let chunk;
    try {
      chunk = await getChunk(gh, repo, issue);
    } catch (error: unknown) {
      if (errorStatus(error) !== 404) throw error;
      problems.push(`MUST step '${step.id}' tracks #${issue}, which does not exist (404) — ${REBIND}`);
      continue;
    }
    if (chunk === null) {
      problems.push(`MUST step '${step.id}' tracks #${issue}, which is not a work item (no chunk:* label) — ${REBIND}`);
      continue;
    }
    if (chunk.state !== 'ready') {
      problems.push(
        `MUST step '${step.id}' tracks #${issue}, a legacy title-only item (the retired chunk:${chunk.state} label, rule of 2026-09-07) with no requirement behind it — ${REBIND}`,
      );
      continue;
    }
    const missing = (['intent', 'outcomeMetric', 'acceptance'] as const).filter((f) => chunk[f] === null);
    if (missing.length > 0) {
      problems.push(`MUST step '${step.id}' tracks #${issue}, labeled ready but missing section(s): ${missing.join(', ')} — ${REBIND}`);
    }
  }
  return problems;
}

/** Verification targets that map to a MUST step and carry no executable `run`, in
 *  verification_targets order — G18's fail set, each with the MUST steps it maps to. */
export function inexecutableMustTargets(plan: PlanDoc): { vtId: string; mustStepIds: string[] }[] {
  const must = new Set(plan.steps.filter((s) => s.priority === 'MUST').map((s) => s.id));
  // `run` is optional and `min(1)` in the schema, but the operator's form is a
  // textarea and a whitespace-only command would pass the schema and then be handed
  // to `bash -c` as nothing — the same seam G4 holds for `check`.
  const executable = (run: string | undefined): boolean => (run ?? '').trim().length > 0;
  return plan.verification_targets
    .filter((vt) => !executable(vt.run))
    .map((vt) => ({ vtId: vt.id, mustStepIds: vt.maps_to.filter((id) => must.has(id)) }))
    .filter((t) => t.mustStepIds.length > 0);
}

/**
 * G18 — every MUST-mapped verification target is executable (FR-063; GHI #146).
 *
 * A target with only the prose `check` is not verified and not reported by
 * `build-verify` — honest, since L3 then fails closed — but it makes the workload
 * uncompletable, and the plan should be refused at approval rather than discovered
 * after the build. SHOULD/COULD targets are exempt: an optional step's target may
 * stay prose, because nothing downstream fails closed on it.
 */
export function checkG18MustTargetsExecutable(plan: PlanDoc): GateResult {
  const offending = inexecutableMustTargets(plan);
  return offending.length === 0
    ? { id: 'G18', status: 'pass', requirement: 'FR-063' }
    : {
        id: 'G18',
        status: 'fail',
        requirement: 'FR-063',
        detail: offending
          .map(
            ({ vtId, mustStepIds }) =>
              `${vtId} (maps to MUST step ${mustStepIds.join(', ')}) has no run command — add a run command, or lower the step's priority`,
          )
          .join('; '),
      };
}
