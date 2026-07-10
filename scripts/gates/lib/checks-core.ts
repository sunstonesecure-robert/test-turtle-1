import type { Octokit } from '@octokit/rest';
import type { RepoRef } from '../../../dashboard/lib/github/client';
import { PlanDoc } from '../../../schemas/plan';
import { getAndon, openCorrectionCount } from '../../../dashboard/lib/github/andon';
import { listAnswers } from '../../../dashboard/lib/github/answers';
import { maxPlanVersion, tagExists, planBranch } from '../../../dashboard/lib/github/plans';
import type { GateResult } from './runner';

/**
 * Core plan-gate checks G1, G7–G11 (gate-checks-cli.md §1).
 * G2–G6 arrive with US2/US5/US6 — the tracer's plan-gate runs this set.
 */

export function checkG1Schema(rawPlan: unknown): { result: GateResult; plan: PlanDoc | null } {
  const parsed = PlanDoc.safeParse(rawPlan);
  if (parsed.success) return { result: { id: 'G1', status: 'pass', requirement: 'schema' }, plan: parsed.data };
  return {
    result: {
      id: 'G1',
      status: 'fail',
      requirement: 'schema',
      detail: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '),
    },
    plan: null,
  };
}

export async function checkG7NoOpenCorrections(
  gh: Octokit,
  repo: RepoRef,
  andonIssue: number,
): Promise<GateResult> {
  const open = await openCorrectionCount(gh, repo, andonIssue);
  return open === 0
    ? { id: 'G7', status: 'pass', requirement: 'FR-005' }
    : { id: 'G7', status: 'fail', requirement: 'FR-005', detail: `${open} correction:open issue(s) linked to Andon #${andonIssue}` };
}

export async function checkG8AllJudged(
  gh: Octokit,
  repo: RepoRef,
  plan: PlanDoc,
): Promise<GateResult> {
  const andon = await getAndon(gh, repo, plan.andon_issue);
  const judgedIds = new Set(andon.items.filter((i) => i.judged).map((i) => i.id));
  const unjudged = plan.boundary_cases.map((bc) => bc.id).filter((id) => !judgedIds.has(id));
  return unjudged.length === 0
    ? { id: 'G8', status: 'pass', requirement: 'FR-002' }
    : { id: 'G8', status: 'fail', requirement: 'FR-002', detail: `unjudged boundary cases: ${unjudged.join(', ')}` };
}

export async function checkG9VersionMonotonic(
  gh: Octokit,
  repo: RepoRef,
  plan: PlanDoc,
): Promise<GateResult> {
  // "Existing" counts frozen tags AND other plan branches — abandoned versions
  // are never reused (FR-058) — but not this plan's own branch, which exists by
  // the time the gate runs on its approval PR.
  const own = planBranch(plan.feature, plan.version);
  const max = await maxPlanVersion(gh, repo, plan.feature, { excludeRef: own });
  if (plan.version !== max + 1) {
    return {
      id: 'G9',
      status: 'fail',
      requirement: 'FR-027',
      detail: `version ${plan.version} is not max existing (${max}, over frozen tags and plan branches) + 1`,
    };
  }
  if (await tagExists(gh, repo, own)) {
    return { id: 'G9', status: 'fail', requirement: 'FR-027', detail: `tag ${own} already exists` };
  }
  return { id: 'G9', status: 'pass', requirement: 'FR-027' };
}

export function checkG10Acyclic(plan: PlanDoc): GateResult {
  const ids = new Set(plan.steps.map((s) => s.id));
  const unknown = plan.steps.flatMap((s) => s.depends_on.filter((d) => !ids.has(d)));
  if (unknown.length > 0) {
    return { id: 'G10', status: 'fail', requirement: 'data integrity', detail: `unknown step refs: ${unknown.join(', ')}` };
  }
  // Cycle detection: iterative DFS with colors.
  const edges = new Map(plan.steps.map((s) => [s.id, s.depends_on]));
  const color = new Map<string, 'gray' | 'black'>();
  const visit = (start: string): boolean => {
    const stack: { id: string; next: number }[] = [{ id: start, next: 0 }];
    color.set(start, 'gray');
    while (stack.length > 0) {
      const frame = stack[stack.length - 1]!;
      const deps = edges.get(frame.id) ?? [];
      if (frame.next < deps.length) {
        const dep = deps[frame.next++]!;
        const c = color.get(dep);
        if (c === 'gray') return false; // back edge = cycle
        if (c === undefined) {
          color.set(dep, 'gray');
          stack.push({ id: dep, next: 0 });
        }
      } else {
        color.set(frame.id, 'black');
        stack.pop();
      }
    }
    return true;
  };
  for (const step of plan.steps) {
    if (!color.has(step.id) && !visit(step.id)) {
      return { id: 'G10', status: 'fail', requirement: 'data integrity', detail: 'depends_on graph has a cycle' };
    }
  }
  return { id: 'G10', status: 'pass', requirement: 'data integrity' };
}

export async function checkG11QuestionsAnswered(
  gh: Octokit,
  repo: RepoRef,
  plan: PlanDoc,
): Promise<GateResult> {
  // A q- item is satisfied ONLY by both halves: the recorded answer:v1 comment
  // AND the ✓ (gate-checks-cli.md §G11). A hand-checked box without an answer
  // does not count, and an answer whose item is held ✗ by an open correction
  // still blocks — the checkbox belongs to the correction round-trip
  // (issue-tracker-contract.md §Andon Break). Zero q- items = pass, the same
  // vacuous-truth stance as G8.
  const andon = await getAndon(gh, repo, plan.andon_issue);
  const questions = andon.items.filter((i) => i.id.startsWith('q-'));
  if (questions.length === 0) return { id: 'G11', status: 'pass', requirement: 'FR-056' };
  const answered = new Set((await listAnswers(gh, repo, plan.andon_issue)).map((a) => a.itemId));
  // Body order = deterministic report order; the question TEXT ships in the
  // detail so the operator sees what is being asked without opening the break.
  const blocking = questions
    .filter((q) => !q.judged || !answered.has(q.id))
    .map((q) => `${q.id} ${answered.has(q.id) ? 'answered but not ✓' : 'unanswered'} — ${q.description}`);
  return blocking.length === 0
    ? { id: 'G11', status: 'pass', requirement: 'FR-056' }
    : { id: 'G11', status: 'fail', requirement: 'FR-056', detail: `blocking questions: ${blocking.join('; ')}` };
}
