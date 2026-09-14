import type { Octokit } from '@octokit/rest';
import type { RepoRef } from './client';

/**
 * THE REQUIRED CHECK CONTEXTS, and whether they have finished running (GHI #236).
 *
 * Lives here — beside `checks.ts`, on the light side of the dashboard bundle
 * boundary — rather than in `scripts/gates/lib/readiness.ts`, which is where the
 * constant used to sit. `readiness.ts` reaches Octokit, the install manifest and the
 * environment tables, and the Builds page now needs this predicate: importing it
 * from there would drag all of that into a page's module graph, which is the class
 * of break `dashboard-bundle-boundary.test.ts` exists to catch. `readiness.ts`
 * re-exports the constant, so there is still exactly ONE definition and
 * `setup-repo.ts` keeps registering the ruleset from the same list the gates
 * publish under.
 *
 * WHY THIS EXISTS AT ALL. `build-merge` is started by the `workflow_run` completion
 * of `deliverable-gate` — but `deliverable-gate` runs TWICE on a deliverable pull
 * request: once on the `pull_request` event against the PR head, and once in the
 * sweep. The SWEEP copy's completion is what starts the merger; the `pull_request`
 * copy is the one whose check-run context the default-branch ruleset requires. Live
 * on 2026-09-12 the second was still `in_progress` when `pulls.merge` was called 27 s
 * into its 31 s job, GitHub refused the merge as a rule violation, and the refusal
 * was recorded as terminal. A green run, a pre-authorized deliverable, and 101
 * minutes of nothing (PB-017 finding 14).
 *
 * So the merger asks this question BEFORE it asks GitHub to merge, and the Builds
 * page asks it to tell "in flight" from "should have merged and did not" — one
 * predicate, two readers, no possibility of them disagreeing about what "the gate has
 * finished" means.
 */

/**
 * The check-run names the default-branch ruleset requires (`setup-repo.ts` registers
 * the ruleset FROM this list, and `deliverable-gate` publishes under these names, so
 * a rename cannot leave the ruleset requiring a context nothing reports).
 */
export const REQUIRED_CHECK_CONTEXTS = ['plan-gate', 'deliverable-gate'] as const;

/** Only the check-run fields this derivation reads. */
export interface RequiredCheckRun {
  /** the check-run name — compared against REQUIRED_CHECK_CONTEXTS */
  name: string;
  /** GitHub's check-run status: queued | in_progress | completed */
  status: string;
  /** null until the run reaches a conclusion */
  conclusion: string | null;
  /** when it started, for telling a SUPERSEDED run from the current one. Absent on a
   *  payload that carried none, which only costs ordering precision. */
  startedMs?: number | null;
  /** the monotonic check-run id — the tiebreak when two runs share a start time */
  id?: number | null;
}

/** A required context with a run that has not finished. */
export interface PendingRequiredCheck {
  context: string;
  /** `queued` or `in_progress` — what the unfinished run was doing */
  status: string;
}

/**
 * PURE: which required contexts have a run that has NOT concluded.
 *
 * A CONTEXT WITH NO RUN AT ALL IS NOT PENDING HERE, and that is a decision rather
 * than an oversight. On deliverable PR #93 nothing but the sweep ever claimed the
 * required name — the `pull_request` gate copies sat in the approval-required state,
 * executed no jobs and published no check run — and the pre-authorized merge
 * SUCCEEDED. Treating an absent context as pending would have blocked that, and
 * would block forever on any context that legitimately never runs on a `build/**`
 * branch, since nothing would ever arrive to un-block it. GitHub's ruleset remains
 * the authority on whether a missing context refuses a merge; all this function
 * removes is the RACE, which by definition is about a run that EXISTS and is still
 * going.
 *
 * Every run is examined, not merely the newest per name: the required context is
 * satisfied by NAME, so two runs sharing a name both hold it, and the one still in
 * progress is precisely the one that refused the merge live. (That is only true because
 * `listAllCheckRunsForRef` passes `filter: 'all'` — GitHub's default would hand this
 * function an already-deduplicated set and the guarantee would be empty.)
 *
 * THIS ANSWERS THE MERGER'S QUESTION ONLY: "may I ask GitHub to merge yet?" It is
 * deliberately permissive about absence and says nothing about whether a concluded run
 * PASSED. A reader who must act on the answer — the Builds page — needs
 * `classifyRequiredSuite` instead; tightening THIS predicate to serve that reader turns
 * a bounded wait into a permanent one and is the change not to make.
 */
