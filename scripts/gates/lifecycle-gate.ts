import type { Octokit } from '@octokit/rest';
import { createClient, type RepoRef } from '../../dashboard/lib/github/client';
import { getWorkload, type Workload } from '../../dashboard/lib/github/workloads';
import { scanDeferralContradictions } from '../../dashboard/lib/github/evidence';
import { WORKLOAD_TRANSITIONS } from '../../dashboard/lib/github/labels';
import { findLiveAndonsBySlug } from '../../dashboard/lib/github/andon';
import { resolveCurrent, tagTargetSha, tryReadPlanAtRef } from '../../dashboard/lib/github/plans';
import { deriveCompletionStatus, listVtCheckRuns } from '../../dashboard/lib/github/checks';
import { commitmentScope } from './lib/checks-scope';
import { cliMain, runGates, UsageError, type GateReport, type GateResult } from './lib/runner';

/**
 * lifecycle-gate (T137/T155/T167/T174) — precondition check for every workload
 * transition, run as step 1 of the workload-lifecycle single-writer workflow.
 * Implemented: L0 (exactly one workload:* label + valid header), L1 (activate
 * only from proposed), US10's L2/L3/L10 (complete — FR-032/FR-034/FR-036),
 * US12's L4–L8 (cancel/defer/reactivate — FR-038…040), and US13's L9 (archive —
 * FR-041).
 * Every contract row (gate-checks-cli.md §3) is now implemented.
 * There is NO delete action: unknown actions exit 2 (FR-042).
 */

const KNOWN_ACTIONS = Object.keys(WORKLOAD_TRANSITIONS);

/** The from-state precondition shared by L1/L2/L4/L5/L7/L9 — every allowed
 *  from-state is read from WORKLOAD_TRANSITIONS, never spelled here, so the
 *  transition-authority matrix stays the single source of truth (a second copy
 *  is how a gate comes to allow a transition the matrix forbids). */
function statePrecondition(workload: Workload | null, action: string): string | null {
  const allowed = WORKLOAD_TRANSITIONS[action]!.from;
  return workload?.state && allowed.includes(workload.state)
    ? null
    : `current state is ${workload?.state ?? 'unknown'}, not ${allowed.join('/')}`;
}

/**
 * L3 (complete, FR-034/SC-002) — a thin I/O wrapper over the shared pure
 * derivation in dashboard/lib/github/checks.ts, which the Wave-B completion view
 * renders from as well. Only resolution lives here:
 *   1. the official frozen plan is DERIVED (resolveCurrent = the newest frozen
 *      plan/<slug>/v* tag) — never a branch, never a stored pointer (GHI #44);
 *   2. results are read on that TAG's commit SHA, so a re-opened plan (new
 *      version, new SHA) automatically requires fresh results;
 *   3. the MUST-mapped target set comes from commitmentScope() — the same
 *      FR-010 derivation plan-gate G3 and the scope panel use, so what was
 *      committed at approval is exactly what completion measures.
 */
async function checkL3Completion(gh: Octokit, repo: RepoRef, slug: string): Promise<GateResult> {
  const fail = (detail: string): GateResult => ({ id: 'L3', status: 'fail', requirement: 'FR-034', detail });

  const current = await resolveCurrent(gh, repo, slug);
  if (current === null) {
    // Reported through the shared derivation (scope: null) so the gate refusal
    // and the dashboard's "not completable" copy are one string, not two.
    return fail(deriveCompletionStatus(slug, null, new Map()).unmet.join('; '));
  }
  const frozenSha = await tagTargetSha(gh, repo, current);
  if (frozenSha === null) {
    // resolveCurrent saw the tag and it is gone now (tags are never deleted —
    // FR-042 — so this is a transient read, not a state): refuse rather than
    // measure completion against no SHA at all.
    return fail(`official version ${current} resolved but its tag no longer does — re-run the completion gate`);
  }
  const { plan, errors } = await tryReadPlanAtRef(gh, repo, current);
  if (!plan) {
    // A frozen plan passed G1 at approval, so this is tampering or corruption,
    // not an ordinary failure — refusing names it instead of reading a target
    // set of zero and completing vacuously.
    return fail(`plan.json at the frozen ${current} does not validate, so its MUST set is unknown: ${errors.join('; ')}`);
  }

  const verdict = deriveCompletionStatus(slug, commitmentScope(plan), await listVtCheckRuns(gh, repo, frozenSha));
  return verdict.complete
    ? { id: 'L3', status: 'pass', requirement: 'FR-034', ...(verdict.note ? { detail: verdict.note } : {}) }
    : fail(verdict.unmet.join('; '));
}

