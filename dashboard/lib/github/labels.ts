/**
 * Label taxonomy + mutual-exclusion rules (issue-tracker-contract.md, FR-025).
 * The transition-authority matrix lives here so both dashboard and gate CLIs
 * flag out-of-contract transitions as tampering.
 */

// andon:superseded is the withdrawn-proposal terminal state (T198, FR-057/FR-058):
// a review ended without approval — distinct from andon:resolved, which is
// approval-only. Both are terminal and mutually exclusive with the live states.
export const ANDON_LABELS = ['andon:open', 'andon:under-review', 'andon:resolved', 'andon:superseded'] as const;
// The two halves of that family, named because THREE modules query one half by label
// and must agree on which half they got (same reason CONFLICT_LABEL is named below).
export const LIVE_ANDON_LABELS = ['andon:open', 'andon:under-review'] as const;
export const TERMINAL_ANDON_LABELS = ['andon:resolved', 'andon:superseded'] as const;
export const CORRECTION_LABELS = ['correction:open', 'correction:addressed', 'correction:withdrawn'] as const;
export const CHUNK_LABELS = ['chunk:title-only', 'chunk:ready'] as const;
/**
 * The deliverable pull request's lifecycle state (US18, FR-064). Exactly one at a
 * time, and TWO deterministic writers by trigger: `build-publish` sets the initial
 * `build:awaiting-merge` on the executor's completion, and `build-merge` transitions
 * it on the `pull_request` merge/close event. Two writers because `build-publish`
 * fires only on `workflow_run` from the build, so with it as the sole writer a merged
 * PR kept `build:awaiting-merge` forever — still returned by the portfolio's search
 * and still falsely action-required (PR #115 Codex review). No other actor writes them.
 */
export const BUILD_LABELS = ['build:awaiting-merge', 'build:merged', 'build:refused'] as const;
export const WORKLOAD_LABELS = [
  'workload:proposed',
  'workload:active',
  'workload:deferred',
  'workload:completed',
  'workload:canceled',
  'workload:archived',
] as const;
// One label per authority in the V1 enum (schemas/plan.ts, schemas/confirmation.ts,
// high-stakes.tsx AUTHORITY). `security-regulatory` joined 2026-09-04 (operator ask): an
// information-security or regulatory-compliance officer's sign-off, wired exactly like the
// other three — flag → label → refusal at build until confirm-record lights `confirmed:*`.
export const HIGH_STAKES_LABELS = [
  'high-stakes:customer',
  'high-stakes:clinical',
  'high-stakes:legal',
  'high-stakes:security-regulatory',
] as const;
export const CONFIRMED_LABELS = [
  'confirmed:customer',
  'confirmed:clinical',
  'confirmed:legal',
  'confirmed:security-regulatory',
] as const;
// The cross-workload conflict flag (FR-047). Named on its own — not just spelled inside
// the taxonomy array — because xlinks.ts PROPAGATES it and portfolio.ts READS IT BACK to
// tell the operator a conflict is unresolved. Those two must never disagree with the
// taxonomy (or each other) about the string: a one-character drift would silently mean
// "no conflicts anywhere" on a view whose whole job is to surface them.
export const CONFLICT_LABEL = 'conflict:open';
// Named for the same reason CONFLICT_LABEL is: it has a writer (markContradicted),
// two readers that BLOCK on it (preflight B6, lifecycle L8), and now a clearer at
// the freeze (GHI #75) — four modules that must spell it identically.
export const CONTRADICTION_LABEL = 'flagged:wrong-assumption';
/**
 * The approval pull request's marker — what KIND of pull request this is, and nothing
 * more (operator finding, 2026-08-28).
 *
 * WHY IT EXISTS. A deliverable pull request carries a `build:*` label; an approval pull
 * request carried none, so a governed repo's pull request list showed labels on some
 * rows and nothing on others — which reads as "that one has no state" rather than "that
 * one is a different kind". It is also what makes `label:plan:approval` a shareable
 * filter, which the title alone is not.
 *
 * WHY IT IS A MARKER AND NOT A FAMILY. There is deliberately no
 * `plan:awaiting-approval` → `plan:approved` progression, because that fact is already
 * held in two authoritative places: the Andon break's `andon:*` labels, and the pull
 * request's own merged/closed state, which is what `getApprovalRecord` reads (FR-026).
 * A third copy is a third thing to go stale — and this taxonomy has been bitten by that
 * twice already, in the stranded live-Andon labels `isLiveAndon` exists to survive, and
 * in `build:awaiting-merge` outliving its merge until a second writer was added.
 *
 * WHY NOTHING READS IT. Not one gate, sweep or view keys on this label, and none may.
 * An approval pull request is identified by its head ref (`plan/<slug>/v<N>`, bound to
 * the frozen tag) and its authority is the merge itself — `merged_by`, `merged_at`,
 * `merge_commit_sha`. A label is mutable by anyone with write access; the moment one
 * enters that chain, the answer to "was this approved" becomes forgeable. It is display,
 * and it stays display (GHI #105 makes the same argument about attestation by label).
 */
