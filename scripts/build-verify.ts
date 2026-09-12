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
 *
 * A TARGET THAT CHANGES THE CHECKOUT IS NOT A RESULT (GHI #162, option 3 then 1). All
 * targets run in one writable checkout, one after another. A target that writes a
 * file — an `npm run fix` that rewrites the thing a later test reads, or a build that
 * emits what a later assertion looks for — changes the subject every later target
 * sees, and the check runs would still be recorded against the merge commit as if
 * they described it. That is GHI #141's shape (a completion earned against code the
 * repository never held) by a different route. So the runner snapshots the tree
 * before and after every target: a target that left the checkout different from how
 * it found it is recorded `action_required`, naming what it touched, whatever its
 * exit status said — a green verdict on a tree the commit does not contain is not a
 * verdict on the commit — and the checkout is reset before the next target runs.
 * G4 already refuses a chained check, so each target is one independent assertion
 * and the reset breaks nothing the contract permits; a build-then-test plan breaks
 * loudly here rather than passing silently.
 *
 * A TARGET THAT PASSES ON A TREE WITHOUT ITS STEP WITNESSED NOTHING (GHI #230, the
 * NEGATIVE CONTROL). Every target that concludes `success` is re-executed against the
 * tree the deliverable landed ON — the merge commit's first parent, which by
 * construction contains none of this deliverable's work. A target that passes THERE TOO
 * did not discriminate: whatever it asserts was already true before the step existed,
 * so its green says nothing about the step it maps to. Such a target is recorded
 * `action_required` naming the reason, and L3 (which fails closed on anything short of
 * `success`) refuses completion until it is fixed.
 *
 * WHY THIS AND NOT A LINT OF THE COMMAND TEXT. Found live on 2026-09-11: of 19 targets
 * on `plan/lza-phase0-0/v2`, three reported `success` against merge base `2847f881`, a
 * tree that had received none of the plan's 8 steps. Two mechanisms, and no single
 * static rule catches both — a `;`-list or a `for` loop reports only its LAST command's
 * status (`set -e` would fix those), while `! grep … missing-file` launders grep's exit
 * 2 into a pass and is EXEMPT from errexit (`bash -c 'set -e; ! grep -q X missing; echo
 * reached'` prints `reached`). The negative control is decidable, reads no command text,
 * and asks the property that actually matters: not determinism (#145 made `run`
 * deterministic and these strings were perfectly deterministic while lying), but
 * DISCRIMINATION.
 *
 * ONLY THE GREENS ARE RE-RUN, deliberately. A target that already concluded non-success
 * on the subject is not a false green, so re-running it could only cost time — on a plan
 * whose steps are mostly unbuilt, which is the ordinary case mid-plan, that is most of
 * them. The property is identical either way.
 *
 * THE OBJECTION, NAMED AND STAGED. A target legitimately guarding a PRE-EXISTING
 * invariant also passes on both trees. Under `maps_to` semantics it does not witness the
 * step it claims, so flagging it is right — but the plan schema may want an explicit
 * regression-guard kind before this becomes an approval-time refusal. It reports
 * `action_required` first; whether the plan gate should refuse such a target outright is
 * decided after seeing how often this fires (GHI #230).
 *
 * WHAT THIS DELIBERATELY DOES NOT DO. The control fires AFTER a build. GHI #230 named
 * three complements that fire earlier — an approval-time shell lint (a new gate), the
 * rule taught to the proposing agent, and a decision about the inert `bash -euo pipefail`
 * wrapper on the invocation below — and they are carried on GHI #232, not here. Until
 * they land, a plan whose step carries a SINGLE vacuous target is still approvable; it is
 * caught at verification rather than at the Andon break.
 *
 * Known blind spot, accepted and named: the snapshot is `git status --porcelain`
 * plus HEAD, so `.gitignore`d output (`node_modules/`, `cdk.out/`) is invisible, and
 * `git clean -fd` (no `-x`) leaves it in place. Ignored paths are, by the
 * repository's own declaration, not part of the tree the commit describes — and
 * flagging every `npm ci` would make each real target on an LZA plan
 * `action_required`. Whether that stays acceptable is the question the first live
 * run answers on GHI #162.
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
  /** targets recorded `action_required` because they changed the checkout (GHI #162),
   *  with what each one touched — for the run log; `vt-results.json` carries only the
   *  conclusion */
  mutated: { id: string; changes: string[] }[];
  /** targets that passed on the subject AND on the tree the deliverable landed on, so
   *  they witnessed nothing and were recorded `action_required` (GHI #230) */
  nonDiscriminating: string[];
}

