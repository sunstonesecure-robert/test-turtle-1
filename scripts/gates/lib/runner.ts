import { appendFileSync } from 'node:fs';
import { errorMessage, errorStatus } from '../../../dashboard/lib/github/errors';

/**
 * Gate-runner skeleton (T019, gate-checks-cli.md "Shared conventions").
 * Exit codes: 0 all green · 1 gate failure(s) · 2 usage/IO error · 3 GitHub API
 * unavailable (fail closed — the check reruns, it never passes open).
 * Reports are deterministic: stable gate ordering, stable key order, no timestamps.
 */

/**
 * Four outcomes, not two (GHI #108).
 *
 * A report used to list only the gates that ran, so a report MISSING five gates
 * was shaped exactly like a report of a build where those five did not apply —
 * and both were shaped like a report where they all passed. The reader could not
 * tell "checked and fine" from "never checked", which makes the artifact unable to
 * support the one claim anyone reads it for: *was this build fully gated?*
 *
 *   pass            — ran, green
 *   fail            — ran, red
 *   not-applicable  — did not run, ON PURPOSE, and the reason says which purpose
 *                     (no --chunk given, attended run). Legitimate and deliberate.
 *   absent          — the gate the catalogue declares is NOT PRESENT in the code
 *                     that ran. Never legitimate; fails the report.
 *
 * Only the first three can appear in a healthy run. `absent` exists so that the
 * one condition nobody could previously see has a name in the artifact.
 */
export type GateStatus = 'pass' | 'fail' | 'not-applicable' | 'absent';

export interface GateResult {
  id: string;
  status: GateStatus;
  requirement: string;
  detail?: string;
}

/**
 * One gate as the CATALOGUE declares it — what SHOULD be reported, independent of
 * what the caller happens to hand the runner.
 *
 * `run` returns null when the gate does not apply to this invocation, which is how
 * a deliberate skip becomes `not-applicable` WITH ITS REASON rather than a silent
 * omission. A catalogue entry whose `run` is absent altogether is `absent`: the
 * gate is declared but the code that ran does not implement it.
 */
export interface GateSpec {
  id: string;
  requirement: string;
  /** why this gate does not apply, when it does not; null/undefined means it does */
  skip?: () => string | null;
  run: GateCheck;
}

/**
 * WHICH gate code produced this report (GHI #107). Named, never implied: a build
 * dispatched on a frozen tag used to run the preflight out of that tag's own
 * checkout, so every gate added after the freeze was silently absent — and the
 * report had no way to say so. Run 32074383640 (2026-08-17, `plan/demo6/v1`)
 * listed B1/B2/B7 and read as a clean three-gate pass while B3, B4, B5, B6 and
 * B8 simply did not exist in the code that ran. A reader cannot tell an absent
 * gate from a passing one unless the report identifies the gate set.
 */
export interface GateSetRef {
  /** the ref the gate code was checked out at (a branch or a pinned gates tag) */
  ref: string;
  /** the commit that ref resolved to at run time — the auditable half */
  sha: string;
}

export interface GateReport {
  plan?: string;
  subject?: string;
  /** absent on a local CLI run, where there is no checkout to attribute */
  gate_set?: GateSetRef;
  result: 'pass' | 'fail';
  /** lifecycle-gate L8 (reactivate only): contradicting evidence arrived during
   *  the deferral — the transition still passes, but the workflow re-opens the
   *  plan so the workload returns to review first (FR-040). */
  requires_review?: boolean;
  gates: GateResult[];
}

export class ApiUnavailableError extends Error {
  readonly exitCode = 3;
}

export class UsageError extends Error {
  readonly exitCode = 2;
}

export type GateCheck = () => Promise<GateResult> | GateResult;

/** Run checks in declaration order (stable) and assemble the report. */
export async function runGates(subject: string, checks: GateCheck[]): Promise<GateReport> {
  const gates: GateResult[] = [];
  for (const check of checks) {
    gates.push(await check());
  }
  return {
    subject,
    result: reportResult(gates),
    gates,
  };
}

/**
 * The verdict over a gate list. `absent` fails as hard as `fail` (GHI #108): a gate
 * the catalogue declares and the running code does not implement is a build nobody
 * can say was gated, and passing it through would be the absent-≠-success mistake
 * this project refuses everywhere else. `not-applicable` is the only status that
 * neither passes nor blocks — it is a deliberate skip, recorded.
 */
export function reportResult(gates: GateResult[]): 'pass' | 'fail' {
  return gates.every((g) => g.status === 'pass' || g.status === 'not-applicable') ? 'pass' : 'fail';
}

/**
 * Run a DECLARED gate catalogue and reconcile the outcome against it (GHI #108).
 *
 * The difference from `runGates` is the whole point: that one reports whatever the
 * caller handed it, so a caller that forgot a gate — or a copy of the code in which
 * the gate does not exist — produced a shorter report and nothing said so. This one
 * is handed the catalogue for the gate family and reports EVERY entry, so the
 * report's shape is a property of the contract rather than of the call site.
 *
 * Order is catalogue order, which is the order the contract documents.
 */
export async function runGateCatalogue(subject: string, specs: GateSpec[]): Promise<GateReport> {
  const gates: GateResult[] = [];
  for (const spec of specs) {
    const skipped = spec.skip?.() ?? null;
    if (skipped !== null) {
      gates.push({ id: spec.id, status: 'not-applicable', requirement: spec.requirement, detail: skipped });
      continue;
    }
    gates.push(await spec.run());
  }
  return { subject, result: reportResult(gates), gates };
}

