import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { Octokit } from '@octokit/rest';
import { createClient, type RepoRef } from '../dashboard/lib/github/client';
import { PlanDoc } from '../schemas/plan';
import { alignLegacyPlanFileWithBase, planBranch, planPath, tagExists } from '../dashboard/lib/github/plans';
import { parseAndonHeader, serializeAndonHeader } from '../dashboard/lib/github/markers';
import { getWorkload, getWorkloadByIssue } from '../dashboard/lib/github/workloads';
import { findOpenAndonByPlanRef } from '../dashboard/lib/github/andon';
import { errorMessage, errorStatus } from '../dashboard/lib/github/errors';

/**
 * plan-publish — the deterministic writer that lands an agent-proposed plan.
 * The plan-propose agentic job is read-only (contents: read, safe outputs
 * create-issue + upload-artifact only): it CANNOT push the plan branch its
 * instructions describe. This publisher, triggered on plan-propose's
 * workflow_run completion, takes the uploaded plan.json artifact, finds the
 * agent's Andon break by its plan-ref header, patches the real andon_issue
 * number in (the agent can't know it before the issue exists), validates the
 * document against the schema, and creates `plan/<slug>/v<N>` with the document
 * committed at `plans/<slug>/plan.json` (per-workload path, GHI #79 — a shared
 * repo-root file made every approval merge collide with every other in-flight
 * approval PR) — the same write the demo seed script performs, moved behind the
 * substrate split: agent proposes, deterministic single writer publishes.
 * Idempotent: an existing branch for this plan ref is a no-op re-run; an
 * existing TAG for it is a version collision with a frozen plan and errors.
 */

export type PublishResult =
  | { outcome: 'published'; planRef: string; andonIssue: number }
  | { outcome: 'already_published'; planRef: string };