export const APPROVAL_PR_LABEL = 'plan:approval';
export const STANDALONE_LABELS = [
  'intent:confirmed',
  'evidence:batch',
  CONTRADICTION_LABEL,
  CONFLICT_LABEL,
  // Deliberately NOT in EXCLUSIVE_FAMILIES below: it has no siblings to be exclusive with.
  APPROVAL_PR_LABEL,
] as const;

export const ALL_LABELS: readonly string[] = [
  ...ANDON_LABELS,
  ...CORRECTION_LABELS,
  ...CHUNK_LABELS,
  ...WORKLOAD_LABELS,
  ...HIGH_STAKES_LABELS,
  ...CONFIRMED_LABELS,
  ...BUILD_LABELS,
  ...STANDALONE_LABELS,
];

export type WorkloadState = 'proposed' | 'active' | 'deferred' | 'completed' | 'canceled' | 'archived';

const EXCLUSIVE_FAMILIES: readonly (readonly string[])[] = [
  ANDON_LABELS,
  CORRECTION_LABELS,
  CHUNK_LABELS,
  WORKLOAD_LABELS,
  BUILD_LABELS,
];

/**
 * Is this break LIVE — a review that still wants the operator? A live label alone does
 * not answer it. Every terminal closure adds its terminal label FIRST and drops the live
 * ones after (GHI #48 ordering, so a crash never leaves the break label-less), which means
 * a teardown that fails in between leaves BOTH on the issue. The break's own page reads
 * the terminal label and says "Withdrawn"; every surface that asked only "does it carry a
 * live label?" kept calling it live — an action-required banner on /workloads, a "Continue
 * review" in the Inbox, and a lifecycle-gate blocker, all pointing at a review the operator
 * had already ended (live finding, 2026-08-17: demo5 / break #25 held all three).
 *
 * Terminal wins, deliberately: it is the LAST thing the operator was told, it is the state
 * the break's own page renders, and it is the half of the pair that closures write first —
 * so believing it can never be premature. The stale live label is then inert everywhere
 * rather than half-believed, and the withdrawal's own idempotent retry stays the thing that
 * converges the labels.
 *
 * This is the READ-side guard only. What strands the label in the first place — a teardown
 * whose first (usually no-op) removeLabel takes the close down with it — is GHI #104.
 */
export function isLiveAndon(labels: string[]): boolean {
  return (
    labels.some((l) => (LIVE_ANDON_LABELS as readonly string[]).includes(l)) &&
    !labels.some((l) => (TERMINAL_ANDON_LABELS as readonly string[]).includes(l))
  );
}

/** Returns the families violated by the given label set (≥2 labels of one exclusive family). */
export function exclusivityViolations(labels: string[]): string[][] {
  return EXCLUSIVE_FAMILIES.map((family) => labels.filter((l) => family.includes(l))).filter(
    (present) => present.length > 1,
  );
}

/** Exactly-one rule for workload issues (SC-011). */
export function workloadState(labels: string[]): WorkloadState | null {
  const present = labels.filter((l) => (WORKLOAD_LABELS as readonly string[]).includes(l));
  if (present.length !== 1) return null;
  return present[0]!.split(':')[1] as WorkloadState;
}

/** Legal workload transitions — the lifecycle-gate encodes preconditions; this is the map. */
export const WORKLOAD_TRANSITIONS: Record<string, { from: WorkloadState[]; to: WorkloadState }> = {
  activate: { from: ['proposed'], to: 'active' },
  complete: { from: ['active'], to: 'completed' },
  // proposed/deferred included per the amended FR-038 (state-transition audit 2026-07-03):
  // a workload that will never activate, or a dead deferral, must be cancelable — the only
  // path to archival. Runs-to-stop exist only when canceling from active.
  cancel: { from: ['proposed', 'active', 'deferred'], to: 'canceled' },
  defer: { from: ['active'], to: 'deferred' },
  reactivate: { from: ['deferred'], to: 'active' },
  archive: { from: ['completed', 'canceled'], to: 'archived' },
};
// There is deliberately NO delete action (FR-042).
