import type { Octokit } from '@octokit/rest';
import { createClient, type RepoRef } from '../../dashboard/lib/github/client';
import { errorMessage, errorStatus } from '../../dashboard/lib/github/errors';
import { listPullRequestPaths } from '../../dashboard/lib/github/builds';
import { slugFromPlanRef } from '../../dashboard/lib/github/plans';
import { ApiUnavailableError, cliMain, printReport, refusalDetail, runGateCatalogue, UsageError, type GateReport } from './lib/runner';
import { DELIVERABLE_CATALOGUE } from './lib/catalogue';
import {
  checkD1Provenance,
  checkD2ScopeContainment,
  checkD3MergeAuthority,
  checkD4ExecutorProvenance,
  checkD5SubjectBoundary,
  resolveDeliveringStep,
  type DeliverablePr,
} from './lib/checks-deliverable';
import { checkD6SubjectWorkflowContent, subjectWorkflowPaths, type SubjectWorkflowFile } from './lib/checks-subject-workflow';
import { checkpointPathsTouched, parseCheckpointPaths, CHECKPOINT_PATHS_VARIABLE } from './lib/checkpoint-paths';
import { scannerRunner } from './lib/subject-workflow-scanners';

/**
 * deliverable-gate (T208 + T239 + T274) — required status check on every
 * `build/<slug>/<step-id>` pull request.
 *
 * This is the gate that decides whether an agent's actual work may land, and the only
 * gate in the system that reads a patch. Since 2026-08-29 it also reads the CONTENT of
 * one kind of file: a subject workflow (`.github/workflows/<workload-slug>_*.yml`,
 * FR-069) is the one part of `.github/` an agent may deliver, and D6 judges what such a
 * file may do at runtime — D5 says where an agent may write, D6 says what a file
 * written there may do (GHI #174). That namespace is per workload since 2026-09-01
 * (T279), so this gate resolves WHICH workload from D1's marker before D5 and D6 are
 * asked anything. Like every other family it reports EVERY declared gate on every run —
 * a gate that does not apply says so by name, so a report can never be read as
 * "everything was checked" when it was not (GHI #108).
 *
 * REGISTRATION IS HALF THE GATE. A `deliverable-gate` that runs on a build PR
 * without being REGISTERED AS A REQUIRED CHECK reports its verdict and blocks
 * nothing — D2 and D5 become advisory, silently, with a green-looking PR. So the
 * CLI, the workflow, and `setup-repo.ts`'s ruleset registration are one change, and
 * readiness item I7 asserts the registration independently.
 *
 * AND THE `pull_request` TRIGGER IS NOT ENOUGH — found live, 2026-08-25. A
 * deliverable pull request is opened by `build-publish` using `GITHUB_TOKEN`, and
 * GitHub deliberately does not fire workflow events for actions taken with that
 * token (it exists to stop runaway recursion). So on the one pull request this gate
 * exists for, the `pull_request` event NEVER ARRIVES: PR #54 sat with
 * `build:awaiting-merge`, no checks at all, and a required check that could never be
 * satisfied. Permanently unmergeable, and green-looking.
 *
 * The fix is a SWEEP, not a cleverer event payload. `deliverable-gate.yml` also runs
 * on `build-publish`'s completion and asks a different question — "which open
 * deliverable pull requests have no verdict?" — then writes the `deliverable-gate`
 * check run onto each head commit itself. Deliberately broader than the event that
 * prompted it, and self-healing for the same reason: a gate whose run was lost, or
 * whose PR predates the gate, is picked up on the next sweep rather than waiting for
 * an event that already happened.
 */

/** The check-run name IS the required-check context. One constant, because the
 *  ruleset registration (`REQUIRED_CHECK_CONTEXTS`) and this must be the same
 *  string or the gate reports a verdict nothing is waiting for. */
export const DELIVERABLE_CHECK_NAME = 'deliverable-gate';

