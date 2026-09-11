import type { Octokit } from '@octokit/rest';
import type { RepoRef } from './client';
import { credentialRemedy, errorMessage, errorStatus, githubSaid, isPermissionDenied, Refusal } from './errors';
import { parseDeliverableMarker, type DeliverableMarker } from './markers';
import { readPlanAtRef, resolveCurrent, slugFromPlanRef, tagTargetSha, freezeCompletion, freezeIncompleteSentence } from './plans';
import { findIntentConfirmation, getChunk } from './chunks';
import { getWorkload } from './workloads';
import type { PlanStep } from '../../../schemas/plan';
import type { MergeAuthority } from '../../../schemas/executor';
import { checkpointPathsTouched, type CheckpointPath } from '../../../scripts/gates/lib/checkpoint-paths';
import { checkB5ConfirmationRecorded, checkB6NotFlagged } from '../../../scripts/gates/lib/checks-preflight';
import { AGENTIC_WORKFLOWS } from '../../../scripts/gates/lib/readiness';
import { readCheckpointPaths } from './checkpoint-config';

/**
 * Deliverable pull requests as a lifecycle object (US18 — FR-064, FR-065, and the
 * FR-034 amendment).
 *
 * The sole reader-side module for the deliverable path: the portfolio's
 * action-required rollup, the builds page, and lifecycle-gate **L3** all resolve
 * "what did this workload actually build, and where is it?" through here. One
 * module because the alternative is three answers to that question — and the one
 * that matters most, L3's, would be the one nobody looked at.
 */

/**
 * The inputs merge authority is derived from — besides the step itself.
 *
 * Every field ESCALATES or is absent; none can pre-authorize. That is what lets a
 * reader that could not read one of them still answer when another is set (see
 * `listDeliverablePrs`).
 */
export interface MergeAuthorityInputs {
  /** the repository's `BUILD_REQUIRES_OPERATOR_MERGE` Actions variable (FR-062) */
  requiresOperatorMerge?: boolean;
  /** the checkpoint paths THIS PATCH touches, each with why it waits — a subject
   *  workflow of the delivering workload (`<slug>_<name>.yml`), or a path inside a
   *  `CHECKPOINT_PATHS` glob (`checkpointPathsTouched`, GHI #163 option 3 / GHI #174
   *  D6.7). Read from the pull request's actual files, never from the declared scope. */
  checkpointPaths?: readonly CheckpointPath[];
}

/**
 * Merge authority (T209, FR-062; amended T274) — DERIVED, never configured.
 *
 * Escalation-only, and the asymmetry is the whole rule: configuration may ADD a
 * checkpoint and may never remove one a gate demands.
 *
 *   high-stakes step with a recorded confirmation → operator-merge-required, always
 *   the patch touches a checkpoint path           → operator-merge-required, always
 *   repository checkpoint (`BUILD_REQUIRES_OPERATOR_MERGE`) → operator-merge-required
 *   otherwise                                      → pre-authorized by the approved plan
 *
 * WHY THE HIGH-STAKES BRANCH IS NOT CONFIGURABLE. A step reaches B5 because a
 * customer, clinician, or lawyer answered a question about *that step* (GHI #87
 * scoped the gate to the step for this reason). Pre-authorizing its landing would
 * spend a real authority's answer on a diff no human read — the confirmation would
 * attest to an intent while the code went unreviewed.
 *
 * WHY THE PATH BRANCH SITS SECOND, ABOVE THE REPOSITORY SETTING (GHI #163 option 3, GHI
 * #174 D6.7). The deliverable that most needs a human to read it is identified by WHAT
 * IT CHANGES — an agent-authored GitHub Actions workflow decides what runs with which
 * credentials the moment it lands, and an IAM or organization config is the same shape
 * of change in the cloud. So a workload's own workflow namespace
 * (`.github/workflows/<workload-slug>_*`, T279) always waits, whatever
 * `BUILD_REQUIRES_OPERATOR_MERGE` says, and the operator may add their own paths. It is
 * checked even when the STEP is unknown: a checkpoint by path does not depend on which
 * plan step produced the change, and answering "pre-authorized" about a subject
 * workflow because the plan could not be read would be the absent-≠-success mistake
 * applied to a merge decision.
 *
 * THE REASONS CARRY NO GATE OR REQUIREMENT IDS (house rule, 2026-08-29). They reach
 * the Builds page verbatim — the operator is told in plain words which path waits and
 * why — and the gate's own detail (`checkD3MergeAuthority`) quotes the same sentence
 * so three readers cannot phrase one decision three ways (GHI #127).
 */
export function resolveMergeAuthority(step: PlanStep | null, opts: MergeAuthorityInputs = {}): {
  authority: MergeAuthority;
  reason: string;
} {
  if (step?.high_stakes) {
    return {
      authority: 'operator-merge-required',
      reason:
        `step ${step.id} is high-stakes (${step.authority ?? 'authority unset'}) and carries an external authority's ` +
        'confirmation — its deliverable always waits for your own merge, whatever the configuration says ' +
        '(configuration may add a checkpoint, never remove one a gate demands)',
    };
  }
  const checkpoints = opts.checkpointPaths ?? [];
  if (checkpoints.length > 0) {
    return { authority: 'operator-merge-required', reason: checkpointPathsReason(checkpoints) };
  }
  if (opts.requiresOperatorMerge) {
    // NAMES THE REPOSITORY VARIABLE, not a per-executor field (GHI #163, option 2). The
    // old sentence cited the executor's own merge flag, which was configuration that
    // nothing read; the checkpoint has always been `BUILD_REQUIRES_OPERATOR_MERGE`, and
    // the per-executor field is now deleted from the executor schema.
    return {
      authority: 'operator-merge-required',
      reason:
        'the repository\'s BUILD_REQUIRES_OPERATOR_MERGE variable asks for an operator checkpoint on every ' +
        'deliverable — this one waits for your own merge',
    };
  }
  return {
    authority: 'pre-authorized',
    reason:
      'the approved plan pre-authorizes this deliverable\'s merge — the step is not high-stakes, the change touches ' +
      'no checkpoint path, and the repository asks for no checkpoint',
  };
}

/**
 * The plain-language sentence for a path checkpoint: "this change touches `a`, `b` —
 * <why>", one clause per distinct reason. Paths are grouped by their reason so a
 * patch touching two subject workflows reads as one fact, not two.
 */
