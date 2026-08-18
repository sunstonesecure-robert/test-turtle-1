import type { Octokit } from '@octokit/rest';
import type { RepoRef } from '../../../dashboard/lib/github/client';
import { errorStatus } from '../../../dashboard/lib/github/errors';
import { resolveCurrent } from '../../../dashboard/lib/github/plans';
import { checkB1FrozenCurrent, checkB2PlanRevalidates } from './checks-preflight';
import type { GateResult } from './runner';

/**
 * "Could this workload's OFFICIAL plan pass preflight TODAY?" (GHI #109)
 *
 * THE GAP THIS FILLS. Nothing anywhere reported that a workload's approved plan
 * can never be built. The operator found out by dispatching a build and reading a
 * failed Actions run; `/workloads`, `/backlog` and the readiness check all showed
 * the workload as fine. Two live workloads in the governed repo were in exactly
 * that state on 2026-08-17, and three more were working only because obsolete
 * files nobody meant to keep had never been cleaned up — a tidy-up commit would
 * have bricked them with no warning anywhere.
 *
 * The cause of the first instance was that removing the `plans/<slug>/CURRENT`
 * pointer (GHI #44) was a breaking change to something ALREADY-FROZEN plans
 * depend on: their gate code reads a file the project deliberately deleted, so
 * B1 fails forever. Running the gates from a current source (GHI #107) stops that
 * happening to plans frozen from now on. It does nothing for the plans already
 * bricked, and it cannot: `workflow_dispatch` on a tag runs the workflow FILE as
 * it exists at that tag, so a plan frozen before that fix keeps its old workflow
 * and its old, frozen-in gate code. Which is why detection is a separate thing
 * from the fix, and why a plan can be unbuildable for reasons neither one covers.
 *
 * WHAT IS CHECKED, AND WHY ONLY THIS. The STRUCTURAL half of preflight — the
 * gates that are a property of the plan and the repo rather than of a particular
 * dispatch:
 *
 *   B1/B2 (reused, never re-implemented) — the frozen tag resolves as the
 *     official version and its document still validates. These are the gates that
 *     fail for the whole plan rather than for one build of it.
 *
 *   the frozen workflow — whether the build workflow AT THE TAG runs its preflight
 *     from a current gate source. If it does not, this plan is policed by whatever
 *     the rules were on its approval date, and any dependency those rules had on a
 *     since-removed mechanism is a permanent failure with no way to fix it in place.
 *
 * Deliberately EXCLUDED: B3/B4/B6 need a chunk, B8 needs a dispatch ref, and B5 is
 * a state a flagged step is legitimately IN — "waiting on an authority" is the
 * gate working, not a broken plan. Reporting those here would turn an
 * action-required banner into noise the operator learns to ignore, which is how a
 * real one goes unnoticed.
 */

/** The build workflow as installed in the governed repo. Named once here rather
 *  than spelled at the read below, so the file this looks for and the file
 *  readiness I5 requires stay one string. */
export const BUILD_WORKFLOW_PATH = '.github/workflows/build-template.lock.yml';

/**
 * The marker that a lock runs its gates from a current checkout: the preflight
 * invocation carries `--gates-ref`. Chosen over parsing the YAML because it is
 * the ARGUMENT the fix introduced — a lock that passes it necessarily resolved a
 * gates ref, and a lock that does not, necessarily runs whatever gate code its own
 * checkout holds. A structural YAML walk would be more code for a weaker claim.
 */
const CURRENT_GATES_MARKER = '--gates-ref';

export interface BuildabilityVerdict {
  slug: string;
  /** the official version, or null when this workload has approved none */
  planRef: string | null;
  /** false only when something makes the plan unbuildable — never for "nothing frozen yet" */
  buildable: boolean;
  /** operator-facing, one per cause, each actionable on its own; empty when buildable */
  reasons: string[];
  /** the structural gate results behind the verdict, in preflight order */
  gates: GateResult[];
}

/** One file at one ref as text, or null when absent. */
async function readTextAtRef(gh: Octokit, repo: RepoRef, path: string, ref: string): Promise<string | null> {
  try {
    const { data } = await gh.repos.getContent({ ...repo, path, ref });
    if (Array.isArray(data) || !('content' in data)) return null;
    return Buffer.from(data.content, 'base64').toString('utf8');
  } catch (error: unknown) {
    if (errorStatus(error) === 404) return null;
    throw error;
  }
}

/**
 * Whether a build dispatched on this frozen tag would be policed by CURRENT rules.
 *
 * Three outcomes, and the middle one is the whole point: a tag whose workflow runs
 * the preflight out of its own checkout is not merely at risk — every gate added
 * since it was frozen is already absent from every build of it, silently.
 */
function frozenWorkflowReason(planRef: string, lock: string | null): string | null {
  if (lock === null) {
    return (
      `the build workflow is missing from ${planRef} — a build dispatched on this tag has nothing to run, ` +
      `so this plan cannot be built at all. Re-approve it as a new version (re-open, approve, freeze) to cut a ` +
      `tag that carries the workflow`
    );
  }
  if (!lock.includes(CURRENT_GATES_MARKER)) {
    return (
      `${planRef} was frozen before builds ran their checks from current code, so a build of it is policed by ` +
      `the rules of its approval date — every check added since is silently absent, and any that depended on ` +
      `something the project has removed fails permanently. Re-approve it as a new version (re-open, approve, ` +
      `freeze) to pick up the current checks`
    );
  }
  return null;
}

/**
 * The verdict for ONE workload. Never throws for an ordinary state: a workload
 * with nothing frozen is `buildable: true` with a null ref, because "has not
 * approved a plan yet" is not a broken plan and surfacing it as action-required
 * would flag every new workload the day it is created.
 */
export async function checkOfficialPlanBuildable(gh: Octokit, repo: RepoRef, slug: string): Promise<BuildabilityVerdict> {
  const planRef = await resolveCurrent(gh, repo, slug);
  if (planRef === null) return { slug, planRef: null, buildable: true, reasons: [], gates: [] };

  // The gate functions themselves, not a second opinion (gate-checks-cli.md
  // "Shared conventions"): what this scan calls unbuildable has to be what the
  // preflight actually refuses, in its own words.
  const gates = [
    await checkB1FrozenCurrent(gh, repo, planRef, slug),
    await checkB2PlanRevalidates(gh, repo, planRef),
  ];
  const reasons = gates
    .filter((g) => g.status === 'fail')
    .map((g) =>
      g.id === 'B1'
        ? `the approved plan ${planRef} is no longer resolvable as this workload's official version (${g.detail}) — a build of it is refused before any work happens`
        : `the approved plan ${planRef} no longer reads as a valid plan (${g.detail}) — a build of it is refused before any work happens`,
    );

  const workflowReason = frozenWorkflowReason(planRef, await readTextAtRef(gh, repo, BUILD_WORKFLOW_PATH, planRef));
  if (workflowReason !== null) reasons.push(workflowReason);

  return { slug, planRef, buildable: reasons.length === 0, reasons, gates };
}

/** Every named workload's verdict, concurrently — one workload's reads touch only
 *  its own refs and document, so nothing here couples two workloads (FR-046). */
export async function scanBuildability(gh: Octokit, repo: RepoRef, slugs: string[]): Promise<BuildabilityVerdict[]> {
  return Promise.all(slugs.map((slug) => checkOfficialPlanBuildable(gh, repo, slug)));
}
