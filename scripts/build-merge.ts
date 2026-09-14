import { appendFileSync } from 'node:fs';
import type { Octokit } from '@octokit/rest';
import { createClient, type RepoRef } from '../dashboard/lib/github/client';
import { parseDeliverableMarker } from '../dashboard/lib/github/markers';
import { readPlanAtRef } from '../dashboard/lib/github/plans';
import { errorMessage, errorStatus } from '../dashboard/lib/github/errors';
import { listPullRequestPaths, resolveMergeAuthority } from '../dashboard/lib/github/builds';
import { deliverableGate } from './gates/deliverable-gate';
import { refusalDetail } from './gates/lib/runner';
import { checkpointPathsTouched, parseCheckpointPaths, CHECKPOINT_PATHS_VARIABLE } from './gates/lib/checkpoint-paths';
import {
  listRequiredCheckRuns,
  pendingRequiredChecks,
  pendingPhrase,
  type PendingRequiredCheck,
} from '../dashboard/lib/github/required-checks';

/**
 * build-merge (T224) — the post-gate actor nobody had assigned.
 *
 * Two states were unreachable before this file existed (PR #115 Codex review):
 *   1. On the repository default path — `BUILD_REQUIRES_OPERATOR_MERGE` unset, no
 *      checkpoint path touched, the step not high-stakes — **nothing merged the
 *      pull request.** `build-publish` opens it, `deliverable-gate` judges it,
 *      `resolveMergeAuthority` names the authority, and the dashboard deliberately
 *      shows no button for a pre-authorized PR — so the default tracer stalled
 *      forever one step before verification.
 *   2. Nothing ever replaced `build:awaiting-merge`, so a merged deliverable stayed
 *      action-required in the portfolio permanently.
 *
 * Two modes, matching the two triggers:
 *   `--branch build/<slug>/<step>`  after the gate completes: merge IF and only if
 *                                   authority resolves to `pre-authorized`
 *   `--pr <n> --closed`             on the pull_request close event: transition the
 *                                   `build:*` label to merged or refused
 *
 * IT RE-RUNS THE GATE RATHER THAN READING ITS CHECK RUN. A check run is a record of
 * what the gate said at some past moment about some past commit; merging on it means
 * merging on a claim. Re-running `deliverableGate` in-process costs a few API calls
 * and makes the merge conditional on the gate's verdict about the code being merged
 * — so this actor can never land something the gate would refuse, even if a stale
 * green check run is sitting on the PR.
 *
 * IT NEVER MERGES AN OPERATOR-REQUIRED PULL REQUEST. That PR waits for the human,
 * and the label transition still applies when they merge it — the close-event mode
 * does not care who did the merging, only that it happened. Since 2026-08-29 (T274,
 * GHI #163 option 3) "operator-required" is also decided by WHAT THE DIFF TOUCHES: a
 * subject workflow (`.github/workflows/<workload-slug>_*.yml`, FR-069; ANY workload's
 * prefix — see `checkpoint-paths.ts`, T279) always waits, and so
 * does any path inside a `CHECKPOINT_PATHS` glob — so this actor reads the pull
 * request's files before it reads anything else, and a checkpoint path is a reason
 * to stop, never a thing to merge around.
 *
 * IT WAITS FOR THE REQUIRED CONTEXTS TO CONCLUDE BEFORE IT ASKS (GHI #236, options 2
 * and 1; operator decision 2026-09-13). `deliverable-gate` runs TWICE on a deliverable
 * pull request — once on `pull_request` against the PR head, once in the sweep — and
 * the SWEEP copy's completion is what starts this workflow while the `pull_request`
 * copy may still be running. Live on 2026-09-12 that copy was 27 s into a 31 s job when
 * `pulls.merge` was called; GitHub refused the merge as a rule violation
 * (*"Required status check \"deliverable-gate\" is in progress"*), the refusal was
 * recorded as `blocked`, and `blocked` exits the sweep SUCCESSFULLY. A pre-authorized
 * deliverable that would have merged thirty seconds later sat open for 101 minutes
 * behind a green run, with the dashboard correctly reporting that nothing was required
 * of the operator (PB-017 finding 14).
 *
 * So: the required contexts are polled until every run under those names has CONCLUDED
 * before the merge is attempted, which makes the refusal impossible rather than merely
 * recoverable. And a transient answer that still slips through — GitHub's own
 * *"is in progress"*, *"is expected"*, *"Base branch was modified"* — is recorded as
 * `waiting-on-checks`, NOT as `blocked`: it is a statement about this instant, not
 * about this pull request, and the two must never be filed under one word again.
 * A wait that EXPIRES leaves a visible hold, not a silent one: `waiting-on-checks` is
 * recorded, the Builds page names it, and an operator clears it with a no-input dispatch.
 * There is no automatic retry — the `check_suite` backstop this file used to promise was
 * measured inert (45 runs, zero) and removed. See `waitForRequiredChecks` below.
 *
 * WHY IT NEEDS NO RULESET BYPASS. `setup-repo.ts` grants the main ruleset's only
 * bypass to the repo-admin role; the `github-actions` Integration deliberately holds
 * none (GHI #44). This actor does not need one: it merges a pull request whose
 * required checks are green, which is the ordinary path the rules exist to permit.
 * A bypass here would mean automation could land work the gates refused, which is
 * the whole thing the gates are for.
 */

