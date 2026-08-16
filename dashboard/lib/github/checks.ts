import type { Octokit } from '@octokit/rest';
import type { RepoRef } from './client';
// TYPE-ONLY on purpose: scripts/gates/* already imports dashboard/lib/github/*,
// so a runtime import back the other way would close an import cycle. The scope
// itself is always DERIVED by the caller with commitmentScope() — this module
// never re-derives it (checks-scope.ts's one-derivation invariant, FR-010).
import type { CommitmentScope } from '../../../scripts/gates/lib/checks-scope';

/**
 * Verification-target results & the completion verdict (FR-034, SC-002).
 *
 * A verification target's result is a check run NAMED FOR THE TARGET on the
 * frozen plan tag's commit SHA (data-model.md "Verification Target Result";
 * dashboard-github-api.md's completion read is
 * `GET /repos/{o}/{r}/commits/{frozen-sha}/check-runs` filtered to `vt-*`).
 * Target ids are schema-forced to `^vt-[a-z0-9-]+$`, so the contract's
 * `vt-<id>` check-run name IS the target id — no prefixing is applied here.
 *
 * `deriveCompletionStatus` is PURE (inputs in / verdict out, no I/O, no clock),
 * mirroring checks-scope.ts: lifecycle-gate L3 is a thin wrapper over it and the
 * dashboard completion view renders the SAME verdict from the SAME function. A
 * second derivation on the view is exactly the gate-vs-preview drift this repo
 * forbids (gate-checks-cli.md "Shared conventions").
 */

/** Only the check-run fields the verdict and the latest-run choice read. */
export interface VtCheckRun {
  /** the verification target id (check-run name) */
  name: string;
  /** GitHub's check-run status: queued | in_progress | completed */
  status: string;
  /** null until the run reaches a conclusion */
  conclusion: string | null;
}

/** Per-target verdict; `unverified` means no result was ever reported. */
export type VtStatus = 'passing' | 'failing' | 'unverified';

export interface VtTargetStatus {
  vtId: string;
  /** the MUST steps this target covers, in plan order (why it is load-bearing) */
  mustStepIds: string[];
  status: VtStatus;
  /** the latest run's conclusion; null when unverified or not yet concluded */
  conclusion: string | null;
}

export interface CompletionVerdict {
  /** FR-034: every MUST-mapped target passing (and no MUST step unmapped) */
  complete: boolean;
  /** every MUST-mapped target, first-appearance order over the MUST steps */
  targets: VtTargetStatus[];
  /** operator-facing unmet items, plan order — each actionable on its own */
  unmet: string[];
  /** attached even on a PASS: the vacuous-completion warning, else null */
  note: string | null;
}

// The `vt-` restriction is LOAD-BEARING, not cosmetic: plan-gate, and any other
// CI check the repo runs, live on this very SHA (the frozen tag points at the
// approval merge commit). A `plan-gate` success must never help satisfy L3, and
// a red unrelated check must never block a completion whose targets all passed —
// completion is a statement about verification targets only (FR-034).
const VT_NAME_RE = /^vt-/;

/** A candidate for "latest run of this name", with its ordering keys. */
interface RankedRun {
  run: VtCheckRun;
  /** started_at in ms, null when absent/unparseable */
  startedMs: number | null;
  /** check-run id, null when absent */
  id: number | null;
  /** position in the API's list response — the last-resort key */
  index: number;
}

/**
 * Total, deterministic "is a newer than b": `started_at` first (when both carry
 * one), then the monotonic check-run `id`, then list position. Explicit rather
 * than trusting the endpoint's ordering, which the contract does not pin; the
 * list-order fallback is sound because it is only reached when a payload carries
 * neither key, and GitHub always returns both for a real check run.
 */
function isNewer(a: RankedRun, b: RankedRun): boolean {
  if (a.startedMs !== null && b.startedMs !== null && a.startedMs !== b.startedMs) return a.startedMs > b.startedMs;
  if (a.id !== null && b.id !== null && a.id !== b.id) return a.id > b.id;
  return a.index > b.index;
}

/**
 * The LATEST `vt-*` check run per name on one commit SHA (FR-034's completion
 * read). Paginated: a plan may carry more than one page of verification targets,
 * and a silently truncated page would read as "unverified" — a wrong refusal.
 * Re-reported targets are normal (a re-run build reports the same name again),
 * so only the newest run per name counts.
 */
