import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { Octokit } from '@octokit/rest';
import { createClient, type RepoRef } from '../dashboard/lib/github/client';
import { readPlanAtRef, slugFromPlanRef } from '../dashboard/lib/github/plans';
import { listDeliverablePrs } from '../dashboard/lib/github/builds';
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
 * FROZEN PLAN TREE — the commit `plan/<slug>/v<N>` tags. A target that passes THERE TOO
 * did not discriminate: whatever it asserts was already true before any of the plan's
 * work existed, so its green says nothing about the step it maps to. Such a target is
 * recorded `action_required` naming the reason, and L3 (which fails closed on anything
 * short of `success`) refuses completion until it is fixed.
 *
 * WHY THE FROZEN TAG AND NOT THE MERGE COMMIT'S FIRST PARENT (Codex P1 on PR #233,
 * 2026-09-12 — the first version of this used the first parent and would have broken
 * every multi-step plan). The first parent is the default branch as it was immediately
 * before THIS deliverable landed, so on the second and every later delivery it ALREADY
 * CONTAINS the earlier steps. `targetsToVerify` returns EVERY target of the plan, and
 * L3 reads only the NEWEST merge commit (`resolveVerifiedCommit`) — so every earlier
 * step's target would pass on both trees, be demoted, and refuse completion forever. An
 * 8-MUST-step plan delivered one work item at a time — the north-star shape — could
 * never complete. The frozen tag does not drift: `build-publish` cuts every deliverable
 * branch FROM that commit (`createRef({ sha: tagSha })`), so it holds none of the plan's
 * work however many deliverables have landed, and B9 has already proved the subject
 * descends from it, so the two trees sit on one line of history by construction.
 *
 * THE RESIDUAL, CLOSED (GHI #234, option 2; 2026-09-13). A plan RE-OPENED and re-frozen
 * (FR-008) after some of its steps had already landed carries that work in the new tag's
 * tree, so those steps' targets passed on the base and were falsely demoted — and there
 * was no exit, because no command can fail on a tree that contains the step, and
 * re-opening again only enlarges the baseline. The control now SKIPS a target any of
 * whose mapped steps merged BEFORE the frozen tag was cut: its work is in the baseline
 * by construction, so a comparison against that baseline answers nothing about it. This
 * needed no new mechanism — every deliverable pull request already carries `planRef` +
 * `stepId` in its `deliverable:v1` marker with an immutable `mergedAt`, and the tag's own
 * commit date comes from the base checkout.
 *
 * ANY mapped step in the baseline skips the control, not ALL of them. A target mapping to
 * one delivered and one undelivered step might still discriminate, or might not, and this
 * runner cannot tell which without reading the command. The two errors are not
 * symmetrical: a FALSE DEMOTION blocks completion permanently with no operator remedy
 * except retracting the commitment, while a MISSED demotion leaves that one target
 * un-controlled — which is exactly where every target stood before GHI #230 — and is
 * printed. So it fails toward not demoting, loudly.
 *
 * WHAT THIS STILL DOES NOT COVER, named so it is not rediscovered as a surprise. The
 * frozen tag's tree is the default branch at approval, not an empty tree, so work that
 * reached the default branch by a NON-DELIVERABLE route — `npm run init` writing
 * `.github/workflows/**`, another workload's deliverable merging, an operator's hand
 * edit — is in the baseline too and leaves no marker to read. Such a target can still be
 * demoted with no re-open having happened. The log line for a demotion names both causes
 * and their opposite remedies for exactly this reason.
 *
 * ONLY A DELIVERED STEP'S TARGET IS REPORTED AT ALL (GHI #231; operator decision
 * 2026-09-13). `targetsToVerify` returns every target of the plan, so an 8-MUST-step plan
 * with one delivered step used to stamp 4 success / 15 failure onto its first deliverable
 * — and the 15 were targets for steps that had never been dispatched, each carrying the
 * remedy *"fix the step and re-run the build"* for a step there was nothing wrong with.
 * Roughly 105 red check runs across a plan delivered one item at a time, consumed by
 * nothing: L3 reads only the newest merge commit, so an intermediate red has no
 * mechanical effect at all (that one-commit read is GHI #250, and closing it is what would
 * revive ADR-0004's option (c)). Fifteen instructions naming a nonexistent remedy is how an
 * operator is trained to stop reading red.
 *
 * So a target is executed and reported only when EVERY step it maps to has a merged
 * deliverable. The rest are recorded as not-yet-delivered and given no check run, which
 * the completion panel already has the vocabulary for: an absent check run is
 * `unverified`, and L3 fails closed on an unverified MUST target exactly as it does on a
 * red one (`checks.ts` pushes an `unmet` entry either way). THIS CANNOT CREATE A FALSE
 * COMPLETION — it was checked against `deriveCompletionStatus` rather than assumed — and
 * it makes the panel's sentence true: the remedy for a step nobody built is to build it.
 *
 * ALL VERSIONS OF THE WORKLOAD'S PLAN COUNT AS DELIVERY, not only this one. The question
 * is "is this step's work on the default branch?", and a step delivered under `v2` is
 * still in the tree after a re-open to `v3`. Keying on the current `planRef` would
 * un-deliver every earlier step at every re-open and put the reds straight back.
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
 * them. The property is identical either way. What the saving does NOT do is bound the
 * worst case: a plan of slow GREEN targets executes twice, which is why the verify job's
 * budget doubled with this change (build-verify.yml, `timeout-minutes: 40`) — a run
 * cancelled at the cap uploads no artifact and reports nothing at all.
 *
 * A BASE THAT IS THE SUBJECT IS NOT A CONTROL. `vt-report`'s pre-US18 compatibility shim
 * accepts a verified commit IDENTICAL to the frozen tag's; were that ever handed here,
 * every target would trivially pass on both trees and the whole plan would be demoted at
 * once. The two HEADs are compared before the loop and the control is skipped, loudly,
 * rather than producing a verdict from a comparison of a tree with itself.
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
  /** targets NOT executed and NOT reported because a step they map to has no merged
   *  deliverable yet, with the step ids still outstanding (GHI #231) */
  notYetDelivered: { id: string; pendingStepIds: string[] }[];
  /** targets whose green stands WITHOUT a negative control, because a step they map to
   *  was already in the frozen tag's tree when it was cut (GHI #234) */
  controlSkipped: { id: string; baselineStepIds: string[] }[];
}

