import { readFileSync } from 'node:fs';
import type { Octokit } from '@octokit/rest';
import { createClient, type RepoRef } from '../dashboard/lib/github/client';
import { performLifecycleTransition } from '../dashboard/lib/github/lifecycle';
import { errorMessage } from '../dashboard/lib/github/errors';
import { resolveCurrent, tagTargetSha } from '../dashboard/lib/github/plans';
import { resolveVerifiedCommit } from '../dashboard/lib/github/builds';
import { dispatchSubjectWorkflows, type DispatchSubjectWorkflowsResult } from '../dashboard/lib/github/subject-workflows';
import { subjectWorkflowName } from './install-manifest';

/**
 * Lifecycle apply CLI — invoked ONLY by the workload-lifecycle workflow after
 * lifecycle-gate passes: performs the post-gate effects (cancel: REST run
 * cancellation + live breaks → andon:superseded with corrections withdrawn;
 * contradicted reactivate: plan re-open, FR-040) and then flips the
 * workload:* label and appends the workload-event:v1 comment (close+lock on
 * archive happens in the module). --gate-report points at the gate step's
 * --json output so L8's requires_review verdict — not a re-scan that could
 * disagree with it — is what decides the re-open.
 *
 * AND, AFTER A SUCCESSFUL `complete`, THE DEPLOY HOOK (T273/T274, FR-070, GHI #174
 * §3). A subject workflow — the operator's own deploy, delivered by an agent into
 * `.github/workflows/<workload-slug>_<name>.yml` and merged by the operator — never
 * fires on the automated path by itself: `build-merge` merges with GITHUB_TOKEN and
 * GitHub emits no `push` for that. So completion is where the product starts it: every
 * subject workflow OF THE COMPLETING WORKLOAD declaring the `plan_ref` and `commit`
 * inputs is `workflow_dispatch`ed with the official plan ref and the VERIFIED MERGED
 * COMMIT — the same commit L3 just read its check runs from, so what deploys is exactly
 * what was verified (FR-063).
 *
 * "OF THE COMPLETING WORKLOAD" IS LOAD-BEARING (T279, operator decision 2026-09-01).
 * The namespace is the workload's own slug, so `demo7`'s completion starts `demo7_*.yml`
 * and nothing else. Under the old shared prefix this hook dispatched every subject
 * workflow in the repository, handing one workload's plan ref and merged commit to
 * another workload's deploy — a tree that deploy's own operator never approved.
 *
 * WHAT IT RECORDS, AND WHERE. On the workload issue, one comment: each dispatched
 * workflow with both values; each skipped one with why (no dispatch inputs, or the
 * operator disabled it in the Actions UI); or that this workload owns none, naming the
 * prefix its own would carry; or — when the workload completed on the pre-US18
 * compatibility shim with no merged deliverable — that nothing was dispatched and why.
 * Absent ≠ success (GHI #108): there is no silent branch. ANY API error after the
 * transition — resolving the plan, the verified commit or the default branch, as much
 * as the dispatch itself — is commented FIRST and then fails the run: the transition
 * already happened and must not be undone by a failed side effect; the red run and the
 * comment are the signal.
 */

const ACTIONS = ['activate', 'complete', 'cancel', 'defer', 'reactivate', 'archive'];

/** The plain-language record the hook leaves on the workload issue. No gate ids: the
 *  reader is the operator (house rule). */
export const NO_MERGED_DELIVERABLE_NOTE =
  'no subject workflow was dispatched: this workload completed with no merged deliverable';
/** Said of THIS WORKLOAD, not of the repository (T279). The namespace is per-workload
 *  (`<slug>_<name>.yml`), so a repository can hold another workload's deploy workflow
 *  and still have nothing for this completion to start — and a record that claimed the
 *  repository had none would be false about a file the operator can see in the Actions
 *  tab. The prefix this workload's own workflows carry is named at the call site, so
 *  the sentence also says the way out. */
export const NO_SUBJECT_WORKFLOWS_NOTE = 'this workload owns no subject workflow in this repository';

export type CompletionDispatchOutcome =
  | { kind: 'no-plan'; comment: string }
  | { kind: 'no-merged-deliverable'; comment: string }
  | { kind: 'dispatched'; comment: string; planRef: string; commit: string; result: DispatchSubjectWorkflowsResult };

/**
 * The completion → dispatch hook. Comments the record on `issueNumber` and returns
 * it; a dispatch API error is commented and then RETHROWN for the caller to fail on.
 */