export type MergeOutcome =
  | { outcome: 'merged'; prNumber: number; sha: string }
  | { outcome: 'awaiting-operator'; prNumber: number; reason: string }
  | { outcome: 'blocked'; prNumber: number; reason: string }
  /**
   * NOT TERMINAL, and that is the whole point (GHI #236). `blocked` means "this pull
   * request cannot be merged, and a human must do something about it"; this means
   * "nothing is wrong and the answer is not available yet". They were the same word
   * until 2026-09-13, which is how a deliverable that was thirty seconds from merging
   * came to be filed as permanently refused behind a green run. Exits the sweep
   * successfully like `blocked` does, but the Builds page reads it as a live state and
   * the next sweep — an operator's dispatch, or the next deliverable's gate — finds it.
   */
  | { outcome: 'waiting-on-checks'; prNumber: number; reason: string; pending: PendingRequiredCheck[] }
  | { outcome: 'no-pr'; branch: string }
  | { outcome: 'labelled'; prNumber: number; label: string };

async function setBuildLabel(gh: Octokit, repo: RepoRef, prNumber: number, label: string): Promise<void> {
  // Exactly one `build:*` at a time (labels.ts EXCLUSIVE_FAMILIES). Add first, then
  // remove the others: a PR briefly carrying two states is recoverable, one carrying
  // none is invisible to every reader that searches by label.
  await gh.issues.addLabels({ ...repo, issue_number: prNumber, labels: [label] }).catch(() => undefined);
  for (const other of ['build:awaiting-merge', 'build:merged', 'build:refused']) {
    if (other === label) continue;
    await gh.issues.removeLabel({ ...repo, issue_number: prNumber, name: other }).catch((error: unknown) => {
      if (errorStatus(error) !== 404) throw error; // 404 = it was not there, which is the goal
    });
  }
}

/** What the merger reads besides the pull request: the repository checkpoint and the
 *  operator's CHECKPOINT_PATHS globs, both from the workflow's env. */
export interface MergeOptions {
  requiresOperatorMerge?: boolean;
  checkpointGlobs?: readonly string[];
  /** passed straight to `waitForRequiredChecks` — the tests inject a fake clock and
   *  sleep so the wait's re-read is proved without spending real seconds */
  wait?: Parameters<typeof waitForRequiredChecks>[3];
  /** called the instant `pulls.merge` returns and BEFORE any ancillary write, so a merge
   *  can never be performed without being recorded and verified (Codex on PR #252) */
  onMerged?: (merged: { prNumber: number; sha: string }) => Promise<void>;
}

/**
 * GitHub's own words for "not yet", as opposed to "no" (GHI #236).
 *
 * Every one of these is a statement about THIS INSTANT that a later attempt can
 * answer differently: a required context whose run has not finished, a base branch
 * that moved while the merge was being formed, a mergeable state GitHub has not
 * computed yet. A failing required check or a real rule violation is not here, and
 * must not be — those are answers about the pull request, and `blocked` is the right
 * word for them.
 *
 * Matched on the message because that is the only place GitHub says which it is: the
 * transient and the terminal refusal arrive under the SAME 405, which is exactly how
 * the PR #145 narrowing — written to stop an operational failure being filed as
 * `blocked` — let a transient one through into the same trap one layer down.
 */
const TRANSIENT_REFUSAL = [
  /is in progress/i,
  /is expected/i,
  /Base branch was modified/i,
  /mergeable state is unknown/i,
];