export function checkpointPathsReason(paths: readonly CheckpointPath[]): string {
  const byWhy = new Map<string, string[]>();
  for (const p of paths) {
    const list = byWhy.get(p.why) ?? [];
    if (!list.includes(p.path)) list.push(p.path);
    byWhy.set(p.why, list);
  }
  return [...byWhy.entries()]
    .map(([why, list]) => `this change touches ${list.map((p) => `\`${p}\``).join(', ')} — ${why}`)
    .join('; ');
}

/**
 * Every path a pull request's diff touches — added, modified, removed, renamed.
 *
 * `previous_filename` is included deliberately: a rename WRITES both sides, so a patch
 * that renames a reserved or checkpoint file out of the way has touched it, and a
 * reader that only saw the destination would let exactly that through. Shared by the
 * gate (D5, D6, D3), the merger and this listing, so all four readers of "what did
 * this change touch?" ask the API the same question (T274).
 */
export async function listPullRequestPaths(gh: Octokit, repo: RepoRef, prNumber: number): Promise<string[]> {
  const files = await gh.paginate(gh.pulls.listFiles, { ...repo, pull_number: prNumber, per_page: 100 });
  return [...new Set(files.flatMap((f) => [f.filename, ...(f.previous_filename ? [f.previous_filename] : [])]))];
}

/** Warned-about diff reads, so a listing does not print once per pull request. */
const diffWarned = new Set<string>();

/**
 * The listing's degrading form of `listPullRequestPaths`: `null` when the diff could
 * not be read, warned once with the remedy. The GATE and the MERGER keep the throwing
 * form — for them an unreadable diff is `ApiUnavailableError`, a refusal to decide;
 * for a listing it is one row that says `unknown` (the `readOperatorMergeCheckpoint`
 * rule: taking the whole Builds view down because one read failed is a worse outcome
 * than the value it was fetching).
 */
async function listPullRequestPathsOrNull(gh: Octokit, repo: RepoRef, prNumber: number): Promise<string[] | null> {
  try {
    return await listPullRequestPaths(gh, repo, prNumber);
  } catch (error: unknown) {
    const key = `${repo.owner}/${repo.repo}#${prNumber}`;
    if (!diffWarned.has(key)) {
      diffWarned.add(key);
      console.warn(
        `Could not read the files of pull request ${key} (${errorStatus(error) ?? 'no status'}). Its merge authority is ` +
          'reported as "unknown" rather than guessed. A 403 means the token lacks pull-request read on this repository.',
      );
    }
    return null;
  }
}

/**
 * The authority `build-publish` RECORDED on a pull request body at publication —
 * `**Merge authority:** \`<authority>\` — <reason>` — for the settled rows, where the
 * decision is history. `null` when the line is absent or names an unknown value.
 */
export function parseRecordedMergeAuthority(body: string): { authority: MergeAuthority; reason: string } | null {
  const m = /\*\*Merge authority:\*\* `(pre-authorized|operator-merge-required)`(?: — ([^\n]+))?/.exec(body);
  if (!m) return null;
  return { authority: m[1] as MergeAuthority, reason: (m[2] ?? '').trim() || 'recorded at publication' };
}

export type BuildState = 'awaiting-merge' | 'merged' | 'refused' | 'unknown';

export interface DeliverablePrView {
  number: number;
  title: string;
  url: string;
  branch: string;
  state: BuildState;
  merged: boolean;
  /** the merge commit — the code verification runs against and completion is earned from */
  mergeCommitSha: string | null;
  /** WHEN it merged — immutable, unlike `updatedAt` (Codex on PR #145). This is the
   *  ordering key for "which deliverable is newest", because a label change or a body
   *  edit on an older pull request moves `updatedAt` and would otherwise make the
   *  wrong merge commit look like the latest delivered tree. */
  mergedAt: string | null;
  marker: DeliverableMarker | null;
  /** derived: awaiting an OPERATOR merge specifically, which is what the portfolio
   *  surfaces as action-required (FR-064). A pre-authorized PR awaiting the
   *  deterministic merger is not the operator's problem and is not flagged. */
  actionRequired: boolean;
  mergeAuthority: 'pre-authorized' | 'operator-merge-required' | 'unknown';
  /** WHY, in the rule's own plain words (`resolveMergeAuthority`), for the Builds page
   *  to show under an operator-required row — which path waits, or which setting asked.
   *  `null` when the authority is `unknown`: there is no reason to give for an answer
   *  that could not be derived. */
  mergeReason: string | null;
  updatedAt: string;
}

/**
 * The plan step a deliverable delivers, for the live merge-authority derivation.
 *
 * Cached per listing: a workload's deliverables share a plan ref, so a multi-step
 * plan would otherwise re-read the same document once per pull request.
 */
const planCache = new Map<string, Promise<PlanStep[] | null>>();

async function stepForMarker(gh: Octokit, repo: RepoRef, marker: DeliverableMarker): Promise<PlanStep | null> {
  const key = `${repo.owner}/${repo.repo}@${marker.planRef}`;
  let steps = planCache.get(key);
  if (!steps) {
    steps = readPlanAtRef(gh, repo, marker.planRef)
      .then((plan) => plan.steps)
      .catch(() => null);
    planCache.set(key, steps);
  }
  return (await steps)?.find((s) => s.id === marker.stepId) ?? null;
}

function stateFromLabels(labels: string[], merged: boolean): BuildState {
  if (labels.includes('build:merged') || merged) return 'merged';
  if (labels.includes('build:refused')) return 'refused';
  if (labels.includes('build:awaiting-merge')) return 'awaiting-merge';
  return 'unknown';
}

/**
 * Every deliverable pull request, newest first — optionally narrowed to one workload.
 *
 * Identified by the `deliverable:v1` marker rather than by the branch name. A branch
 * called `build/anything` is just a branch; only the deterministic writer emits the
 * marker, and it holds a write scope the executor does not. Reading the marker is
 * therefore the difference between "this looks like a deliverable" and "this is one".
 */