/** One merged deliverable, reduced to what delivery scope needs. */
export interface MergedDelivery {
  /** the step its `deliverable:v1` marker names */
  stepId: string;
  /** GitHub's immutable `merged_at` */
  mergedAt: string;
}

/**
 * What has actually landed, as the two questions this runner asks of it.
 *
 * Derived ONCE per run and passed in, rather than re-asked per target: the two
 * questions are about the same set of facts, and a runner that re-read them could
 * report a target against one answer and control it against another.
 */
export interface DeliveryRecord {
  /** steps with a merged deliverable under ANY version of this workload's plan —
   *  "is this step's work on the default branch?" (GHI #231) */
  delivered: ReadonlySet<string>;
  /** steps whose deliverable merged BEFORE the frozen tag was cut, so the negative
   *  control's baseline already contains their work (GHI #234) */
  inBaseline: ReadonlySet<string>;
}

/**
 * PURE: the delivery record, from the merged deliverables and the moment the frozen
 * tag's own commit was made.
 *
 * `baselineCommittedAt` null means the baseline's date could not be read — every step
 * is then treated as NOT in the baseline, so the control still runs. That is the
 * fail-open direction, and it is the right one here: an un-skipped control can only
 * produce a demotion the operator can read and argue with, whereas skipping on an
 * unknown date would silently switch the GHI #230 control off for the whole plan.
 */