/**
 * L10 (complete, FR-036/SC-013) — no review may be running.
 *
 * L3 asks its question of the OFFICIAL version, which `resolveCurrent` derives from
 * the newest frozen tag. A plan under review is deliberately not that (v N stays
 * official until a fresh approval freezes v N+1), so L3 can be perfectly green on
 * v1 while v2 sits in review carrying a scope request the operator asked for.
 * Completing there would close the edit surface — a completed workload admits no
 * edits — and abandon the live review, which is the same "approve the change away"
 * hole the break-level correction closes, reached from the other direction
 * (PR #71 review).
 *
 * Keyed on LIVE breaks only (open or under-review), NOT on "a plan branch newer
 * than the frozen version": a withdrawn proposal legitimately leaves its branch
 * behind — versions are never reused (FR-058) and nothing deletes it — so branch
 * presence would refuse completion forever after any withdrawal. A live break is
 * exactly "somebody is still deciding".
 */
async function checkL10NoLiveReview(gh: Octokit, repo: RepoRef, slug: string): Promise<GateResult> {
  const live = await findLiveAndonsBySlug(gh, repo, slug);
  return live.length === 0
    ? { id: 'L10', status: 'pass', requirement: 'FR-036' }
    : {
        id: 'L10',
        status: 'fail',
        requirement: 'FR-036',
        detail:
          `${live.length} review(s) still open for ${slug} (Andon ${live.map((n) => `#${n}`).join(', ')}) — ` +
          `finish them first: approve the proposal, or withdraw it. Completing now would abandon a review the ` +
          `operator opened and close the edit surface behind it (FR-036/SC-013)`,
      };
}

