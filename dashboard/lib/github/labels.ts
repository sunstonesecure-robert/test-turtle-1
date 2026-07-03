/**
 * Label taxonomy + mutual-exclusion rules (issue-tracker-contract.md, FR-025).
 * The transition-authority matrix lives here so both dashboard and gate CLIs
 * flag out-of-contract transitions as tampering.
 */

export const ANDON_LABELS = ['andon:open', 'andon:under-review', 'andon:resolved'] as const;
export const CORRECTION_LABELS = ['correction:open', 'correction:addressed', 'correction:withdrawn'] as const;
export const CHUNK_LABELS = ['chunk:title-only', 'chunk:ready'] as const;
export const WORKLOAD_LABELS = [
  'workload:proposed',
  'workload:active',
  'workload:deferred',
  'workload:completed',
  'workload:canceled',
  'workload:archived',
] as const;
export const HIGH_STAKES_LABELS = ['high-stakes:customer', 'high-stakes:clinical', 'high-stakes:legal'] as const;
export const CONFIRMED_LABELS = ['confirmed:customer', 'confirmed:clinical', 'confirmed:legal'] as const;
export const STANDALONE_LABELS = ['intent:confirmed', 'evidence:batch', 'flagged:wrong-assumption', 'conflict:open'] as const;

export const ALL_LABELS: readonly string[] = [
  ...ANDON_LABELS,
  ...CORRECTION_LABELS,
  ...CHUNK_LABELS,
  ...WORKLOAD_LABELS,
  ...HIGH_STAKES_LABELS,
  ...CONFIRMED_LABELS,
  ...STANDALONE_LABELS,
];

export type WorkloadState = 'proposed' | 'active' | 'deferred' | 'completed' | 'canceled' | 'archived';

const EXCLUSIVE_FAMILIES: readonly (readonly string[])[] = [
  ANDON_LABELS,
  CORRECTION_LABELS,
  CHUNK_LABELS,
  WORKLOAD_LABELS,
];

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
  cancel: { from: ['active'], to: 'canceled' },
  defer: { from: ['active'], to: 'deferred' },
  reactivate: { from: ['deferred'], to: 'active' },
  archive: { from: ['completed', 'canceled'], to: 'archived' },
};
// There is deliberately NO delete action (FR-042).
