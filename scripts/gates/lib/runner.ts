import { errorMessage, errorStatus } from '../../../dashboard/lib/github/errors';

/**
 * Gate-runner skeleton (T019, gate-checks-cli.md "Shared conventions").
 * Exit codes: 0 all green · 1 gate failure(s) · 2 usage/IO error · 3 GitHub API
 * unavailable (fail closed — the check reruns, it never passes open).
 * Reports are deterministic: stable gate ordering, stable key order, no timestamps.
 */

export interface GateResult {
  id: string;
  status: 'pass' | 'fail';
  requirement: string;
  detail?: string;
}

export interface GateReport {
  plan?: string;
  subject?: string;
  result: 'pass' | 'fail';
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
    result: gates.every((g) => g.status === 'pass') ? 'pass' : 'fail',
    gates,
  };
}

export function printReport(report: GateReport, json: boolean): void {
  if (json) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }
  for (const gate of report.gates) {
    const mark = gate.status === 'pass' ? '✓' : '✗';
    console.log(`${mark} ${gate.id} (${gate.requirement})${gate.detail ? ` — ${gate.detail}` : ''}`);
  }
  console.log(report.result === 'pass' ? 'ALL GATES GREEN' : 'GATE FAILURES — see above');
}

/** Shared CLI plumbing: run, print, translate outcomes to contract exit codes. */
export async function cliMain(fn: (args: Map<string, string>, flags: Set<string>) => Promise<GateReport>): Promise<void> {
  const args = new Map<string, string>();
  const flags = new Set<string>();
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (!arg.startsWith('--')) continue;
    const name = arg.slice(2);
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith('--')) {
      args.set(name, next);
      i++;
    } else {
      flags.add(name);
    }
  }
  try {
    const report = await fn(args, flags);
    printReport(report, flags.has('json'));
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