export function deriveDeliveryRecord(
  deliveries: readonly MergedDelivery[],
  baselineCommittedAt: string | null,
): DeliveryRecord {
  const delivered = new Set<string>();
  const inBaseline = new Set<string>();
  const baselineMs = baselineCommittedAt === null ? null : Date.parse(baselineCommittedAt);
  for (const { stepId, mergedAt } of deliveries) {
    delivered.add(stepId);
    const mergedMs = Date.parse(mergedAt);
    // STRICTLY BEFORE. A deliverable that merged at the same instant the approval
    // commit was made is not in that commit's tree — the tag is cut from a merge that
    // had already happened, so equality means "not included".
    if (baselineMs !== null && !Number.isNaN(mergedMs) && !Number.isNaN(baselineMs) && mergedMs < baselineMs) {
      inBaseline.add(stepId);
    }
  }
  return { delivered, inBaseline };
}

/** When the frozen tag's own commit was made, read from the control's checkout — no
 *  API call, because the base checkout IS that commit. Null when it cannot be read,
 *  which `deriveDeliveryRecord` treats as "nothing is in the baseline". */
export function baselineCommittedAt(baseCwd: string): string | null {
  try {
    return git(baseCwd, ['log', '-1', '--format=%cI', 'HEAD']).trim() || null;
  } catch {
    return null;
  }
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
  // THE `-euo pipefail` BELOW IS INERT FOR THE SHAPE EVERY LIVE TARGET HAS, and saying
  // so here is GHI #232's third complement — it reads as hardening and is not, and a
  // reader who assumes otherwise will trust a green this flag did nothing to earn.
  //
  //   bash -euo pipefail -c 'false; true'             # exit 1 — the outer -e works
  //   bash -euo pipefail -c "bash -c 'false; true'"   # exit 0 — and this was all 19
  //                                                   #   targets on the live plan
  //
  // Every target re-enters a fresh `bash -c` / `sh -c` / `python3 -c`, so the outer
  // errexit only ever observes ONE child process's status: the inner shell's, which is
  // its own last command's. The flags are kept because they cost nothing and do bind a
  // target written as a flat command — they simply are not the protection they look
  // like for the nested form.
  //
  // THE ALTERNATIVE IS A DECISION, NOT A REFACTOR, and it is not taken here. Wrapping
  // the target's BODY rather than the invocation (`bash -c "set -euo pipefail; $run"`)
  // would make it real — and would change the MEANING of every `run` already frozen
  // into a plan tag, which is a Frozen-Artifact Compatibility question (GHI #151's
  // family) rather than an implementation choice, and it is filed as GHI #249. G19 now
  // lints the outer shape at approval instead, where a command is still editable without
  // a re-open, and the negative control catches what no lint can. GHI #232.
  //
  // `tests/unit/build-verify.test.ts` reproduces `vt-config-six` with the nested
  // `bash -c` deliberately, with this contrast in its comment, because a flat
  // reproduction passes for the wrong reason.
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

/** EVERY target the plan defines, unfiltered — not only the MUST-mapped ones, and not
 *  only the ones the step under delivery maps to. (The name and the docstring said
 *  "MUST-mapped" until 2026-09-12; the code never did, and one well-meaning edit to
 *  match the prose would silently change what the negative control and L3 see.)
 *
 *  Completion (L3) reads only MUST-mapped results, but a SHOULD/COULD target carrying
 *  `run` is still executed and recorded, because a result the plan can explain is worth
 *  having; it simply gates nothing. */
export function targetsToVerify(plan: PlanDoc): PlanDoc['verification_targets'] {
  return plan.verification_targets;
}

export function mustMappedTargetIds(plan: PlanDoc): string[] {
  const must = new Set(plan.steps.filter((s) => s.priority === 'MUST').map((s) => s.id));
  return plan.verification_targets.filter((vt) => vt.maps_to.some((id) => must.has(id))).map((vt) => vt.id);
}

/**
 * @param cwd      the MERGED deliverable commit's checkout — the subject.
 * @param baseCwd  the FROZEN PLAN TREE's checkout (the commit `plan/<slug>/v<N>` tags),
 *                 for the negative control. Omitted, the control does not run and the
 *                 runner says so loudly: a green with no control behind it is exactly
 *                 what GHI #230 is about, and it must not pass unremarked.
 * @param delivery which steps have landed, and which were already in the baseline
 *                 (GHI #231 and #234). Omitted, EVERY target is reported and every green
 *                 is controlled — the pre-2026-09-13 behaviour, kept so the CLI stays
 *                 runnable by hand against two checkouts with no repository access, and
 *                 said out loud in the summary because both defects come back with it.
 */
export function runVerification(
  plan: PlanDoc,
  planRef: string,
  cwd: string,
  baseCwd?: string,
  delivery?: DeliveryRecord,
): VerifyOutcome {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const key of CREDENTIAL_ENV) delete env[key];

  const results: { id: string; conclusion: CheckConclusion }[] = [];
  const unexecutable: string[] = [];
  const mutated: { id: string; changes: string[] }[] = [];
  const nonDiscriminating: string[] = [];
  const notYetDelivered: { id: string; pendingStepIds: string[] }[] = [];
  const controlSkipped: { id: string; baselineStepIds: string[] }[] = [];
  const mustIds = new Set(mustMappedTargetIds(plan));

  // The control's tree, or `undefined` for "no control". Resolved ONCE, before any
  // target runs: a base that is the subject itself compares a tree with itself, which
  // would pass every target and demote the entire plan in one go.
  let control: string | undefined;
  if (baseCwd !== undefined) {
    const subjectHead = snapshotCheckout(cwd).head;
    const baseHead = snapshotCheckout(baseCwd).head;
    if (baseHead === subjectHead) {
      console.log(
        `NO NEGATIVE CONTROL: the base tree is the commit under verification (${baseHead.slice(0, 8)}) — the pre-US18 ` +
          "compatibility shim's identical binding. A tree compared with itself answers nothing, so no target is demoted. " +
          'GHI #230.',
      );
    } else {
      control = baseCwd;
    }
  }

  for (const target of targetsToVerify(plan)) {
    // DELIVERY SCOPE FIRST (GHI #231), before anything is executed or classified. A
    // target whose step has not been built is not a failing target, not an
    // unexecutable one, and not this run's business — it is a target whose subject
    // does not exist yet. Asked before the `run` check so a MUST target with no `run`
    // whose step is also unbuilt is reported as the one thing the operator can act on.
    if (delivery !== undefined) {
      const pendingStepIds = target.maps_to.filter((id) => !delivery.delivered.has(id));
      if (pendingStepIds.length > 0) {
        notYetDelivered.push({ id: target.id, pendingStepIds });
        console.log(
          `– ${target.id}: not reported — step${pendingStepIds.length > 1 ? 's' : ''} ${pendingStepIds.join(', ')} ` +
            'ha' + (pendingStepIds.length > 1 ? 've' : 's') + ' no merged deliverable yet, so this target has nothing ' +
            'to judge. No check run is created; completion (L3) reads it as unverified and stays refused. GHI #231',
        );
        continue;
      }
    }
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
    // THE BASELINE ALREADY HOLDS THIS STEP (GHI #234). A control run against a tree
    // that contains the work cannot discriminate, and its inevitable pass would demote
    // a legitimately delivered step with no remedy left but retracting the commitment.
    // Skipped rather than run-and-ignored so the cost is not paid either.
    const baselineStepIds =
      delivery === undefined ? [] : target.maps_to.filter((id) => delivery.inBaseline.has(id));
    let base: TargetRun | null = null;
    if (conclusion === 'success' && control !== undefined && baselineStepIds.length > 0) {
      controlSkipped.push({ id: target.id, baselineStepIds });
    } else if (conclusion === 'success' && control !== undefined) {
      base = executeTarget(target.run, control, env);
      // ONLY exit 0 demotes. A spawn error, a timeout or a mutation on the base tree
      // means the control could not be performed — and "could not ask" must never read
      // as "it discriminated", nor as "it did not". The subject's own verdict stands,
      // and the reason appears in the log below.
      if (base.changes.length > 0) resetCheckout(control, base.before.head);
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
    if (base === null && baselineStepIds.length > 0 && conclusion === 'success' && control !== undefined) {
      console.log(
        `  NO NEGATIVE CONTROL for this target (GHI #234): step${baselineStepIds.length > 1 ? 's' : ''} ` +
          `${baselineStepIds.join(', ')} already merged BEFORE ${planRef} was cut, so the frozen tree contains ` +
          'that work and a control against it could only pass — which would demote a step that was legitimately ' +
          'delivered and legitimately verified. The green stands UNCONTROLLED: it is evidence the target passed on ' +
          'the merged commit, and not evidence that it would have failed without the work.',
      );
    }
    if (base !== null) {
      if (nonDiscriminating.includes(target.id)) {
        console.log(
          `  WITNESSED NOTHING (GHI #230): this also passed on ${base.before.head.slice(0, 8)}, the frozen tree of ` +
            `${planRef}. A target that passes with and without the step it maps to (${target.maps_to.join(', ')}) asserts ` +
            'something that was already true, so its green is not evidence about the step. Recorded action_required. ' +
            'TWO CAUSES, AND THEY NEED OPPOSITE REMEDIES — check which one this is before acting: (1) the command does ' +
            'not discriminate (the ordinary case) → re-open the plan and make it fail on a tree lacking the step; ' +
            "(2) the frozen tree ALREADY CONTAINS this step's work, because the tag was cut after that work landed (a " +
            'plan re-frozen mid-delivery, or work that reached the default branch by some other route) → re-opening ' +
            'AGAIN makes it worse, since the next tag is cut from a default branch holding even more of it, and no ' +
            'command can fail on a tree that has the step. The only exit from (2) is to retract the commitment: drop ' +
            'the target, or take its step out of MUST. GHI #234',
        );
      } else if (base.changes.length > 0 || base.status === null) {
        console.log(
          `  negative control could not be performed (${base.changes.length > 0 ? `it changed the base checkout: ${base.changes.join('; ')}` : 'the command did not run'}) — ` +
            "the subject's verdict stands unmodified",
        );
      } else {
        // THE CONTROL'S OWN FAIL-OPEN, MADE VISIBLE. A non-zero exit on the base is read
        // as "it discriminated" and the green stands — but this runner cannot tell
        // "the assertion was false there" from "the command errored there" (a missing
        // tool, exit 127, or grep's exit 2 on an absent file — the very
        // error-laundered-as-signal mechanism GHI #230 exists to catch, now on the other
        // side of the comparison). Undecidable in general, so it is printed rather than
        // guessed at: a reader auditing a green can see what the base actually did.
        console.log(`  negative control: exit ${base.status} on the frozen tree — it discriminated, green stands`);
        if (base.stderr.trim()) console.log(`    base stderr: ${base.stderr.trim().slice(0, 400)}`);
      }
    }
    results.push({ id: target.id, conclusion });
  }
  return { planRef, results, unexecutable, mutated, nonDiscriminating, notYetDelivered, controlSkipped };
}

/**
 * What this workload has delivered, and what of it was already in the baseline
 * (GHI #231 and #234) — ONE read, serving both questions.
 *
 * Every deliverable pull request carries `planRef` + `stepId` in its `deliverable:v1`
 * marker, written by the deterministic `build-publish` and never taken from a caller,
 * and `listDeliverablePrs` surfaces the marker alongside GitHub's immutable
 * `merged_at`. So neither of these facts needed a new mechanism or a new record at
 * freeze time — that is what made option 2 the answer on #234 and what lets #231's
 * scoping cost nothing extra.
 *
 * A FAILED READ THROWS. If this runner cannot learn what has been delivered it cannot
 * know which targets to report, and both ways of guessing are bad: report everything
 * and the plan is back to stamping ~15 reds whose remedy does not exist; report
 * nothing and a verify run produces no check runs at all while looking like it ran —
 * the absent-≠-success shape, in the one pipeline that must never have it. "Could not
 * ask" is not an answer here either.
 */
export async function readDeliveryRecord(
  gh: Octokit,
  repo: RepoRef,
  planRef: string,
  baseCwd?: string,
): Promise<DeliveryRecord> {
  const slug = slugFromPlanRef(planRef);
  if (slug === null) {
    throw new Error(
      `cannot determine delivery scope: "${planRef}" is not a frozen plan ref (plan/<slug>/v<N>), so there is no ` +
        'workload to ask which steps have merged (GHI #231)',
    );
  }
  const prs = await listDeliverablePrs(gh, repo, slug);
  // ANY version of this workload's plan counts (see the module docblock): the question
  // is whether the step's work is on the default branch, and a re-open does not remove
  // an earlier version's merged deliverable from the tree.
  const deliveries: MergedDelivery[] = prs
    .filter((pr) => pr.merged && pr.mergedAt !== null && pr.marker !== null)
    .map((pr) => ({ stepId: pr.marker!.stepId, mergedAt: pr.mergedAt! }));
  const record = deriveDeliveryRecord(deliveries, baseCwd === undefined ? null : baselineCommittedAt(baseCwd));
  if (record.delivered.size === 0) {
    // The read SUCCEEDED and the answer is none — a different thing from the throw
    // above, and it must not look like it. Every target is out of scope and no check
    // run will be created, which is correct and would otherwise be indistinguishable
    // from a broken run.
    console.log(
      `no merged deliverable exists for workload "${slug}" — every verification target is out of scope for this run ` +
        'and NO check run will be created. This is the read succeeding with an empty answer, not a failure to read.',
    );
  }
  return record;
}

export async function buildVerify(
  gh: Octokit,
  repo: RepoRef,
  planRef: string,
  cwd: string,
  baseCwd?: string,
): Promise<VerifyOutcome> {
  const plan = await readPlanAtRef(gh, repo, planRef);
  const delivery = await readDeliveryRecord(gh, repo, planRef, baseCwd);
  return runVerification(plan, planRef, cwd, baseCwd, delivery);
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
  // The FROZEN PLAN TREE — the negative control's base (GHI #230). Optional so the CLI
  // stays runnable by hand against one checkout; the workflow always passes it, and a
  // run without it says so in the summary below.
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
      if (outcome.notYetDelivered.length > 0) {
        // Loud, and NOT a failure: these targets were deliberately not executed. Said
        // in the run log because the alternative reading of "no check run" is that the
        // reporter broke, and this is the line that tells the two apart.
        console.log(
          `NOT REPORTED (their step has no merged deliverable yet, GHI #231): ${outcome.notYetDelivered
            .map((t) => `${t.id} → ${t.pendingStepIds.join(', ')}`)
            .join(' | ')}. No check run is created for these, so completion (L3) reads each as UNVERIFIED and stays ` +
            'refused — which is the same refusal a red would produce, with the remedy that is actually true: build ' +
            'the step. They are not failing targets.',
        );
      }
      if (outcome.controlSkipped.length > 0) {
        // Loud because it is a WEAKENING of the GHI #230 control, correctly applied. An
        // operator auditing one of these greens must be able to see that nothing
        // challenged it.
        console.log(
          `GREEN WITHOUT A NEGATIVE CONTROL (GHI #234): ${outcome.controlSkipped
            .map((t) => `${t.id} → ${t.baselineStepIds.join(', ')}`)
            .join(' | ')}. Each of these maps to a step that merged BEFORE this plan version was frozen, so the ` +
            'frozen tree already contains the work and a control against it could only pass — demoting a step that ' +
            'was legitimately delivered. The control is skipped rather than ignored; these greens say the target ' +
            'passed on the merged commit and nothing more.',
        );
      }
      if (outcome.nonDiscriminating.length > 0) {
        // Loud, and NOT a failure of this run: the targets ran, and what they reported
        // is that they do not discriminate. That is a real finding about the PLAN, and
        // the operator acts on it by re-opening the plan — not by re-running this.
        console.log(
          `WITNESSED NOTHING (recorded action_required, GHI #230): ${outcome.nonDiscriminating.join(', ')} — each of these ` +
            "passed on the merged commit AND on the frozen plan tree, which contains none of the plan's work. A target " +
            'that passes with and without the step it maps to asserts something that was already true, so its green is ' +
            'not evidence about the step. Completion (L3) stays refused until the plan is re-opened to make the command ' +
            'fail on a tree lacking the step.',
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
