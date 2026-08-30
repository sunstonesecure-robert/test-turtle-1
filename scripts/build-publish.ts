import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { Octokit } from '@octokit/rest';
import { createClient, type RepoRef } from '../dashboard/lib/github/client';
import { DeliverablePatch, patchPaths } from '../schemas/deliverable';
import type { PlanStep } from '../schemas/plan';
import { readPlanAtRef, slugFromPlanRef, tagTargetSha } from '../dashboard/lib/github/plans';
import { getWorkload } from '../dashboard/lib/github/workloads';
import { serializeDeliverableMarker } from '../dashboard/lib/github/markers';
import { errorMessage, errorStatus } from '../dashboard/lib/github/errors';
import { patchPathsWithinStepScope } from './gates/lib/checks-deliverable';
import { resolveMergeAuthority } from '../dashboard/lib/github/builds';
import { isRepoRelative, normalizePath } from './gates/lib/globs';
import { reservedPathsTouched, reservedRefusalDetail, PRODUCT_PR_ROUTE } from './gates/lib/reserved-paths';
import { checkD6SubjectWorkflowContent, subjectWorkflowPaths, type SubjectWorkflowFile } from './gates/lib/checks-subject-workflow';
import { checkpointPathsTouched, parseCheckpointPaths, CHECKPOINT_PATHS_VARIABLE } from './gates/lib/checkpoint-paths';
import { scannerRunner } from './gates/lib/subject-workflow-scanners';

/**
 * build-publish (T207) — the deterministic writer that lands an agent's deliverable.
 *
 * The build executor is read-only by design (`contents: read`; its outputs are
 * artifacts and a `missing-data` safe output), so it CANNOT push the branch or open
 * the pull request its work has to become. This publisher, triggered on the build's
 * `workflow_run` completion, downloads `deliverable.patch`, validates it as
 * UNTRUSTED input, and — only if every check holds — creates
 * `build/<slug>/v<N>/<step-id>` off the frozen tag's commit, writes the files, and opens
 * the pull request with the executor's provenance recorded on it.
 *
 * Third instance of the same seam: `plan.json`→`plan-publish`,
 * `vt-results.json`→`vt-report`, and now `deliverable.patch`→here. The executor
 * never holds a write scope; the writer never runs a model.
 *
 * WHAT IT REFUSES, BEFORE ANY WRITE. Validation is all-or-nothing — a refused patch
 * produces no branch, no commit, no pull request, and a `build:refused` record on
 * the work item naming exactly what was wrong:
 *
 *   • the envelope does not validate against schemas/deliverable.schema.json
 *   • `plan_ref` is not the ref the build actually ran on (the trusted binding —
 *     the build was dispatched ON the frozen tag, preflight B8, so the run's own
 *     head is the one signal the executor cannot author)
 *   • `step_id` names no step in that plan
 *   • any path is not repo-relative (`../`, absolute, drive letter) — refused, never
 *     normalized into safety
 *   • any path falls outside the delivering step's declared scope (FR-061)
 *   • any path is inside the RESERVED set — the installed oversight machinery or the
 *     governance record (FR-068), regardless of what the scope says
 *   • a subject workflow (`.github/workflows/subject_<name>.yml`, the one part of
 *     `.github/` a deliverable may be — FR-069, GHI #174) whose CONTENT fails any D6
 *     guard: a trigger outside push/pull_request/workflow_dispatch, a write scope, a
 *     secret, an unpinned action, a scanner finding, an OIDC job with no environment
 *
 * The last three run HERE as well as in `deliverable-gate`, and the duplication is
 * deliberate: the gate is the required check that blocks a merge, but a refused
 * patch should never become a pull request at all. A branch that exists is a thing
 * someone can merge with an admin bypass; a branch that was never created is not.
 *
 * THE RESIDUAL, STATED (GHI #116). `step_id` is executor-authored and there is no
 * trusted binding for it at this point: the `workflow_run` payload cannot see the
 * build's `--chunk` dispatch input, so nothing here can independently derive which
 * step the build was ASKED to do. A lying executor could therefore name a different
 * step of the SAME approved plan and be validated against that step's scope. The
 * blast radius is bounded by what the operator already approved for this workload,
 * and D5 excludes the machinery from every step regardless — but it is a real gap,
 * it is the operator's mechanism choice, and it is not closed by this file.
 */

