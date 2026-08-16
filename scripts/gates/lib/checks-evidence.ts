import type { GateResult } from './runner';

/**
 * Evidence gate G5 (T093, FR-019/FR-020): every step carries an evidence tag
 * (verified | assumption), and every assumption names a non-empty stand_in —
 * the most representative source the guess stands in for.
 *
 * Operates on the RAW parsed document, not the zod-validated PlanDoc: G1
 * (schema) fails documents like these too, but G5 is the gate that SURFACES
 * the evidence-discipline violation by step id, so the operator sees "step X
 * is untagged" rather than a generic schema error. Same raw-input pattern as
 * checks-scope's G2.
 */

interface RawStepish {
  id?: unknown;
  evidence_tag?: unknown;
  stand_in?: unknown;
}

export function checkG5EvidenceTags(rawPlan: unknown): GateResult {
  const steps = (rawPlan as { steps?: unknown })?.steps;
  if (!Array.isArray(steps)) {
    return { id: 'G5', status: 'fail', requirement: 'FR-019', detail: 'plan has no steps array' };
  }
  const untagged: string[] = [];
  const standInMissing: string[] = [];
  steps.forEach((step: RawStepish, index) => {
    const id = typeof step?.id === 'string' ? step.id : `steps[${index}]`;
    const tag = step?.evidence_tag;
    if (tag !== 'verified' && tag !== 'assumption') {
      untagged.push(id);
      return;
    }
    if (tag === 'assumption' && (typeof step.stand_in !== 'string' || step.stand_in.trim().length === 0)) {
      standInMissing.push(id);
    }
  });
  if (untagged.length === 0 && standInMissing.length === 0) {
    return { id: 'G5', status: 'pass', requirement: 'FR-019' };
  }
  const parts: string[] = [];
  if (untagged.length > 0) parts.push(`untagged step(s): ${untagged.join(', ')}`);
  if (standInMissing.length > 0) {
    parts.push(`assumption step(s) with no named stand_in: ${standInMissing.join(', ')} (FR-020)`);
  }
  return { id: 'G5', status: 'fail', requirement: 'FR-019', detail: parts.join('; ') };
}
