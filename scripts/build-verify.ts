import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { Octokit } from '@octokit/rest';
import { createClient, type RepoRef } from '../dashboard/lib/github/client';
import { readPlanAtRef } from '../dashboard/lib/github/plans';
import { parseDeliverableMarker } from '../dashboard/lib/github/markers';
import { errorMessage } from '../dashboard/lib/github/errors';
import type { PlanDoc } from '../schemas/plan';
import type { CheckConclusion } from './vt-report';

/**
 * build-verify (T211) — verification executed against the MERGED deliverable commit.
 *
 * This is what makes completion earnable against code that exists. Before US18 the
 * build agent verified the FROZEN TREE, because nothing in the system could produce
 * anything else — so `vt-*` check runs described a commit that never contained the
 * work, and a completion could be earned on a lie (GHI #141). Verification now runs
 * on the merged commit and its results are recorded there (FR-063).
 *
 * DETERMINISTIC WHERE THE PLAN MADE IT SO. `VerificationTarget.check` is prose an
 * operator judged; `VerificationTarget.run` (T223) is its executable form — one
 * shell command whose exit status is the verdict. When a target carries `run`, no
 * model is involved at all: the result is reproducible, costs nothing, and the
 * operator approved the exact command that judges their work (constitution:
 * Deterministic-First Execution). That is the path this file implements.
 *
 * A TARGET WITH NO `run` IS NOT REPORTED, AND THAT IS THE POINT. It cannot be
 * verified deterministically, so this runner emits no result for it — and L3 fails
 * closed on a MUST target with no check run, which means completion stays refused
 * until either the plan is re-opened to add `run` or a conformant executor is
 * invoked in verify mode to interpret the prose. What it must never do is report
 * something for a target it did not actually check: that is the exact shape of the
 * failure this whole file exists to close.
 *
 * THE COMMANDS RUN WITHOUT CREDENTIALS. `GITHUB_TOKEN` and friends are stripped from
 * the child environment before any target executes. The plan is operator-approved,
 * but "approved" is not "trusted with the repository's write scope" — a verification
 * target's job is to look at the tree and say pass or fail, and nothing it needs is
 * in a token.
 */

/** Environment variables a verification target must never inherit. */
const CREDENTIAL_ENV = [
  'GITHUB_TOKEN',
  'GH_TOKEN',
  'GH_APP_PRIVATE_KEY',
  'GH_APP_ID',
  'GH_APP_INSTALLATION_ID',
  'ANTHROPIC_API_KEY',
  'NPM_TOKEN',
];

export interface VerifyOutcome {
  planRef: string;
  results: { id: string; conclusion: CheckConclusion }[];
  /** MUST-mapped targets that carry no `run` and were therefore NOT reported */
  unexecutable: string[];
}

/** The MUST-mapped targets — the only ones completion (L3) reads. A SHOULD/COULD
 *  target is still verified when it carries `run`, because a result the plan can
 *  explain is always worth recording; it simply does not gate anything. */
export function targetsToVerify(plan: PlanDoc): PlanDoc['verification_targets'] {
  return plan.verification_targets;
}

export function mustMappedTargetIds(plan: PlanDoc): string[] {
  const must = new Set(plan.steps.filter((s) => s.priority === 'MUST').map((s) => s.id));
  return plan.verification_targets.filter((vt) => vt.maps_to.some((id) => must.has(id))).map((vt) => vt.id);
}

export function runVerification(plan: PlanDoc, planRef: string, cwd: string): VerifyOutcome {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const key of CREDENTIAL_ENV) delete env[key];

  const results: { id: string; conclusion: CheckConclusion }[] = [];
  const unexecutable: string[] = [];
  const mustIds = new Set(mustMappedTargetIds(plan));

  for (const target of targetsToVerify(plan)) {
    if (!target.run) {
      if (mustIds.has(target.id)) unexecutable.push(target.id);
      console.log(`– ${target.id}: no \`run\` — not executable deterministically, NOT reported`);
      continue;
    }
    const started = Date.now();
    const proc = spawnSync('bash', ['-euo', 'pipefail', '-c', target.run], {
      cwd,
      env,
      encoding: 'utf8',
      timeout: 5 * 60 * 1000,
      maxBuffer: 8 * 1024 * 1024,
    });
    // A timeout, a missing shell, or a signal are NOT "failure" in the sense the
    // target means — they are the verification not having happened. `timed_out`
    // and `action_required` say so, and L3 treats every non-success as unmet, so
    // neither can be mistaken for a pass.
    const conclusion: CheckConclusion =
      proc.error && /ETIMEDOUT|timed out/i.test(String(proc.error.message))
        ? 'timed_out'
        : proc.error
          ? 'action_required'
          : proc.status === 0
            ? 'success'
            : 'failure';
    const ms = Date.now() - started;
    console.log(`${conclusion === 'success' ? '✓' : '✗'} ${target.id} (${ms}ms) — ${target.run}`);
    if (proc.stdout?.trim()) console.log(`  stdout: ${proc.stdout.trim().slice(0, 2000)}`);
    if (proc.stderr?.trim()) console.log(`  stderr: ${proc.stderr.trim().slice(0, 2000)}`);
    results.push({ id: target.id, conclusion });
  }
  return { planRef, results, unexecutable };
}