export function isTransientMergeRefusal(message: string): boolean {
  return TRANSIENT_REFUSAL.some((re) => re.test(message));
}

/** How long the merger waits for the required contexts, and how often it looks.
 *  Five minutes because the live case settled in 31 s and the job's own cap is 10
 *  minutes — long enough that the ordinary race settles well inside it, short enough
 *  that a genuinely stuck gate does not burn the job. Shared across the whole sweep, not
 *  per candidate (see `sweepMergeable`). */
const WAIT_BUDGET_MS = 5 * 60 * 1000;
const WAIT_POLL_MS = 10 * 1000;

/**
 * Wait until no required context has a run still going on `sha`, and report what was
 * still pending when the budget ran out (empty = settled).
 *
 * THE WAIT IS BOUNDED, AND ITS EXPIRY IS A VISIBLE STALL AN OPERATOR CLEARS. This
 * docblock used to promise that a `check_suite: completed` trigger brought another
 * sweep. It never did: GitHub's anti-recursion rule suppresses every event caused by
 * `GITHUB_TOKEN`, and a check suite in a governed repo is created by the Actions app.
 * Measured on test-turtle-1 2026-09-13 — 45 `build-merge` runs, ZERO on `check_suite`,
 * with the trigger installed and check suites completing throughout. The same rule kills
 * the other candidate: the `pull_request` copy of `deliverable-gate` carries
 * `actor = github-actions[bot]`, so its completion fires no `workflow_run` either (gate
 * run 34697342001 on PR #94 concluded `success` with no `build-merge` behind it).
 *
 * Only `workflow_dispatch`, `repository_dispatch` and `schedule` are delivered here, and
 * this workflow takes none of them automatically — a scheduled sweep is a standing
 * decision against (see the workflow header). So when this wait expires the deliverable
 * stays open, `waiting-on-checks` is recorded, the Builds page names the hold, and the
 * operator clears it with *Actions → build-merge → Run workflow*. That is a real hole in
 * the unattended path, stated rather than papered over (operator decision 2026-09-13,
 * option A). What removes the RACE that causes it is a change one layer up:
 * `deliverable-gate` no longer runs its `pull_request` copy for a bot-opened deliverable,
 * so no second in-progress required context is ever created.
 *
 * `sleep` is injectable so the tests do not spend real seconds proving the loop
 * re-reads; nothing else about the wait changes between the two.
 */
export async function waitForRequiredChecks(
  gh: Octokit,
  repo: RepoRef,
  sha: string,
  opts: { budgetMs?: number; pollMs?: number; now?: () => number; sleep?: (ms: number) => Promise<void> } = {},
): Promise<PendingRequiredCheck[]> {
  const budgetMs = opts.budgetMs ?? WAIT_BUDGET_MS;
  const pollMs = opts.pollMs ?? WAIT_POLL_MS;
  const now = opts.now ?? (() => Date.now());
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const deadline = now() + budgetMs;
  let pending = pendingRequiredChecks(await listRequiredCheckRuns(gh, repo, sha));
  while (pending.length > 0 && now() < deadline) {
    console.log(
      `required check ${pendingPhrase(pending)} on ${sha.slice(0, 8)} has not concluded — waiting up to ` +
        `${Math.round(budgetMs / 1000)}s before asking GitHub to merge (GHI #236)`,
    );
    await sleep(pollMs);
    pending = pendingRequiredChecks(await listRequiredCheckRuns(gh, repo, sha));
  }
  return pending;
}