export type PublishOutcome =
  | { outcome: 'published'; branch: string; prNumber: number; paths: string[]; authority: string }
  | { outcome: 'already_published'; branch: string; prNumber: number }
  | { outcome: 'refused'; reason: string; reportedOn: number | null };

/** Everything the writer needs that it must not take from the artifact. */
export interface BuildRunContext {
  /** the build run's id — trusted provenance, recorded on the PR (the executor cannot author it) */
  runId: string;
  /** the ref the build run was dispatched on (`workflow_run.head_branch`), which
   *  preflight B8 guarantees is the frozen plan tag. The binding for `plan_ref`. */
  headBranch?: string;
  /** the build run's own commit (`workflow_run.head_sha`) — the frozen tag's commit */
  headSha?: string;
  /** per-workflow merge checkpoint (FR-062); may only ADD a checkpoint */
  requiresOperatorMerge?: boolean;
  /** the operator's CHECKPOINT_PATHS globs (parsed); a path inside one waits for the
   *  operator's merge (GHI #163 option 3). Subject workflows wait regardless. */
  checkpointGlobs?: readonly string[];
  base?: string;
}

/**
 * The deliverable branch for one step of one FROZEN VERSION of a plan.
 *
 * THE VERSION IS PART OF THE NAME (Codex on PR #153). It used to be
 * `build/<slug>/<step-id>`, which is stable across a re-open — and a re-open is an
 * ordinary move (FR-008), not an edge case. Rebuilding the same step against v2 then
 * found the v1 branch still there, `createRef` returned 422, and the write below
 * resumed on it: the new commit was parented to the OLD branch head instead of the v2
 * tag. Since a v2 tag normally descends from the earlier merge on `main`, the two
 * histories diverge, and D1 refuses the v2 pull request as not descending from its
 * plan — permanently, with no way out but deleting a branch by hand.
 *
 * Mirroring the plan ref's own shape (`plan/<slug>/v<N>` → `build/<slug>/v<N>/<step>`)
 * keeps the slug at the same path segment, which is what `listDeliverablePrs` falls
 * back to when a pull request carries no readable marker.
 */