/**
 * The FR-062 merge checkpoint, read from where the operator actually sets it.
 *
 * IT IS AN ACTIONS REPOSITORY VARIABLE (Codex on PR #153). `CONFIGURATION_GUIDE.md` §3
 * documents it as one, and `build-publish`, `deliverable-gate` and `build-merge` all
 * receive it as `${{ vars.BUILD_REQUIRES_OPERATOR_MERGE }}`. This module used to read
 * `process.env` — which, in a dashboard deployment, is the DASHBOARD's environment and
 * has nothing to do with the repository variable. An operator who set the checkpoint as
 * documented got the gate and the merger correctly waiting for a human, while this
 * reader defaulted to `false`, classified the pull request as pre-authorized, left it
 * out of Action Required and offered no merge link. A checkpoint nobody is told about
 * is an invisible stall — the same failure `actionRequired` exists to prevent.
 *
 * `process.env` stays as an explicit override so the CLIs, which run INSIDE Actions and
 * already receive the variable in their environment, keep working unchanged — and so a
 * local dashboard can exercise the path without touching the target's settings.
 *
 * UNREADABLE IS NOT UNSET (operator finding, 2026-08-28; GHI #150). This used to
 * answer `false` for every failure, and `false` here means *pre-authorized* — so a
 * repository whose checkpoint is set to `true`, read with a token that cannot see
 * repository variables, produced the exact invisible stall the paragraph above says
 * this function exists to prevent. That is how it was found: the documented dashboard
 * token carries **Actions read**, and GitHub gates `actions/variables` behind a
 * SEPARATE *Variables* permission, so a correctly-configured target answered `403` and
 * this reader called it "not set".
 *
 * The distinction is the one T260 drew for `readExecutorConfig` on this same pull
 * request, one function away, and the one the listing below already makes about an
 * unreadable PLAN: only a verified 404 is absence. Everything else is `'unreadable'`,
 * and a caller that cannot tell must not guess — `listDeliverablePrs` reports every
 * deliverable's authority as `unknown` rather than inventing `pre-authorized`.
 *
 * Still no throw: this value renders a listing, and taking the whole Builds view down
 * because one settings read failed would be a worse outcome than the value it was
 * fetching. It degrades to "I could not tell", which is honest and visible.
 */
export type MergeCheckpoint = boolean | 'unreadable';

/** Warned-about repositories, so a per-render read does not print once per workload. */
const checkpointWarned = new Set<string>();

export async function readOperatorMergeCheckpoint(gh: Octokit, repo: RepoRef): Promise<MergeCheckpoint> {
  const truthy = (v: string | undefined): boolean => /^(1|true|yes)$/i.test(v ?? '');
  if (process.env.BUILD_REQUIRES_OPERATOR_MERGE !== undefined) {
    return truthy(process.env.BUILD_REQUIRES_OPERATOR_MERGE);
  }
  try {
    const { data } = await gh.actions.getRepoVariable({ ...repo, name: 'BUILD_REQUIRES_OPERATOR_MERGE' });
    return truthy(data.value);
  } catch (error: unknown) {
    // 404 is the ordinary unset case — the FR-062 default is pre-authorized.
    if (errorStatus(error) === 404) return false;
    const key = `${repo.owner}/${repo.repo}`;
    if (!checkpointWarned.has(key)) {
      checkpointWarned.add(key);
      // Said once, and said with the remedy: a status code alone sends the operator
      // to the network tab to work out which setting it was about.
      console.warn(
        `Could not read the BUILD_REQUIRES_OPERATOR_MERGE repository variable of ${key} ` +
          `(${errorStatus(error) ?? 'no status'}). Merge authority is reported as "unknown" rather than ` +
          'guessed. A 403 means the token lacks the fine-grained "Variables" read permission — grant it, ' +
          'or set BUILD_REQUIRES_OPERATOR_MERGE in the dashboard environment to state the answer directly.',
      );
    }
    return 'unreadable';
  }
}