/** Mode 1 — merge a pre-authorized deliverable whose gate is green. */
export async function mergeIfPreAuthorized(
  gh: Octokit,
  repo: RepoRef,
  branch: string,
  opts: MergeOptions = {},
): Promise<MergeOutcome> {
  const { data: open } = await gh.pulls.list({ ...repo, head: `${repo.owner}:${branch}`, state: 'open', per_page: 10 });
  const pr = open[0];
  if (!pr) return { outcome: 'no-pr', branch };

  const marker = parseDeliverableMarker(pr.body ?? '');
  if (!marker) {
    return { outcome: 'blocked', prNumber: pr.number, reason: 'no deliverable:v1 marker — this is not a deliverable pull request' };
  }
  const plan = await readPlanAtRef(gh, repo, marker.planRef).catch(() => null);
  const step = plan?.steps.find((s) => s.id === marker.stepId) ?? null;
  // The diff, read the same way the gate and the dashboard read it, so all three agree
  // on what this change touches — a subject workflow or an operator-listed path makes
  // it operator-required whatever the repository setting says (T274).
  const touched = await listPullRequestPaths(gh, repo, pr.number);
  const checkpointPaths = checkpointPathsTouched(touched, opts.checkpointGlobs ?? []);
  const { authority, reason } = resolveMergeAuthority(step, { requiresOperatorMerge: opts.requiresOperatorMerge, checkpointPaths });
  if (authority === 'operator-merge-required') {
    // Not a failure — the intended state. The label stays `build:awaiting-merge`
    // and the portfolio surfaces it as action-required (FR-064).
    return { outcome: 'awaiting-operator', prNumber: pr.number, reason };
  }

  const report = await deliverableGate(gh, repo, pr.number);
  if (report.result !== 'pass') {
    return { outcome: 'blocked', prNumber: pr.number, reason: `deliverable-gate is red: ${refusalDetail(report.gates)}` };
  }

  // THE RACE, CLOSED BEFORE IT IS RUN (GHI #236). The gate's own verdict above is
  // about the CODE; this is about whether GitHub's ruleset will currently accept a
  // merge. They are different questions and only the second is time-dependent: the
  // `pull_request` copy of deliverable-gate can still be running while the sweep copy
  // that started this workflow has already finished. Asked here rather than let
  // GitHub refuse, so the refusal becomes impossible rather than merely recoverable.
  const pending = await waitForRequiredChecks(gh, repo, pr.head.sha, opts.wait);
  if (pending.length > 0) {
    return {
      outcome: 'waiting-on-checks',
      prNumber: pr.number,
      reason:
        `required check ${pendingPhrase(pending)} has not concluded on ${pr.head.sha.slice(0, 8)} — not merged, and ` +
        'NOT blocked: nothing is wrong with this deliverable and the answer is not available yet. The next sweep ' +
        'will find it — an operator dispatch (Actions → build-merge → Run workflow, no inputs), or the next ' +
        "deliverable's gate. Nothing retries on its own",
      pending,
    };
  }

  try {
    const { data } = await gh.pulls.merge({
      ...repo,
      pull_number: pr.number,
      merge_method: 'merge',
      commit_title: `${pr.title} (#${pr.number})`,
      commit_message:
        `Pre-authorized by the approved plan (FR-062).\n\n` +
        `plan: ${marker.planRef}\nstep: ${marker.stepId}\nexecutor: ${marker.executorId}\nbuild run: ${marker.runId}\n`,
    });
    // RECORDED AND VERIFIED BEFORE ANY ANCILLARY WRITE (Codex on PR #252, third review).
    //
    // `setBuildLabel` used to sit between the merge and the caller learning about it, and
    // it can throw: `removeLabel` rethrows anything that is not a 404. A failure there —
    // or a cancellation in that window — meant `mergeIfPreAuthorized` never returned, so
    // the sweep's callback never fired: no `BM_RESULTS_FILE` line, no `build-verify`
    // dispatch. And the pull request is MERGED by then, so no later sweep can find it
    // (`sweepMergeable` lists `state: 'open'` only). An unverified merge on the default
    // branch, unreachable by any retry.
    //
    // The ordering is now: merge → record and dispatch → label. The label is the only one
    // of the three that is recoverable on its own — the `pull_request` close event runs
    // `transitionOnClose`, which sets it from the merge GitHub already performed.
    await opts.onMerged?.({ prNumber: pr.number, sha: data.sha });
    try {
      await setBuildLabel(gh, repo, pr.number, 'build:merged');
    } catch (error: unknown) {
      // Loud, and NOT fatal. The merge happened, it is recorded and its verification has
      // started; losing the outcome now because a label write failed would undo the whole
      // point of the ordering above.
      console.error(
        `merged PR #${pr.number} but could not set build:merged (${errorMessage(error)}) — the close event's ` +
          'transition will set it; the merge and its verification are unaffected',
      );
    }
    return { outcome: 'merged', prNumber: pr.number, sha: data.sha };
  } catch (error: unknown) {
    // ONLY THE EXPECTED NON-MERGEABLE ANSWERS BECOME `blocked` (Codex on PR #145,
    // 2026-08-25). This catch used to swallow everything, and `blocked` exits the
    // sweep successfully — so a timeout, a secondary rate limit, an auth failure or a
    // 5xx left a pre-authorized deliverable sitting open with a GREEN workflow, while
    // the dashboard correctly told the operator that nothing was required of them.
    // Nobody would ever have looked.
    //
    //   405 / 409  not mergeable: conflicts, required checks unsatisfied, a ruleset.
    //              A real answer about this pull request, and the operator can merge
    //              it themselves — `blocked` with the reason is exactly right.
    //   422        GitHub's other "cannot merge as asked" response.
    //   anything   an operational failure that says nothing about mergeability. It
    //   else       must fail the run so the retry is visible — and `workflow_dispatch`
    //              on this workflow is what an operator uses to re-run the sweep.
    //
    // AND A TRANSIENT ANSWER IS NOT A TERMINAL ONE (GHI #236, 2026-09-13). The wait
    // above makes this branch rare rather than impossible — a context can go back in
    // progress, or the base branch can move, between the last poll and the merge call
    // — and the two arrive under the SAME 405. Recorded as `waiting-on-checks`, which
    // exits the sweep successfully like `blocked` but says "not yet" instead of "no",
    // so the Builds page keeps showing it and the next sweep can still land it.
    const status = errorStatus(error);
    if (status === 405 || status === 409 || status === 422) {
      const message = errorMessage(error);
      if (isTransientMergeRefusal(message)) {
        return {
          outcome: 'waiting-on-checks',
          prNumber: pr.number,
          reason: `${message} — transient, so this is NOT recorded as blocked; the next sweep will retry it`,
          pending: [],
        };
      }
      return { outcome: 'blocked', prNumber: pr.number, reason: message };
    }
    throw error;
  }
}