export async function publishPlan(
  gh: Octokit,
  repo: RepoRef,
  planRaw: unknown,
  opts: { base?: string; runId?: string; andonIssue?: number; workloadIssue?: number; addresses?: number[] } = {},
): Promise<PublishResult> {
  // The agent cannot know the Andon number before the issue exists, so its
  // andon_issue is a placeholder — neutralize it for validation and patch the
  // real number in below.
  const draft = typeof planRaw === 'object' && planRaw !== null ? { ...(planRaw as Record<string, unknown>), andon_issue: 1 } : planRaw;
  const parsed = PlanDoc.safeParse(draft);
  if (!parsed.success) {
    throw new Error(`plan.json failed schema validation: ${parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`);
  }
  const planRef = planBranch(parsed.data.feature, parsed.data.version);

  // The agent authors plan.json, and a schema-legal invented `feature` silently
  // disconnects the plan from its workload: the branch, CURRENT pointer, and
  // every slug-keyed flow would never link back to the workload issue (live
  // PB-004 finding D — the agent wrote feature "053-fibonacci-sequence" for
  // workload demo4). The publisher is the deterministic gate: the feature MUST
  // name a real workload. Create-then-publish callers pass the workload's issue
  // number because the LIST endpoint is not read-after-write consistent
  // (PB-003 finding B); the workflow_run path lists — intake ran long before.
  const workload =
    opts.workloadIssue !== undefined
      ? await getWorkloadByIssue(gh, repo, opts.workloadIssue)
      : await getWorkload(gh, repo, parsed.data.feature);
  if (!workload) {
    // Distinct messages: a dead HINT is the caller's bug, an unknown FEATURE is
    // the agent's (PR #35 review) — conflating them sends debugging the wrong way.
    throw new Error(
      opts.workloadIssue !== undefined
        ? `refusing to publish ${planRef}: workload issue #${opts.workloadIssue} does not exist or is not a workload`
        : `refusing to publish ${planRef}: plan.feature "${parsed.data.feature}" does not name an existing workload — ` +
            `the plan's feature field must equal the workload slug exactly (PB-004 finding D)`,
    );
  }
  if (workload.slug !== parsed.data.feature) {
    // Only reachable via the hint (the slug lookup matches by construction).
    throw new Error(
      `refusing to publish ${planRef}: plan.feature "${parsed.data.feature}" does not match workload slug ` +
        `"${workload.slug}" (issue #${workload.issueNumber}) — the plan's feature field must equal the workload ` +
        `slug exactly (PB-004 finding D)`,
    );
  }
  if (workload.state !== 'active') {
    // Serialization guard (GHI #43): workload-lifecycle and plan-propose are
    // NOT serialized, and run cancellation alone is racy — a cancel can land
    // between the propose run's success and this publish. The publisher is the
    // chokepoint: whatever the dispatch interleaving, no plan branch or Andon
    // break is ever minted for a workload that is not active (not-yet-activated,
    // deferred, canceled, completed, archived — agent eligibility begins at
    // explicit operator activation, FR-033).
    throw new Error(
      `refusing to publish ${planRef}: workload "${workload.slug}" (issue #${workload.issueNumber}) is ` +
        `${workload.state ? `workload:${workload.state}` : 'in an invalid label state (SC-011)'}, not workload:active — ` +
        `agent planning requires an active workload (GHI #43)`,
    );
  }

  if (await tagExists(gh, repo, planRef)) {
    throw new Error(`refusing to publish ${planRef}: a frozen tag with that version already exists — the agent must propose v${parsed.data.version + 1}`);
  }

  // Locate the run's Andon break (paginated — parallel workloads can hold many open at once).
  // Preferred key: the andon:v1 header. But gh-aw's safe-output sanitizer strips agent-supplied
  // HTML comments (live-discovered), so a fresh break has NO header — fall back to the trusted
  // gh-aw footer, which links the triggering run, then inject the canonical header ourselves:
  // agent proposes, deterministic single writer normalizes.
  let andon: { number: number; body?: string | null } | undefined;
  if (opts.andonIssue !== undefined) {
    // Create-then-publish callers (the demo seed) pass the break's number: the
    // LIST endpoint is not read-after-write consistent, so a just-created Andon
    // can be invisible to the search below (PB-003 finding B applies here too).
    let issue;
    try {
      ({ data: issue } = await gh.issues.get({ ...repo, issue_number: opts.andonIssue }));
    } catch (error: unknown) {
      if (errorStatus(error) !== 404) throw error;
      throw new Error(`Andon #${opts.andonIssue} does not exist — refusing to publish against it`);
    }
    if (issue.state !== 'open' || parseAndonHeader(issue.body ?? '')?.planRef !== planRef) {
      throw new Error(`Andon #${opts.andonIssue} is closed or does not reference ${planRef} — refusing to publish against it`);
    }
    andon = issue;
    const plan = PlanDoc.parse({ ...parsed.data, andon_issue: andon.number });
    return writePlanBranch(gh, repo, plan, planRef, opts.base, opts.addresses);
  }
  // LIVE = open OR under-review: a revision can land after the operator has
  // picked the review up (label flipped) — matching only andon:open here made
  // the FR-058 guard below mis-refuse a live revision as an abandoned version
  // (PR #25 review finding). The run-link fallback below searches BOTH live
  // labels too: a headerless break the operator has already picked up (Start
  // review flips it to under-review before the publisher ran — 2026-09-09,
  // Codex on PR #209) must still be publishable by run id.
  const liveBreak = await findOpenAndonByPlanRef(gh, repo, planRef);
  if (liveBreak !== null) andon = { number: liveBreak };
  if (!andon) {
    // No live break carries this plan ref — but if its BRANCH exists, this ref
    // already held a proposal whose review ended unapproved (superseded /
    // canceled). Abandoned versions are never reused (FR-058): refuse before
    // the run-link fallback can bind a fresh break to a dead ref. (A live
    // revision — the correction round-trip — matches the header above; a
    // resumable partial publish does too, since header injection precedes
    // branch creation.)
    let branchExists = false;
    try {
      await gh.git.getRef({ ...repo, ref: `heads/${planRef}` });
      branchExists = true;
    } catch (error: unknown) {
      if (errorStatus(error) !== 404) throw error;
    }
    if (branchExists) {
      throw new Error(
        `refusing to publish ${planRef}: the branch exists but no open Andon break references it — ` +
          `v${parsed.data.version} was abandoned and versions are never reused; propose ` +
          `${planBranch(parsed.data.feature, parsed.data.version + 1)} instead (FR-058)`,
      );
    }
  }
  if (!andon && opts.runId) {
    andon = await findLiveBreakByRunLink(gh, repo, opts.runId);
    if (andon) {
      const header = serializeAndonHeader({ runId: parsed.data.run_id, planRef });
      await gh.issues.update({ ...repo, issue_number: andon.number, body: `${header}\n${andon.body ?? ''}` });
    }
  }
  if (!andon) {
    throw new Error(`no live Andon break references ${planRef}${opts.runId ? ` or run ${opts.runId}` : ''} — plan-propose must raise the Andon before publish`);
  }
  const plan = PlanDoc.parse({ ...parsed.data, andon_issue: andon.number });
  return writePlanBranch(gh, repo, plan, planRef, opts.base, opts.addresses);
}

