import type { Octokit } from '@octokit/rest';
import type { RepoRef } from './github/client';
import type { PlanDoc } from '../../schemas/plan';
import { buildPreflight } from '../../scripts/gates/build-preflight';
import { blockingGates, phraseGate, type GateReport, type GateResult } from '../../scripts/gates/lib/runner';
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
  // Deliberately NOT `refusalDetail`: this one appends `(FR-0NN)` for the
  // disabled-button title, which is a different string for a different reader.
  // Safe to keep separate because `absent` is unreachable here — these three
  // checks are CALLED, not looked up in a catalogue, so the status the shared
  // formatter exists to stop dropping cannot arise on this path.
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
  /** would an ATTENDED run be allowed to start? */
  pass: boolean;
  /** would an UNATTENDED run be allowed? Never true when `pass` is false. */
  unattendedPass: boolean;
  /** failing gates for an attended run, phrased for an operator: "B3: <detail>" */
  failures: string[];
  /** what an unattended run additionally owes; empty when the two verdicts agree */
  unattendedFailures: string[];
  /** gates this preview could not evaluate, named — never implied as covered */
  unevaluated: string[];
}

export async function buildDispatchPreview(
  gh: Octokit,
  repo: RepoRef,
  input: { planRef: string; workload: string; chunk?: number },
): Promise<BuildDispatchPreview> {
  // Previewed UNATTENDED, and the attended verdict derived from it (PR #113 review).
  //
  // The card offers both — it prints `unattended` as a value to copy — but the
  // preview only ever ran the attended path, so B4 came back `not-applicable` and an
  // operator who set `unattended=true` could meet a refusal the green preview never
  // mentioned. That is reachable without anything exotic: the card is offered on the
  // `intent:confirmed` LABEL, while B4 requires the well-formed confirmation COMMENT
  // that carries identity and timestamp — a hand-applied label, or a deleted comment,
  // splits the two.
  //
  // One preflight answers both, because B4 is the ONLY gate that differs between
  // them: the attended verdict is this same report with B4 set aside.
  const report = await buildPreflight(gh, repo, {
    planRef: input.planRef,
    workload: input.workload,
    ...(input.chunk !== undefined ? { chunk: input.chunk } : {}),
    ...(input.chunk !== undefined ? { unattended: true } : {}),
    // githubRef deliberately omitted — see above.
  });

  // `blockingGates`/`phraseGate` were this file's own two helpers until GHI #127
  // needed the same phrasing on the dispatch path; they moved to `runner.ts`
  // beside the gate types unchanged, and the three call sites that had the rule
  // WRONG (fail only, so an absent gate explained nothing) now share this one.
  const blocking = blockingGates(report.gates);
  const attendedBlocking = blocking.filter((g) => g.id !== 'B4');
  const unattendedOnly = blocking.filter((g) => g.id === 'B4');

  return {
    report,
    // `not-applicable` neither passes nor blocks, which is exactly the reading a
    // preview needs too (GHI #108).
    pass: attendedBlocking.length === 0,
    unattendedPass: blocking.length === 0,
    failures: attendedBlocking.map(phraseGate),
    unattendedFailures: unattendedOnly.map(phraseGate),
    // B8 by name, always: it is not "passing", it is unasked.
    unevaluated: ['B8 (was this dispatched on the frozen tag) — only answerable once the run exists'],
  };
}
