import type { Octokit } from '@octokit/rest';
import type { RepoRef } from '../../../dashboard/lib/github/client';
import { resolveCurrent, tagExists, tryReadPlanAtRef } from '../../../dashboard/lib/github/plans';
import { getWorkload } from '../../../dashboard/lib/github/workloads';
import type { GateResult } from './runner';

/**
 * Build-preflight checks (gate-checks-cli.md §2) — tracer set:
 *   B1  --plan-ref tag exists AND equals plans/<slug>/CURRENT (FR-007)
 *   B2  plan at that tag re-validates against the schema (integrity)
 *   B7  the workload carries workload:active (FR-033/038/039/041)
 * B3–B6 arrive with US4/US5/US6.
 */

export async function checkB1FrozenCurrent(
  gh: Octokit,
  repo: RepoRef,
  planRef: string,
  slug: string,
): Promise<GateResult> {
  if (!(await tagExists(gh, repo, planRef))) {
    return { id: 'B1', status: 'fail', requirement: 'FR-007', detail: `tag ${planRef} does not exist` };
  }
  const current = await resolveCurrent(gh, repo, slug);
  if (current !== planRef) {
    return { id: 'B1', status: 'fail', requirement: 'FR-007', detail: `CURRENT is ${current ?? 'unset'}, not ${planRef}` };
  }
  return { id: 'B1', status: 'pass', requirement: 'FR-007' };
}

export async function checkB2PlanRevalidates(gh: Octokit, repo: RepoRef, planRef: string): Promise<GateResult> {
  const { plan, errors } = await tryReadPlanAtRef(gh, repo, planRef);
  return plan
    ? { id: 'B2', status: 'pass', requirement: 'integrity' }
    : { id: 'B2', status: 'fail', requirement: 'integrity', detail: errors.join('; ') };
}

export async function checkB7WorkloadActive(gh: Octokit, repo: RepoRef, slug: string): Promise<GateResult> {
  const workload = await getWorkload(gh, repo, slug);
  if (!workload) {
    return { id: 'B7', status: 'fail', requirement: 'FR-033', detail: `workload not found: ${slug}` };
  }
  return workload.state === 'active'
    ? { id: 'B7', status: 'pass', requirement: 'FR-033' }
    : { id: 'B7', status: 'fail', requirement: 'FR-033', detail: `workload ${slug} is workload:${workload.state}, not active` };
}