/**
 * The executor configuration at the frozen tag, or `null` when there genuinely is none.
 *
 * ONLY A VERIFIED 404 MEANS ABSENT (Codex on PR #153). Absence is a legitimate state
 * for the in-sandbox reference executor, and D4 decides what it means per tier — but a
 * bare `catch { return null }` made EVERY failure mean it. A 5xx, a secondary rate
 * limit or an authorization error was read as "no configuration declared", which for an
 * `in-sandbox` marker is a PASS: a temporarily unreadable config that actually declares
 * `spawned`, lacks its guardrails, or contradicts the marker's tier could take a green
 * REQUIRED gate and be auto-merged. That is the absent-≠-satisfied mistake this project
 * refuses everywhere else (GHI #108), reached through the one door nothing was watching.
 *
 * Exported so the distinction is testable directly: the difference between "absent" and
 * "unreadable" is the whole point, and it is invisible from the gate's own report.
 */
export async function readExecutorConfig(
  gh: Octokit,
  repo: RepoRef,
  executorId: string,
  planRef: string,
): Promise<string | null> {
  try {
    const { data } = await gh.repos.getContent({ ...repo, path: `executors/${executorId}.yml`, ref: planRef });
    if (Array.isArray(data) || !('content' in data)) return null;
    return Buffer.from(data.content, 'base64').toString('utf8');
  } catch (error: unknown) {
    if (errorStatus(error) === 404) return null;
    throw new ApiUnavailableError(errorMessage(error));
  }
}

/**
 * The subject-workflow files D6 reads, as they are AT THE PULL REQUEST'S HEAD.
 *
 * Read from the head commit rather than from the patch artifact because the head is
 * what merges — and only a VERIFIED 404 is a deletion (GHI #150): a path the diff
 * lists that does not exist at the head was removed by this patch, and D6.1 is the only
 * guard that applies to it. Every other failure is `ApiUnavailableError`, never
 * `content: null` — an unreadable workflow judged as "deleted" would pass a gate that
 * never saw it, which is the absent-≠-success mistake (GHI #108) on the one file class
 * this gate exists to read.
 */
export async function readSubjectWorkflowFiles(
  gh: Octokit,
  repo: RepoRef,
  paths: readonly string[],
  ref: string,
): Promise<SubjectWorkflowFile[]> {
  const out: SubjectWorkflowFile[] = [];
  for (const path of paths) {
    try {
      const { data } = await gh.repos.getContent({ ...repo, path, ref });
      if (Array.isArray(data) || !('content' in data) || typeof data.content !== 'string') {
        throw new ApiUnavailableError(`${path} at ${ref.slice(0, 8)} is not a readable file`);
      }
      out.push({ path, content: Buffer.from(data.content, 'base64').toString('utf8') });
    } catch (error: unknown) {
      if (error instanceof ApiUnavailableError) throw error;
      if (errorStatus(error) === 404) {
        out.push({ path, content: null });
        continue;
      }
      throw new ApiUnavailableError(`could not read ${path} at ${ref.slice(0, 8)}: ${errorMessage(error)}`);
    }
  }
  return out;
}