/**
 * SWEEP — every open deliverable pull request, not one named branch.
 *
 * Same reasoning as the gate's sweep, and the same live cause: the pull request is
 * opened by `GITHUB_TOKEN`, so no `pull_request` event fires for it and there is no
 * reliable branch name in the triggering payload to key on. Asking "which
 * pre-authorized deliverables are green and unmerged?" needs no event archaeology and
 * is self-healing — a merge whose run was lost is picked up on the next sweep.
 */
export async function sweepMergeable(
  gh: Octokit,
  repo: RepoRef,
  opts: MergeOptions = {},
  /** called the instant each outcome is formed and AWAITED before the next candidate is
   *  touched — see ONE DEADLINE FOR THE WHOLE SWEEP below for why the caller needs this,
   *  and the CLI for why it starts verification from here rather than after the loop */
  onOutcome?: (outcome: MergeOutcome) => void | Promise<void>,
): Promise<MergeOutcome[]> {
  // A thrown operational failure propagates out of here by design (see the catch in
  // `mergeIfPreAuthorized`): one unmergeable pull request is a result, but a broken
  // API is a broken sweep, and finishing the loop quietly would hide it.
  const open = await gh.paginate(gh.pulls.list, { ...repo, state: 'open', per_page: 100 });
  const out: MergeOutcome[] = [];
  // ONE DEADLINE FOR THE WHOLE SWEEP, not one per candidate (Codex on PR #252).
  //
  // Each candidate used to get the FULL five-minute wait, serially, under a job whose
  // own cap is ten minutes. Two slow candidates plus checkout, setup-node and `npm ci`
  // already exceed it — and a job cancelled at the cap takes the process down mid-loop,
  // so merges this sweep ALREADY MADE were never printed and never recorded. The dispatch
  // step then starts no verification for them, and a `GITHUB_TOKEN` merge emits no
  // `push` to start one by any other route: an unverified merge sitting on the default
  // branch behind a GREEN build-merge run. `sweepMergeable` lists `state: 'open'` only,
  // so the merged-but-unrecorded pull request is never found again by a later sweep.
  //
  // The budget is therefore shared. A later candidate inherits whatever is left, and
  // `budgetMs: 0` degrades to exactly one reading and a `waiting-on-checks` — a state
  // this file already produces correctly and the next sweep resolves.
  const now = opts.wait?.now ?? (() => Date.now());
  const sweepDeadline = now() + (opts.wait?.budgetMs ?? WAIT_BUDGET_MS);
  for (const pr of open) {
    if (!pr.head.ref.startsWith('build/')) continue;
    if (!parseDeliverableMarker(pr.body ?? '')) continue;
    const outcome = await mergeIfPreAuthorized(gh, repo, pr.head.ref, {
      ...opts,
      wait: { ...opts.wait, budgetMs: Math.max(0, sweepDeadline - now()) },
    });
    out.push(outcome);
    // RECORDED BEFORE THE NEXT CANDIDATE IS TOUCHED. Printing only after the whole
    // sweep resolves is the other half of the defect above: a throw or a cancellation
    // mid-loop loses every outcome already formed.
    await onOutcome?.(outcome);
  }
  return out;
}