export function pendingRequiredChecks(runs: readonly RequiredCheckRun[]): PendingRequiredCheck[] {
  const required = new Set<string>(REQUIRED_CHECK_CONTEXTS);
  return runs
    .filter((run) => required.has(run.name) && run.status !== 'completed')
    .map((run) => ({ context: run.name, status: run.status }));
}

/**
 * WHAT THE REQUIRED SUITE IS DOING, for a reader who must ACT on the answer.
 *
 * `pendingRequiredChecks` above answers the MERGER's question and is deliberately
 * permissive: an absent context is not pending, because GitHub's ruleset adjudicates
 * behind the merger and PR #93 merged in exactly that state. That permissiveness is
 * correct there and WRONG here, and the difference is what this function exists for
 * (Codex on PR #252, two findings).
 *
 * Nothing adjudicates behind the Builds page. It terminates in an assertion to a human
 * plus a remedy — so "I observed nothing" must not read as "everything concluded", and
 * "the gate said no" must not read as "the automation failed". Reaching the stall
 * verdict by the NEGATION of "a run exists and is unfinished" said both.
 *
 * Evaluated in order, first match wins:
 *   `in-flight`   a required run is queued or in progress — nothing is wrong, wait
 *   `refused`     a required run concluded outside SATISFYING — GitHub is right to
 *                 refuse, and re-running the merger cannot repair it
 *   `unobserved`  at least one required context has not reported — including the case
 *                 where none has. On a bot-opened deliverable the two gate sweeps start
 *                 independently, so a PARTIAL suite is the ordinary state for a while and
 *                 must never be read as settled. `contexts` names what is still missing
 *   `settled`     every required run concluded satisfyingly — if the pull request is
 *                 still open, the merger genuinely did not land it
 *
 * `skipped` is SATISFYING and that is not a detail: `plan-gate` reports `skipped`, never
 * `success`, on every deliverable pull request, so a naive "non-success is a failure"
 * rule would mark every healthy build refused. `neutral` likewise.
 */
export type RequiredSuiteKind = 'in-flight' | 'refused' | 'unobserved' | 'settled';

export interface RequiredSuiteVerdict {
  kind: RequiredSuiteKind;
  /** the contexts that decided it, for the operator-facing sentence */
  contexts: string[];
  /** for `refused`: the conclusions observed, aligned with `contexts` */
  conclusions: string[];
}

/** Total, deterministic "is a newer than b" — `started_at`, then the monotonic id. The
 *  same rule `listVtCheckRuns` uses for the same reason: the endpoint's ordering is not
 *  pinned by the contract, so it is stated rather than trusted. */
function isNewerRun(a: RequiredCheckRun, b: RequiredCheckRun): boolean {
  const as = a.startedMs ?? null;
  const bs = b.startedMs ?? null;
  if (as !== null && bs !== null && as !== bs) return as > bs;
  const ai = a.id ?? null;
  const bi = b.id ?? null;
  if (ai !== null && bi !== null && ai !== bi) return ai > bi;
  return false;
}

/** Conclusions that satisfy a required status check. */
const SATISFYING = new Set(['success', 'skipped', 'neutral']);

