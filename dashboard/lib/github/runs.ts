import type { Octokit } from '@octokit/rest';
import type { RepoRef } from './client';
import { errorStatus } from './errors';

/**
 * Run seam (US12 slice of the run surface — the full monitor arrives with US3):
 * find and cancel a workload's in-flight Actions runs (FR-038, SC-014).
 *
 * Linkage: builds are dispatched ON the frozen plan tag they build from, so a
 * run's `head_branch` IS the plan ref — the same slug-anchored `plan/<slug>/v<N>`
 * key that makes parallel workloads structurally independent (data-model
 * "Workload", FR-044). Matching by that anchored key means one workload's cancel
 * can never stop another workload's runs.
 *
 * That linkage is ENFORCED, not assumed: preflight **B8** fails any build whose
 * `GITHUB_REF` is not the frozen tag (`checks-preflight.ts`). It has to be — while
 * builds were dispatched on `main` with the tag passed only as an input, every
 * build run's `head_branch` was `main`, so the match below found nothing and a
 * workload cancel silently stopped no builds at all (FR-038, SC-014). The tests
 * passed throughout because their fixtures seed `head_branch` as the plan ref,
 * encoding the convention the live dispatch path did not follow (GHI #72 option A,
 * decided 2026-07-28).
 */

/** In-flight per the REST status filter; runs are canceled and KEPT (FR-042). */
const IN_FLIGHT_STATUSES = ['queued', 'in_progress'] as const;

export interface CanceledRun {
  id: number;
  headBranch: string;
}

export async function cancelWorkloadRuns(gh: Octokit, repo: RepoRef, slug: string): Promise<CanceledRun[]> {
  // Slug-anchored like resolveCurrent: plan/demo/v1 never matches slug demo2,
  // and slugs are SLUG_RE-validated kebab-case — no regex metacharacters.
  const versionRe = new RegExp(`^plan/${slug}/v\\d+$`);
  // The per-status LISTs are independent reads — fetched concurrently. A run
  // can transition queued → in_progress between them and show up in BOTH
  // pages, so matches dedupe by run id before any cancel is sent.
  const pages = await Promise.all(
    IN_FLIGHT_STATUSES.map((status) => gh.paginate(gh.actions.listWorkflowRunsForRepo, { ...repo, status, per_page: 100 })),
  );
  const matching = new Map<number, string>();
  for (const run of pages.flat()) {
    if (run.head_branch && versionRe.test(run.head_branch)) matching.set(run.id, run.head_branch);
  }
  // Cancels stay sequential and id-ordered: concurrent MUTATIONS invite
  // GitHub's secondary rate limits, and the returned list (logged by
  // lifecycle-apply) must be deterministic.
  const canceled: CanceledRun[] = [];
  for (const [id, headBranch] of [...matching.entries()].sort(([a], [b]) => a - b)) {
    try {
      await gh.actions.cancelWorkflowRun({ ...repo, run_id: id });
    } catch (error: unknown) {
      // 409: the run reached a terminal state between list and cancel —
      // stopped is stopped; everything else propagates (the workflow retries).
      if (errorStatus(error) !== 409) throw error;
    }
    canceled.push({ id, headBranch });
  }
  return canceled;
}

/* ------------------------------------------------------------------------- *
 * US3 run monitor (T068, FR-013…FR-015, SC-009).
 *
 * Deterministic-First, mirroring scripts/gates/lib/checks-scope.ts: the
 * derivations are PURE — inputs in / verdict out, no I/O and no internal clock
 * (`now` and the stall threshold are PARAMETERS). The run-monitor UI reuses them
 * so preview and logic cannot drift (dashboard-github-api.md "Derived state
 * rules, client-side, deterministic"). The thin I/O helpers below are the only
 * impure part and go through the ETag-caching client (client.ts sends
 * If-None-Match and re-serves on 304 — the contract's rate-limit seam).
 * ------------------------------------------------------------------------- */

export type RunDisplayState = 'queued' | 'in progress' | 'complete' | 'action required' | 'stalled' | 'lost';

/** Only the step timestamps the stall derivation reads (jobs payload, FR-015). */
export interface RunStep {
  started_at?: string | null;
  completed_at?: string | null;
}

export interface RunJob {
  id: number;
  name: string;
  status: string;
  conclusion: string | null;
  steps: RunStep[];
}

export interface DisplayStateInput {
  /** the run as returned by the API, or null when its id no longer resolves */
  run: { status: string; conclusion: string | null } | null;
  /** an open plan/andon record still points at this run — the FR-015 lost trigger */
  referencedByOpen: boolean;
  /** the run's jobs; only steps[].started_at|completed_at are read (structural) */
  jobs: { steps: RunStep[] }[];
  /** current time as a PARAMETER (epoch ms or ISO) so the derivation is deterministic */
  now: number | string;
  /** stall window in minutes; caller supplies stallThresholdMinutes() */
  stallThresholdMin: number;
}

export interface ActionRequiredInput {
  /** the run's API conclusion */
  conclusion: string | null;
  /** an open issue label:andon:* is linked to the run */
  hasOpenAndon: boolean;
  /** a missing-data safe-output signal was found in the run's artifacts (FR-014) */
  hasMissingDataSignal: boolean;
}

function toMs(t: number | string): number {
  return typeof t === 'number' ? t : Date.parse(t);
}

/** Newest step activity across jobs (completed_at, else started_at); null when none. */
function latestStepActivityMs(jobs: { steps: RunStep[] }[]): number | null {
  let latest: number | null = null;
  for (const job of jobs) {
    for (const step of job.steps ?? []) {
      const stamp = step.completed_at ?? step.started_at;
      if (!stamp) continue;
      const ms = Date.parse(stamp);
      if (Number.isNaN(ms)) continue;
      if (latest === null || ms > latest) latest = ms;
    }
  }
  return latest;
}