export async function listDeliverablePrs(gh: Octokit, repo: RepoRef, slug?: string): Promise<DeliverablePrView[]> {
  const prs = await gh.paginate(gh.pulls.list, { ...repo, state: 'all', sort: 'updated', direction: 'desc', per_page: 100 });
  // Read ONCE for the whole listing: the checkpoint is a repository-wide setting, and
  // re-reading it per pull request would let one page report two different answers.
  const checkpoint = await readOperatorMergeCheckpoint(gh, repo);
  const requiresOperatorMerge = checkpoint === true;
  // The operator's CHECKPOINT_PATHS list, read at most once per listing and only when
  // an open deliverable needs it (T274). Lazy because this listing also serves
  // `resolveVerifiedCommit`, which asks only about MERGED pull requests — reading a
  // setting that cannot change their answer would cost an API call and, on a token
  // without the Variables permission, a warning about nothing.
  let checkpointConfig: Awaited<ReturnType<typeof readCheckpointPaths>> | undefined;
  const readCheckpointConfig = async () => (checkpointConfig ??= await readCheckpointPaths(gh, repo));
  const views: DeliverablePrView[] = [];
  for (const pr of prs) {
    if (!pr.head.ref.startsWith('build/')) continue;
    const marker = parseDeliverableMarker(pr.body ?? '');
    if (slug !== undefined) {
      const prSlug = marker ? slugFromPlanRef(marker.planRef) : pr.head.ref.split('/')[1];
      if (prSlug !== slug) continue;
    }
    const labels = pr.labels.map((l) => (typeof l === 'string' ? l : (l.name ?? '')));
    const merged = Boolean(pr.merged_at);
    const state = stateFromLabels(labels, merged);
    // Open = not merged and not closed. `state` is read defensively because the
    // listing's shape is what the tests stub, and a missing field must not turn a
    // pull request into a settled one.
    const isOpen = !merged && (pr as { state?: string }).state !== 'closed';
    // MERGE AUTHORITY IS DERIVED LIVE, not parsed out of the pull request body
    // (Codex on PR #145). The body records what the writer computed at PUBLICATION
    // time, and `BUILD_REQUIRES_OPERATOR_MERGE` is a mutable repository variable: flip
    // it while a deliverable is open and the gate and the merger start refusing to
    // auto-merge while this reader kept reporting `pre-authorized`. The portfolio then
    // calls the pull request "in flight" and nothing ever asks the operator to merge
    // it — an invisible stall, which is the same failure `actionRequired` exists to
    // prevent.
    //
    // So it goes through `resolveMergeAuthority` — the SAME function the gate and the
    // merger call — with the step read from the plan the marker names. One rule, one
    // implementation, three callers. An unreadable plan yields `unknown` rather than a
    // guess: reporting `pre-authorized` because we could not tell would be the
    // absent-≠-success mistake applied to a merge decision.
    //
    // An unreadable CHECKPOINT degrades to `unknown` for the same reason — except where
    // the checkpoint does not decide the answer. A HIGH-STAKES step is
    // `operator-merge-required` whatever the configuration says (FR-062 is
    // escalation-only), so its authority is fully knowable with the setting unread, and
    // reporting `unknown` there would HIDE the one class of deliverable that certainly
    // waits for a human — worse than the guess this change removes (Codex on PR #166).
    // So: always read the step; consult the checkpoint only when it is what the answer
    // depends on.
    //
    // THE SAME RULE, GENERALIZED FOR THE PATH CHECKPOINT (T274, GHI #163 option 3).
    // Every input to `resolveMergeAuthority` escalates or is absent, so the answer is
    // KNOWABLE the moment any readable input escalates: a high-stakes step, a subject
    // workflow in the diff (the namespace needs no setting to be recognised), a path
    // inside a readable `CHECKPOINT_PATHS` glob, or a readable `true` in
    // `BUILD_REQUIRES_OPERATOR_MERGE`. Only when every input we COULD read says
    // "pre-authorized" and one input could not be read is the answer `unknown` — because
    // the unread one might have been the escalation.
    let authority: DeliverablePrView['mergeAuthority'] = 'unknown';
    let mergeReason: string | null = null;
    if (marker && !isOpen) {
      // A SETTLED pull request's authority line is history, not a decision, and it is
      // NOT re-derived (correctness review 2026-08-29). The first version re-ran
      // `resolveMergeAuthority` for a merged PR with the diff input left EMPTY — and so
      // told the operator who had merged a subject workflow by hand, because every
      // gate said operator-merge-required, that "the approved plan pre-authorized this
      // landing". A derivation from a partial input set is a false verdict, not a
      // cheaper one. What the writer recorded on the body at publication is what the
      // decision WAS; when the line is absent (a body edited by hand, a pre-T274
      // deliverable) the honest answer is `unknown`.
      const recorded = parseRecordedMergeAuthority(pr.body ?? '');
      if (recorded) ({ authority, reason: mergeReason } = recorded);
    } else if (marker) {
      const step = await stepForMarker(gh, repo, marker);
      // THE DIFF IS READ WHETHER OR NOT THE STEP RESOLVED (correctness review
      // 2026-08-29). `resolveMergeAuthority` promises the path checkpoint "is checked
      // even when the STEP is unknown", and the gate and the merger honour that — but
      // this listing used to gate the whole derivation on the step, so an unreadable
      // plan plus a subject workflow in the diff read `unknown` here and
      // `operator-merge-required` at build-merge for one pull request. Both are
      // non-permissive, but the Builds page should name the path that waits.
      //
      // AND THE DIFF READ MAY FAIL WITHOUT TAKING THE LISTING DOWN. Every other input
      // on this path degrades — the plan to `null`, the two variables to `unreadable` —
      // and this one threw, so one 5xx (or a token without pull-request read) on ANY
      // open deliverable rejected the whole listing, and with it `resolveVerifiedCommit`
      // (lifecycle-gate L3 and the completion hook), whose answer never needed that
      // diff. Unreadable ⇒ `unknown` for that row, honest and action-required.
      const touched = await listPullRequestPathsOrNull(gh, repo, pr.number);
      let checkpointPaths: ReturnType<typeof checkpointPathsTouched> | null = null;
      let configUnreadable = false;
      if (touched !== null) {
        const config = touched.length > 0 ? await readCheckpointConfig() : [];
        configUnreadable = config === 'unreadable';
        // With an unreadable list, the operator globs are empty and this holds ONLY the
        // namespace paths — which are knowable without the variable.
        //
        // NO SLUG IS THREADED HERE, DELIBERATELY (T279; the reasoning lives in
        // `checkpoint-paths.ts`'s docblock, where the rule is). Everywhere else the
        // workload slug is threaded through because an absent one must fail CLOSED —
        // an empty namespace reserves and refuses MORE. In this position the same
        // default would fail OPEN: "not in the namespace" here means *not a
        // checkpoint*, so a listing that forgot the slug would quietly stop telling the
        // operator that an agent-authored deploy workflow is waiting for them, and
        // would still typecheck. So the question asked of the diff is ANY workload's
        // namespace, which no caller can narrow by accident — and a file carrying
        // another workload's prefix could not have been delivered anyway (D5 refuses
        // it), so the wider set costs nothing and the promise holds whoever's prefix
        // the file carries.
        checkpointPaths = checkpointPathsTouched(touched, config === 'unreadable' ? [] : config);
      }
      if (step && (step.high_stakes || checkpoint === true)) {
        // INDEPENDENT ESCALATION FIRST (Codex P2 on PR #175, 2026-08-30). A high-stakes
        // step and a repository checkpoint set to `true` each require the operator's merge
        // on their own; the diff can only ADD a reason, never remove one. So an unreadable
        // diff must not turn a known "waits for you" into `unknown` — that is the same
        // permissive fallback GHI #150 was filed about, one input over. Derive with the
        // paths we have (none, when the read failed) and let the reason name what is
        // certain; the path reason, if any, is the only thing the failed read cost.
        ({ authority, reason: mergeReason } = resolveMergeAuthority(step, { requiresOperatorMerge, checkpointPaths: checkpointPaths ?? [] }));
      } else if (checkpointPaths !== null) {
        if (step) {
          const unreadable = checkpoint === 'unreadable' || configUnreadable;
          const knowable = !unreadable || checkpointPaths.length > 0;
          if (knowable) {
            ({ authority, reason: mergeReason } = resolveMergeAuthority(step, { requiresOperatorMerge, checkpointPaths }));
          }
        } else if (checkpointPaths.length > 0) {
          // The step could not be read, but a checkpoint path does not depend on the
          // plan: the answer is knowable, and it is the escalating one.
          ({ authority, reason: mergeReason } = resolveMergeAuthority(null, { checkpointPaths }));
        }
      }
    }
    views.push({
      number: pr.number,
      title: pr.title,
      url: pr.html_url,
      branch: pr.head.ref,
      state,
      merged,
      mergeCommitSha: pr.merge_commit_sha ?? null,
      mergedAt: pr.merged_at ?? null,
      marker,
      // NOT the pre-authorized case: a pre-authorized PR waiting on the deterministic
      // merger is in progress, not blocked on a human — flagging it would teach the
      // operator that action-required sometimes means "wait".
      //
      // `unknown` DOES belong here (Codex on PR #166). It is not "wait", it is "we
      // could not tell whether this waits for you", and the surface that leaves it out
      // files it under In flight, where the card reads *"Nothing is asked of you
      // here."* — the permissive answer this whole change exists to stop reporting,
      // arriving one layer up. Asking a human to look at a deliverable that might be
      // stalled is the cheap error; leaving it silent is the expensive one.
      actionRequired: state === 'awaiting-merge' && authority !== 'pre-authorized',
      mergeAuthority: authority,
      mergeReason,
      updatedAt: pr.updated_at,
    });
  }
  return views;
}

