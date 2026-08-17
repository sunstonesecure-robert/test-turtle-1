import type { GateResult } from '../gates/lib/runner';

/**
 * Scanner findings seam (T191, FR-054, gate-checks-cli.md "Scanner findings seam").
 * V1 ships the SEAM ONLY — the pluggable interface, the registry, and the rule by which
 * a gate consumes findings. The V1 scanner is the gh-aw **threat-detection judge**, which
 * runs as an isolated job compiled into `plan-propose.lock.yml` and is NOT our TypeScript:
 * this module adapts the report it already produced, it does not reimplement the judge.
 *
 * The invariant that keeps V1 gate behaviour unchanged is structural, not documentary:
 * a finding's `mode` is stamped by the registry from the scanner's REGISTRATION, so a
 * scanner cannot declare its own blocking power, and `isBlocking` demands
 * `mode === 'blocking'`. Every V1 scanner is advisory, so no V1 finding can block a gate
 * however severe the scanner rates it (constitution: Automated Adversarial Validation —
 * the judge is advisory input for the operator, never the pass/fail gate).
 */

/** Severity scale, least → most severe; `severityRank` is the only ordering. */
export type Severity = 'info' | 'low' | 'medium' | 'high' | 'critical';

const SEVERITY_SCALE: readonly Severity[] = ['info', 'low', 'medium', 'high', 'critical'];

/** A blocking-mode finding at or above this severity is an unmet gate item. */
export const BLOCKING_SEVERITY: Severity = 'high';

export function severityRank(severity: Severity): number {
  return SEVERITY_SCALE.indexOf(severity);
}

/** Which side of the agent boundary the scanned text crossed (FR-054: inputs AND outputs). */
export type ScanSubject = 'agent_input' | 'agent_output';

/** Advisory scanners inform the operator; only a blocking scanner can fail a gate. */
export type ScannerMode = 'advisory' | 'blocking';

export interface ScanInput {
  subject: ScanSubject;
  /** stable locator for provenance: `issue:42`, `plans/<slug>/plan.json`, `context/notes.md` */
  source: string;
  content: string;
}

/** What a scanner emits. It cannot name itself or its mode — the registry stamps both. */
export interface ScanFindingInput {
  severity: Severity;
  summary: string;
  /** narrower provenance than the input's, e.g. a step id; defaults to the input's */
  source?: string;
  subject?: ScanSubject;
}

/**
 * The attributable record (FR-054): which scanner, at what standing, how severe, over which
 * side of the boundary, and where it came from. No timestamp — time of detection belongs in
 * the audit record (US14), never in a gate report body (gate-checks-cli.md Shared conventions).
 */
export interface ScanFinding {
  scanner: string;
  mode: ScannerMode;
  severity: Severity;
  subject: ScanSubject;
  source: string;
  summary: string;
}

export interface Scanner {
  readonly id: string;
  readonly mode: ScannerMode;
  /** Promise-tolerant: a V2 secrets/SAST scanner shells out, and widening the seam later
   *  would be the breaking change the seam exists to prevent. */
  scan(input: ScanInput): ScanFindingInput[] | Promise<ScanFindingInput[]>;
}

/** The one place the advisory invariant is decided. */
export function isBlocking(finding: ScanFinding): boolean {
  return finding.mode === 'blocking' && severityRank(finding.severity) >= severityRank(BLOCKING_SEVERITY);
}

export interface ScannerRegistry {
  register(scanner: Scanner): void;
  /** registration order — the stable finding order the gate report depends on */
  list(): readonly Scanner[];
  run(input: ScanInput): Promise<ScanFinding[]>;
}

/**
 * Registry seeded with the V1 default. Callers hold their own registry rather than sharing a
 * module-level mutable one, so what ran is a function of the call site alone — the same
 * determinism the gate reports are held to.
 */
export function createScannerRegistry(scanners: readonly Scanner[] = [threatDetectionJudge()]): ScannerRegistry {
  const registered: Scanner[] = [];
  const registry: ScannerRegistry = {
    register(scanner: Scanner): void {
      // Duplicate ids would make findings unattributable, which is the whole point of the record.
      if (registered.some((s) => s.id === scanner.id)) {
        throw new Error(`scanner '${scanner.id}' is already registered`);
      }
      registered.push(scanner);
    },
    list: () => [...registered],
    async run(input: ScanInput): Promise<ScanFinding[]> {
      const findings: ScanFinding[] = [];
      for (const scanner of registered) {
        for (const raw of await scanner.scan(input)) {
          findings.push({
            scanner: scanner.id,
            mode: scanner.mode,
            severity: raw.severity,
            subject: raw.subject ?? input.subject,
            source: raw.source ?? input.source,
            summary: raw.summary,
          });
        }
      }
      return findings;
    },
  };
  for (const scanner of scanners) registry.register(scanner);
  return registry;
}

export const THREAT_DETECTION_JUDGE_ID = 'threat-detection-judge';

/**
 * The V1 scanner (plan-propose.md "Threat Detection judge job"): a separate container with no
 * shared credentials scans the proposed plan before the Andon issue is opened. Its report is
 * gh-aw's format, not ours, so the caller normalizes it into `ScanFindingInput[]` and this
 * adapter attributes it; with no report in hand (V1, where the verdict is attached to the
 * Andon issue out-of-band) it contributes nothing. Advisory either way: a report of nothing
 * but `critical` findings still cannot fail a gate.
 */
export function threatDetectionJudge(report: readonly ScanFindingInput[] = []): Scanner {
  return {
    id: THREAT_DETECTION_JUDGE_ID,
    mode: 'advisory',
    scan: () => [...report],
  };
}

/**
 * Gate consumption (gate-checks-cli.md): blocking findings become unmet items in the same
 * GateResult shape every other check produces, in the order `run` returned them. The consuming
 * gate supplies its own id — V1 wires no gate, which is why the seam adds no row to the G-check
 * table and no V1 report gains an entry.
 */
export function scanFindingsGate(
  id: string,
  findings: readonly ScanFinding[],
  requirement = 'FR-054',
): GateResult {
  const blocking = findings.filter(isBlocking);
  if (blocking.length === 0) {
    const detail =
      findings.length === 0
        ? 'no scan findings'
        : `${findings.length} advisory finding(s), none blocking`;
    return { id, status: 'pass', requirement, detail };
  }
  return {
    id,
    status: 'fail',
    requirement,
    detail: `blocking finding(s): ${blocking
      .map((f) => `${f.scanner} ${f.severity} on ${f.subject} ${f.source}: ${f.summary}`)
      .join('; ')}`,
  };
}
