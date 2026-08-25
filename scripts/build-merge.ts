import type { Octokit } from '@octokit/rest';
import { createClient, type RepoRef } from '../dashboard/lib/github/client';
import { parseDeliverableMarker } from '../dashboard/lib/github/markers';
import { readPlanAtRef } from '../dashboard/lib/github/plans';
import { errorMessage, errorStatus } from '../dashboard/lib/github/errors';
import { resolveMergeAuthority } from './gates/lib/checks-deliverable';
import { deliverableGate } from './gates/deliverable-gate';
import { refusalDetail } from './gates/lib/runner';

/**
 * build-merge (T224) — the post-gate actor nobody had assigned.
 *
 * Two states were unreachable before this file existed (PR #115 Codex review):
 *   1. On the default `requires_operator_merge: false` path **nothing merged the
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
 * does not care who did the merging, only that it happened.
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

/** Mode 1 — merge a pre-authorized deliverable whose gate is green. */
export async function mergeIfPreAuthorized(
  gh: Octokit,
  repo: RepoRef,
  branch: string,
  opts: { requiresOperatorMerge?: boolean } = {},
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
  const { authority, reason } = resolveMergeAuthority(step, opts);
  if (authority === 'operator-merge-required') {
    // Not a failure — the intended state. The label stays `build:awaiting-merge`
    // and the portfolio surfaces it as action-required (FR-064).
    return { outcome: 'awaiting-operator', prNumber: pr.number, reason };
  }

  const report = await deliverableGate(gh, repo, pr.number);
  if (report.result !== 'pass') {
    return { outcome: 'blocked', prNumber: pr.number, reason: `deliverable-gate is red: ${refusalDetail(report.gates)}` };
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
    // 405 = not mergeable (conflicts, required checks unsatisfied, ruleset). Report
    // it as blocked rather than crashing: the PR is still there and still correct,
    // and the operator can merge it themselves.
    return { outcome: 'blocked', prNumber: pr.number, reason: errorMessage(error) };
  }
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
  const run = has('closed')
    ? transitionOnClose(gh, repo, Number(get('pr')))
    : mergeIfPreAuthorized(gh, repo, get('branch') ?? '', { requiresOperatorMerge });
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
