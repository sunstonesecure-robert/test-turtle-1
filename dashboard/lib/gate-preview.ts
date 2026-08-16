import type { PlanDoc } from '../../schemas/plan';
import type { GateResult } from '../../scripts/gates/lib/runner';
import { checkG2ExactlyOnePriority, checkG3MustCoverage, checkG4SinglePassFail } from '../../scripts/gates/lib/checks-scope';

/**
 * Scope-gate preview (T060, US2): G2/G3/G4 for the dashboard, REUSING the
 * exact check functions plan-gate runs (gate-checks-cli.md "Shared
 * conventions": previews reuse the same lib so UX and enforcement cannot
 * drift). Pure and synchronous — only the Octokit-free checks belong here;
 * the required plan-gate status check on the approval PR remains the
 * authoritative enforcement point (FR-009/FR-011/FR-012). G2 receives the
 * parsed doc as its raw plan: a PlanDoc that survived G1's schema always
 * satisfies the raw-shape rules, the same defense-in-depth pass it is in the
 * wired gate.
 */

export interface ScopeGatePreview {
  pass: boolean;
  /** stable order G2, G3, G4 — the same relative order plan-gate reports */
  gates: GateResult[];
  /** failing gates phrased for the disabled-button title: "G3: <detail> (FR-012)" */
  failures: string[];
}

export function scopeGatePreview(plan: PlanDoc): ScopeGatePreview {
  const gates = [checkG2ExactlyOnePriority(plan), checkG3MustCoverage(plan), checkG4SinglePassFail(plan)];
  const failures = gates
    .filter((g) => g.status === 'fail')
    .map((g) => `${g.id}: ${g.detail ?? 'failed'} (${g.requirement})`);
  return { pass: failures.length === 0, gates, failures };
}
