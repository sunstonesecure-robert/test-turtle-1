import type { Octokit } from '@octokit/rest';
import { createClient, type RepoRef } from '../../dashboard/lib/github/client';
import { cliMain, runGates, UsageError, type GateReport } from './lib/runner';
import { checkB1FrozenCurrent, checkB2PlanRevalidates, checkB7WorkloadActive } from './lib/checks-preflight';

/**
 * build-preflight (T040 + T140) — step 1 of every dispatched build workflow.
 * A non-zero exit fails the run before any agent step executes.
 * Tracer set: B1, B2, B7. B3–B6 arrive with US4/US5/US6.
 */

export function slugFromPlanRef(planRef: string): string | null {
  const m = /^plan\/([a-z0-9-]+)\/v\d+$/.exec(planRef);
  return m ? m[1]! : null;
}

export async function buildPreflight(
  gh: Octokit,
  repo: RepoRef,
  input: { planRef: string; workload: string },
): Promise<GateReport> {
  const report = await runGates(input.planRef, [
    () => checkB1FrozenCurrent(gh, repo, input.planRef, input.workload),
    () => checkB2PlanRevalidates(gh, repo, input.planRef),
    () => checkB7WorkloadActive(gh, repo, input.workload),
  ]);
  return { plan: input.planRef, result: report.result, gates: report.gates };
}

const isMain = process.argv[1]?.endsWith('build-preflight.ts');
if (isMain) {
  void cliMain(async (args) => {
    const planRef = args.get('plan-ref');
    const repoArg = args.get('repo');
    if (!planRef || !repoArg) {
      throw new UsageError('build-preflight --plan-ref <tag> --workload <slug> --repo <owner/repo> [--json]');
    }
    const workload = args.get('workload') ?? slugFromPlanRef(planRef);
    if (!workload) throw new UsageError(`cannot derive workload slug from ${planRef}; pass --workload`);
    const [owner, repo] = repoArg.split('/');
    if (!owner || !repo) throw new UsageError(`invalid --repo: ${repoArg}`);
    return buildPreflight(createClient(), { owner, repo }, { planRef, workload });
  });
}