/**
 * The live break a given run raised, found through gh-aw's own footer link.
 *
 * ONE definition, two callers: the publish path uses it to locate the break it is
 * about to stamp, and `reportUnpublishable` uses it to find the break it has to tell
 * that no plan is coming (GHI #286). Two spellings of "which break did this run
 * raise" could disagree, and the disagreement would be invisible — a break stamped
 * by one rule and reported to by another.
 *
 * Boundary-anchored: a bare .includes() would let run 123 claim the break for run
 * 123456 when both are open concurrently. LIVE = open OR under-review, because the
 * operator may already have picked the break up.
 */
export async function findLiveBreakByRunLink(
  gh: Octokit,
  repo: RepoRef,
  runId: string,
): Promise<{ number: number; body?: string | null } | undefined> {
  const runLink = new RegExp(`/actions/runs/${runId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?!\\d)`);
  const liveBreaks = (
    await Promise.all(
      ['andon:open', 'andon:under-review'].map((label) =>
        gh.paginate(gh.issues.listForRepo, { ...repo, labels: label, state: 'open', per_page: 100 }),
      ),
    )
  ).flat();
  return liveBreaks.find((issue) => runLink.test(issue.body ?? ''));
}

/** The live break carrying a plan ref, in the shape the reporter wants. One call into
 *  the same `findOpenAndonByPlanRef` the publish path uses, so "which break owns this
 *  plan" has one answer in this file. */
async function findBreakByPlanRef(
  gh: Octokit,
  repo: RepoRef,
  planRef: string,
): Promise<{ number: number } | undefined> {
  const found = await findOpenAndonByPlanRef(gh, repo, planRef);
  return found === null ? undefined : { number: found };
}

/** Why a run produced nothing to publish — the probe knows which, and each one
 *  reads differently to the operator. */
export type UnpublishableReason = 'no-artifact' | 'expired' | 'revision-incomplete';

/** Idempotency key: the publisher may be re-delivered or re-dispatched for the same
 *  run, and a break that collects the same notice three times is noise, not a record. */
export function unpublishableMarker(runId: string): string {
  return `<!-- plan-publish:nothing-to-publish:${runId} -->`;
}

/**
 * What the break is told. Written here, as a pure function over the reason, so the
 * sentence an operator reads is a tested value rather than a string built inside a
 * workflow step nothing can run.
 */