/**
 * THE VERIFIED COMMIT for a workload — what L3 reads check runs on (FR-034 as
 * amended, FR-063).
 *
 * Before US18 this was simply the frozen tag's commit, and that was defensible only
 * while a build verified the frozen TREE and produced nothing. Once a build produces
 * a deliverable, results on the frozen commit describe code the repository has never
 * contained — a completion earned on a lie (GHI #141).
 *
 * So: the newest MERGED deliverable whose marker names the workload's OFFICIAL plan
 * ref. Two properties follow, both wanted:
 *   • a re-opened plan (new version, new tag) invalidates old deliverables for
 *     completion purposes without deleting anything — their marker names the
 *     superseded ref and stops matching.
 *   • a workload with no merged deliverable falls back to the frozen SHA, which is
 *     the pre-US18 COMPATIBILITY SHIM and nothing more. It is what keeps plans
 *     frozen before 2026-08-24 completable; it is not a licence to complete a
 *     US18-era workload that never built anything, because such a workload has no
 *     `vt-*` check runs on the frozen commit either — `build-publish` refuses to
 *     create anything for a build with no deliverable, and nothing else writes them.
 */
export async function resolveVerifiedCommit(
  gh: Octokit,
  repo: RepoRef,
  planRef: string,
  frozenSha: string,
): Promise<{ sha: string; source: 'merged-deliverable' | 'frozen-plan'; prNumber?: number }> {
  const slug = slugFromPlanRef(planRef);
  if (slug === null) return { sha: frozenSha, source: 'frozen-plan' };
  const prs = await listDeliverablePrs(gh, repo, slug);
  const merged = prs
    .filter((p) => p.merged && p.mergeCommitSha && p.marker?.planRef === planRef)
    // BY MERGE TIME, which is immutable (Codex on PR #145). Sorting by `updatedAt`
    // meant a label change or a body edit on an OLDER deliverable could make it sort
    // newest, and L3 would then read `vt-*` check runs from the wrong merge commit —
    // completing against a stale tree, or refusing a completion that was valid. For a
    // multi-step plan with several merged deliverables that is reachable, and
    // `build-publish` itself edits bodies on re-delivery.
    .sort((a, b) => (a.mergedAt ?? '').localeCompare(b.mergedAt ?? '') * -1);
  const newest = merged[0];
  return newest?.mergeCommitSha
    ? { sha: newest.mergeCommitSha, source: 'merged-deliverable', prNumber: newest.number }
    : { sha: frozenSha, source: 'frozen-plan' };
}

/* ------------------------------------------------------------------------- *
 * Dispatching a build (GHI #196; decision D4, 2026-09-08) — the one governed
 * action the dashboard could not perform.
 * ------------------------------------------------------------------------- */

/**
 * The workflow every build runs as, and the file it must exist as on the target.
 *
 * Derived from the readiness list, not typed here: `init --verify` (I5) asserts this
 * exact filename exists in the target, and `workflowDispatchUrl` derives its link from
 * the same constants. Three readers of one filename must not be able to disagree.
 */
const BUILD_WORKFLOW = 'build-template' satisfies (typeof AGENTIC_WORKFLOWS)[number];
export const BUILD_WORKFLOW_PATH = `.github/workflows/${BUILD_WORKFLOW}.lock.yml`;

export interface DispatchBuildInput {
  slug: string;
  /** the work item (chunk issue number) this build delivers. Never optional: the
   *  dashboard dispatches per work item only (D4) — a chunkless "whole plan" build is
   *  the Actions UI's legacy route, and the agent choosing the step is GHI #116's
   *  problem, not a feature. */
  chunk: number;
  /** nobody watching — allowed only on a work item whose intent the operator confirmed */
  unattended: boolean;
  /** @login of the operator who clicked, and when — the event comment's attribution */
  actor: string;
  at: string;
}

export interface DispatchBuildResult {
  /** the run GitHub created, once it appeared; null when it had not yet — the caller
   *  links the Runs page, never a guessed id */
  runId: number | null;
  /** the FULLY-QUALIFIED ref the dispatch was made on: `refs/tags/plan/<slug>/v<N>` */
  ref: string;
  /** the exact `workflow_dispatch` inputs GitHub received */
  inputs: Record<string, string>;
  /** the frozen plan, by its short name (`plan/<slug>/v<N>`) — what the run's
   *  `head_branch` will read as, and what the operator knows the plan by */
  planRef: string;
  /** the workload issue the event comment was recorded on */
  workloadIssue: number;
  /**
   * Non-null when the build STARTED but its record comment could not be written: the
   * sentence names what failed and the exact fact that went unrecorded (who started
   * what, when) so the operator can add it to the workload by hand. The dispatch is
   * not undone — GitHub has the run — and the action must not report failure, or the
   * operator retries and starts a second paid build (PR #204 review).
   */
  recordWarning: string | null;
}

export interface DispatchBuildOptions {
  /** how many times to look for the new run before giving the caller `null` */
  attempts?: number;
  /** pause between looks, in milliseconds */
  delayMs?: number;
}

/**
 * The sentence the workload card, the plan review and `dispatchBuild` all use for a
 * flagged step whose confirmation is not on record — one wording, so the button that
 * is withheld and the refusal a hand-crafted POST meets say the same thing. Names the
 * authority and where the record is made; no gate id (operator-visible copy).
 */
export function awaitingConfirmationSentence(step: Pick<PlanStep, 'id' | 'authority'>): string {
  const who = step.authority ? `${step.authority.replace('-', ' and ')} confirmation` : 'outside confirmation';
  return `step ${step.id} is flagged high-stakes and its ${who} is not on record, so the build's own gate would refuse it before the agent started. Record the confirmation under High-stakes on the plan review, then dispatch.`;
}