/**
 * display_state (dashboard-github-api.md): the run's single monitor state.
 * Total for every real run; a null run is valid input only when
 * referencedByOpen (FR-015 lost) — see the guard below.
 */
export function displayState(input: DisplayStateInput): RunDisplayState {
  // FR-015: a null run is one whose id no longer resolves in the Actions list.
  // The contract scopes "lost" to absent AND still referenced by an open
  // plan/andon — referencedByOpen is that reference, and it is the only reason a
  // null run enters the monitored set (snapshot.ts builds the lost rows from the
  // referenced ids). An absent-AND-unreferenced run is not tracked at all and
  // has no defined monitor state, so classifying one is a caller error: fail
  // loud rather than silently mislabel it 'lost', keeping the AND-semantics
  // honest for the shared derivation the US9 portfolio rollup reuses.
  if (input.run === null) {
    if (input.referencedByOpen) return 'lost';
    throw new Error(
      'displayState: a null run must be referencedByOpen — an untracked absent run has no monitor state (FR-015)',
    );
  }

  if (input.run.status === 'completed') {
    // conclusion map: action_required → the unmissable state; every other
    // terminal conclusion (success, failure, cancelled…) is "complete". The
    // broader action_required() predicate carries the intervention signal.
    return input.run.conclusion === 'action_required' ? 'action required' : 'complete';
  }
  if (input.run.status === 'in_progress') {
    // FR-015 stall: no step timestamp newer than the threshold before `now`.
    // No step timestamps yet ⇒ no evidence of staleness ⇒ still "in progress".
    const latest = latestStepActivityMs(input.jobs);
    if (latest !== null && toMs(input.now) - latest > input.stallThresholdMin * 60_000) return 'stalled';
    return 'in progress';
  }
  if (input.run.status === 'queued') return 'queued';
  // Any other pre-terminal status the API may introduce is treated as live.
  return 'in progress';
}

/**
 * action_required (dashboard-github-api.md, FR-014): the run needs operator
 * intervention. The three signals are supplied by the caller — the andon-link
 * lookup and the artifact missing-data scan are I/O done elsewhere so this stays
 * pure. Renders as the constitution's unmissable
 * "Action Required: Operator Intervention Needed".
 */
export function actionRequired(input: ActionRequiredInput): boolean {
  return input.conclusion === 'action_required' || input.hasOpenAndon || input.hasMissingDataSignal;
}

/** Poll cadence: 10 s while any run is in_progress, else 30 s idle (contract). */
export const ACTIVE_POLL_MS = 10_000;
export const IDLE_POLL_MS = 30_000;

/** Next SWR refreshInterval — PURE so the cadence rule is testable in isolation. */
export function pollIntervalMs(runs: { status: string }[]): number {
  return runs.some((r) => r.status === 'in_progress') ? ACTIVE_POLL_MS : IDLE_POLL_MS;
}

/** Default stall window: > the longest expected step (research.md FR-015 note). */
export const DEFAULT_STALL_THRESHOLD_MIN = 15;

/**
 * STALL_THRESHOLD_MINUTES from the environment, default 15 (server.ts env-read
 * pattern). Exposed so the pure derivation receives it as a param and never
 * reads config itself. A non-positive or non-numeric value falls back to default.
 */
export function stallThresholdMinutes(): number {
  const raw = process.env.STALL_THRESHOLD_MINUTES;
  const n = raw === undefined ? Number.NaN : Number(raw);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_STALL_THRESHOLD_MIN;
}

/** Triggering event the monitor keys runs on — builds are workflow_dispatch. */
export const DEFAULT_RUN_EVENT = 'workflow_dispatch';

export function runMonitorEvent(): string {
  return process.env.RUN_MONITOR_EVENT ?? DEFAULT_RUN_EVENT;
}

export interface RunSummary {
  id: number;
  name: string | null;
  /** head_branch IS the plan ref plan/<slug>/v<N> — the job/session key (FR-013). */
  headBranch: string | null;
  status: string;
  conclusion: string | null;
}

/**
 * List the repo's workflow runs, keyed to the monitor's workflow event
 * (GET /actions/runs?event=…). head_branch is the plan-ref session key callers
 * group by. Paginated so a growing run history is never silently truncated.
 */
export async function listRuns(
  gh: Octokit,
  repo: RepoRef,
  opts: { event?: string; status?: 'queued' | 'in_progress' | 'completed' } = {},
): Promise<RunSummary[]> {
  const data = await gh.paginate(gh.actions.listWorkflowRunsForRepo, {
    ...repo,
    per_page: 100,
    ...(opts.event !== undefined ? { event: opts.event } : {}),
    ...(opts.status !== undefined ? { status: opts.status } : {}),
  });
  return data.map((run) => ({
    id: run.id,
    name: run.name ?? null,
    headBranch: run.head_branch ?? null,
    status: run.status ?? 'queued',
    conclusion: run.conclusion,
  }));
}

/**
 * A run's jobs + steps (GET /actions/runs/{run_id}/jobs), keyed by the run/session
 * id. Steps carry the started_at/completed_at the stall derivation reads (FR-015).
 */
export async function listRunJobs(gh: Octokit, repo: RepoRef, runId: number): Promise<RunJob[]> {
  const data = await gh.paginate(gh.actions.listJobsForWorkflowRun, { ...repo, run_id: runId, per_page: 100 });
  return data.map((job) => ({
    id: job.id,
    name: job.name,
    status: job.status,
    conclusion: job.conclusion,
    steps: (job.steps ?? []).map((s) => ({ started_at: s.started_at ?? null, completed_at: s.completed_at ?? null })),
  }));
}