/** Mode 2 — the close event. Who merged it is not this function's business. */
export async function transitionOnClose(gh: Octokit, repo: RepoRef, prNumber: number): Promise<MergeOutcome> {
  const { data: pr } = await gh.pulls.get({ ...repo, pull_number: prNumber });
  const label = pr.merged ? 'build:merged' : 'build:refused';
  await setBuildLabel(gh, repo, prNumber, label);
  return { outcome: 'labelled', prNumber, label };
}

const isMain = process.argv[1]?.endsWith('build-merge.ts');
if (isMain) {
  const argv = process.argv.slice(2);
  const get = (name: string): string | undefined => {
    const i = argv.indexOf(`--${name}`);
    return i >= 0 && argv[i + 1] && !argv[i + 1]!.startsWith('--') ? argv[i + 1] : undefined;
  };
  const has = (name: string): boolean => argv.includes(`--${name}`);
  const repoArg = get('repo');
  const [owner, repoName] = (repoArg ?? '').split('/');
  if (!owner || !repoName) {
    console.error('usage: build-merge --repo <owner/repo> (--branch <build/...> | --pr <n> --closed)');
    process.exit(2);
  }
  const gh = createClient();
  const repo = { owner, repo: repoName };
  const requiresOperatorMerge = /^(1|true|yes)$/i.test(process.env.BUILD_REQUIRES_OPERATOR_MERGE ?? '');
  // Passed through by the workflow as an env var of the same name as the repository
  // variable (CONFIGURATION_GUIDE.md §3), next to BUILD_REQUIRES_OPERATOR_MERGE.
  const checkpointGlobs = parseCheckpointPaths(process.env[CHECKPOINT_PATHS_VARIABLE]);
  const opts: MergeOptions = { requiresOperatorMerge, checkpointGlobs };
  if (has('sweep')) {
    // A blocked pull request is NOT a failed sweep: it is a correct outcome recorded
    // (the gate is red, or the operator's merge is required). Exiting non-zero would
    // turn "waiting for a human" into a red run, which is exactly the misreading
    // FR-067 forbids on the operator's own surfaces.
    // WRITTEN AS THEY HAPPEN, not collected and printed at the end (Codex on PR #252).
    // `| tee` cannot save this: the shell buffers, and a job cancelled at its timeout
    // takes the process down with the buffer unflushed. An unbuffered append per outcome
    // is what survives both the mid-loop throw this file deliberately propagates and the
    // SIGTERM a job-level timeout sends — and the record is what the workflow's dispatch
    // step reads to start verification for each merge. A merge that HAPPENED must always
    // be recorded and verified, even when the sweep around it did not finish.
    const resultsFile = process.env.BM_RESULTS_FILE;
    // VERIFICATION IS STARTED HERE, PER MERGE, NOT AFTER THE LOOP (Codex on PR #252,
    // second review). The previous shape recorded each merge to a runner-local file and
    // left a later workflow STEP to dispatch verification for all of them. `always()`
    // does not rescue that: `timeout-minutes` cancels the JOB, and a runner-local file
    // dies with it — so a merge that had already landed could end up on the default
    // branch with no verification and no record, and `sweepMergeable` lists OPEN pull
    // requests only, so no later sweep would ever find it again.
    //
    // Starting the verify run immediately after `pulls.merge` returns makes the two
    // atomic in the only sense that matters: nothing between them can be lost. The
    // workflow step remains as a BACKSTOP for anything this missed. A `workflow_dispatch`
    // made with GITHUB_TOKEN is the documented exemption to the anti-recursion rule and
    // is proven here twice (E1a).
    const failures: string[] = [];
    const defaultBranch = process.env.BM_DEFAULT_BRANCH;
    const append = (line: string): void => {
      if (!resultsFile) return;
      try {
        appendFileSync(resultsFile, `${line}\n`);
      } catch (error: unknown) {
        // NOT swallowed. stderr does not fail a step — the comment here used to claim it
        // did, and it was wrong. Collected, and the run exits 1 below, because a merge
        // nobody recorded is a merge nobody verifies.
        failures.push(`could not append to BM_RESULTS_FILE (${resultsFile}): ${errorMessage(error)}`);
      }
    };
    // CALLED BEFORE ANY ANCILLARY WRITE, so a merge cannot exist without its record and
    // its verification (Codex on PR #252, third review).
    //
    // `verifyDispatched` is what stops the workflow's backstop step dispatching a SECOND
    // run for every merge (same review). Nothing recorded whether this succeeded, so the
    // backstop re-dispatched unconditionally: two verify runs per merge, double the cost,
    // and a duplicate result able to supersede the first. The backstop now dispatches
    // only the merges whose line says verification did NOT start.
    const onMerged = async ({ prNumber, sha }: { prNumber: number; sha: string }): Promise<void> => {
      let verifyDispatched = false;
      if (!defaultBranch) {
        failures.push(`merged PR #${prNumber} but BM_DEFAULT_BRANCH is unset, so no build-verify run was started`);
      } else {
        try {
          await gh.actions.createWorkflowDispatch({
            ...repo,
            workflow_id: 'build-verify.yml',
            ref: defaultBranch,
            inputs: { commit: sha },
          });
          verifyDispatched = true;
          console.log(`started build-verify for merge commit ${sha} (E1: expect a run with event=workflow_dispatch)`);
        } catch (error: unknown) {
          // EVERY merge is still attempted — one refused dispatch must not leave the later
          // merges undispatched and unnamed (PR #204 finding F9). Collected, reported with
          // its by-hand remedy, and the backstop step will try this sha again.
          failures.push(
            `merged PR #${prNumber} → ${sha} but could not start build-verify: ${errorMessage(error)}. ` +
              `The backstop step will retry it; by hand: gh workflow run build-verify.yml -f commit=${sha}`,
          );
        }
      }
      append(JSON.stringify({ outcome: 'merged', prNumber, sha, verifyDispatched }));
    };
    // The JSONL line for a merge is written by `onMerged` above, before the label write;
    // this records every OTHER outcome, and prints them all.
    const record = (r: MergeOutcome): void => {
      console.log(JSON.stringify(r));
      if (r.outcome !== 'merged') append(JSON.stringify(r));
    };
    void sweepMergeable(gh, repo, { ...opts, onMerged }, record)
      .then((results) => {
        if (results.length === 0) console.log('no open deliverable pull requests — nothing to merge');
        if (failures.length > 0) {
          for (const f of failures) console.error(f);
          // A merge that landed without its verification started, or without its record
          // written, is the silent-stall class this whole file exists to close. It must
          // be loud.
          process.exit(1);
        }
      })
      .catch((error) => {
        console.error(errorMessage(error));
        process.exit(1);
      });
  } else {
  const run = has('closed')
    ? transitionOnClose(gh, repo, Number(get('pr')))
    : mergeIfPreAuthorized(gh, repo, get('branch') ?? '', opts);
  run
    .then((result) => {
      switch (result.outcome) {
        case 'merged':
          console.log(`merged PR #${result.prNumber} → ${result.sha}`);
          break;
        case 'awaiting-operator':
          console.log(`PR #${result.prNumber} waits for the operator's own merge: ${result.reason}`);
          break;
        case 'blocked':
          console.error(`PR #${result.prNumber} not merged: ${result.reason}`);
          process.exit(1);
          break;
        // EXIT 0, deliberately. A red run here would say the merger failed, and it did
        // not: it declined to ask a question whose answer was not ready. What clears it
        // is the next sweep — the operator's own dispatch, or the one the next
        // deliverable's gate starts. NOT a `check_suite` retry: that trigger never fired
        // and has been removed (GHI #236 follow-up, Codex on PR #252).
        case 'waiting-on-checks':
          console.log(`PR #${result.prNumber} not merged yet: ${result.reason}`);
          break;
        case 'no-pr':
          console.log(`no open deliverable pull request for ${result.branch}`);
          break;
        case 'labelled':
          console.log(`PR #${result.prNumber} → ${result.label}`);
          break;
      }
    })
    .catch((error) => {
      console.error(errorMessage(error));
      process.exit(1);
    });
  }
}
