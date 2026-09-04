import type { GateResult } from './runner';

/**
 * High-stakes gate G6 (T107, FR-023): every step flagged `high_stakes` NAMES the
 * authority that will confirm it — customer, clinical, legal or security-regulatory. Without a named
 * route there is nobody to send the item to, so the confirmation B5 waits for can
 * never arrive.
 *
 * Operates on the RAW parsed document, not the zod-validated PlanDoc: G1 (schema)
 * rejects documents like these too, but G6 is the gate that SURFACES the violation
 * by step id, so the operator reads "step-dosing is high-stakes with no authority
 * named" rather than a zod path. Same raw-input pattern as checks-evidence's G5 and
 * checks-scope's G2.
 *
 * Only FLAGGED steps are gated. An authority left behind on a step that was
 * unflagged again is untidy, not a violation — refusing the plan for it would teach
 * the operator to fear the flag, which is the one behaviour FR-023 cannot afford.
 */

const AUTHORITIES = new Set(['customer', 'clinical', 'legal', 'security-regulatory']);

interface RawStepish {
  id?: unknown;
  high_stakes?: unknown;
  authority?: unknown;
}

export function checkG6HighStakesAuthority(rawPlan: unknown): GateResult {
  const steps = (rawPlan as { steps?: unknown } | null)?.steps;
  if (!Array.isArray(steps)) {
    return { id: 'G6', status: 'fail', requirement: 'FR-023', detail: 'plan has no steps array' };
  }
  const unrouted: string[] = [];
  steps.forEach((step: RawStepish, index) => {
    if (step?.high_stakes !== true) return;
    // Absent, null, empty and out-of-enum all land here: the enum is the set of
    // routes that exist today, and anything outside it routes the item nowhere.
    if (typeof step.authority !== 'string' || !AUTHORITIES.has(step.authority)) {
      unrouted.push(typeof step?.id === 'string' ? step.id : `steps[${index}]`);
    }
  });
  if (unrouted.length === 0) {
    return { id: 'G6', status: 'pass', requirement: 'FR-023' };
  }
  return {
    id: 'G6',
    status: 'fail',
    requirement: 'FR-023',
    detail: `high-stakes step(s) with no confirming authority named: ${unrouted.join(', ')} (expected one of ${[...AUTHORITIES].join(', ')})`,
  };
}