export function classifyRequiredSuite(runs: readonly RequiredCheckRun[]): RequiredSuiteVerdict {
  const required = new Set<string>(REQUIRED_CHECK_CONTEXTS);
  const mine = runs.filter((run) => required.has(run.name));
  const pending = mine.filter((run) => run.status !== 'completed');
  if (pending.length > 0) {
    return { kind: 'in-flight', contexts: [...new Set(pending.map((r) => r.name))], conclusions: [] };
  }
  // A CONCLUSION IS JUDGED ON THE CURRENT RUN PER CONTEXT, NOT ON EVERY RUN EVER
  // (Codex on PR #252, third review). `filter: 'all'` is required for the PENDING
  // question — the required context is held by name, so any unfinished run under it
  // blocks — but it also returns SUPERSEDED runs, and treating an old failure as current
  // told the operator forever that GitHub was right to refuse and that re-running the
  // merger could not help, even after a successful re-run fixed it. The two questions
  // want opposite readings of the same set, and that is why they are asked separately.
  const current = new Map<string, RequiredCheckRun>();
  for (const run of mine) {
    const incumbent = current.get(run.name);
    if (!incumbent || isNewerRun(run, incumbent)) current.set(run.name, run);
  }
  const refused = [...current.values()].filter((run) => !SATISFYING.has(run.conclusion ?? ''));
  if (refused.length > 0) {
    return { kind: 'refused', contexts: refused.map((r) => r.name), conclusions: refused.map((r) => r.conclusion ?? 'no conclusion') };
  }
  // PARTIAL OBSERVATION IS NOT SETTLEMENT (Codex on PR #252, second review). The first
  // version only recognised TOTAL absence, so one satisfying context was enough to call
  // the suite settled while another required context had never reported at all.
  //
  // That is reachable on the ordinary path, not a corner: on a bot-opened deliverable
  // the `plan-gate` and `deliverable-gate` sweeps start independently from the same
  // `build-publish` completion, so `plan-gate=skipped` is routinely visible while
  // `deliverable-gate` has not appeared yet. The Builds page would announce a merger
  // stall while GitHub was still, correctly, waiting for the missing gate.
  const reported = new Set(current.keys());
  const missing = REQUIRED_CHECK_CONTEXTS.filter((c) => !reported.has(c));
  if (missing.length > 0) return { kind: 'unobserved', contexts: missing, conclusions: [] };
  return { kind: 'settled', contexts: [...reported], conclusions: [] };
}

/** The pending contexts as one phrase, for a log line or an operator-facing row. */
export function pendingPhrase(pending: readonly PendingRequiredCheck[]): string {
  return pending.map((p) => `${p.context} (${p.status})`).join(', ');
}

/**
 * EVERY check run on one commit — `filter: 'all'`, and the flag is load-bearing.
 *
 * GitHub's default is `filter=latest`, which returns only the newest check run per
 * (name, app) group. This read's whole correctness depends on seeing EVERY run under a
 * required name, because the required context is held by NAME: two runs share it, and
 * the one that blocks a merge is whichever is still going — not whichever is newest.
 *
 * MEASURED, not inferred (Codex on PR #252, confirmed against the live target): on
 * `66aaca04`, the head of the deliverable that stalled 101 minutes, the default read
 * returns **6** check runs and `filter: 'all'` returns **8** — three `deliverable-gate`
 * runs exist and the default shows two. A read that drops runs here fails OPEN: the
 * merger concludes nothing is pending and walks straight back into the race this module
 * was written to remove.
 *
 * Paginated for the same reason `listVtCheckRuns` is: a silently truncated page would
 * report a pending gate as settled, which is the same failure by a different route.
 */
export async function listAllCheckRunsForRef(gh: Octokit, repo: RepoRef, sha: string): Promise<RequiredCheckRun[]> {
  const listed = await gh.paginate(gh.checks.listForRef, { ...repo, ref: sha, per_page: 100, filter: 'all' });
  return listed.map((raw) => {
    const started = raw.started_at ? Date.parse(raw.started_at) : Number.NaN;
    return {
      name: raw.name,
      status: raw.status,
      conclusion: raw.conclusion ?? null,
      startedMs: Number.isNaN(started) ? null : started,
      id: typeof raw.id === 'number' ? raw.id : null,
    };
  });
}

/** Every check run on one commit whose name is a required context. */
export async function listRequiredCheckRuns(gh: Octokit, repo: RepoRef, sha: string): Promise<RequiredCheckRun[]> {
  const required = new Set<string>(REQUIRED_CHECK_CONTEXTS);
  return (await listAllCheckRunsForRef(gh, repo, sha)).filter((run) => required.has(run.name));
}