export async function deliverableGate(gh: Octokit, repo: RepoRef, prNumber: number): Promise<GateReport> {
  const { data: pr } = await gh.pulls.get({ ...repo, pull_number: prNumber });
  // Every path the diff touches — added, modified, removed, renamed. `previous_filename`
  // is included deliberately: a rename WRITES both sides, so a patch that renames a
  // reserved file out of the way has touched it, and a gate that only saw the
  // destination would let exactly that through. Shared with the merger and the
  // dashboard listing (`listPullRequestPaths`) so the four readers of merge authority
  // see the same diff.
  const paths = await listPullRequestPaths(gh, repo, prNumber);

  const subject: DeliverablePr = {
    number: pr.number,
    headRef: pr.head.ref,
    headSha: pr.head.sha,
    body: pr.body ?? '',
    labels: pr.labels.map((l) => (typeof l === 'string' ? l : (l.name ?? ''))),
    paths,
    // WHO opened it — D1's cheapest forgery check (Codex on PR #145). The
    // deterministic writer runs as an Actions identity; a person cannot be it.
    authorLogin: pr.user?.login ?? '(unknown)',
    authorIsBot: pr.user?.type === 'Bot',
  };

  // D1 runs first and its marker feeds the rest: the step every later gate judges
  // comes from the plan the marker names. Reading the plan once here, rather than in
  // each check, is what stops four gates disagreeing about which step this is.
  const d1 = await checkD1Provenance(gh, repo, subject);
  const { step } = await resolveDeliveringStep(gh, repo, d1.marker);
  // WHICH WORKLOAD this patch belongs to, and therefore which subject-workflow namespace
  // is carved out of `.github/**` for it (T279). THE PLAN REF IS THE SOURCE, and it is
  // the marker's — the same marker D1 just judged, which only the deterministic writer
  // emits. A missing or malformed marker yields `null`, which is the EMPTY namespace:
  // D5 then reserves all of `.github/**` and D6 refuses every file handed to it. That
  // is the fail-closed direction, and it is the right one — a patch whose provenance
  // D1 could not establish is the last patch that should be granted a carve-out.
  const slug = slugFromPlanRef(d1.marker?.planRef);
  // The per-workflow merge checkpoint (FR-062). Escalation-only: this can only ever
  // ADD a checkpoint — nothing read here can remove one a gate demands, which is why
  // the high-stakes branch inside resolveMergeAuthority does not consult it.
  const requiresOperatorMerge = /^(1|true|yes)$/i.test(process.env.BUILD_REQUIRES_OPERATOR_MERGE ?? '');
  // The checkpoint BY PATH (GHI #163 option 3, GHI #174 D6.7): a subject workflow in
  // the diff always waits for the operator, and so does any path inside a glob the
  // operator listed in the CHECKPOINT_PATHS repository variable — passed to this CLI as
  // an env var of the same name by the workflow, like BUILD_REQUIRES_OPERATOR_MERGE.
  // Read from the patch's ACTUAL files (`paths`, both sides of a rename), never from
  // the declared scope — the same rule D5 follows, for the same reason.
  const checkpointPaths = checkpointPathsTouched(paths, parseCheckpointPaths(process.env[CHECKPOINT_PATHS_VARIABLE]));

  // D6's subjects: the namespace paths in the diff, read at the head commit. Computed
  // before the catalogue runs so `skip` can say "no subject workflow in this patch" —
  // a gate that does not apply says so by name rather than passing (GHI #108).
  const subjectFiles = await readSubjectWorkflowFiles(gh, repo, subjectWorkflowPaths(paths, slug), pr.head.sha);

  const noMarker = (): string | null =>
    d1.marker ? null : 'no deliverable:v1 marker on the pull request (D1), so there is nothing to judge this against';
  const noStep = (): string | null =>
    !d1.marker
      ? 'no deliverable:v1 marker on the pull request (D1)'
      : step
        ? null
        : `the marker names step ${d1.marker.stepId}, which ${d1.marker.planRef} does not define (D1)`;

  const report = await runGateCatalogue(`#${prNumber} ${pr.head.ref}`, DELIVERABLE_CATALOGUE, [
    { id: 'D1', run: () => ({ id: d1.id, status: d1.status, requirement: d1.requirement, ...(d1.detail ? { detail: d1.detail } : {}) }) },
    { id: 'D2', skip: noStep, run: () => checkD2ScopeContainment(subject, step) },
    { id: 'D3', skip: noStep, run: () => checkD3MergeAuthority(step, { requiresOperatorMerge, checkpointPaths }) },
    {
      id: 'D4',
      skip: noMarker,
      // The config is read AT THE FROZEN TAG — the commit the operator approved — and
      // `executors/` is inside the reserved set, so a deliverable cannot edit its own
      // configuration into compliance (D5). Both properties are what make loading it
      // here meaningful rather than decorative (FR-066).
      run: () =>
        checkD4ExecutorProvenance(d1.marker, (executorId) =>
          d1.marker ? readExecutorConfig(gh, repo, executorId, d1.marker.planRef) : Promise.resolve(null),
        ),
    },
    // NO `skip`, deliberately, and this is the difference that matters. D2/D3/D4 all
    // need the plan to have resolved; D5 needs nothing but the paths. A patch whose
    // marker is missing, whose plan is unreadable, or whose step is a lie is exactly
    // the patch most worth asking the subject question about — so D5 always runs.
    { id: 'D5', run: () => checkD5SubjectBoundary(subject, { slug }) },
    // D6 — the content guards on the one part of `.github/` a deliverable may be
    // (FR-069, GHI #174). Like D5 it needs no plan: a subject workflow is judged on
    // what it DOES, whoever's step delivered it. `defaultBranch` is the branch this
    // pull request lands on — the one a subject trigger may name (D6.2) — which is
    // also what build-publish judged against (`ctx.base ?? 'main'`), so the writer and
    // the gate cannot disagree about it. The scanners come from PATH at call time; when
    // either is missing `scannerRunner()` is `null` and D6.5 FAILS closed.
    {
      id: 'D6',
      skip: () => (subjectFiles.length === 0 ? 'no subject workflow in this patch' : null),
      run: () => checkD6SubjectWorkflowContent(subjectFiles, { defaultBranch: pr.base.ref, slug, scan: scannerRunner() }),
    },
  ]);
  return { subject: report.subject, result: report.result, gates: report.gates };
}