export function unpublishableComment(input: { runId: string; reason: UnpublishableReason; liveArtifacts: string[] }): string {
  const why: Record<UnpublishableReason, string> = {
    'no-artifact':
      `**No plan document came out of that run.** The agent finished and raised this review, but it uploaded no ` +
      `\`plan.json\`, so there is nothing to publish and no plan to judge. Publishing this run again cannot change ` +
      `that answer.`,
    expired:
      `**The plan document has expired.** The agent did upload it, but GitHub keeps run files only for a limited ` +
      `time and this one has aged past that — it is still listed on the run and can no longer be downloaded. ` +
      `Nothing was wrong with the plan; it is simply gone.`,
    'revision-incomplete':
      `**The revision is incomplete.** That run uploaded the revised plan but not the list of corrections it carries ` +
      `out, and a revision published without it leaves every correction it addressed unmarkable. Re-run the revision ` +
      `agent for this review.`,
  };
  const route =
    input.reason === 'revision-incomplete'
      ? `**What to do**: run the revision agent again for this review.`
      : `**What to do**: withdraw this review — it has nothing to judge — and let the agent propose again. The next ` +
        `proposal takes the next version number; this one is never reused.`;
  return [
    unpublishableMarker(input.runId),
    `### This review has no plan`,
    ``,
    why[input.reason],
    ``,
    route,
    ``,
    `_Checked by the publisher against run ${input.runId}; the files it found there were: ` +
      `${input.liveArtifacts.length > 0 ? input.liveArtifacts.map((a) => `\`${a}\``).join(', ') : 'none'}._`,
  ].join('\n');
}

/**
 * SAY IT WHERE THE OPERATOR IS LOOKING (GHI #286; live 2026-09-19, test-turtle-1
 * run 35455533939).
 *
 * The publisher already detects this perfectly — it probes for the artifact, finds
 * none, and exits clean. But it said so only in its own run log, in a `::notice`
 * nobody had a reason to open: the planning run was GREEN, the break was OPEN, and
 * the review page explained the silence with a cause that was false. The fact was
 * known and unpublished, in both senses.
 *
 * So the publisher now comments on the break it would have stamped. It does not
 * withdraw it: ending a review is the operator's act, with a cause of their own, and
 * the harness's job here is to make the state legible before the click rather than to
 * decide it (ADR-0007). Idempotent by marker — a re-delivery or a re-dispatch for the
 * same run adds nothing.
 */
export async function reportUnpublishable(
  gh: Octokit,
  repo: RepoRef,
  input: { runId: string; reason: UnpublishableReason; liveArtifacts: string[]; planRef?: string | null },
): Promise<{ outcome: 'commented' | 'already_reported' | 'no_break'; issueNumber?: number }> {
  // TWO LOCATORS, because a revision's break does not link the revision's run (Codex on
  // PR #287). The run-link search finds the break a PROPOSAL raised, because gh-aw's
  // footer on that issue names that run. A plan-revise run raises no issue and edits
  // none, so the break it revises still carries the ORIGINAL proposal's footer and the
  // run-link search can only ever return nothing for it — the incomplete-revision
  // explanation would have been posted nowhere. When the caller can name the plan ref
  // (the revision DID upload plan.json; that is what makes it "incomplete" rather than
  // absent), find the live break by ref the way the publish path already does.
  const andon =
    (input.planRef ? await findBreakByPlanRef(gh, repo, input.planRef) : undefined) ??
    (await findLiveBreakByRunLink(gh, repo, input.runId));
  if (!andon) return { outcome: 'no_break' };
  const marker = unpublishableMarker(input.runId);
  const existing = await gh.paginate(gh.issues.listComments, { ...repo, issue_number: andon.number, per_page: 100 });
  if (existing.some((c) => (c.body ?? '').includes(marker))) return { outcome: 'already_reported', issueNumber: andon.number };
  await gh.issues.createComment({ ...repo, issue_number: andon.number, body: unpublishableComment(input) });
  return { outcome: 'commented', issueNumber: andon.number };
}

/** The deterministic branch write both publish paths share. RESUMABLE: a
 *  workflow_run re-delivery or an earlier partial publish (branch created,
 *  file write failed) must complete, not skip. */
async function writePlanBranch(
  gh: Octokit,
  repo: RepoRef,
  plan: PlanDoc,
  planRef: string,
  base = 'main',
  addresses: number[] = [],
): Promise<PublishResult> {
  const desired = JSON.stringify(plan, null, 2);
  // The canonical per-workload path (GHI #79). The publisher ALWAYS writes here,
  // never to the shared repo root: root is a read-only fallback for refs frozen
  // before the migration, and writing it again is precisely what made one
  // workload's approval merge conflict with every other in-flight approval PR.
  const path = planPath(plan.feature);

  try {
    const { data: baseRef } = await gh.git.getRef({ ...repo, ref: `heads/${base}` });
    await gh.git.createRef({ ...repo, ref: `refs/heads/${planRef}`, sha: baseRef.object.sha });
  } catch (error: unknown) {
    if (errorStatus(error) !== 422) throw error; // 422 = branch already exists — resume below
  }

  // The branch may already carry THIS workload's document at this path — inherited
  // from base (a prior approval merge for the same slug left it on main) or written
  // by an earlier attempt: supply its sha, skip if equal. Other workloads' documents
  // live under their own slug and are never touched.
  let existingSha: string | undefined;
  let alreadyPublished = false;
  try {
    const { data } = await gh.repos.getContent({ ...repo, path, ref: planRef });
    if (!Array.isArray(data) && 'content' in data && typeof data.content === 'string' && 'sha' in data) {
      if (Buffer.from(data.content, 'base64').toString('utf8').trim() === desired.trim()) {
        alreadyPublished = true;
      }
      existingSha = data.sha;
    }
  } catch (error: unknown) {
    if (errorStatus(error) !== 404) throw error;
  }

  if (!alreadyPublished) {
    // A REVISION cites every correction it carries out — the `addresses:` commit
    // trailers are exactly what revisionCites() reads to permit the operator's
    // re-judge ✓ (FR-004); one commit may address several corrections.
    const trailers = addresses.map((n) => `addresses: correction #${n}`).join('\n');
    await gh.repos.createOrUpdateFileContents({
      ...repo,
      path,
      message:
        addresses.length > 0
          ? `plan: revise ${planRef} (run ${plan.run_id}, Andon #${plan.andon_issue})\n\n${trailers}`
          : `plan: publish ${planRef} (proposed by run ${plan.run_id}, Andon #${plan.andon_issue})`,
      content: Buffer.from(desired).toString('base64'),
      branch: planRef,
      ...(existingSha ? { sha: existingSha } : {}),
    });
  }

  // STRICTLY AFTER the canonical write: a branch published before GHI #79 still
  // carries its plan at the shared repo root, which conflicts with base's copy of
  // that path and makes the approval PR unmergeable. Aligning the leftover with
  // base makes both sides of the merge agree, so the go-ahead stays one click
  // instead of a hand-resolved conflict. Runs on the resumed path too — an
  // already-published branch is exactly the one whose PR is sitting open and
  // blocked. No-op (one 404) for every branch published after the migration.
  await alignLegacyPlanFileWithBase(gh, repo, { planRef, base });

  return alreadyPublished
    ? { outcome: 'already_published', planRef }
    : { outcome: 'published', planRef, andonIssue: plan.andon_issue };
}

