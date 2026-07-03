import type { Octokit } from '@octokit/rest';
import { createClient, type RepoRef } from '../../dashboard/lib/github/client';
import { getWorkload } from '../../dashboard/lib/github/workloads';
import { WORKLOAD_TRANSITIONS } from '../../dashboard/lib/github/labels';
import { cliMain, runGates, UsageError, type GateReport, type GateResult } from './lib/runner';

/**
 * lifecycle-gate (T137) — precondition check for every workload transition,
 * run as step 1 of the workload-lifecycle single-writer workflow.
 * Tracer set: L0 (exactly one workload:* label + valid header) and L1
 * (activate only from proposed). L2–L9 arrive with US10–US13.
 * There is NO delete action: unknown actions exit 2 (FR-042).
 */

const KNOWN_ACTIONS = Object.keys(WORKLOAD_TRANSITIONS);

export async function lifecycleGate(
  gh: Octokit,
  repo: RepoRef,
  input: { slug: string; action: string },
): Promise<GateReport> {
  if (!KNOWN_ACTIONS.includes(input.action)) {
    throw new UsageError(`unknown lifecycle action: ${input.action} (no delete exists — FR-042)`);
  }
  const workload = await getWorkload(gh, repo, input.slug);

  const l0: GateResult = workload && workload.state !== null
    ? { id: 'L0', status: 'pass', requirement: 'FR-032' }
    : {
        id: 'L0',
        status: 'fail',
        requirement: 'FR-032',
        detail: workload
          ? `workload ${input.slug} does not carry exactly one workload:* label (SC-011)`
          : `no workload issue with a workload:v1 header for slug ${input.slug}`,
      };

  const checks: GateResult[] = [l0];
  if (input.action === 'activate') {
    checks.push(
      workload?.state === 'proposed'
        ? { id: 'L1', status: 'pass', requirement: 'FR-033' }
        : { id: 'L1', status: 'fail', requirement: 'FR-033', detail: `current state is ${workload?.state ?? 'unknown'}, not proposed` },
    );
  }

  const report = await runGates(`${input.slug}:${input.action}`, checks.map((c) => () => c));
  return { subject: `${input.slug}:${input.action}`, result: report.result, gates: report.gates };
}

const isMain = process.argv[1]?.endsWith('lifecycle-gate.ts');
if (isMain) {
  void cliMain(async (args) => {
    const slug = args.get('workload');
    const action = args.get('action');
    const repoArg = args.get('repo');
    if (!slug || !action || !repoArg) {
      throw new UsageError('lifecycle-gate --workload <slug> --action <activate|complete|cancel|defer|reactivate|archive> --repo <owner/repo> [--json]');
    }
    const [owner, repo] = repoArg.split('/');
    if (!owner || !repo) throw new UsageError(`invalid --repo: ${repoArg}`);
    return lifecycleGate(createClient(), { owner, repo }, { slug, action });
  });
}
