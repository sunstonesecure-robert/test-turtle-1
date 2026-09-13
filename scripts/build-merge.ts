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
 * `templates/workflows/build-merge.yml` carries the backstop for a wait that expires
 * (a `check_suite: completed` trigger), so nothing here has to succeed on the first try.
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
   * the workflow's `check_suite` trigger brings another sweep when the gate concludes.
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
 *  minutes — long enough that the ordinary race never reaches the backstop, short
 *  enough that a genuinely stuck gate does not burn the job. */
const WAIT_BUDGET_MS = 5 * 60 * 1000;
const WAIT_POLL_MS = 10 * 1000;

/**
 * Wait until no required context has a run still going on `sha`, and report what was
 * still pending when the budget ran out (empty = settled).
 *
 * THE WAIT IS BOUNDED AND ITS EXPIRY IS NOT A FAILURE. The `check_suite: completed`
 * trigger on this workflow brings another sweep when the gate concludes, so an expired
 * wait costs one more sweep rather than a stall — belt and braces for a chain that has
 * now produced three distinct silent stalls (T245, GHI #228, and this one), each for a
 * different reason.
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
        "(this workflow's check_suite trigger, or Actions → build-merge → Run workflow) will find it",
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
    await setBuildLabel(gh, repo, pr.number, 'build:merged');
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
    // so the Builds page keeps showing it and the backstop sweep retries it.
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
): Promise<MergeOutcome[]> {
  // A thrown operational failure propagates out of here by design (see the catch in
  // `mergeIfPreAuthorized`): one unmergeable pull request is a result, but a broken
  // API is a broken sweep, and finishing the loop quietly would hide it.
  const open = await gh.paginate(gh.pulls.list, { ...repo, state: 'open', per_page: 100 });
  const out: MergeOutcome[] = [];
  for (const pr of open) {
    if (!pr.head.ref.startsWith('build/')) continue;
    if (!parseDeliverableMarker(pr.body ?? '')) continue;
    out.push(await mergeIfPreAuthorized(gh, repo, pr.head.ref, opts));
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
    void sweepMergeable(gh, repo, opts)
      .then((results) => {
        if (results.length === 0) console.log('no open deliverable pull requests — nothing to merge');
        for (const r of results) console.log(JSON.stringify(r));
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
        // not: it declined to ask a question whose answer was not ready. The retry is
        // the workflow's own backstop trigger, not an operator re-running a red job.
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