/** Locate a named file anywhere under the downloaded-artifacts directory. */
function findArtifactFile(dir: string, name: string): string | null {
  if (!existsSync(dir)) return null;
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      const nested = findArtifactFile(full, name);
      if (nested) return nested;
    } else if (entry === name) {
      return full;
    }
  }
  return null;
}

/** Every correction number the revision declares it addresses (addresses.json,
 *  uploaded by plan-revise); empty for a fresh proposal. Malformed content is
 *  refused loudly — a silent [] would land a revision that unlocks nothing. */
export function readAddressesFile(dir: string): number[] {
  const file = findArtifactFile(dir, 'addresses.json');
  if (!file) return [];
  const parsed: unknown = JSON.parse(readFileSync(file, 'utf8'));
  if (!Array.isArray(parsed) || parsed.some((n) => !Number.isInteger(n) || n <= 0)) {
    throw new Error(`addresses.json must be a JSON array of correction issue numbers — got: ${JSON.stringify(parsed).slice(0, 120)}`);
  }
  return parsed as number[];
}

/** Locate plan.json anywhere under the downloaded-artifacts directory. */
export function findPlanFile(dir: string): string | null {
  if (!existsSync(dir)) return null;
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      const nested = findPlanFile(full);
      if (nested) return nested;
    } else if (entry === 'plan.json') {
      return full;
    }
  }
  return null;
}

