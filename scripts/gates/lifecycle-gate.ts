import type { Octokit } from '@octokit/rest';
import { createClient, type RepoRef } from '../../dashboard/lib/github/client';
import { getWorkload, getWorkloadByIssue, type Workload } from '../../dashboard/lib/github/workloads';
import { scanDeferralContradictions } from '../../dashboard/lib/github/evidence';
import { WORKLOAD_TRANSITIONS } from '../../dashboard/lib/github/labels';
import { findLiveAndonsBySlug } from '../../dashboard/lib/github/andon';
import { resolveCurrent, tagTargetSha, tryReadPlanAtRef } from '../../dashboard/lib/github/plans';
import { deriveCompletionStatus, listVtCheckRuns } from '../../dashboard/lib/github/checks';
import { commitmentScope } from './lib/checks-scope';
import { cliMain, runGateCatalogue, UsageError, type GateReport, type GateResult } from './lib/runner';
import { LIFECYCLE_CATALOGUE } from './lib/catalogue';

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

/** A from-state / argument precondition as a gate row: null means met. Collapses
 *  the ten near-identical ternaries the per-action assembly used to carry. */
function precondition(id: string, requirement: string, unmet: string | null): GateResult {
  return unmet ? { id, status: 'fail', requirement, detail: unmet } : { id, status: 'pass', requirement };
}

export async function lifecycleGate(
  gh: Octokit,
  repo: RepoRef,
  input: { slug: string; action: string; reason?: string; revisit?: string; issueNumber?: number },
): Promise<GateReport> {
  if (!KNOWN_ACTIONS.includes(input.action)) {
    throw new UsageError(`unknown lifecycle action: ${input.action} (no delete exists — FR-042)`);
  }
  // Resolve by ISSUE NUMBER when the caller has one, because `getWorkload` reads
  // the LIST endpoint and that is not read-after-write consistent. The dashboard
  // now renders a just-introduced workload from the `?just=` hint, so the operator
  // can see the card and click Activate while the list still has not caught up —
  // and L0 would fail "no workload issue for slug X" about a card in front of them
  // (PR #123 bot review). A gate refusing what the page offers is the
  // preview-versus-enforcement drift this repo forbids everywhere else.
  //
  // The number arrives from a form, so it is checked, not trusted: a resolved
  // workload whose slug disagrees is treated as absent, exactly as
  // `applyLifecycleTransition` already does. That keeps a hand-crafted POST from
  // running a transition against a workload it did not name.
  const byIssue = input.issueNumber !== undefined ? await getWorkloadByIssue(gh, repo, input.issueNumber) : null;
  const workload =
    byIssue !== null && byIssue.slug === input.slug ? byIssue : await getWorkload(gh, repo, input.slug);

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

  // THE CATALOGUE — every L gate the contract declares, reported on every
  // transition (GHI #108). The set used to be ASSEMBLED per action, so a cancel
  // report listed L0 and L4 and said nothing about the eight it did not run; a
  // reader could not tell "does not apply to a cancel" from "not implemented".
  // `skip` now carries that distinction, and it carries the REASON, which is the
  // part a reader actually needs: "this gate is about completing, and you are
  // cancelling" is an answer, "absent" is not.
  //
  // The from-state preconditions are pure functions of the workload and the
  // action, so they are computed up front rather than inside the checks: L8 needs
  // to know whether L7 would pass BEFORE deciding whether it applies, and a skip
  // predicate cannot wait for another gate's result.
  const forAction = (...actions: string[]): (() => string | null) => {
    return () =>
      actions.includes(input.action)
        ? null
        : `this gate applies to ${actions.join('/')}, and this transition is ${input.action}`;
  };
  const reactivateUnmet = statePrecondition(workload, 'reactivate');

  let requiresReview: boolean | undefined;

  const report = await runGateCatalogue(`${input.slug}:${input.action}`, LIFECYCLE_CATALOGUE, [
    // L0 is the only gate on every transition: a workload whose state cannot be
    // read has no legal transition at all.
    { id: 'L0', run: () => l0 },
    {
      id: 'L1',
      skip: forAction('activate'),
      run: () => precondition('L1', 'FR-033', statePrecondition(workload, 'activate')),
    },
    {
      id: 'L2',
      skip: forAction('complete'),
      run: () => precondition('L2', 'FR-032', statePrecondition(workload, 'complete')),
    },
    {
      // L3 runs whatever L2 said — deliberately unlike L8, which needs L7's
      // deferral window to exist before it has anything to scan. Reading check
      // runs has no precondition, and FR-034's "list the unmet items when
      // refusing" is most useful when a single refusal carries BOTH the wrong
      // state and the outstanding targets, rather than making the operator fix
      // one to discover the other.
      id: 'L3',
      skip: forAction('complete'),
      run: () => checkL3Completion(gh, repo, input.slug),
    },
    {
      id: 'L4',
      skip: forAction('cancel'),
      run: () => {
        // One contract row, two conditions: legal from-state (proposed/active/
        // deferred per the amended FR-038) AND a non-empty recorded reason.
        const problems: string[] = [];
        const unmet = statePrecondition(workload, 'cancel');
        if (unmet) problems.push(unmet);
        if (!input.reason?.trim()) problems.push('a non-empty cancellation reason must be supplied');
        return precondition('L4', 'FR-038', problems.length > 0 ? problems.join('; ') : null);
      },
    },
    {
      id: 'L5',
      skip: forAction('defer'),
      run: () => precondition('L5', 'FR-032', statePrecondition(workload, 'defer')),
    },
    {
      id: 'L6',
      skip: forAction('defer'),
      run: () =>
        precondition('L6', 'FR-039', input.revisit?.trim() ? null : 'a revisit condition or date must be supplied'),
    },
    {
      id: 'L7',
      skip: forAction('reactivate'),
      run: () => precondition('L7', 'FR-040', reactivateUnmet),
    },
    {
      // L8 scans an actual deferral WINDOW, so it needs L7 to hold before it has
      // anything to scan — on an L7 failure the report is already red and performs
      // nothing. That is a second, narrower reason for not applying, and it says so
      // rather than sharing L7's wording.
      id: 'L8',
      skip: () =>
        input.action !== 'reactivate'
          ? `this gate applies to reactivate, and this transition is ${input.action}`
          : reactivateUnmet !== null || !workload
            ? 'the workload is not in a deferred state (L7), so there is no deferral window to scan'
            : null,
      run: async () => {
        const scan = await scanDeferralContradictions(gh, repo, workload!);
        requiresReview = scan.contradicted;
        return {
          id: 'L8',
          status: 'pass', // never blocks the transition — it routes it back to review
          requirement: 'FR-040',
          detail: scan.contradicted
            ? `contradicting evidence during deferral — plan re-opens for review: ${scan.findings.join('; ')}`
            : 'no contradicting evidence recorded during the deferral window',
        };
      },
    },
    {
      // Terminal-only (FR-041) — and which states are terminal comes from
      // WORKLOAD_TRANSITIONS.archive.from via statePrecondition, so the refusal
      // text follows the matrix automatically. Archiving is close + lock, never
      // deletion (FR-042): the record stays searchable afterwards (FR-043).
      id: 'L9',
      skip: forAction('archive'),
      run: () => precondition('L9', 'FR-041', statePrecondition(workload, 'archive')),
    },
    {
      // L10 last: L2/L3 answer about the official version, L10 about anything still
      // in flight beside it. All three ship in one report so a refusal names every
      // reason at once.
      id: 'L10',
      skip: forAction('complete'),
      run: () => checkL10NoLiveReview(gh, repo, input.slug),
    },
  ]);

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
