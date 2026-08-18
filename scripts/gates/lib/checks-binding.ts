import type { Octokit } from '@octokit/rest';
import type { RepoRef } from '../../../dashboard/lib/github/client';
import { resolveCurrent, tryReadPlanAtRef } from '../../../dashboard/lib/github/plans';
import { listWorkloads } from '../../../dashboard/lib/github/workloads';
import type { PlanDoc } from '../../../schemas/plan';
import type { GateResult } from './runner';

/**
 * Plan↔work-item binding checks (GHI #102).
 *
 * `plan.steps[].tracking_issue` names the backlog chunk a step delivers, and the
 * binding is one-to-one. Nothing enforced that until now, for the plain reason
 * that nothing WROTE the field either (GHI #101) — a constraint on a field no
 * writer sets constrains nothing. Both landed together deliberately: a repo that
 * accumulates double-claimed chunks before the rule exists is a repo that needs a
 * migration.
 *
 *   G12  two steps of ONE plan claim the same chunk (pure, no API call)
 *   G13  a step claims a chunk another workload's OFFICIAL plan already claims
 *
 * WHY THE NUMBERS. G12 was reserved for the intent-drift gate deferred to GHI #28,
 * whose detection mechanism is still unsettled; taking the number would have made
 * two different gates answer to one id across the history. So these take G13 and
 * G14... except they do not: gate ids are operator- and report-visible and this
 * repo never renumbers, so the within-plan check takes **G13** and the
 * cross-workload one **G14**, leaving G12 parked where its issue left it.
 */

/**
 * G13 — no two steps of this plan claim the same work item.
 *
 * PURE, and cheap enough to run on every plan. Not a boundary violation like G14 —
 * one workload, one lifecycle — but still one work item carrying two acceptance
 * criteria, and one `flagged:wrong-assumption` standing for two steps. It also
 * makes the question B3 asks answerable: "which step is this build for?" has no
 * answer when two steps claim the item the build names, which is precisely what
 * GHI #87's `--step` derivation needs to resolve.
 *
 * Reported by ISSUE, listing the steps that collide, because the operator's fix is
 * to decide which step really delivers that item — a step-first message would make
 * them reconstruct the pairing themselves.
 */
export function checkG13WorkItemUniqueInPlan(plan: PlanDoc): GateResult {
  const byIssue = new Map<number, string[]>();
  for (const step of plan.steps) {
    if (typeof step.tracking_issue !== 'number') continue;
    byIssue.set(step.tracking_issue, [...(byIssue.get(step.tracking_issue) ?? []), step.id]);
  }
  // Plan order for the steps within an issue (Map preserves insertion), issue order
  // ascending across collisions — deterministic, per "Shared conventions".
  const collisions = [...byIssue.entries()]
    .filter(([, steps]) => steps.length > 1)
    .sort(([a], [b]) => a - b)
    .map(([issue, steps]) => `#${issue} is claimed by ${steps.join(' and ')}`);

  return collisions.length === 0
    ? { id: 'G13', status: 'pass', requirement: 'FR-017' }
    : {
        id: 'G13',
        status: 'fail',
        requirement: 'FR-017',
        detail: `${collisions.join('; ')} — one work item delivers one step, or "which step is this build for?" has no answer. Decide which step it belongs to and unlink the other`,
      };
}

/**
 * G14 — no step claims a work item another workload's OFFICIAL plan already claims.
 *
 * A DELIBERATE CROSS-WORKLOAD READ, and the only one in the plan gate. Every other
 * check validates a plan against itself and its own workload, which is FR-046
 * holding by construction. This one cannot: the constraint is inherently global,
 * and it is added on purpose rather than by accident.
 *
 * It is not an FR-046 violation to enforce it, it is what FR-046 protects. A chunk
 * claimed by two workloads' official plans breaks the independence guarantee in
 * three already-implemented ways: two approval lifecycles gate one work item;
 * contradicting a step in A applies `flagged:wrong-assumption` to the shared issue
 * and B6 then refuses B's build for a contradiction B never saw; and `conflict:open`
 * propagates a dispute recorded in A onto an item B is building on.
 *
 * ONLY THE OFFICIAL VERSION COUNTS (the question GHI #102 asked to settle). A claim
 * in a superseded version is not a claim — it is history, and the tag holding it is
 * immutable, so counting it would make an old plan permanently veto a new one with
 * no way to release the item. `resolveCurrent` is therefore the only reader used,
 * and the scan never walks every tag.
 *
 * THE PLAN'S OWN WORKLOAD IS EXCLUDED, by feature rather than by ref: a re-opened
 * v<N+1> legitimately re-claims everything v<N> claimed, and comparing it against
 * its own frozen predecessor would refuse every re-approval outright.
 *
 * Fails OPEN on an unreadable foreign plan — it contributes no claims rather than
 * failing this plan. An off-schema plan elsewhere is that plan's gate's business,
 * and letting it block an unrelated approval would be the cross-workload coupling
 * this check exists to prevent.
 */
export async function checkG14WorkItemUnclaimedElsewhere(
  gh: Octokit,
  repo: RepoRef,
  plan: PlanDoc,
): Promise<GateResult> {
  const claimed = plan.steps
    .filter((s): s is typeof s & { tracking_issue: number } => typeof s.tracking_issue === 'number')
    .map((s) => ({ stepId: s.id, issue: s.tracking_issue }));
  // Nothing claimed is the ordinary state of a plan whose steps no backlog item
  // covers, and it costs no API call to say so.
  if (claimed.length === 0) return { id: 'G14', status: 'pass', requirement: 'FR-046' };

  const workloads = (await listWorkloads(gh, repo))
    .filter((w) => w.slug !== plan.feature)
    .sort((a, b) => a.slug.localeCompare(b.slug));

  // issue → the foreign workload + step already claiming it. First claimant wins;
  // workloads are sorted, so the report is the same on every run.
  const foreign = new Map<number, { slug: string; planRef: string; stepId: string }>();
  for (const workload of workloads) {
    const planRef = await resolveCurrent(gh, repo, workload.slug);
    if (planRef === null) continue; // nothing frozen — this workload claims nothing
    const { plan: official } = await tryReadPlanAtRef(gh, repo, planRef);
    if (!official) continue; // unreadable: that plan's own gate's problem, not this plan's
    for (const step of official.steps) {
      if (typeof step.tracking_issue !== 'number') continue;
      if (!foreign.has(step.tracking_issue)) {
        foreign.set(step.tracking_issue, { slug: workload.slug, planRef, stepId: step.id });
      }
    }
  }

  // Plan order, so the operator reads the offenders top-to-bottom against the
  // document in front of them.
  const conflicts = claimed
    .map(({ stepId, issue }) => ({ stepId, issue, holder: foreign.get(issue) }))
    .filter((c): c is typeof c & { holder: { slug: string; planRef: string; stepId: string } } => c.holder !== undefined)
    .map(
      (c) =>
        `${c.stepId} claims work item #${c.issue}, which ${c.holder.slug}'s approved plan already claims for ${c.holder.stepId} (${c.holder.planRef})`,
    );

  return conflicts.length === 0
    ? { id: 'G14', status: 'pass', requirement: 'FR-046' }
    : {
        id: 'G14',
        status: 'fail',
        requirement: 'FR-046',
        detail: `${conflicts.join('; ')} — two workloads cannot deliver one work item: contradicting evidence in one would block builds in the other, and each would gate the item on its own approval. Give this step its own work item, or take the item off the other plan first`,
      };
}