/** One target's execution in one checkout — the verdict plus what the tree looked like
 *  before it, so the caller can detect a mutation and reset. */
interface TargetRun {
  conclusion: CheckConclusion;
  before: CheckoutSnapshot;
  changes: string[];
  ms: number;
  stdout: string;
  stderr: string;
  status: number | null;
}

/**
 * Execute ONE target in ONE checkout and form its verdict, including the GHI #162
 * mutation check. Extracted when the negative control gave the same command a second
 * tree to run in (GHI #230): the two executions must be identical in every respect
 * except which directory they happen in, and two copies of this logic would eventually
 * differ in one — the timeout, the stripped environment, the snapshot — and the control
 * would then be comparing two different questions.
 */
function executeTarget(run: string, cwd: string, env: NodeJS.ProcessEnv): TargetRun {
  const before = snapshotCheckout(cwd);
  const started = Date.now();
  const proc = spawnSync('bash', ['-euo', 'pipefail', '-c', run], {
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
  let conclusion: CheckConclusion =
    proc.error && /ETIMEDOUT|timed out/i.test(String(proc.error.message))
      ? 'timed_out'
      : proc.error
        ? 'action_required'
        : proc.status === 0
          ? 'success'
          : 'failure';
  const ms = Date.now() - started;
  // Snapshotted AFTER the verdict is formed and BEFORE it is recorded: a target that
  // changed the tree has its verdict replaced, not annotated (GHI #162).
  const changes = checkoutMutation(before, snapshotCheckout(cwd));
  if (changes.length > 0) conclusion = 'action_required';
  return { conclusion, before, changes, ms, stdout: proc.stdout ?? '', stderr: proc.stderr ?? '', status: proc.status };
}

/**
 * What the checkout looked like at one instant (GHI #162). Two facts, because a target
 * can change the tree two ways: write to the working copy (`status` shows it) or move
 * HEAD by committing or checking out another ref (`status` stays clean; `head` moves).
 */
export interface CheckoutSnapshot {
  /** `git rev-parse HEAD` */
  head: string;
  /** `git status --porcelain=v1 --untracked-files=all`, one entry per line, sorted so
   *  two snapshots of the same state compare equal whatever order git listed them in */
  status: string[];
}

/** Runs git in the checkout; a failure is a FAULT (the runner needs a working tree),
 *  not a refusal — the workflow always checks the merge commit out at `--cwd`. */
function git(cwd: string, args: string[]): string {
  const proc = spawnSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });
  if (proc.error) throw new Error(`git ${args[0]} could not run in ${cwd}: ${proc.error.message}`);
  if (proc.status !== 0) {
    throw new Error(
      `git ${args.join(' ')} exited ${proc.status} in ${cwd}: ${proc.stderr.trim()} — the verification checkout must be a git working tree`,
    );
  }
  return proc.stdout;
}

export function snapshotCheckout(cwd: string): CheckoutSnapshot {
  const head = git(cwd, ['rev-parse', 'HEAD']).trim();
  const status = git(cwd, ['status', '--porcelain=v1', '--untracked-files=all'])
    .split('\n')
    .filter((line) => line.length > 0)
    .sort();
  return { head, status };
}

/** One porcelain v1 entry (`XY path`, or `XY from -> to` for a rename) as a phrase. */
function describeEntry(entry: string): string {
  const code = entry.slice(0, 2);
  const path = entry.slice(3);
  if (code === '??') return `created ${path}`;
  if (code.includes('D')) return `deleted ${path}`;
  if (code.includes('R')) return `renamed ${path}`;
  if (code.includes('A')) return `added ${path}`;
  if (code.includes('M')) return `modified ${path}`;
  return `changed ${path} (${code.trim()})`;
}

/**
 * PURE: what a target changed between two snapshots, as phrases an operator can read.
 * Empty means the target left the checkout exactly as it found it. Pre-existing state
 * (an entry present in BOTH snapshots) is not attributed to the target; an entry that
 * DISAPPEARED is — the target altered something that was already there.
 */
export function checkoutMutation(before: CheckoutSnapshot, after: CheckoutSnapshot): string[] {
  const changes: string[] = [];
  if (before.head !== after.head) {
    changes.push(`moved HEAD from ${before.head.slice(0, 8)} to ${after.head.slice(0, 8)}`);
  }
  const was = new Set(before.status);
  const now = new Set(after.status);
  for (const entry of after.status) if (!was.has(entry)) changes.push(describeEntry(entry));
  for (const entry of before.status) if (!now.has(entry)) changes.push(`undid a pre-existing change: ${describeEntry(entry)}`);
  return changes;
}

