import type { Octokit } from '@octokit/rest';
import { createClient, type RepoRef } from '../../dashboard/lib/github/client';
import { cliMain, runGates, UsageError, type GateReport } from './lib/runner';
import {
  checkB1FrozenCurrent,
  checkB2PlanRevalidates,
  checkB3ChunkReady,
  checkB4IntentConfirmed,
  checkB6NotFlagged,
  checkB7WorkloadActive,
  checkB8DispatchedOnFrozenRef,
} from './lib/checks-preflight';
import { slugFromPlanRef } from '../../dashboard/lib/github/plans';

/**
 * build-preflight (T040 + T140) — step 1 of every dispatched build workflow.
 * A non-zero exit fails the run before any agent step executes.
 * Tracer set: B1, B2, B7, B8. B3–B6 arrive with US4/US5/US6.
 *
 * The plan-ref → slug parse lives in plans.ts beside `planBranch` that builds it: this
 * gate and the portfolio view must agree on which workload a ref names.
 */

export async function buildPreflight(
  gh: Octokit,
  repo: RepoRef,
  input: { planRef: string; workload: string; chunk?: number; unattended?: boolean; githubRef?: string },
): Promise<GateReport> {
  // B3/B6 run only when the build names a chunk; B4 only for unattended runs on
  // that chunk. A chunkless build (the US1 tracer's whole-plan demo build) is
  // legal and skips them — an UNATTENDED build without a chunk is not: there is
  // no chunk whose confirmed intent could authorize it (FR-018).
  if (input.unattended && input.chunk === undefined) {
    throw new UsageError('an unattended build requires --chunk — intent confirmation (B4) attaches to a chunk (FR-018)');
  }
  const report = await runGates(input.planRef, [
    () => checkB1FrozenCurrent(gh, repo, input.planRef, input.workload),
    () => checkB2PlanRevalidates(gh, repo, input.planRef),
    ...(input.chunk !== undefined
      ? [
          () => checkB3ChunkReady(gh, repo, input.chunk!, input.planRef),
          ...(input.unattended ? [() => checkB4IntentConfirmed(gh, repo, input.chunk!)] : []),
          () => checkB6NotFlagged(gh, repo, input.chunk!),
        ]
      : []),
    () => checkB7WorkloadActive(gh, repo, input.workload),
    // B8 is pure and reads no API, so it runs last and costs nothing — but its
    // failure is the most structural of the set: the run is building the wrong
    // worktree entirely (GHI #72 option A).
    () => checkB8DispatchedOnFrozenRef(input.planRef, input.githubRef),
  ]);
  return { plan: input.planRef, result: report.result, gates: report.gates };
}

const isMain = process.argv[1]?.endsWith('build-preflight.ts');
if (isMain) {
  void cliMain(async (args, flags) => {
    const planRef = args.get('plan-ref');
    const repoArg = args.get('repo');
    if (!planRef || !repoArg) {
      throw new UsageError('build-preflight --plan-ref <tag> --workload <slug> --repo <owner/repo> [--chunk <issue#>] [--unattended] [--json]');
    }
    const chunkArg = args.get('chunk');
    const chunk = chunkArg !== undefined ? Number(chunkArg) : undefined;
    if (chunkArg !== undefined && !Number.isInteger(chunk)) {
      throw new UsageError(`invalid --chunk: ${chunkArg} (expected an issue number)`);
    }
    const workload = args.get('workload') ?? slugFromPlanRef(planRef);
    if (!workload) throw new UsageError(`cannot derive workload slug from ${planRef}; pass --workload`);
    const [owner, repo] = repoArg.split('/');
    if (!owner || !repo) throw new UsageError(`invalid --repo: ${repoArg}`);
    // GITHUB_REF comes from the Actions environment, never from an argument: a
    // caller-supplied ref would let the very dispatch B8 refuses assert its own
    // correctness.
    const githubRef = process.env.GITHUB_REF;
    return buildPreflight(createClient(), { owner, repo }, {
      planRef,
      workload,
      ...(chunk !== undefined ? { chunk } : {}),
      ...(flags.has('unattended') ? { unattended: true } : {}),
      ...(githubRef !== undefined ? { githubRef } : {}),
    });
  });
}
