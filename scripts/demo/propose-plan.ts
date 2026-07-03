import { Octokit } from '@octokit/rest';
import { createClient, repoFromEnv, type RepoRef } from '../../dashboard/lib/github/client';
import { createAndonIssue } from '../../dashboard/lib/github/andon';
import { getWorkload, introduceWorkload, applyLifecycleTransition } from '../../dashboard/lib/github/workloads';
import { planBranch } from '../../dashboard/lib/github/plans';
import type { PlanDoc } from '../../schemas/plan';
import { errorMessage } from '../../dashboard/lib/github/errors';

/**
 * Demo seed (T047, quickstart §4): simulates the agent side of the tracer —
 * introduces + activates the "demo" workload when absent, pushes a one-step
 * plan (one boundary case, one verification target) to plan/demo/v1, and
 * raises the Andon break. In production this runs inside the plan-propose
 * gh-aw workflow via safe outputs; the seed writes through the same seam.
 */

export function demoPlan(runId: string): PlanDoc {
  return {
    feature: 'demo',
    version: 1,
    supersedes: null,
    run_id: runId,
    andon_issue: 1, // patched after the Andon issue is created
    steps: [
      {
        id: 'step-hello',
        title: 'Render the demo greeting',
        intent: 'Show the operator-facing hello-world greeting on the demo page',
        acceptance: 'GET /demo returns HTTP 200 and the body contains the exact greeting string',
        priority: 'MUST',
        evidence_tag: 'verified',
        stand_in: null,
        high_stakes: false,
        authority: null,
        depends_on: [],
        tracking_issue: null,
      },
    ],
    verification_targets: [
      {
        id: 'vt-hello-copy',
        kind: 'exact-copy',
        check: 'Response body of GET /demo equals "Hello, operator!"',
        maps_to: ['step-hello'],
      },
    ],
    boundary_cases: [
      {
        id: 'bc-empty-name',
        description: 'When no operator name is configured, the greeting falls back to "Hello, operator!"',
        step_id: 'step-hello',
      },
    ],
  };
}

export interface ProposeResult {
  workloadIssue: number;
  andonIssue: number;
  planRef: string;
}

export async function proposeDemoPlan(
  gh: Octokit,
  repo: RepoRef,
  opts: { slug?: string; runId?: string; actor?: string; at?: string; base?: string } = {},
): Promise<ProposeResult> {
  const slug = opts.slug ?? 'demo';
  const runId = opts.runId ?? `demo-run-${slug}`;
  const actor = opts.actor ?? 'operator';
  const at = opts.at ?? new Date().toISOString();

  // Introduce + activate the workload when not present (quickstart §4 note).
  let workload = await getWorkload(gh, repo, slug);
  if (!workload) {
    workload = await introduceWorkload(gh, repo, { slug, title: `Demo workload (${slug})`, actor, at });
    workload = await applyLifecycleTransition(gh, repo, { slug, action: 'activated', actor, at });
  }

  // Branch plan/<slug>/v1 from the default branch head, with plan.json committed.
  const base = opts.base ?? 'main';
  const { data: baseRef } = await gh.git.getRef({ ...repo, ref: `heads/${base}` });
  const branch = planBranch(slug, 1);
  await gh.git.createRef({ ...repo, ref: `refs/heads/${branch}`, sha: baseRef.object.sha });

  const plan = demoPlan(runId);
  plan.feature = slug;

  // Raise the Andon break first so plan.json can carry its issue number.
  const andonIssue = await createAndonIssue(gh, repo, { slug, plan, planRef: branch });
  plan.andon_issue = andonIssue;

  await gh.repos.createOrUpdateFileContents({
    ...repo,
    path: 'plan.json',
    message: `plan: propose ${branch}`,
    content: Buffer.from(JSON.stringify(plan, null, 2)).toString('base64'),
    branch,
  });

  return { workloadIssue: workload.issueNumber, andonIssue, planRef: branch };
}

const isMain = process.argv[1]?.endsWith('propose-plan.ts');
if (isMain) {
  const gh = createClient();
  const repo = repoFromEnv();
  proposeDemoPlan(gh, repo)
    .then((r) => {
      console.log(`workload issue #${r.workloadIssue}`);
      console.log(`Andon break  #${r.andonIssue} (andon:open)`);
      console.log(`plan branch  ${r.planRef}`);
    })
    .catch((error) => {
      console.error(errorMessage(error));
      process.exit(1);
    });
}