/**
 * The sentence for a work item carrying `flagged:wrong-assumption` — evidence
 * contradicted an assumption it rests on (GHI #205). One wording for the card, the
 * review and `dispatchBuild`'s refusal, so the withheld button and a hand-crafted
 * POST say the same thing. Names the two remedies; no gate id (operator-visible copy).
 */
export function wrongAssumptionSentence(issueNumber: number): string {
  return `work item #${issueNumber} is flagged as resting on a wrong assumption — evidence contradicted it, and the build's own gate would refuse it before the agent started. Resolve the contradiction on the Evidence page, or re-open the plan so the step is judged again, then dispatch.`;
}

/**
 * Dispatch a build of ONE work item of a workload's official frozen plan, on the frozen
 * tag by construction.
 *
 * WHY THE REF IS DERIVED AND FULLY QUALIFIED. Runs 33931241186 and 33976904559 on
 * `lza-phase0` were both refused at the workflow's own tag guard because GitHub's
 * Run-workflow picker offers the BRANCH `plan/lza-phase0/v1` first and the tag of the
 * same name second; the operator picked what was offered. The guard was right; the door
 * was wrong. Here the ref is `refs/tags/` + the tag `resolveCurrent` found — the newest
 * frozen version, which is the official plan by derivation (GHI #44) — so no caller can
 * type a name, and the tag/branch ambiguity cannot arise. The workflow's first step and
 * preflight B8 still check it; this makes the check unable to fail for this door.
 *
 * WHY IT REFUSES WHAT THE RUNNER WOULD REFUSE. Every refusal below is a question the
 * preflight asks on the runner two minutes later — B7 (workload active), B3 (the work
 * item is `chunk:ready` and exactly one step of THIS plan tracks it), B4 (an unattended
 * run has the confirmation on record). Asking them here, read-only, before spending a
 * run is `actions.ts`'s principle: the refusal before the click, never only after. The
 * gate remains the authority (GHI #108); this is a preview that happens to refuse. The
 * sentences carry no gate ids — they reach the operator's page verbatim (house rule).
 *
 * Nothing is written on any refusal. The dispatch is the first write, the event comment
 * on the workload issue the second; the run lookup after them is read-only and may
 * fail without undoing either. A failed event comment is reported in `recordWarning`
 * rather than thrown, for the same reason the lookup is: the build has started.
 */
