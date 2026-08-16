import type { PlanDoc } from '../../../schemas/plan';

/**
 * Wrong-assumption propagation (T095, FR-022): the dependency closure that a
 * contradiction must flag. Deterministic, pure — no LLM, no I/O (constitution:
 * Deterministic-First); the label application lives with the caller
 * (evidence.markContradicted / the reconcile workflow).
 *
 * Edges: steps[].depends_on points AT prerequisites, so "work depending on a
 * contradicted step" means walking the edges IN REVERSE — A depends_on B and
 * B contradicted ⇒ A is built on the contradicted ground and joins the
 * closure. The contradicted steps themselves are included (they are the first
 * things needing correction), the result is deduplicated and sorted for a
 * stable audit record.
 */
export function dependencyClosure(plan: PlanDoc, contradictedStepIds: string[]): string[] {
  const dependents = new Map<string, string[]>(); // prerequisite -> steps that depend on it
  for (const step of plan.steps) {
    for (const prerequisite of step.depends_on) {
      const list = dependents.get(prerequisite);
      if (list) list.push(step.id);
      else dependents.set(prerequisite, [step.id]);
    }
  }
  const known = new Set(plan.steps.map((s) => s.id));
  const closure = new Set<string>();
  const queue = contradictedStepIds.filter((id) => known.has(id));
  while (queue.length > 0) {
    const id = queue.pop()!;
    if (closure.has(id)) continue;
    closure.add(id);
    for (const dependent of dependents.get(id) ?? []) queue.push(dependent);
  }
  return [...closure].sort();
}
