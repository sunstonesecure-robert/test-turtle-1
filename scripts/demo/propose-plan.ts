import { Octokit } from '@octokit/rest';
import { createClient, repoFromEnv, type RepoRef } from '../../dashboard/lib/github/client';
import { createAndonIssue } from '../../dashboard/lib/github/andon';
import { getWorkload, introduceWorkload, applyLifecycleTransition } from '../../dashboard/lib/github/workloads';
import { parseAndonHeader } from '../../dashboard/lib/github/markers';
import { planBranch } from '../../dashboard/lib/github/plans';
import { publishPlan } from '../plan-publish';
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
  // The activate re-reads by ISSUE NUMBER: GitHub's list endpoint is not
  // read-after-write consistent, so the just-created issue can be invisible to
  // a slug lookup (live PB-003 finding). A pre-existing proposed workload (e.g.
  // a prior run that failed here) is activated too — the seed is resumable.
  let workload = await getWorkload(gh, repo, slug);
  if (!workload) {
    workload = await introduceWorkload(gh, repo, { slug, title: `Demo workload (${slug})`, actor, at });
  }
  if (workload.state === 'proposed') {
    workload = await applyLifecycleTransition(gh, repo, {
      slug,
      action: 'activated',
      actor,
      at,
      issueNumber: workload.issueNumber,
    });
  }

  const branch = planBranch(slug, 1);
  const plan = demoPlan(runId);
  plan.feature = slug;

  // Find-or-create the Andon break, then land the branch through publishPlan —
  // the SAME deterministic writer the production flow uses. That inherits its
  // resumability (branch-exists, inherited plan.json sha — live PB-003 finding
  // C: approval merges put a plan.json on main, and a sha-less write 422s) and
  // avoids a second copy of the write logic. The fresh Andon's number is passed
  // as a hint: lists lag creates (finding B), only single GETs are consistent.
  const openBreaks = await gh.paginate(gh.issues.listForRepo, { ...repo, labels: 'andon:open', state: 'open', per_page: 100 });
  let andonIssue = openBreaks.find((issue) => parseAndonHeader(issue.body ?? '')?.planRef === branch)?.number;
  if (andonIssue === undefined) {
    andonIssue = await createAndonIssue(gh, repo, { slug, plan, planRef: branch });
  }
  plan.andon_issue = andonIssue;
  await publishPlan(gh, repo, plan, { base: opts.base, andonIssue });

  return { workloadIssue: workload.issueNumber, andonIssue, planRef: branch };
}

const isMain = process.argv[1]?.endsWith('propose-plan.ts');
if (isMain) {
  // A live target accumulates plan/<slug>/v* refs run over run (PB-001 used
  // `demo`, PB-002 `demo2`), and this seed always proposes v1 — so the operator
  // must be able to pick a fresh slug (PB-003 precondition).
  // Accept --slug <value> and --slug=<value>: this arg is optional with a
  // default, so an unrecognized spelling would otherwise fall through SILENTLY
  // to `demo` — wrong slug on a fresh target, confusing ref-exists 422 here.
  const argv = process.argv.slice(2);
  const i = argv.findIndex((a) => a === '--slug' || a.startsWith('--slug='));
  const slug = i < 0 ? undefined : argv[i]!.startsWith('--slug=') ? argv[i]!.slice('--slug='.length) : argv[i + 1];
  if (i >= 0 && (!slug || !/^[a-z0-9][a-z0-9-]*$/.test(slug))) {
    console.error('usage: propose-plan [--slug <kebab-case-slug>]  (default: demo)');
    process.exit(2);
  }
  const gh = createClient();
  const repo = repoFromEnv();
  proposeDemoPlan(gh, repo, slug ? { slug } : {})
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