export async function dispatchBuild(
  gh: Octokit,
  repo: RepoRef,
  input: DispatchBuildInput,
  opts: DispatchBuildOptions = {},
): Promise<DispatchBuildResult> {
  const { slug, chunk } = input;
  if (!Number.isInteger(chunk) || chunk <= 0) {
    throw new Refusal(
      `"${String(chunk)}" is not a work item number — a build delivers one work item, so no run was started. Dispatch from a work item's own row.`,
    );
  }

  // 1. The official plan: the newest frozen tag, or nothing to build from.
  const planRef = await resolveCurrent(gh, repo, slug);
  if (planRef === null) {
    throw new Refusal(
      `workload ${slug} has no approved plan — nothing is frozen to build from, so no run was started. Approve a plan first (Commit for approval, then merge the approval pull request); the frozen tag that creates is the only ref a build runs on.`,
    );
  }
  // The tag's commit, for the record. `resolveCurrent` just listed this tag and tags
  // are never deleted, so an absent answer here is a fault, not a state.
  const frozenSha = await tagTargetSha(gh, repo, planRef);
  if (frozenSha === null) throw new Error(`frozen tag ${planRef} was listed but cannot be resolved to a commit`);
  // 1b. The freeze must have COMPLETED (GHI #212; review of PR #214): the tag comes
  //     first, the work items are rewritten to this version's steps after it, and the
  //     break is resolved last. A tag with an unresolved break is a freeze that stopped
  //     part-way — this item may still say, and still be confirmed for, what the
  //     previous version said — and the runner's B1 would refuse it; spend no run.
  const completion = await freezeCompletion(gh, repo, planRef);
  if (!completion.complete) {
    throw new Refusal(`${freezeIncompleteSentence(planRef)} No run was started.`);
  }

  // 2. The workload must be active (B7 would refuse anyway — spend no run).
  const workload = await getWorkload(gh, repo, slug);
  if (!workload) {
    throw new Refusal(
      `no workload is named ${slug} — a build belongs to a workload, and none carries this slug, so no run was started. Introduce the workload first.`,
    );
  }
  if (workload.state !== 'active') {
    throw new Refusal(
      `workload ${slug} is ${workload.state ?? 'in no single state (its issue does not carry exactly one workload label)'}, not active — the build's own preflight would refuse it on the runner, so no run was spent. ${inactiveWorkloadRemedy(workload.state)}`,
    );
  }

  // 3. The work item must be a ready chunk that exactly one step of THIS frozen plan
  //    tracks (B3's binding). A chunk of another workload, another version, or none
  //    is refused here rather than two minutes later on the runner.
  const item = await getChunk(gh, repo, chunk);
  if (!item) {
    throw new Refusal(
      `issue #${chunk} is not a work item (it carries no work-item label) — a build delivers one work item, so no run was started. Dispatch from a work item's own row.`,
    );
  }
  if (item.state !== 'ready') {
    throw new Refusal(
      `work item #${chunk} still carries the retired title-only label — a build delivers a work item that says what "done" means, so no run was started. Write its intent, outcome metric and acceptance on its workload's card under Work items — an item the plan tracks is listed there, not among the unbound ones — and dispatch again.`,
    );
  }
  const missing = (['intent', 'outcomeMetric', 'acceptance'] as const).filter((f) => item[f] === null);
  if (missing.length > 0) {
    throw new Refusal(
      `work item #${chunk} is labelled ready but its requirement is missing ${missing.join(', ')} — the runner's gate would refuse the build, so no run was spent. Complete the requirement on the work item and dispatch again.`,
    );
  }
  // `readPlanAtRef` THROWS on a frozen document that no longer parses. That is a fault:
  // the freeze wrote it, nothing else can, and no remedy of the operator's fixes it.
  const plan = await readPlanAtRef(gh, repo, planRef);
  const claiming = plan.steps.filter((s) => s.tracking_issue === chunk);
  if (claiming.length === 0) {
    throw new Refusal(
      `work item #${chunk} is not tracked by any step of ${planRef} — the gate on the runner would refuse this build, so no run was spent. A build delivers the step that tracks its work item: re-open the plan and bind a step to #${chunk} at Commit for approval, or dispatch one of the work items this plan does track.`,
    );
  }
  if (claiming.length > 1) {
    throw new Refusal(
      `work item #${chunk} is tracked by ${claiming.map((s) => s.id).join(' and ')} in ${planRef} — one work item delivers one step, so this build cannot say which step it is for and the runner's gate would refuse it. Re-open the plan and give each step its own work item.`,
    );
  }
  const step = claiming[0]!;

  // 3b. A flagged step's outside confirmation must be on record (the runner's B5,
  //     scoped to this one step — GHI #87). Asked here with the gate's own function
  //     so the click and the runner cannot disagree, and so a run is not spent to
  //     learn what the review's High-stakes section already shows. Unflagged steps
  //     cost nothing.
  if (step.high_stakes) {
    const b5 = await checkB5ConfirmationRecorded(gh, repo, planRef, [step.id]);
    if (b5.status !== 'pass') {
      throw new Refusal(`${awaitingConfirmationSentence(step)} No run was started.`);
    }
  }

  // 3c. A contradicted work item does not build (the runner's B6, GHI #205). The
  //     gate's own function, not a restatement of its predicate: the label it reads
  //     is the label the Evidence page writes, and two readers of one label is how a
  //     card and a runner come to disagree. Asked here so a run is not spent to fail
  //     on it two minutes later.
  const b6 = await checkB6NotFlagged(gh, repo, chunk);
  if (b6.status !== 'pass') {
    throw new Refusal(`${wrongAssumptionSentence(chunk)} No run was started.`);
  }

  // 4. Unattended needs the confirmation ON RECORD — the well-formed comment carrying
  //    identity and timestamp, not the label alone (B4's rule; the label is a light).
  let confirmation: { by: string; at: string } | null = null;
  if (input.unattended) {
    if (!item.intentConfirmed) {
      throw new Refusal(
        `work item #${chunk} carries no intent confirmation — an unattended build runs with nobody watching, and only your recorded confirmation authorizes that, so no run was started. Confirm the work item's intent on its row, or dispatch it attended.`,
      );
    }
    confirmation = await findIntentConfirmation(gh, repo, chunk);
    if (!confirmation) {
      throw new Refusal(
        `work item #${chunk} carries the intent:confirmed label but no well-formed confirmation on record — the label without the record authorizes nothing, so no run was started. Confirm the work item's intent again (which writes the record), or dispatch it attended.`,
      );
    }
  }

  // 5. The workflow to run, found by the file it must exist as. Absent from the listing
  //    is a verified absence (the listing IS the set of workflows GitHub knows), and the
  //    remedy is init; an unreadable listing throws and is a fault.
  const workflows = await gh.paginate(gh.actions.listRepoWorkflows, { ...repo, per_page: 100 });
  const workflow = workflows.find((w) => w.path === BUILD_WORKFLOW_PATH);
  if (!workflow) {
    throw new Refusal(
      `the build workflow is not installed on ${repo.owner}/${repo.repo} (${BUILD_WORKFLOW_PATH} is not among its workflows) — nothing there can run a build, so no run was started. Run \`npm run init\` against the target, then dispatch again.`,
    );
  }
  if (workflow.state !== 'active') {
    throw new Refusal(
      `the build workflow is disabled in the Actions UI (state: ${workflow.state}) — GitHub refuses to start it, so no run was started. Re-enable it under Actions → ${BUILD_WORKFLOW} → Enable workflow, then dispatch again.`,
    );
  }

  // The runs on this workflow and tag BEFORE the dispatch. GitHub does not return the
  // run a dispatch creates (204, no body), so "the new run" is found by difference: a
  // previous build of the same work item on the same tag is a real run on this exact
  // key, and reading the newest row without this snapshot would link the operator to
  // it and call it theirs. Clock-free on purpose — comparing `created_at` against the
  // operator's `at` trusts two clocks to agree.
  const before = new Set(await listRunIds(gh, repo, workflow.id, planRef));

  // THE DISPATCH. Inputs are the template's own names (`templates/workflows/
  // build-template.md`, `on.workflow_dispatch.inputs`), every one a string as GitHub
  // requires. `gates_ref` is sent blank deliberately: the workflow then runs its gates
  // from the default branch — CURRENT rules over a FROZEN plan (GHI #107).
  const ref = `refs/tags/${planRef}`;
  const inputs: Record<string, string> = {
    plan_ref: planRef,
    workload: slug,
    chunk: String(chunk),
    unattended: input.unattended ? 'true' : 'false',
    gates_ref: '',
  };
  try {
    await gh.actions.createWorkflowDispatch({ ...repo, workflow_id: workflow.id, ref, inputs });
  } catch (error: unknown) {
    // A 403 HERE IS A REFUSAL, NOT A FAULT (live, 2026-09-11, the first LZA dispatch):
    // starting a run is an Actions WRITE, and a day-to-day token minted from the guide's
    // pre-Wave-1 row (Actions: Read) is denied with "Resource not accessible by personal
    // access token". Nothing was started, nothing was written — but as a plain throw this
    // reached the error boundary as "a fault in the dashboard" with a log digest, and the
    // one sentence the operator needed (which permission, where) never arrived. The
    // remedy is the operator's, so the sentence is the product; GitHub's own words ride
    // along. ONLY the permission-denied 403 is converted (Codex P2 on PR #221): GitHub also
    // answers 403 for an exhausted rate limit ("API rate limit exceeded", transient — the
    // token is fine) and for a repository/organization Actions policy that blocks
    // dispatches (not the token's scope either). Telling either operator to edit the token
    // is the wrong remedy, so those stay faults with GitHub's message in the digest. The
    // permission signal is GitHub's own wording for a denied scope, for a PAT and for an
    // App installation token alike. Any other status is still a fault: a 404 or 422 means
    // the lookups above lied.
    if (isPermissionDenied(error)) {
      throw new Refusal(
        `GitHub refused to start the build: the dashboard's credential may not start workflow runs on this repository. ` +
          `Starting a run needs the permission Actions: Read and write (CONFIGURATION_GUIDE.md §1, the Actions row); ` +
          `${credentialRemedy(error, 'Actions: Read and write')}, then dispatch again. No run was started. ${githubSaid(error)}`,
      );
    }
    throw error;
  }

  // THE RECORD, before the lookup: who started what is the durable fact; the run id is
  // a convenience the Runs page can supply if this comment has to stand without it.
  //
  // A FAILED RECORD IS A WARNING, NOT A THROW. The dispatch above is the one write
  // that cannot be taken back — GitHub has the run — so a fault here must not reach
  // the operator as "the dispatch failed": they would retry, and the retry is a second
  // paid build of the same work item (PR #204 review). The build is reported as
  // running, and the warning carries the exact fact that went unrecorded so it can be
  // added by hand. A fault BEFORE the dispatch still throws — nothing has happened yet.
  let recordWarning: string | null = null;
  try {
    await gh.issues.createComment({
      ...repo,
      issue_number: workload.issueNumber,
      body: serializeBuildDispatchEvent({
        slug,
        chunk,
        planRef,
        stepId: step.id,
        frozenSha,
        unattended: input.unattended,
        confirmation,
        by: input.actor,
        at: input.at,
      }),
    });
  } catch (error: unknown) {
    recordWarning =
      `the dispatch record could not be written on workload issue #${workload.issueNumber} ` +
      `(${errorStatus(error) ?? 'no status'}: ${errorMessage(error)}). Unrecorded fact: ` +
      `build of work item #${chunk} (step ${step.id}) on ${planRef}, ${input.unattended ? 'unattended' : 'attended'}, ` +
      `dispatched by @${input.actor} at ${input.at}`;
    console.warn(`build dispatched on ${planRef}, but ${recordWarning}`);
  }

  const runId = await findNewRun(gh, repo, workflow.id, planRef, before, opts);
  return { runId, ref, inputs, planRef, workloadIssue: workload.issueNumber, recordWarning };
}