/**
 * Put the checkout back to `head` with a clean working copy — option 1 on GHI #162,
 * chosen over a worktree per target because it is one git call and the detection above
 * already guarantees what the isolation was for: the target that changed the tree is
 * recorded as such, and the next target sees the merged tree. No `-x`: ignored output
 * stays, consistent with the snapshot not seeing it.
 */
export function resetCheckout(cwd: string, head: string): void {
  git(cwd, ['reset', '-q', '--hard', head]);
  git(cwd, ['clean', '-fdq']);
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

/**
 * @param cwd      the MERGED deliverable commit's checkout — the subject.
 * @param baseCwd  the tree the deliverable landed ON (the merge commit's first parent),
 *                 for the negative control. Omitted, the control does not run and the
 *                 runner says so loudly: a green with no control behind it is exactly
 *                 what GHI #230 is about, and it must not pass unremarked.
 */
export function runVerification(plan: PlanDoc, planRef: string, cwd: string, baseCwd?: string): VerifyOutcome {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const key of CREDENTIAL_ENV) delete env[key];

  const results: { id: string; conclusion: CheckConclusion }[] = [];
  const unexecutable: string[] = [];
  const mutated: { id: string; changes: string[] }[] = [];
  const nonDiscriminating: string[] = [];
  const mustIds = new Set(mustMappedTargetIds(plan));

  for (const target of targetsToVerify(plan)) {
    if (!target.run) {
      if (mustIds.has(target.id)) unexecutable.push(target.id);
      console.log(`– ${target.id}: no \`run\` — not executable deterministically, NOT reported`);
      continue;
    }
    const subject = executeTarget(target.run, cwd, env);
    let conclusion = subject.conclusion;
    if (subject.changes.length > 0) mutated.push({ id: target.id, changes: subject.changes });

    // THE NEGATIVE CONTROL (GHI #230). Only a green needs one: a target that already
    // failed on the subject is not a false green, and re-running it would cost a second
    // execution to learn nothing.
    let base: TargetRun | null = null;
    if (conclusion === 'success' && baseCwd !== undefined) {
      base = executeTarget(target.run, baseCwd, env);
      // ONLY exit 0 demotes. A spawn error, a timeout or a mutation on the base tree
      // means the control could not be performed — and "could not ask" must never read
      // as "it discriminated", nor as "it did not". The subject's own verdict stands,
      // and the reason appears in the log below.
      if (base.changes.length > 0) resetCheckout(baseCwd, base.before.head);
      if (base.status === 0 && base.changes.length === 0) {
        conclusion = 'action_required';
        nonDiscriminating.push(target.id);
      }
    }

    console.log(`${conclusion === 'success' ? '✓' : '✗'} ${target.id} (${subject.ms}ms) — ${target.run}`);
    if (subject.stdout.trim()) console.log(`  stdout: ${subject.stdout.trim().slice(0, 2000)}`);
    if (subject.stderr.trim()) console.log(`  stderr: ${subject.stderr.trim().slice(0, 2000)}`);
    if (subject.changes.length > 0) {
      console.log(
        `  CHANGED THE CHECKOUT (exit ${subject.status ?? 'none'}): ${subject.changes.join('; ')} — recorded action_required, because a ` +
          'result about a tree the merge commit does not contain is not a result about the commit; checkout reset before the next target',
      );
      resetCheckout(cwd, subject.before.head);
    }
    if (base !== null) {
      if (nonDiscriminating.includes(target.id)) {
        console.log(
          `  WITNESSED NOTHING (GHI #230): this also passed on ${base.before.head.slice(0, 8)}, the tree this deliverable ` +
            `landed on — which contains none of its work. A target that passes with and without the step it maps to ` +
            `(${target.maps_to.join(', ')}) asserts something that was already true, so its green is not evidence about the ` +
            'step. Recorded action_required; re-open the plan to make the command fail on a tree lacking the step',
        );
      } else if (base.changes.length > 0 || base.status === null) {
        console.log(
          `  negative control could not be performed (${base.changes.length > 0 ? `it changed the base checkout: ${base.changes.join('; ')}` : 'the command did not run'}) — ` +
            "the subject's verdict stands unmodified",
        );
      }
    }
    results.push({ id: target.id, conclusion });
  }
  return { planRef, results, unexecutable, mutated, nonDiscriminating };
}