export function deliverableBranch(planRef: string, stepId: string): string {
  const withoutPrefix = planRef.replace(/^plan\//, '');
  return `build/${withoutPrefix}/${stepId}`;
}

/**
 * Record a refusal where the operator will meet it, and return it as an outcome
 * rather than throwing.
 *
 * A refused patch is not a crashed workflow: it is a decision, and FR-042 means it
 * is a retained record rather than a log line that scrolls away. It lands on the
 * step's work item when the plan names one, else on the workload issue.
 */
async function refuse(
  gh: Octokit,
  repo: RepoRef,
  where: number | null,
  reason: string,
): Promise<PublishOutcome> {
  if (where !== null) {
    await gh.issues
      .createComment({
        ...repo,
        issue_number: where,
        body: `**Deliverable refused — nothing was written.**\n\n${reason}`,
      })
      .catch(() => undefined);
    await gh.issues.addLabels({ ...repo, issue_number: where, labels: ['build:refused'] }).catch(() => undefined);
  }
  return { outcome: 'refused', reason, reportedOn: where };
}

export async function publishDeliverable(
  gh: Octokit,
  repo: RepoRef,
  raw: unknown,
  ctx: BuildRunContext,
): Promise<PublishOutcome> {
  const parsed = DeliverablePatch.safeParse(raw);
  if (!parsed.success) {
    return refuse(
      gh,
      repo,
      null,
      `deliverable.patch failed schema validation: ${parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ')}`,
    );
  }
  const patch = parsed.data;
  const slug = slugFromPlanRef(patch.plan_ref);
  if (slug === null) {
    return refuse(gh, repo, null, `plan_ref "${patch.plan_ref}" is not a frozen plan ref (plan/<slug>/v<N>)`);
  }

  // THE TRUSTED BINDING. The build was dispatched ON the frozen tag (preflight B8
  // refuses anything else), so the run's own head is the one signal in this pipeline
  // the executor cannot author. An envelope naming a different plan than the run
  // actually built is refused here, before anything exists to merge — the same
  // substitution `vt-report` closes with `--expect-sha`.
  const tagSha = await tagTargetSha(gh, repo, patch.plan_ref);
  if (tagSha === null) {
    return refuse(gh, repo, null, `plan_ref "${patch.plan_ref}" names no frozen tag — a deliverable must descend from an approved plan`);
  }
  if (ctx.headSha && ctx.headSha.trim() !== tagSha) {
    return refuse(
      gh,
      repo,
      null,
      `deliverable.patch claims ${patch.plan_ref} (commit ${tagSha.slice(0, 8)}), but the build that produced it ran on ` +
        `commit ${ctx.headSha.trim().slice(0, 8)}. A build may only deliver against the plan it actually built ` +
        '(FR-007). Nothing was written.',
    );
  }
  if (ctx.headBranch && ctx.headBranch.trim() !== patch.plan_ref) {
    return refuse(
      gh,
      repo,
      null,
      `deliverable.patch claims ${patch.plan_ref}, but the build run was dispatched on "${ctx.headBranch}" (FR-007, preflight B8)`,
    );
  }

  const plan = await readPlanAtRef(gh, repo, patch.plan_ref);
  const step: PlanStep | undefined = plan.steps.find((s) => s.id === patch.step_id);
  const workload = await getWorkload(gh, repo, slug).catch(() => null);
  const fallbackIssue = workload?.issueNumber ?? plan.andon_issue ?? null;
  if (!step) {
    return refuse(
      gh,
      repo,
      fallbackIssue,
      `deliverable.patch names step "${patch.step_id}", which ${patch.plan_ref} does not define. The plan's steps are: ` +
        `${plan.steps.map((s) => s.id).join(', ')}`,
    );
  }
  // The step's own work item is where a refusal belongs — that is the issue an
  // operator is watching for this build.
  const reportOn = step.tracking_issue ?? fallbackIssue;

  // VALIDATED RAW, NORMALIZED AFTER (Codex on PR #145, 2026-08-25). The order was
  // reversed, and `normalizePath` strips a leading slash — so an executor emitting
  // `/docs/output.txt` had it quietly turned into `docs/output.txt` BEFORE
  // `isRepoRelative` looked at it, and the absolute path the contract requires to be
  // refused was accepted and written to the relative location instead. Silently
  // repairing untrusted input is exactly what this boundary must not do, and the
  // later gate cannot recover the original spelling to notice.
  const rawPaths = patchPaths(patch);
  if (rawPaths.length === 0) {
    return refuse(gh, repo, reportOn, 'deliverable.patch writes and deletes nothing — an empty deliverable is not a deliverable');
  }
  const traversal = rawPaths.filter((p) => !isRepoRelative(p));
  if (traversal.length > 0) {
    return refuse(
      gh,
      repo,
      reportOn,
      `deliverable.patch names path(s) that are not repo-relative: ${traversal.join(', ')}. Refused outright, and ` +
        'refused AS WRITTEN — an absolute path or a traversal is never normalized into something acceptable and then ' +
        'accepted; the contract requires repo-relative paths with forward slashes.',
    );
  }

  // FR-068 BEFORE FR-061, deliberately. A patch aimed at the machinery is refused
  // whatever the scope says, so asking the scope question first would report the
  // less important failure when both hold — and would imply, wrongly, that a wider
  // scope could have made it acceptable.
  // Only now — every path is known repo-relative, so normalizing cannot launder one.
  const paths = rawPaths.map(normalizePath);
  const reserved = reservedPathsTouched(paths);
  if (reserved.length > 0) {
    return refuse(gh, repo, reportOn, reservedRefusalDetail(reserved, 'deliverable.patch'));
  }
  const scope = step.scope ?? [];
  if (scope.length > 0) {
    const straying = patchPathsWithinStepScope(paths, scope);
    if (straying.length > 0) {
      return refuse(
        gh,
        repo,
        reportOn,
        `deliverable.patch touches ${straying.length} path(s) outside step ${step.id}'s declared scope ` +
          `[${scope.join(', ')}]: ${straying.join(', ')}. Work outside the step is work no authority was asked ` +
          'about (FR-061) — the pull request is refused rather than silently trimmed.',
      );
    }
  }

  const base = ctx.base ?? 'main';

  // D6 — THE CONTENT GUARDS, on the one part of `.github/` a deliverable may be
  // (FR-069, GHI #174), and still BEFORE ANY WRITE. D5 above said where an agent may
  // write; this says what a file written there may do. The bytes judged are the
  // patch's own (the same bytes the tree below would be built from), and the branch a
  // subject trigger may name is the one this pull request lands on — the gate reads
  // `pr.base.ref`, which is this same `base`, so the two cannot disagree. The scanners
  // come from PATH; when either is missing D6.5 FAILS closed and the patch is refused
  // rather than published unscanned (GHI #108). A refused subject workflow therefore
  // produces no branch — the property this whole pre-write block exists for.
  const subjectPaths = new Set(subjectWorkflowPaths(paths));
  if (subjectPaths.size > 0) {
    const subjectFiles: SubjectWorkflowFile[] = [
      ...patch.files
        .filter((f) => subjectPaths.has(normalizePath(f.path)))
        .map((f) => ({
          path: normalizePath(f.path),
          content: f.encoding === 'base64' ? Buffer.from(f.content, 'base64').toString('utf8') : f.content,
        })),
      ...(patch.deletions ?? [])
        .map(normalizePath)
        .filter((p) => subjectPaths.has(p))
        .map((p) => ({ path: p, content: null })),
    ];
    const d6 = await checkD6SubjectWorkflowContent(subjectFiles, { defaultBranch: base, scan: scannerRunner() });
    if (d6.status !== 'pass') {
      // The gate's OWN sentences (GHI #127): every violated guard, named, with the way out.
      return refuse(
        gh,
        repo,
        reportOn,
        `deliverable.patch delivers a subject workflow that fails the content guards: ${d6.detail ?? d6.status}`,
      );
    }
  }

  // ---- Everything below WRITES. Nothing above did. ----

  const branch = deliverableBranch(patch.plan_ref, step.id);
  // Merge authority, with the checkpoint BY PATH (GHI #163 option 3): a subject workflow
  // always waits for the operator's merge, and so does a path inside one of their
  // CHECKPOINT_PATHS globs. Recorded on the pull request as before; the gate, the
  // merger and the dashboard re-derive it live from the same rule.
  const checkpointPaths = checkpointPathsTouched(paths, ctx.checkpointGlobs ?? []);
  const { authority, reason } = resolveMergeAuthority(step, { requiresOperatorMerge: ctx.requiresOperatorMerge, checkpointPaths });

  // The branch is cut from the FROZEN TAG'S COMMIT, so the head is a DESCENDANT of
  // the frozen commit and never an alteration of it (FR-007 as amended, and what D1
  // re-checks independently).
  try {
    await gh.git.createRef({ ...repo, ref: `refs/heads/${branch}`, sha: tagSha });
  } catch (error: unknown) {
    if (errorStatus(error) !== 422) throw error; // 422 = exists; resume below
  }

  // Written through the git DATA API — blob, tree, commit, ref — rather than a
  // `git push`, so this workflow never holds a git credential in `.git/config`
  // either (zizmor artipacked; the same reason every checkout here sets
  // `persist-credentials: false`).
  const { data: branchRef } = await gh.git.getRef({ ...repo, ref: `heads/${branch}` });
  const { data: headCommit } = await gh.git.getCommit({ ...repo, commit_sha: branchRef.object.sha });

  const treeEntries: { path: string; mode: '100644'; type: 'blob'; sha?: string | null; content?: string }[] = [];
  for (const file of patch.files) {
    const { data: blob } = await gh.git.createBlob({
      ...repo,
      content: file.content,
      encoding: file.encoding === 'base64' ? 'base64' : 'utf-8',
    });
    treeEntries.push({ path: normalizePath(file.path), mode: '100644', type: 'blob', sha: blob.sha });
  }
  for (const path of patch.deletions ?? []) {
    // `sha: null` in a tree entry is the delete. Same containment checks already
    // applied to it above — removing a file is a write.
    treeEntries.push({ path: normalizePath(path), mode: '100644', type: 'blob', sha: null });
  }

  const { data: tree } = await gh.git.createTree({ ...repo, base_tree: headCommit.tree.sha, tree: treeEntries as never });
  if (tree.sha === headCommit.tree.sha) {
    // Re-delivery of an identical envelope. Not an error and not a second commit:
    // the seam is idempotent precisely so a `workflow_run` re-delivery completes
    // rather than conflicting.
    const existing = await findDeliverablePr(gh, repo, branch, base);
    if (existing) return { outcome: 'already_published', branch, prNumber: existing };
  }

  const summary = patch.summary ?? `deliver ${step.id}`;
  const { data: commit } = await gh.git.createCommit({
    ...repo,
    message:
      `build: ${summary}\n\n` +
      `plan: ${patch.plan_ref}\nstep: ${step.id}\nexecutor: ${patch.executor_id}\nbuild run: ${ctx.runId}\n`,
    tree: tree.sha,
    parents: [headCommit.sha],
  });
  await gh.git.updateRef({ ...repo, ref: `heads/${branch}`, sha: commit.sha, force: false }).catch(async (error: unknown) => {
    // A non-fast-forward here means the branch moved under us — a concurrent
    // re-delivery. Fail loudly rather than force: this branch is a record.
    throw new Error(`could not advance ${branch}: ${errorMessage(error)}`);
  });

  const marker = serializeDeliverableMarker({
    planRef: patch.plan_ref,
    stepId: step.id,
    runId: ctx.runId,
    executorId: patch.executor_id,
    tier: patch.executor?.tier ?? 'in-sandbox',
    ...(patch.executor?.engine ? { engine: patch.executor.engine } : {}),
    ...(patch.executor?.image ? { image: patch.executor.image } : {}),
    ...(patch.executor?.model ? { model: patch.executor.model } : {}),
  });

  const body = [
    marker,
    `### Deliverable for \`${step.id}\` — ${step.title}`,
    '',
    `**Plan** \`${patch.plan_ref}\` (frozen commit \`${tagSha.slice(0, 8)}\`) · **Build run** [${ctx.runId}](${`https://github.com/${repo.owner}/${repo.repo}/actions/runs/${ctx.runId}`})`,
    '',
    `**Merge authority:** \`${authority}\` — ${reason}`,
    '',
    `**Executor provenance (FR-065):** \`${patch.executor_id}\`, tier \`${patch.executor?.tier ?? 'in-sandbox'}\`` +
      `${patch.executor?.engine ? `, engine \`${patch.executor.engine}\`` : ''}` +
      `${patch.executor?.image ? `, image \`${patch.executor.image}\`` : ''}` +
      `${patch.executor?.model ? `, model \`${patch.executor.model}\`` : ''}`,
    '',
    `**Declared scope:** ${scope.length > 0 ? scope.map((s) => `\`${s}\``).join(', ') : '_(none — plan frozen before `scope` existed; D2 reports not-applicable and D5 still applies)_'}`,
    '',
    `**Paths written:** ${paths.map((p) => `\`${p}\``).join(', ')}`,
    '',
    '---',
    '',
    'This branch was written by the deterministic `build-publish` workflow, not by the executor — the executor holds',
    '`contents: read` and could not have pushed it. `deliverable-gate` (D1–D6) is the required check on this pull',
    'request; **D5** additionally refuses any patch touching the installed oversight machinery or the governance',
    'record, independently of the declared scope above (FR-068).',
    ...(subjectPaths.size > 0
      ? [
          '',
          `**Subject workflow(s):** ${[...subjectPaths].map((p) => `\`${p}\``).join(', ')} — the one part of \`.github/\` a deliverable may be.`,
          'Its content passed the guards here (triggers, permissions, secrets, pinned actions, scanners, environment) and',
          '**D6** re-reads it on this pull request; it always waits for the operator\'s own merge (FR-069).',
        ]
      : []),
  ].join('\n');

  const existing = await findDeliverablePr(gh, repo, branch, base);
  let prNumber: number;
  if (existing) {
    prNumber = existing;
    await gh.pulls.update({ ...repo, pull_number: prNumber, body });
  } else {
    const { data: pr } = await gh.pulls.create({
      ...repo,
      title: `build(${slug}): ${summary}`,
      head: branch,
      base,
      body,
    });
    prNumber = pr.number;
  }
  await gh.issues.addLabels({ ...repo, issue_number: prNumber, labels: ['build:awaiting-merge'] }).catch(() => undefined);

  return { outcome: 'published', branch, prNumber, paths, authority };
}