function inactiveWorkloadRemedy(state: string | null): string {
  switch (state) {
    case 'proposed':
      return 'Activate the workload from its card, then dispatch.';
    case 'deferred':
      return 'Reactivate the workload from its card, then dispatch.';
    case null:
      return 'Fix the labels on its issue so it carries exactly one workload state, then dispatch.';
    default:
      return 'A completed, canceled or archived workload does not build; introduce a new workload for new work.';
  }
}

/** Run ids on one workflow for one plan ref — `head_branch` IS the tag name for a run
 *  dispatched on a tag, which is what makes the plan ref the session key (FR-013). */
async function listRunIds(gh: Octokit, repo: RepoRef, workflowId: number, planRef: string): Promise<number[]> {
  const { data } = await gh.actions.listWorkflowRuns({
    ...repo,
    workflow_id: workflowId,
    branch: planRef,
    event: 'workflow_dispatch',
    per_page: 20,
  });
  return data.workflow_runs.map((r) => r.id).filter((id) => Number.isInteger(id) && id > 0);
}

/**
 * The run the dispatch produced, once GitHub lists it: the newest id on this workflow
 * and tag that was not there before. A few short looks, then `null` — the dispatch is
 * accepted asynchronously and a run can take several seconds to appear, but a server
 * action should not hold the page for long when the Runs page will show it anyway.
 *
 * A failed lookup is `null`, not a throw: the build HAS started and the record IS
 * written by the time this runs, and a crash page over a read that changed nothing
 * would tell the operator the opposite of what happened.
 */
async function findNewRun(
  gh: Octokit,
  repo: RepoRef,
  workflowId: number,
  planRef: string,
  before: Set<number>,
  opts: DispatchBuildOptions,
): Promise<number | null> {
  const attempts = opts.attempts ?? 4;
  const delayMs = opts.delayMs ?? 750;
  for (let i = 0; i < attempts; i += 1) {
    try {
      const fresh = (await listRunIds(gh, repo, workflowId, planRef)).filter((id) => !before.has(id));
      if (fresh.length > 0) return Math.max(...fresh);
    } catch (error: unknown) {
      console.warn(
        `build dispatched on ${planRef}, but its run could not be looked up (${errorStatus(error) ?? 'no status'}: ${errorMessage(error)}) — the Runs page will show it`,
      );
      return null;
    }
    if (i + 1 < attempts && delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs));
  }
  return null;
}

// ---------- the dispatch event comment ----------

export interface BuildDispatchEvent {
  slug: string;
  chunk: number;
  planRef: string;
  unattended: boolean;
  by: string;
  at: string;
}

const BUILD_DISPATCH_RE =
  /<!--\s*build-dispatch:v1\s+workload:(\S+)\s+chunk:(\d+)\s+plan:(\S+)\s+unattended:(true|false)\s+by:@(\S+)\s+at:(\S+?)\s*-->/;

/**
 * The event comment on the workload issue: a visible sentence for the operator reading
 * the issue, then the machine-readable marker (the same dual rendering every other
 * event comment here uses — a marker-only body renders as an EMPTY comment on GitHub).
 * Attribution is the point: the run's own actor is the dashboard's token, so without
 * this line the record would say a robot started the build.
 */
function serializeBuildDispatchEvent(e: {
  slug: string;
  chunk: number;
  planRef: string;
  stepId: string;
  frozenSha: string;
  unattended: boolean;
  confirmation: { by: string; at: string } | null;
  by: string;
  at: string;
}): string {
  const mode = e.unattended
    ? `unattended — nobody watching, authorized by the intent confirmation of @${e.confirmation?.by ?? 'unknown'} at ${e.confirmation?.at ?? 'unknown'}`
    : 'attended';
  const visible =
    `**Build dispatched** for work item #${e.chunk} on \`${e.planRef}\` by @${e.by} at ${e.at}\n` +
    `> step: ${e.stepId} · mode: ${mode}\n` +
    `> ref: \`refs/tags/${e.planRef}\` (commit ${e.frozenSha})`;
  const marker = `<!-- build-dispatch:v1 workload:${e.slug} chunk:${e.chunk} plan:${e.planRef} unattended:${e.unattended} by:@${e.by} at:${e.at} -->`;
  return `${visible}\n\n${marker}`;
}

/** The dispatch event a comment records, or null when the comment is not one. */
export function parseBuildDispatchEvent(body: string): BuildDispatchEvent | null {
  const m = BUILD_DISPATCH_RE.exec(body);
  if (!m) return null;
  return { slug: m[1]!, chunk: Number(m[2]), planRef: m[3]!, unattended: m[4] === 'true', by: m[5]!, at: m[6]! };
}