export async function listVtCheckRuns(gh: Octokit, repo: RepoRef, sha: string): Promise<Map<string, VtCheckRun>> {
  const listed = await gh.paginate(gh.checks.listForRef, { ...repo, ref: sha, per_page: 100 });
  const latest = new Map<string, RankedRun>();
  listed.forEach((raw, index) => {
    if (!VT_NAME_RE.test(raw.name)) return;
    const startedMs = raw.started_at ? Date.parse(raw.started_at) : Number.NaN;
    const candidate: RankedRun = {
      run: { name: raw.name, status: raw.status, conclusion: raw.conclusion ?? null },
      startedMs: Number.isNaN(startedMs) ? null : startedMs,
      id: typeof raw.id === 'number' ? raw.id : null,
      index,
    };
    const incumbent = latest.get(raw.name);
    if (!incumbent || isNewer(candidate, incumbent)) latest.set(raw.name, candidate);
  });
  return new Map([...latest.entries()].map(([name, ranked]) => [name, ranked.run]));
}

/** How a non-success run reads in a refusal: the conclusion, or why there is none. */
function conclusionLabel(run: VtCheckRun): string {
  return run.conclusion ?? `${run.status} (no conclusion yet)`;
}

function stepsPhrase(mustStepIds: string[]): string {
  return `MUST step${mustStepIds.length > 1 ? 's' : ''} ${mustStepIds.map((id) => `'${id}'`).join(', ')}`;
}

/**
 * The completion verdict (FR-034/SC-002): every MUST-mapped verification
 * target's latest run on the frozen plan SHA concluded `success`.
 *
 * `scope: null` means NO FROZEN PLAN for the slug — reported as one unmet item
 * rather than treated as "nothing to check", which would let an unapproved
 * workload complete itself.
 */
export function deriveCompletionStatus(
  slug: string,
  scope: CommitmentScope | null,
  runs: ReadonlyMap<string, VtCheckRun>,
): CompletionVerdict {
  if (scope === null) {
    return {
      complete: false,
      targets: [],
      unmet: [
        `no frozen plan for workload '${slug}' — no plan/${slug}/v* tag exists, so no MUST step has passed anything; get a plan version approved (and its targets reported) before declaring completion`,
      ],
      note: null,
    };
  }

  // First-appearance order over the MUST steps (plan order), targets in
  // verification_targets order within a step: one target may cover several MUST
  // steps, and the operator must see it once, naming every step it carries.
  const mustStepsByVt = new Map<string, string[]>();
  for (const { stepId, vtIds } of scope.coverage) {
    for (const vtId of vtIds) {
      const covered = mustStepsByVt.get(vtId);
      if (covered) covered.push(stepId);
      else mustStepsByVt.set(vtId, [stepId]);
    }
  }

  const targets: VtTargetStatus[] = [];
  const unmet: string[] = [];
  for (const [vtId, mustStepIds] of mustStepsByVt) {
    const run = runs.get(vtId);
    if (!run) {
      targets.push({ vtId, mustStepIds, status: 'unverified', conclusion: null });
      unmet.push(
        `verification target '${vtId}' (${stepsPhrase(mustStepIds)}) is unverified — no ${vtId} check run exists on the frozen plan SHA; run the build for the frozen plan so its result is reported`,
      );
      continue;
    }
    // Anything short of a concluded `success` is not a pass — an in-flight or
    // neutral/skipped run included. Completion never passes open (the same
    // fail-closed stance as the gates' exit 3).
    if (run.conclusion === 'success') {
      targets.push({ vtId, mustStepIds, status: 'passing', conclusion: run.conclusion });
      continue;
    }
    targets.push({ vtId, mustStepIds, status: 'failing', conclusion: run.conclusion });
    unmet.push(
      `verification target '${vtId}' (${stepsPhrase(mustStepIds)}) concluded '${conclusionLabel(run)}', not success — fix the step and re-run the build so a passing result lands on the frozen plan SHA`,
    );
  }

  // Structurally impossible: plan-gate G3 blocks a MUST step with no target
  // (FR-012), and the plan read here is a FROZEN one, which passed G3. Named
  // rather than skipped, because passing silently here would complete a workload
  // whose committed work was never verifiable at all.
  for (const stepId of scope.unmappedMustStepIds) {
    unmet.push(
      `MUST step '${stepId}' has no verification target — the frozen plan cannot have passed plan-gate G3; re-open the plan (FR-008) and map a target before declaring completion`,
    );
  }

  // Vacuous pass (FR-034 read literally: no MUST step, nothing unmet). Passed,
  // but never silent: an operator must be able to see that a workload completed
  // without committing to anything. L8 sets `detail` on a pass for the same
  // reason — a report row that only says "pass" would hide the finding.
  const vacuous = scope.mustStepIds.length === 0;
  return {
    complete: unmet.length === 0,
    targets,
    unmet,
    note: vacuous && unmet.length === 0 ? 'no MUST steps in the frozen plan — nothing was committed' : null,
  };
}