/**
 * The plan ref an artifact directory names, or null for every way that can fail.
 *
 * Deliberately total: no directory, no plan.json, unreadable bytes, invalid JSON or a
 * document that does not satisfy the schema all mean "no ref", not a thrown error. The
 * caller is a REPORTER — its job is to leave a sentence on a review — and failing it
 * because a plan it was never going to publish is malformed would swallow the report
 * over the very defect the report exists to describe.
 */
export function planRefFromDir(dir: string | undefined): string | null {
  if (!dir) return null;
  try {
    const file = findPlanFile(dir);
    if (!file) return null;
    const parsed = PlanDoc.safeParse(JSON.parse(readFileSync(file, 'utf8')));
    return parsed.success ? planBranch(parsed.data.feature, parsed.data.version) : null;
  } catch {
    return null;
  }
}

const isMain = process.argv[1]?.endsWith('plan-publish.ts');
if (isMain) {
  const argv = process.argv.slice(2);
  const get = (name: string): string | undefined => {
    const i = argv.indexOf(`--${name}`);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const repoArg = get('repo');
  const [owner, repoName] = (repoArg ?? '').split('/');
  // TWO MODES. The publish path needs an artifact directory; the report path (GHI #286)
  // exists precisely because there is no artifact, so it must not require one — and it
  // writes no contents, only a comment on the break the run raised.
  const reportReason = get('report-absence');
  if (reportReason !== undefined) {
    const runId = get('run-id');
    const reasons: UnpublishableReason[] = ['no-artifact', 'expired', 'revision-incomplete'];
    if (!owner || !repoName || !runId || !/^[0-9]+$/.test(runId) || !reasons.includes(reportReason as UnpublishableReason)) {
      console.error(`usage: plan-publish --report-absence <${reasons.join('|')}> --repo <owner/repo> --run-id <digits> [--artifacts "a,b"]`);
      process.exit(2);
    }
    // `--dir` is OPTIONAL here and never required: on the incomplete-revision path the
    // plan document IS present, and reading its ref is the only way to find the break
    // that revision belongs to. On the other two paths there is nothing to read, and a
    // missing, empty or unparsable directory simply yields no ref — the run-link
    // locator then answers, exactly as before.
    const planRef = planRefFromDir(get('dir'));
    reportUnpublishable(createClient(), { owner: owner!, repo: repoName! }, {
      runId: runId!,
      reason: reportReason as UnpublishableReason,
      liveArtifacts: (get('artifacts') ?? '')
        .split(/[\n,]/)
        .map((a) => a.trim())
        .filter((a) => a.length > 0),
      planRef,
    })
      .then((result) => {
        // Every outcome is a normal one. `no_break` in particular: a re-dispatch for a run
        // whose break was already withdrawn is exactly the case where there is nobody left
        // to tell, and failing the job for it would turn a tidy record into a red run the
        // operator has to interpret.
        console.log(
          result.outcome === 'commented'
            ? `told Andon #${result.issueNumber} that run ${runId} has no plan to publish`
            : result.outcome === 'already_reported'
              ? `Andon #${result.issueNumber} was already told about run ${runId} — nothing added`
              : `no live Andon break references run ${runId} — nothing to tell`,
        );
      })
      .catch((error) => {
        console.error(errorMessage(error));
        process.exit(1);
      });
  } else {
    const dir = get('dir');
    if (!dir || !owner || !repoName) {
      console.error('usage: plan-publish --dir <artifacts-dir> --repo <owner/repo> [--base <branch>] [--run-id <workflow_run id>]');
      process.exit(2);
    }
    const planFile = findPlanFile(dir);
    if (!planFile) {
      console.error(`no plan.json found under ${dir} — the plan-propose run uploaded no plan artifact`);
      process.exit(1);
    }
    publishPlan(createClient(), { owner, repo: repoName }, JSON.parse(readFileSync(planFile, 'utf8')), { base: get('base'), runId: get('run-id'), addresses: readAddressesFile(dir) })
      .then((result) => {
        console.log(result.outcome === 'published' ? `published ${result.planRef} (Andon #${result.andonIssue})` : `already published: ${result.planRef}`);
      })
      .catch((error) => {
        console.error(errorMessage(error));
        process.exit(1);
      });
  }
}