export function printReport(report: GateReport, json: boolean): void {
  if (json) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }
  // First line, before any verdict: which rules just ran is the frame every gate
  // line below is read in (GHI #107).
  if (report.gate_set) {
    console.log(`gate set: ${report.gate_set.ref} @ ${report.gate_set.sha}`);
  }
  // A distinct mark per status, because the whole point is that a reader can tell
  // them apart at a glance (GHI #108): `–` did not apply, `?` should have been here
  // and was not.
  const MARK: Record<GateStatus, string> = { pass: '✓', fail: '✗', 'not-applicable': '–', absent: '?' };
  for (const gate of report.gates) {
    console.log(`${MARK[gate.status]} ${gate.id} (${gate.requirement})${gate.detail ? ` — ${gate.detail}` : ''}`);
  }
  const absent = report.gates.filter((g) => g.status === 'absent').map((g) => g.id);
  if (absent.length > 0) {
    console.log(
      `MISSING GATE(S): ${absent.join(', ')} — declared by the contract and not implemented by the gate code that ran. ` +
        `This build cannot be said to have been gated (GHI #108)`,
    );
  }
  if (report.requires_review) {
    console.log('requires_review — contradicting evidence arrived during deferral; the plan re-opens for review (FR-040)');
  }
  console.log(report.result === 'pass' ? 'ALL GATES GREEN' : 'GATE FAILURES — see above');
}

/**
 * The report as a GitHub step summary (GHI #108, recommendation 4).
 *
 * The JSON is for machines and the console lines are for whoever opens the log;
 * neither is where a person actually looks first. Actions renders
 * `$GITHUB_STEP_SUMMARY` at the top of the run page, so the expected/actual
 * reconciliation belongs there — an absent gate should be visible without anyone
 * deciding to read a log.
 *
 * Written from the runner rather than from each workflow, so all three gate CLIs
 * get it with no YAML change and none of them can forget. Appended, never
 * overwritten: several gates may run in one job.
 *
 * Returns the markdown rather than writing it, so the shape is testable without a
 * filesystem; the caller does the append.
 */
export function stepSummary(report: GateReport): string {
  const MARK: Record<GateStatus, string> = { pass: '✅', fail: '❌', 'not-applicable': '➖', absent: '⚠️' };
  const subject = report.plan ?? report.subject ?? '(no subject)';
  const absent = report.gates.filter((g) => g.status === 'absent').map((g) => g.id);
  const lines = [
    `### ${report.result === 'pass' ? '✅' : '❌'} Gates — \`${subject}\``,
    '',
    ...(report.gate_set ? [`Gate set: \`${report.gate_set.ref}\` @ \`${report.gate_set.sha}\``, ''] : []),
    ...(absent.length > 0
      ? [
          `> ⚠️ **Missing gate(s): ${absent.join(', ')}.** Declared by the contract and not implemented by the`,
          `> gate code that ran, so this cannot be said to have been fully gated.`,
          '',
        ]
      : []),
    '| | Gate | Requirement | Detail |',
    '|---|---|---|---|',
    ...report.gates.map(
      (g) => `| ${MARK[g.status]} | \`${g.id}\` | ${g.requirement} | ${(g.detail ?? '').replace(/\|/g, '\\|')} |`,
    ),
    '',
    ...(report.requires_review
      ? ['> Contradicting evidence arrived during the deferral — the plan re-opens for review (FR-040).', '']
      : []),
  ];
  return lines.join('\n');
}

/** Append the summary to the Actions run page when running on a runner; a no-op
 *  everywhere else, so the CLIs behave identically in a local shell. */
function writeStepSummary(report: GateReport): void {
  const path = process.env.GITHUB_STEP_SUMMARY;
  if (!path) return;
  try {
    appendFileSync(path, `${stepSummary(report)}\n`);
  } catch {
    // A summary is a convenience, never a gate. Failing to write one must not
    // change a verdict or fail a run that the gates themselves passed.
  }
}

/**
 * Shared CLI plumbing: run, print, translate outcomes to contract exit codes.
 *
 * `repeated` carries EVERY value each named argument was given, in command-line
 * order, so a repeatable argument (build-preflight's `--step <step-id>`, §2) needs
 * no special case in the parser. It is collected for all arguments, not just the
 * ones known to repeat: `args` keeps its last-wins single value so no existing
 * caller changes, and a caller that repeats an argument reads the whole list here.
 */
export async function cliMain(
  fn: (args: Map<string, string>, flags: Set<string>, repeated: Map<string, string[]>) => Promise<GateReport>,
): Promise<void> {
  const args = new Map<string, string>();
  const repeated = new Map<string, string[]>();
  const flags = new Set<string>();
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (!arg.startsWith('--')) continue;
    const name = arg.slice(2);
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith('--')) {
      args.set(name, next);
      repeated.set(name, [...(repeated.get(name) ?? []), next]);
      i++;
    } else {
      flags.add(name);
    }
  }
  try {
    const report = await fn(args, flags, repeated);
    printReport(report, flags.has('json'));
    // After the console output and before the exit code: the summary is where a
    // human meets the report on the run page (GHI #108).
    writeStepSummary(report);
    process.exit(report.result === 'pass' ? 0 : 1);
  } catch (error: unknown) {
    if (error instanceof UsageError) {
      console.error(`usage error: ${error.message}`);
      process.exit(2);
    }
    if (error instanceof ApiUnavailableError) {
      console.error(`GitHub API unavailable: ${error.message} (fail closed, retryable)`);
      process.exit(3);
    }
    console.error(errorMessage(error));
    process.exit(2);
  }
}

/** Wrap unexpected transport failures as exit-3 (fail closed) API errors. */
export function asApiUnavailable(error: unknown): never {
  const status = errorStatus(error);
  if (status !== undefined && status >= 400 && status < 500) throw error as Error;
  throw new ApiUnavailableError(errorMessage(error));
}