/**
 * Gate every open deliverable pull request and record the verdict as a check run.
 *
 * Returns the reports so the caller can exit non-zero on a red one — but a red gate
 * here is NOT a failed sweep: the check run is the product, and it has been written.
 */
export async function sweepDeliverablePrs(
  gh: Octokit,
  repo: RepoRef,
  opts: { write?: boolean } = {},
): Promise<{ prNumber: number; report: GateReport }[]> {
  const open = await gh.paginate(gh.pulls.list, { ...repo, state: 'open', per_page: 100 });
  const out: { prNumber: number; report: GateReport }[] = [];
  for (const pr of open) {
    if (!pr.head.ref.startsWith('build/')) continue;
    // The marker, not the branch name, is what makes this a deliverable: only the
    // deterministic writer emits one, and it holds a write scope no executor has.
    if (!/<!--\s*deliverable:v1\s/.test(pr.body ?? '')) continue;
    const report = await deliverableGate(gh, repo, pr.number);
    if (opts.write !== false) {
      await gh.checks.create({
        ...repo,
        name: DELIVERABLE_CHECK_NAME,
        head_sha: pr.head.sha,
        status: 'completed',
        conclusion: report.result === 'pass' ? 'success' : 'failure',
        output: {
          title: report.result === 'pass' ? 'D1–D6 green' : `refused: ${refusalDetail(report.gates)}`.slice(0, 120),
          // The gate's OWN sentences, never a paraphrase — the same rule every other
          // refusal surface in this system follows (GHI #127).
          summary: report.gates
            .map((g) => `- **${g.id}** (${g.requirement}) — \`${g.status}\`${g.detail ? `: ${g.detail}` : ''}`)
            .join('\n'),
        },
      });
    }
    out.push({ prNumber: pr.number, report });
  }
  return out;
}

const isMain = process.argv[1]?.endsWith('deliverable-gate.ts');
if (isMain && process.argv.includes('--sweep')) {
  // The sweep is its own entry point rather than a mode of `cliMain`, because its
  // exit code means something different: `cliMain` exits 1 on a red gate, which is
  // right for the required check and wrong here — a red verdict that was
  // successfully RECORDED is a successful sweep. Failing the run would only hide
  // the check run it just wrote.
  const argv = process.argv.slice(2);
  const repoArg = argv[argv.indexOf('--repo') + 1] ?? '';
  const [owner, repoName] = repoArg.split('/');
  if (!owner || !repoName) {
    console.error('usage: deliverable-gate --sweep --repo <owner/repo>');
    process.exit(2);
  }
  void sweepDeliverablePrs(createClient(), { owner, repo: repoName })
    .then((results) => {
      if (results.length === 0) {
        console.log('no open deliverable pull requests — nothing to gate');
        return;
      }
      for (const { prNumber, report } of results) {
        console.log(`\n=== PR #${prNumber} ===`);
        printReport(report, false);
      }
    })
    .catch((error: unknown) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exit(1);
    });
} else if (isMain) {
  void cliMain(async (args) => {
    const prArg = args.get('pr');
    const repoArg = args.get('repo');
    if (!prArg || !repoArg) throw new UsageError('deliverable-gate (--pr <number> | --sweep) --repo <owner/repo> [--json]');
    const prNumber = Number(prArg);
    if (!Number.isInteger(prNumber) || prNumber <= 0) throw new UsageError(`invalid --pr: ${prArg}`);
    const [owner, repo] = repoArg.split('/');
    if (!owner || !repo) throw new UsageError(`invalid --repo: ${repoArg}`);
    return deliverableGate(createClient(), { owner, repo }, prNumber);
  });
}