/** The open deliverable PR for this branch, if there is one. */
async function findDeliverablePr(gh: Octokit, repo: RepoRef, branch: string, base: string): Promise<number | null> {
  const { data } = await gh.pulls.list({ ...repo, head: `${repo.owner}:${branch}`, base, state: 'open', per_page: 10 });
  return data[0]?.number ?? null;
}

/** Locate deliverable.patch anywhere under the downloaded-artifacts directory. */
export function findDeliverableFile(dir: string): string | null {
  if (!existsSync(dir)) return null;
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      const nested = findDeliverableFile(full);
      if (nested) return nested;
    } else if (entry === 'deliverable.patch' || entry === 'deliverable.patch.json') {
      return full;
    }
  }
  return null;
}

const isMain = process.argv[1]?.endsWith('build-publish.ts');
if (isMain) {
  const argv = process.argv.slice(2);
  const get = (name: string): string | undefined => {
    const i = argv.indexOf(`--${name}`);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const dir = get('dir');
  const repoArg = get('repo');
  const runId = get('run-id');
  const [owner, repoName] = (repoArg ?? '').split('/');
  if (!dir || !owner || !repoName || !runId) {
    console.error(
      'usage: build-publish --dir <artifacts-dir> --repo <owner/repo> --run-id <build run id> ' +
        '[--head-branch <ref>] [--head-sha <sha>] [--base <branch>]',
    );
    process.exit(2);
  }
  const file = findDeliverableFile(dir);
  if (!file) {
    // NOT silently green. A build that produced no deliverable has built nothing,
    // and the completion path must never be able to read that as success — which is
    // precisely the hole GHI #141 found one layer up.
    console.error(
      `no deliverable.patch found under ${dir} — the build run produced no deliverable. Nothing was written, and ` +
        'no verification results should be recorded for this run: verification of nothing must not read as ' +
        'verification (GHI #141).',
    );
    process.exit(1);
  }
  publishDeliverable(createClient(), { owner, repo: repoName }, JSON.parse(readFileSync(file, 'utf8')), {
    runId,
    ...(get('head-branch') ? { headBranch: get('head-branch') } : {}),
    ...(get('head-sha') ? { headSha: get('head-sha') } : {}),
    ...(get('base') ? { base: get('base') } : {}),
    requiresOperatorMerge: /^(1|true|yes)$/i.test(process.env.BUILD_REQUIRES_OPERATOR_MERGE ?? ''),
    // The workflow passes the CHECKPOINT_PATHS repository variable through as an env
    // var of the same name (CONFIGURATION_GUIDE.md §3); unset or empty = no operator
    // globs, and subject workflows wait regardless.
    checkpointGlobs: parseCheckpointPaths(process.env[CHECKPOINT_PATHS_VARIABLE]),
  })
    .then((result) => {
      if (result.outcome === 'refused') {
        console.error(`REFUSED: ${result.reason}`);
        console.error(PRODUCT_PR_ROUTE);
        process.exit(1);
      }
      console.log(
        result.outcome === 'published'
          ? `published ${result.branch} as PR #${result.prNumber} (${result.authority}); paths: ${result.paths.join(', ')}`
          : `already published: ${result.branch} (PR #${result.prNumber})`,
      );
    })
    .catch((error) => {
      console.error(errorMessage(error));
      process.exit(1);
    });
}
