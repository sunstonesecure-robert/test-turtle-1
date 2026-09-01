/**
 * THE DECLARED GATE SETS — what each family PROMISES, independent of what any CLI
 * happens to wire up (PR #113 review, Codex P1).
 *
 * This file exists because the first attempt at GHI #108 did not actually close it.
 * `runGateCatalogue` was handed one array that served as both the expected set and
 * the implementations, so a CLI that omitted a gate simply produced a shorter loop
 * and still passed — the exact shape the issue is about, one level up. `absent` was
 * unreachable in production: every entry carried a `run`, so nothing could be
 * declared-but-missing, and the test that "proved" it synthesized an absent row by
 * hand. The reviewer was right that a catalogue which lives in the same expression
 * as the implementations reconciles nothing.
 *
 * So the declaration lives HERE, apart from every call site, and the runner
 * iterates THIS rather than the specs. A gate declared here with no implementation
 * wired to it is reported `absent`, and `absent` fails the report.
 *
 * WHAT THIS CATCHES, stated honestly. It is not a defence against a stale checkout
 * — after GHI #107 the gate code and this file come from the same current ref, so a
 * stale copy would carry a stale catalogue too. What it catches is DRIFT WITHIN a
 * checkout: a gate added to the contract and never wired, a gate dropped from one
 * CLI while another still declares it, a preview that reconciles against a
 * different set from the enforcement point. Those are the reachable failures now
 * that #107 removed the other one, and they were previously invisible.
 *
 * Kept in CONTRACT ORDER (gate-checks-cli.md), because that is the order every
 * report is read in, and the runner takes its ordering from here.
 */

export interface DeclaredGate {
  id: string;
  /** the requirement the gate enforces — reported even when the gate is absent,
   *  since "which promise went unchecked" is the useful half of that news */
  requirement: string;
}

/** §2 `build-preflight`. B8 last: pure, reads no API, and its failure is the most
 *  structural of the set. */
export const PREFLIGHT_CATALOGUE: readonly DeclaredGate[] = [
  { id: 'B1', requirement: 'FR-007' },
  { id: 'B2', requirement: 'integrity' },
  { id: 'B3', requirement: 'FR-017' },
  { id: 'B4', requirement: 'FR-018' },
  { id: 'B5', requirement: 'FR-024' },
  { id: 'B6', requirement: 'FR-022' },
  { id: 'B7', requirement: 'FR-033' },
  { id: 'B8', requirement: 'FR-007' },
  // B9 — a VERIFY run's commit descends from the frozen tag (FR-063, added
  // 2026-08-24). Declared for the whole family and SKIPPED with its reason on a
  // build run, which has no merged commit yet: the alternative — declaring it only
  // for verify runs — would make the two report shapes differ, which is the
  // condition GHI #108 is about.
  { id: 'B9', requirement: 'FR-063' },
];

/**
 * §1 `plan-gate`.
 *
 * G12 IS ABSENT ON PURPOSE and its number is never reused: the unacknowledged
 * intent-drift gate is deferred with its detection mechanism unsettled (GHI #28).
 * It is not declared here because a declared gate with no implementation is
 * `absent`, which would fail every approval — "deferred" and "missing" are
 * different things, and only the second should block.
 */
export const PLAN_CATALOGUE: readonly DeclaredGate[] = [
  { id: 'G1', requirement: 'integrity' },
  { id: 'G2', requirement: 'FR-009' },
  { id: 'G3', requirement: 'FR-012' },
  { id: 'G4', requirement: 'FR-011' },
  { id: 'G5', requirement: 'FR-019' },
  { id: 'G6', requirement: 'FR-023' },
  { id: 'G7', requirement: 'FR-005' },
  { id: 'G8', requirement: 'FR-002' },
  { id: 'G9', requirement: 'FR-027' },
  { id: 'G10', requirement: 'data integrity' },
  { id: 'G11', requirement: 'FR-056' },
  { id: 'G13', requirement: 'FR-017' },
  { id: 'G14', requirement: 'FR-046' },
  { id: 'G15', requirement: 'FR-022' },
  // G16 — the SUBJECT boundary at proposal (FR-068, added 2026-08-24). Every other
  // G gate asks whether the plan is well-formed or fully judged; this one asks what
  // the plan is ABOUT. It is here rather than only at the deliverable gate so the
  // operator is never asked to approve the system rewriting its own controls, and
  // so no build spends money reaching D5.
  { id: 'G16', requirement: 'FR-068' },
];

/**
 * §2b `deliverable-gate` — the required status check on every `build/**` pull
 * request, and the only gate family in the system that reads a patch.
 *
 * D5 LAST, and not because it matters least. D1–D4 are the US18 seam: provenance,
 * containment, authority, attribution — everything about whether the deliverable
 * arrived legitimately. D5 asks a question none of them do, about what the work is
 * ABOUT, and it is appended rather than inserted because gate ids are stable
 * identifiers and D1–D4 shipped first. Report order is contract order.
 */
export const DELIVERABLE_CATALOGUE: readonly DeclaredGate[] = [
  { id: 'D1', requirement: 'FR-060' },
  { id: 'D2', requirement: 'FR-061' },
  { id: 'D3', requirement: 'FR-062' },
  { id: 'D4', requirement: 'FR-065' },
  { id: 'D5', requirement: 'FR-068' },
  // D6 — the SUBJECT-WORKFLOW CONTENT guards (FR-069, GHI #174 C′, added 2026-08-29).
  // D5 says WHERE an agent may write: everything under `.github/**` except this
  // workload's own `<workload-slug>_<name>.yml` namespace (T279). D6 says WHAT a file
  // written into that namespace
  // may do at runtime — triggers, permissions, secrets, pinned actions, an approved
  // environment — because a workflow is the one deliverable that changes what runs
  // with which credentials. It sits after D5 for the same reason D5 sits after D4:
  // ids are stable and it shipped later. Declared for every deliverable and reported
  // `not-applicable` ("no subject workflow in this patch") when none is present, so
  // the report shape never depends on what the patch happened to touch (GHI #108).
  { id: 'D6', requirement: 'FR-069' },
];

/** §3 `lifecycle-gate`. Every transition reports all of these; which ones apply is
 *  the CLI's business, which ones EXIST is this file's. */
export const LIFECYCLE_CATALOGUE: readonly DeclaredGate[] = [
  { id: 'L0', requirement: 'FR-032' },
  { id: 'L1', requirement: 'FR-033' },
  { id: 'L2', requirement: 'FR-032' },
  { id: 'L3', requirement: 'FR-034' },
  { id: 'L4', requirement: 'FR-038' },
  { id: 'L5', requirement: 'FR-032' },
  { id: 'L6', requirement: 'FR-039' },
  { id: 'L7', requirement: 'FR-040' },
  { id: 'L8', requirement: 'FR-040' },
  { id: 'L9', requirement: 'FR-041' },
  { id: 'L10', requirement: 'FR-036' },
];