export async function dispatchOnCompletion(
  gh: Octokit,
  repo: RepoRef,
  slug: string,
  issueNumber: number,
): Promise<CompletionDispatchOutcome> {
  const comment = async (body: string): Promise<void> => {
    await gh.issues.createComment({ ...repo, issue_number: issueNumber, body });
  };
  /** The failure record, written BEFORE the error propagates — and written so that a
   *  failing comment cannot replace the original error in the log: the record is a
   *  best effort, the rethrow is the contract. */
  const failAfterCommenting = async (body: string, error: unknown): Promise<never> => {
    try {
      await comment(body);
    } catch (commentError: unknown) {
      console.error(`could not write the deploy-hook failure record to issue #${issueNumber}: ${errorMessage(commentError)}`);
    }
    throw error;
  };

  // EVERY read after the transition is inside a try (correctness review 2026-08-29):
  // the first version recorded only a failed DISPATCH, so an API error while resolving
  // what to deploy — the plan ref, the frozen tag, the verified commit, the default
  // branch — reached `main` and exited red with no comment on the workload issue. The
  // exit code was right; the durable record was missing, and this module's contract is
  // that there is no silent branch. The two failures are named apart because they need
  // different follow-ups: "could not resolve" means nothing started; "dispatch stopped"
  // means some workflows may have.
  let planRef: string | null;
  let frozenSha: string | null;
  let verified: Awaited<ReturnType<typeof resolveVerifiedCommit>>;
  let ref: string;
  try {
    // The official plan and its frozen commit — the same derivation L3 used a moment
    // ago. No frozen plan means no deliverable could have been built from one, so this
    // is the shim case by construction; it is named separately because "no plan" and
    // "a plan that built nothing" are different things for the operator to fix.
    planRef = await resolveCurrent(gh, repo, slug);
    frozenSha = planRef ? await tagTargetSha(gh, repo, planRef) : null;
    if (!planRef || !frozenSha) {
      const body = `**Deploy hook** — ${NO_MERGED_DELIVERABLE_NOTE} (it has no frozen plan, so nothing was built to deploy).`;
      await comment(body);
      return { kind: 'no-plan', comment: body };
    }

    verified = await resolveVerifiedCommit(gh, repo, planRef, frozenSha);
    if (verified.source !== 'merged-deliverable') {
      // The pre-US18 compatibility shim: completion earned on the frozen commit itself.
      // There is nothing agent-built on the default branch, so a deploy would deploy
      // whatever was already there — and FR-070 says MUST NOT.
      const body = `**Deploy hook** — ${NO_MERGED_DELIVERABLE_NOTE}. Plan \`${planRef}\` was verified on its frozen commit \`${frozenSha.slice(0, 8)}\`, not on a merged pull request, so there is nothing agent-built to deploy.`;
      await comment(body);
      return { kind: 'no-merged-deliverable', comment: body };
    }

    // Dispatch FROM the default branch: that is where the merged deliverable — and the
    // subject workflow itself, if the agent delivered it — now live. `listRepoWorkflows`
    // indexes the default branch too, so reading the inputs there matches the listing.
    const { data: repository } = await gh.repos.get({ ...repo });
    ref = repository.default_branch;
  } catch (error: unknown) {
    return failAfterCommenting(
      `**Deploy hook FAILED** — could not resolve what to deploy for this workload (the official plan, its verified merged ` +
        `commit, or the default branch): ${errorMessage(error)}. NO subject workflow was dispatched. The completion itself ` +
        'stands; this run is red so the failure is seen. Once the cause is fixed, dispatch your subject workflows by hand ' +
        '(Actions → the workflow → Run workflow) with the plan ref and the merged commit from the Builds page.',
      error,
    );
  }

  let result: DispatchSubjectWorkflowsResult;
  try {
    result = await dispatchSubjectWorkflows(gh, repo, { slug, planRef, commit: verified.sha, ref });
  } catch (error: unknown) {
    // A dispatch refusal is no longer thrown from inside the list (it is recorded per
    // workflow in `result.failed`, below); what reaches here is a failure to LIST the
    // workflows or to READ one — before any dispatch was attempted. Comment first, then
    // let the caller fail the run.
    return failAfterCommenting(
      `**Deploy hook FAILED** — could not list or read this workload's subject workflows for plan \`${planRef}\` at commit ` +
        `\`${verified.sha.slice(0, 8)}\`: ${errorMessage(error)}. NO subject workflow was dispatched. The completion itself stands; ` +
        'this run is red so the failure is seen, and re-running the complete transition is refused by the gate, so once the ' +
        'cause is fixed dispatch your subject workflows by hand (Actions → the workflow → Run workflow).',
      error,
    );
  }

  const lines = [`**Deploy hook** — plan \`${planRef}\`, verified commit \`${verified.sha.slice(0, 8)}\` (PR #${verified.prNumber ?? '?'}).`];
  if (result.none) {
    lines.push(
      '',
      `${NO_SUBJECT_WORKFLOWS_NOTE} — nothing to dispatch. A deploy workflow this workload can start is named ` +
        `\`.github/workflows/${subjectWorkflowName(slug, '<name>')}\` (this workload's own slug is the prefix); a ` +
        'workflow under any other name belongs to another workload or to the oversight machinery, and this hook ' +
        'does not start it.',
    );
  } else {
    for (const d of result.dispatched) {
      lines.push('', `- dispatched \`${d.path}\` with \`plan_ref=${planRef}\` and \`commit=${verified.sha}\``);
    }
    for (const s of result.skipped) {
      lines.push('', `- skipped \`${s.path}\`: ${s.why}`);
    }
    for (const f of result.failed) {
      lines.push(
        '',
        `- **FAILED** to dispatch \`${f.path}\`: ${f.why} — re-dispatch it by hand (Actions → the workflow → Run workflow) with \`plan_ref=${planRef}\` and \`commit=${verified.sha}\`; the workflows listed as dispatched above have already started and must not be started twice`,
      );
    }
    if (result.dispatched.length === 0 && result.failed.length === 0) {
      lines.push('', 'No subject workflow was dispatched: every one present was skipped for the reason given.');
    }
  }
  if (result.failed.length > 0) {
    lines.splice(0, 1, `**Deploy hook FAILED** — plan \`${planRef}\`, verified commit \`${verified.sha.slice(0, 8)}\` (PR #${verified.prNumber ?? '?'}): ${result.failed.length} of ${result.dispatched.length + result.failed.length} dispatch(es) refused by the API. The completion itself stands; this run is red so the failure is seen, and re-running the complete transition is refused by the gate.`);
  }
  const body = lines.join('\n');
  if (result.failed.length > 0) {
    // The record is written (best effort — a failing comment is logged, never allowed to
    // replace this error), then the run goes red with GitHub's words in the error so the
    // log and the comment say the same thing.
    return failAfterCommenting(
      body,
      new Error(`${result.failed.length} subject workflow dispatch(es) failed: ${result.failed.map((f) => `${f.path} (${f.why})`).join('; ')}`),
    );
  }
  await comment(body);
  return { kind: 'dispatched', comment: body, planRef, commit: verified.sha, result };
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const get = (name: string): string | undefined => {
    const i = argv.indexOf(`--${name}`);
    const v = i >= 0 ? argv[i + 1] : undefined;
    return v && v.length > 0 ? v : undefined;
  };
  const slug = get('workload');
  const action = get('action');
  const repoArg = get('repo');
  if (!slug || !action || !repoArg || !ACTIONS.includes(action)) {
    console.error('usage: lifecycle-apply --workload <slug> --action <activate|complete|cancel|defer|reactivate|archive> --actor <login> --repo <owner/repo> [--reason ..] [--revisit ..] [--gate-report <path>]');
    process.exit(2);
  }
  const [owner, repoName] = repoArg.split('/');
  if (!owner || !repoName) {
    console.error(`invalid --repo: ${repoArg}`);
    process.exit(2);
  }

  let requiresReview: boolean | undefined;
  const gateReportPath = get('gate-report');
  if (gateReportPath) {
    const report = JSON.parse(readFileSync(gateReportPath, 'utf8')) as { requires_review?: boolean };
    requiresReview = report.requires_review;
  }

  const gh = createClient();
  const repo = { owner, repo: repoName };
  const reason = get('reason');
  const revisit = get('revisit');
  const result = await performLifecycleTransition(gh, repo, {
    slug,
    action,
    actor: get('actor') ?? 'workload-lifecycle[bot]',
    at: new Date().toISOString(),
    ...(reason !== undefined ? { reason } : {}),
    ...(revisit !== undefined ? { revisit } : {}),
    ...(requiresReview !== undefined ? { requiresReview } : {}),
  });
  console.log(`workload ${slug} → workload:${result.workload.state}`);
  for (const run of result.canceledRuns) console.log(`canceled in-flight run ${run.id} (${run.headBranch})`);
  for (const issue of result.supersededBreaks) console.log(`Andon #${issue} → andon:superseded (cause: workload canceled), open corrections withdrawn`);
  if (result.reopened) console.log(`plan re-opened for review: ${result.reopened.planRef} (Andon #${result.reopened.andonIssue}) — FR-040`);

  if (action === 'complete') {
    // After the transition, never before: the label flip and the event comment are the
    // record that completion happened, and a deploy that fired for a completion that
    // then failed to record would be a deploy nobody can account for.
    try {
      const hook = await dispatchOnCompletion(gh, repo, slug, result.workload.issueNumber);
      console.log(hook.comment);
    } catch (error: unknown) {
      // Already commented on the issue. Red run = the signal (FR-070).
      console.error(`subject-workflow dispatch failed: ${errorMessage(error)}`);
      process.exit(1);
    }
  }
}

const isMain = process.argv[1]?.endsWith('lifecycle-apply.ts');
if (isMain) {
  main().catch((error) => {
    console.error(errorMessage(error));
    process.exit(1);
  });
}