export async function lifecycleGate(
  gh: Octokit,
  repo: RepoRef,
  input: { slug: string; action: string; reason?: string; revisit?: string },
): Promise<GateReport> {
  if (!KNOWN_ACTIONS.includes(input.action)) {
    throw new UsageError(`unknown lifecycle action: ${input.action} (no delete exists — FR-042)`);
  }
  const workload = await getWorkload(gh, repo, input.slug);

  const l0: GateResult = workload && workload.state !== null
    ? { id: 'L0', status: 'pass', requirement: 'FR-032' }
    : {
        id: 'L0',
        status: 'fail',
        requirement: 'FR-032',
        detail: workload
          ? `workload ${input.slug} does not carry exactly one workload:* label (SC-011)`
          : `no workload issue with a workload:v1 header for slug ${input.slug}`,
      };

  const checks: GateResult[] = [l0];
  let requiresReview: boolean | undefined;

  if (input.action === 'activate') {
    const unmet = statePrecondition(workload, 'activate');
    checks.push(
      unmet
        ? { id: 'L1', status: 'fail', requirement: 'FR-033', detail: unmet }
        : { id: 'L1', status: 'pass', requirement: 'FR-033' },
    );
  }

  if (input.action === 'complete') {
    const unmet = statePrecondition(workload, 'complete');
    checks.push(
      unmet
        ? { id: 'L2', status: 'fail', requirement: 'FR-032', detail: unmet }
        : { id: 'L2', status: 'pass', requirement: 'FR-032' },
    );
    // L3 runs whatever L2 said — deliberately unlike L8, which needs L7's
    // deferral window to exist before it has anything to scan. Reading check
    // runs has no precondition, and FR-034's "list the unmet items when
    // refusing" is most useful when a single refusal carries BOTH the wrong
    // state and the outstanding targets, rather than making the operator fix
    // one to discover the other.
    checks.push(await checkL3Completion(gh, repo, input.slug));
    // L10 last: L2/L3 answer about the official version, L10 about anything still
    // in flight beside it. All three ship in one report so a refusal names every
    // reason at once.
    checks.push(await checkL10NoLiveReview(gh, repo, input.slug));
  }

  if (input.action === 'cancel') {
    // One contract row, two conditions: legal from-state (proposed/active/
    // deferred per the amended FR-038) AND a non-empty recorded reason.
    const problems: string[] = [];
    const unmet = statePrecondition(workload, 'cancel');
    if (unmet) problems.push(unmet);
    if (!input.reason?.trim()) problems.push('a non-empty cancellation reason must be supplied');
    checks.push(
      problems.length > 0
        ? { id: 'L4', status: 'fail', requirement: 'FR-038', detail: problems.join('; ') }
        : { id: 'L4', status: 'pass', requirement: 'FR-038' },
    );
  }

  if (input.action === 'defer') {
    const unmet = statePrecondition(workload, 'defer');
    checks.push(
      unmet
        ? { id: 'L5', status: 'fail', requirement: 'FR-032', detail: unmet }
        : { id: 'L5', status: 'pass', requirement: 'FR-032' },
    );
    checks.push(
      input.revisit?.trim()
        ? { id: 'L6', status: 'pass', requirement: 'FR-039' }
        : { id: 'L6', status: 'fail', requirement: 'FR-039', detail: 'a revisit condition or date must be supplied' },
    );
  }

  if (input.action === 'reactivate') {
    const unmet = statePrecondition(workload, 'reactivate');
    checks.push(
      unmet
        ? { id: 'L7', status: 'fail', requirement: 'FR-040', detail: unmet }
        : { id: 'L7', status: 'pass', requirement: 'FR-040' },
    );
    // L8 runs only against an actually-deferred workload (a defined deferral
    // window); on an L7 failure the report is already red and performs nothing.
    if (!unmet && workload) {
      const scan = await scanDeferralContradictions(gh, repo, workload);
      requiresReview = scan.contradicted;
      checks.push({
        id: 'L8',
        status: 'pass', // never blocks the transition — it routes it back to review
        requirement: 'FR-040',
        detail: scan.contradicted
          ? `contradicting evidence during deferral — plan re-opens for review: ${scan.findings.join('; ')}`
          : 'no contradicting evidence recorded during the deferral window',
      });
    }
  }

  if (input.action === 'archive') {
    // Terminal-only (FR-041) — and which states are terminal comes from
    // WORKLOAD_TRANSITIONS.archive.from via statePrecondition, so the refusal
    // text follows the matrix automatically. Archiving is close + lock, never
    // deletion (FR-042): the record stays searchable afterwards (FR-043).
    const unmet = statePrecondition(workload, 'archive');
    checks.push(
      unmet
        ? { id: 'L9', status: 'fail', requirement: 'FR-041', detail: unmet }
        : { id: 'L9', status: 'pass', requirement: 'FR-041' },
    );
  }

  const report = await runGates(`${input.slug}:${input.action}`, checks.map((c) => () => c));
  return {
    subject: `${input.slug}:${input.action}`,
    result: report.result,
    ...(requiresReview !== undefined ? { requires_review: requiresReview } : {}),
    gates: report.gates,
  };
}

const isMain = process.argv[1]?.endsWith('lifecycle-gate.ts');
if (isMain) {
  void cliMain(async (args) => {
    const slug = args.get('workload');
    const action = args.get('action');
    const repoArg = args.get('repo');
    if (!slug || !action || !repoArg) {
      throw new UsageError('lifecycle-gate --workload <slug> --action <activate|complete|cancel|defer|reactivate|archive> --repo <owner/repo> [--reason <text>] [--revisit <text>] [--json]');
    }
    const [owner, repo] = repoArg.split('/');
    if (!owner || !repo) throw new UsageError(`invalid --repo: ${repoArg}`);
    const reason = args.get('reason');
    const revisit = args.get('revisit');
    return lifecycleGate(createClient(), { owner, repo }, {
      slug,
      action,
      ...(reason !== undefined ? { reason } : {}),
      ...(revisit !== undefined ? { revisit } : {}),
    });
  });
}