export async function buildVerify(
  gh: Octokit,
  repo: RepoRef,
  planRef: string,
  cwd: string,
): Promise<VerifyOutcome> {
  const plan = await readPlanAtRef(gh, repo, planRef);
  return runVerification(plan, planRef, cwd);
}

/**
 * Which frozen plan (if any) a commit on the default branch is the merged
 * deliverable of.
 *
 * The verify workflow is triggered by a PUSH to the default branch, deliberately:
 * that makes the run's own `head_sha` the merged commit, which is what `vt-report`
 * binds against and what the check runs must land on. But most pushes are not
 * deliverable merges, so the run has to be able to say "not one of mine" cheaply and
 * exit without reporting anything.
 *
 * The answer comes from the pull request the commit closed, and specifically from
 * its `deliverable:v1` marker — written by the deterministic `build-publish`, which
 * holds a write scope no executor has. A branch named `build/…` proves nothing; the
 * marker is what makes this a deliverable.
 */
export async function planRefForMergedCommit(gh: Octokit, repo: RepoRef, sha: string): Promise<string | null> {
  const { data: prs } = await gh.repos.listPullRequestsAssociatedWithCommit({ ...repo, commit_sha: sha });
  for (const pr of prs) {
    if (!pr.head.ref.startsWith('build/')) continue;
    const marker = parseDeliverableMarker(pr.body ?? '');
    if (marker) return marker.planRef;
  }
  return null;
}

const isMain = process.argv[1]?.endsWith('build-verify.ts');
if (isMain) {
  const argv = process.argv.slice(2);
  const get = (name: string): string | undefined => {
    const i = argv.indexOf(`--${name}`);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const repoArg = get('repo');
  const out = get('out') ?? 'vt-results.json';
  const cwd = get('cwd') ?? process.cwd();
  const commit = get('commit');
  const [owner, repoName] = (repoArg ?? '').split('/');
  if (!owner || !repoName || (!get('plan-ref') && !commit)) {
    console.error('usage: build-verify --repo <owner/repo> (--plan-ref <tag> | --commit <sha>) [--cwd <dir>] [--out <file>]');
    process.exit(2);
  }
  const gh = createClient();
  const repo = { owner, repo: repoName };
  const resolve = get('plan-ref')
    ? Promise.resolve(get('plan-ref')!)
    : planRefForMergedCommit(gh, repo, commit!).then((ref) => {
        if (ref === null) {
          // Not a deliverable merge. Exit 0 and report NOTHING: an ordinary push to
          // the default branch is not a verification event, and emitting an empty
          // vt-results.json would make vt-report create zero check runs while
          // looking like it ran — the absent-≠-success shape, in the one pipeline
          // that must never have it.
          console.log(`commit ${commit!.slice(0, 8)} is not a merged deliverable — nothing to verify`);
          process.exit(0);
        }
        return ref;
      });
  resolve
    .then((planRef) => buildVerify(gh, repo, planRef, cwd))
    .then((outcome) => {
      mkdirSync(dirname(out) === '' ? '.' : dirname(out), { recursive: true });
      writeFileSync(out, `${JSON.stringify({ plan_ref: outcome.planRef, results: outcome.results }, null, 2)}\n`);
      console.log(`wrote ${out}: ${outcome.results.length} result(s)`);
      if (outcome.unexecutable.length > 0) {
        // Loud, and NOT a failure of this run: the targets exist and were not
        // checked, which is a fact completion needs to act on rather than a crash.
        console.log(
          `NOT VERIFIED (no \`run\` on a MUST-mapped target): ${outcome.unexecutable.join(', ')} — no check run will ` +
            'be recorded for these, so completion (L3) stays refused until the plan is re-opened to add an ' +
            'executable form or a conformant executor interprets them in verify mode.',
        );
      }
      // The RUN's own status reflects whether verification could be performed, not
      // whether the deliverable passed: a failing target is a real result that must
      // reach `vt-report` and be recorded. Exiting non-zero here would suppress it,
      // and an unreported failure reads exactly like an unreported success.
    })
    .catch((error) => {
      console.error(errorMessage(error));
      process.exit(1);
    });
}