export async function buildVerify(
  gh: Octokit,
  repo: RepoRef,
  planRef: string,
  cwd: string,
  baseCwd?: string,
): Promise<VerifyOutcome> {
  const plan = await readPlanAtRef(gh, repo, planRef);
  return runVerification(plan, planRef, cwd, baseCwd);
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
 *
 * ASSOCIATED IS NOT MERGED (PR #204 review finding F8). GitHub lists a pull request
 * as "associated" with every commit on its head branch, open or merged — so a commit
 * on an OPEN build branch resolved here to its plan ref and would have been verified
 * as though it had landed, with `vt-*` check runs recorded against a commit the default
 * branch does not contain: GHI #141's shape again. Two facts are required of the pull
 * request, and both are GitHub's record rather than the branch's name: it MERGED
 * (`merged_at` set), and THIS sha is its merge commit (`merge_commit_sha`). A merged
 * pull request whose merge commit is some other sha is also declined — the commit
 * asked about is then one of the branch's own, not the deliverable that landed.
 */
export async function planRefForMergedCommit(gh: Octokit, repo: RepoRef, sha: string): Promise<string | null> {
  const { data: prs } = await gh.repos.listPullRequestsAssociatedWithCommit({ ...repo, commit_sha: sha });
  for (const pr of prs) {
    if (!pr.head.ref.startsWith('build/')) continue;
    if (!pr.merged_at || pr.merge_commit_sha !== sha) continue;
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
  // The tree the deliverable landed ON — the negative control's second subject (GHI
  // #230). Optional so the CLI stays runnable by hand against one checkout; the
  // workflow always passes it, and a run without it says so in the summary below.
  const baseCwd = get('base-cwd');
  const commit = get('commit');
  const [owner, repoName] = (repoArg ?? '').split('/');
  if (!owner || !repoName || (!get('plan-ref') && !commit)) {
    console.error(
      'usage: build-verify --repo <owner/repo> (--plan-ref <tag> | --commit <sha>) [--cwd <dir>] [--base-cwd <dir>] [--out <file>]',
    );
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
    .then((planRef) => buildVerify(gh, repo, planRef, cwd, baseCwd))
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
      if (outcome.nonDiscriminating.length > 0) {
        // Loud, and NOT a failure of this run: the targets ran, and what they reported
        // is that they do not discriminate. That is a real finding about the PLAN, and
        // the operator acts on it by re-opening the plan — not by re-running this.
        console.log(
          `WITNESSED NOTHING (recorded action_required, GHI #230): ${outcome.nonDiscriminating.join(', ')} — each of these ` +
            'passed on the merged commit AND on the tree the deliverable landed on, which contains none of its work. A ' +
            'target that passes with and without the step it maps to asserts something that was already true, so its ' +
            'green is not evidence about the step. Completion (L3) stays refused until the plan is re-opened to make the ' +
            'command fail on a tree lacking the step.',
        );
      }
      if (baseCwd === undefined) {
        // The control is what stops a vacuous target reporting a green nobody can
        // question. A run without it is not wrong, but it is weaker, and saying so is
        // cheaper than an operator assuming every green here was discriminated.
        console.log(
          'NO NEGATIVE CONTROL was performed (--base-cwd not given): every `success` above says the target passed on the ' +
            'merged commit, and NOT that it would have failed without the work. GHI #230.',
        );
      }
      if (outcome.mutated.length > 0) {
        // Also loud, also not a failure of this run: the results file carries the
        // `action_required`, this line carries the why the check run cannot.
        console.log(
          `CHANGED THE CHECKOUT (recorded action_required, GHI #162): ${outcome.mutated
            .map((m) => `${m.id} — ${m.changes.join('; ')}`)
            .join(' | ')}. A verification target must leave the tree as the merge commit has it; ` +
            'make the target read-only, or re-open the plan to move the build step out of verification.',
        );
      }
      // THIS SCRIPT's exit status reflects whether verification could be PERFORMED,
      // not whether the deliverable passed: a failing target is a real result that
      // must reach the reporter and be recorded. Exiting non-zero here would suppress
      // it, and an unreported failure reads exactly like an unreported success.
      //
      // THE RUN's conclusion is a wider claim than this script's, since GHI #228. The
      // reporter is now a second JOB of the same build-verify run, so a report refusal
      // — a commit that does not descend from the frozen tag, a superseded plan_ref,
      // an unknown target id, a missing artifact — turns the RUN red while this job
      // stayed green. A green run therefore means "verification could be performed AND
      // its results were recorded", which is the honest reading and was previously
      // split across two runs. Nothing about the rule on this line changes: a failing
      // TARGET still exits 0 here, and still always will.
    })
    .catch((error) => {
      console.error(errorMessage(error));
      process.exit(1);
    });
}
