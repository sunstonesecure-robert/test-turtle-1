import type { Octokit } from '@octokit/rest';
import type { RepoRef } from './github/client';
import type { PlanDoc } from '../../schemas/plan';
import { buildPreflight } from '../../scripts/gates/build-preflight';
import type { GateReport, GateResult } from '../../scripts/gates/lib/runner';
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

/* ------------------------------------------------------------------------- *
 * Build preview (GHI #110) — the dashboard's other preview, and the one that
 * was missing from the single place that dispatches real agent work.
 * ------------------------------------------------------------------------- */

/**
 * What preflight would say about a dispatch, run READ-ONLY before the operator
 * leaves the page.
 *
 * The dashboard previews gate outcomes everywhere except the backlog's build
 * dispatch, which handed the operator four values to copy and no indication of
 * whether the build would be allowed to start — the verdict arrived as a failed
 * Actions run. `actions.ts` states the principle this restores: the operator should
 * see *"the refusal before clicking, never only after"*.
 *
 * IT RUNS THE REAL PREFLIGHT. Not a dashboard restatement of it — `buildPreflight`
 * itself, the same function the workflow's first step calls, over the same
 * `lib/github` seam. Every check it makes is an API read with no side effects, so
 * previewing costs nothing but requests. A second implementation here would be the
 * drift this codebase forbids elsewhere, and it would be worse than no preview: a
 * green preview followed by a red run teaches the operator to ignore the preview.
 *
 * B8 IS THE ONE GATE A PREVIEW CANNOT ANSWER. It compares the dispatch ref against
 * the plan ref, and there is no dispatch yet — so `githubRef` is deliberately left
 * unset, B8 reports its "unenforceable here" pass, and the caller is told which
 * gate went unevaluated rather than being allowed to read the preview as full
 * coverage. Saying so is the point: a preview that quietly implies it checked
 * everything is the same absent-≠-success mistake in a friendlier costume.
 */
export interface BuildDispatchPreview {
  /** the whole preflight report, so the caller can render the gate rows verbatim */
  report: GateReport;
  /** true when nothing would refuse this dispatch */
  pass: boolean;
  /** failing gates, phrased for an operator: "B3: <detail>" */
  failures: string[];
  /** gates this preview could not evaluate, named — never implied as covered */
  unevaluated: string[];
}

export async function buildDispatchPreview(
  gh: Octokit,
  repo: RepoRef,
  input: { planRef: string; workload: string; chunk?: number; unattended?: boolean },
): Promise<BuildDispatchPreview> {
  const report = await buildPreflight(gh, repo, {
    planRef: input.planRef,
    workload: input.workload,
    ...(input.chunk !== undefined ? { chunk: input.chunk } : {}),
    ...(input.unattended ? { unattended: true } : {}),
    // githubRef deliberately omitted — see above.
  });
  return {
    report,
    // `not-applicable` neither passes nor blocks, which is exactly the reading a
    // preview needs too (GHI #108).
    pass: report.result === 'pass',
    failures: report.gates
      .filter((g) => g.status === 'fail' || g.status === 'absent')
      .map((g) => `${g.id}: ${g.detail ?? (g.status === 'absent' ? 'not implemented by the gate code that ran' : 'failed')}`),
    // B8 by name, always: it is not "passing", it is unasked.
    unevaluated: ['B8 (was this dispatched on the frozen tag) — only answerable once the run exists'],
  };
}
