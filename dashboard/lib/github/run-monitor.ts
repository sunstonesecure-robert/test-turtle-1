import type { Octokit } from '@octokit/rest';
import type { RepoRef } from './client';
import {
  displayState,
  actionRequired,
  listRuns,
  listRunJobs,
  runMonitorEvent,
  stallThresholdMinutes,
  type RunDisplayState,
  type RunJob,
  type RunSummary,
} from './runs';
import { listRunArtifacts, fetchArtifactEntry, detectMissingDataSignal, isSafeOutputArtifact } from './artifacts';
import { slugFromPlanRef } from './plans';
import { parseAndonHeader } from './markers';
import { isLiveAndon, LIVE_ANDON_LABELS } from './labels';

/**
 * Server-side monitor snapshot (T070, FR-013…FR-015, SC-009).
 *
 * MOVED here from `app/runs/snapshot.ts` (GHI #143, 2026-08-23). It lived under
 * `app/` because the run monitor renders it, but `lib/github/portfolio.ts` depends
 * on it — and `install.ts` vendors `dashboard/lib` into every governed repo WITHOUT
 * `dashboard/app`, so that import was unresolvable in every target: `RunMonitorRow`
 * degraded to `any` and the vendored toolchain could not typecheck at all. A pure
 * module the library itself depends on belongs in the library; being rendered by a
 * page is not what decides where it lives. `tests/unit/vendored-toolchain.test.ts`
 * now fails on any `lib → app` import, so the next one cannot ship silently. This is the ONLY
 * impure layer of the run surface: it drives the clock and the I/O, then hands
 * `now` and the stall threshold as PARAMETERS to the seam's PURE displayState /
 * actionRequired derivations (dashboard-github-api.md "Derived state rules").
 * The page (initial render) and the /runs/monitor poll route BOTH build the
 * snapshot here, so the first paint and every SWR refresh share one derivation —
 * preview and logic cannot drift (checks-scope.ts precedent). GETs flow through
 * the ETag-caching client (client.ts If-None-Match/304), so repeated polls stay
 * inside the rate limit by construction.
 *
 * NO PULL-REQUEST READ HERE, AND THAT IS A DECISION RATHER THAN AN OMISSION
 * (2026-09-12, the answer to GHI #241: "one per page load — not per monitor").
 *
 * The question asked was whether a run card could name the deliverable its build
 * produced, the way a work-item row now does. Naming it needs the repository's
 * deliverable listing — `listDeliverablePrs`, a repo-wide paginated `pulls.list`
 * plus the repository-variable read behind each merge authority — and the answer
 * was NO, for a reason that is about this module specifically:
 *
 *   1. THIS SNAPSHOT POLLS. The monitor refreshes every 10 s while anything is
 *      running and every 30 s when nothing is (ACTIVE_POLL_MS / IDLE_POLL_MS), so a
 *      read added here is not a page-load cost that an operator pays once by opening
 *      a page deliberately — it recurs for as long as the tab is open. That is the
 *      distinction the answer drew, and it is why the plan review was granted the
 *      same read and this was not.
 *   2. GRANTING ONLY THE FIRST PAINT WOULD BE WORSE THAN GRANTING NOTHING. The page's
 *      initial server render and the /runs/monitor poll route build the SAME snapshot
 *      through this one function — that sharing is the point of the module. So a
 *      deliverable threaded in for the render alone would appear on first paint and
 *      vanish on the first poll ten seconds later, which reads as a deliverable that
 *      was withdrawn. A link that flickers is worse than a link that was never there.
 *
 * The clause "one per page load" is genuinely ambiguous about a monitor whose first
 * render IS a page load; the reading applied is the one above, because of (2). If the
 * operator meant the first paint to be included, the change is not a term added here
 * but a split between the render path and the poll path — and that split has to be
 * designed so the poll does not un-say what the render said. Until then a run card
 * links its run and its workload, never a deliverable, and the deliverable is named on
 * the work-item row of the workload card and of the plan review, where the read is
 * paid once per deliberate page load.
 */

/** Cap on runs enriched per poll — bounds the per-run jobs/artifacts I/O. Andon-referenced
 *  runs, already-`action_required` runs, and each branch's newest run are always included
 *  beyond the cap (see `buildRunMonitorSnapshot`), so the bound cannot hide a workload's
 *  current action-required state from the portfolio. */
const MAX_RUNS = 50;

export interface RunMonitorRow {
  /** stable React key: the run id, or `lost:<planRef>` for a vanished run */
  key: string;
  /** GitHub run id; null when the referenced run no longer resolves (FR-015 lost) */
  id: number | null;
  name: string | null;
  /** head_branch = plan/<slug>/v<N> — the job/session identifier (FR-013) */
  sessionKey: string | null;
  /** raw API status; drives the poll cadence. null for a lost run */
  status: string | null;
  conclusion: string | null;
  /** the seam's deterministic verdict */
  displayState: RunDisplayState;
  /** the seam's FR-014 predicate — renders as the unmissable banner when true */
  actionRequired: boolean;
  /** linked live Andon break (steer target + deep link); null when none */
  andonIssue: number | null;
  /** newest step activity ISO for an in-progress run — the stall context; null otherwise */
  lastActivity: string | null;
  /**
   * The workload this run belongs to, parsed from the session key by the one
   * sanctioned plan-ref parser. Null for a run that belongs to no workload — one
   * triggered on `main`, or a run GitHub reported with no branch.
   *
   * DERIVED HERE AND NOT IN THE CARD because `slugFromPlanRef` lives in the plan
   * module, which reaches Octokit and `Buffer`, and the card is a client component:
   * importing it there would either bloat the browser bundle or fail in it. Copying
   * the regex instead is what `plans.ts` says never to do — two parsers for one ref
   * grammar is how a gate and a view come to disagree about which workload a run
   * belongs to.
   */
  workloadSlug: string | null;
  /**
   * The job the run is inside right now, for the stall line to name and link; null
   * unless a job is running. The stall verdict is already measured from this job's
   * steps — `lastActivity` is its newest stamp — so "which job is it stuck in" was
   * a question this module answered and then dropped.
   */
  activeJob: { id: number; name: string } | null;
  /**
   * The run's own outputs reported that data it needed was missing (FR-014).
   *
   * TRUE ONLY WHEN THAT IS WHAT MADE THE ROW ACTION-REQUIRED: `enrichRun` does not
   * even look for the signal once a conclusion or an open plan review has already
   * answered the question, so a row carrying this is a row with no other reason. The
   * card can therefore say which of the three reasons applies without re-deriving
   * anything.
   */
  missingData: boolean;
}

export interface RunMonitorSnapshot {
  rows: RunMonitorRow[];
  /** STALL_THRESHOLD_MINUTES from the seam/env — the card reads it from here, never a literal */
  stallThresholdMin: number;
  /** when this snapshot was derived (the `now` fed to the derivation) */
  generatedAt: string;
}

/** Severity ordering: intervention first, then distinct failure states, then
 *  live, then terminal. Stable and total so the list never reshuffles between
 *  polls for equal-severity runs (tiebreak: newest id first). */
const STATE_RANK: Record<RunDisplayState, number> = {
  'action required': 0,
  lost: 1,
  stalled: 2,
  'in progress': 3,
  queued: 4,
  complete: 5,
};

function rowRank(row: RunMonitorRow): number {
  // An open Andon or missing-data signal makes a still-running run action-required;
  // float those to the top too, not just conclusion==='action_required' runs.
  return row.actionRequired ? 0 : STATE_RANK[row.displayState];
}

/** Live Andon breaks keyed by the plan ref in their andon:v1 header — the same
 *  plan/<slug>/v<N> key that IS a run's head_branch, so run.headBranch joins to
 *  its break (findLiveAndonsBySlug's dual-label pattern; labels is AND-semantic
 *  so open and under-review need separate reads). First (lowest) issue wins.
 *
 *  isLiveAndon filters what the LIST returns because the label query alone cannot
 *  answer the question: a terminal closure adds its terminal label first and drops
 *  the live one after, so a break whose teardown failed in between still answers to
 *  `labels=andon:under-review`. This index is what the portfolio calls "a proposed
 *  plan is waiting on your judgment" and what makes a vanished run `lost` — both
 *  fired for a WITHDRAWN review on the live dashboard (2026-08-17, demo5 / #25),
 *  contradicting the break's own page. */
async function openAndonsByPlanRef(gh: Octokit, repo: RepoRef): Promise<Map<string, number>> {
  const pages = await Promise.all(
    LIVE_ANDON_LABELS.map((label) =>
      gh.paginate(gh.issues.listForRepo, { ...repo, labels: label, state: 'open', per_page: 100 }),
    ),
  );
  const byRef = new Map<string, number>();
  for (const issue of pages.flat().sort((a, b) => a.number - b.number)) {
    const header = parseAndonHeader(issue.body ?? '');
    const labels = (issue.labels ?? []).map((l) => (typeof l === 'string' ? l : (l.name ?? '')));
    if (header && isLiveAndon(labels) && !byRef.has(header.planRef)) byRef.set(header.planRef, issue.number);
  }
  return byRef;
}

/** Missing-data safe-output signal in a run's artifacts (FR-014). Best-effort:
 *  an artifact I/O failure is rendered as "no signal this poll" — the monitor
 *  degrades to data, it never crashes on an untrusted or unreachable payload. */
async function hasMissingDataSignal(gh: Octokit, repo: RepoRef, runId: number): Promise<boolean> {
  try {
    for (const artifact of await listRunArtifacts(gh, repo, runId)) {
      if (artifact.expired) continue; // an expired artifact has no downloadable body
      // Only safe-output artifacts can carry the signal — the multi-hundred-KB
      // agent/activation bundles never do, and downloading + decoding them per
      // run per cold poll was both the rate-limit burn and the render-path
      // megabyte feed behind the live /runs 500 (2026-08-16).
      if (!isSafeOutputArtifact(artifact)) continue;
      if (detectMissingDataSignal(await fetchArtifactEntry(gh, repo, artifact.id))) return true;
    }
  } catch {
    /* untrusted / unreachable artifact — no signal detected, monitor stays up */
  }
  return false;
}

// A COMPLETED run is immutable, so its missing-data verdict never changes.
// Without this, every 10–30 s poll re-lists and re-downloads the artifact ZIP
// for each of up to MAX_RUNS completed runs — ~2 API calls + a full download
// per run per poll, which exhausts the GitHub rate limit within minutes
// (PR #56 review). Cache the verdict for completed runs only; in_progress /
// queued runs can still gain artifacts, so they are never cached. Bounded with
// FIFO eviction (Map preserves insertion order) so a long-lived server process
// cannot grow the map without limit — stale completed runs age out of the
// MAX_RUNS window and are simply never queried again.
const COMPLETED_MISSING_DATA = new Map<number, boolean>();
const MISSING_DATA_CACHE_CAP = 500;

function rememberCompletedMissingData(runId: number, value: boolean): void {
  if (COMPLETED_MISSING_DATA.size >= MISSING_DATA_CACHE_CAP) {
    const oldest = COMPLETED_MISSING_DATA.keys().next().value;
    if (oldest !== undefined) COMPLETED_MISSING_DATA.delete(oldest);
  }
  COMPLETED_MISSING_DATA.set(runId, value);
}

/** Missing-data verdict, served from the completed-run cache when available so
 *  an immutable run's artifact is downloaded at most once (PR #56 review). */
async function resolveMissingData(gh: Octokit, repo: RepoRef, run: RunSummary): Promise<boolean> {
  const isCompleted = run.status === 'completed';
  if (isCompleted) {
    const cached = COMPLETED_MISSING_DATA.get(run.id);
    if (cached !== undefined) return cached;
  }
  const value = await hasMissingDataSignal(gh, repo, run.id);
  if (isCompleted) rememberCompletedMissingData(run.id, value);
  return value;
}

/** Newest completed_at||started_at across a run's jobs, as ISO; null when none. */
function latestActivityIso(jobs: { steps: { started_at?: string | null; completed_at?: string | null }[] }[]): string | null {
  let latest: number | null = null;
  let iso: string | null = null;
  for (const job of jobs) {
    for (const step of job.steps) {
      const stamp = step.completed_at ?? step.started_at;
      if (!stamp) continue;
      const ms = Date.parse(stamp);
      if (Number.isNaN(ms)) continue;
      if (latest === null || ms > latest) {
        latest = ms;
        iso = stamp;
      }
    }
  }
  return iso;
}

/**
 * The in-progress job the stall clock is actually measured from.
 *
 * `latestActivityIso` reduces every job's steps to one timestamp and the stall
 * verdict is that timestamp against the threshold, so the job holding the newest
 * stamp is the job the stall line is about — picking any other one would name a job
 * the number underneath it does not describe. Ties keep the API's order, which is
 * execution order. Null when nothing is running, which includes every completed run:
 * its jobs are never read at all.
 */
function activeJobOf(jobs: readonly RunJob[]): { id: number; name: string } | null {
  let best: RunJob | null = null;
  let bestMs = -1;
  for (const job of jobs) {
    if (job.status !== 'in_progress') continue;
    const iso = latestActivityIso([job]);
    const ms = iso === null ? Number.NaN : Date.parse(iso);
    const score = Number.isNaN(ms) ? -1 : ms;
    if (best === null || score > bestMs) {
      best = job;
      bestMs = score;
    }
  }
  return best === null ? null : { id: best.id, name: best.name };
}

async function enrichRun(
  gh: Octokit,
  repo: RepoRef,
  run: RunSummary,
  now: number,
  stallThresholdMin: number,
  andonByRef: Map<string, number>,
): Promise<RunMonitorRow> {
  const andonIssue = run.headBranch ? (andonByRef.get(run.headBranch) ?? null) : null;
  const hasOpenAndon = andonIssue !== null;
  // Jobs (for the stall rule) matter only while in_progress; skip the read otherwise.
  const jobs = run.status === 'in_progress' ? await listRunJobs(gh, repo, run.id) : [];
  // Short-circuit the artifact download when the run is already action-required
  // by a cheaper signal (conclusion or an open Andon); otherwise resolve the
  // missing-data verdict through the completed-run cache so an immutable run's
  // artifact is fetched at most once across polls (PR #56 review) — bounds the
  // poll's I/O.
  const missingData =
    run.conclusion === 'action_required' || hasOpenAndon ? false : await resolveMissingData(gh, repo, run);
  const state = displayState({
    run: { status: run.status, conclusion: run.conclusion },
    referencedByOpen: hasOpenAndon,
    jobs,
    now,
    stallThresholdMin,
  });
  const ar = actionRequired({ conclusion: run.conclusion, hasOpenAndon, hasMissingDataSignal: missingData });
  return {
    key: String(run.id),
    id: run.id,
    name: run.name,
    sessionKey: run.headBranch,
    status: run.status,
    conclusion: run.conclusion,
    displayState: state,
    actionRequired: ar,
    andonIssue,
    lastActivity: run.status === 'in_progress' ? latestActivityIso(jobs) : null,
    workloadSlug: slugFromPlanRef(run.headBranch),
    activeJob: activeJobOf(jobs),
    missingData,
  };
}

export async function buildRunMonitorSnapshot(gh: Octokit, repo: RepoRef): Promise<RunMonitorSnapshot> {
  const now = Date.now();
  const stallThresholdMin = stallThresholdMinutes();
  const [runs, andonByRef] = await Promise.all([
    listRuns(gh, repo, { event: runMonitorEvent() }),
    openAndonsByPlanRef(gh, repo),
  ]);

  // The full run set is the "found" universe for the lost check; the display set
  // is the newest MAX_RUNS plus any run an open Andon still references beyond it.
  const foundBranches = new Set(runs.map((r) => r.headBranch).filter((b): b is string => b !== null));
  const referencedRefs = new Set(andonByRef.keys());
  const capped = runs.slice(0, MAX_RUNS);
  const cappedIds = new Set(capped.map((r) => r.id));
  // The cap is by RECENCY (the API's order), applied before severity sorting, so "newest 50"
  // is not "the 50 that matter". Three inclusions rescue what the bound would otherwise hide
  // — the portfolio consumes this same snapshot, and FR-045/SC-015 promise EVERY workload's
  // action-required state, not every workload in the newest 50 runs:
  //   1. runs an open Andon references (they need attention by definition);
  //   2. runs already concluded `action_required` — free to spot, it is on the list response;
  //   3. each branch's newest run, so every workload contributes its CURRENT run and the
  //      enrichment-only signals (stalled, missing-data) are derived for it.
  // (3) bounds the extra enrichment by branch count, not run count. Residual, accepted: an
  // OLDER run of a workload that already has a newer one can still stall unseen — the newest
  // run is that workload's current state, and the monitor page remains the per-run view.
  const newestByBranch = new Map<string, number>();
  for (const r of runs) {
    if (r.headBranch !== null && !newestByBranch.has(r.headBranch)) newestByBranch.set(r.headBranch, r.id);
  }
  const beyondCap = runs.filter(
    (r) =>
      !cappedIds.has(r.id) &&
      ((r.headBranch !== null && referencedRefs.has(r.headBranch)) ||
        r.conclusion === 'action_required' ||
        (r.headBranch !== null && newestByBranch.get(r.headBranch) === r.id)),
  );

  // Failure isolation: one run's enrichment blowing up must degrade THAT row,
  // never 500 the whole monitor (live /runs render crash, 2026-08-16 — the
  // page went down for every run because one enrichment path threw). The
  // degraded row keeps the raw status/conclusion derivation, the Andon linkage
  // and the workload the session key names (all already in hand — no I/O), and
  // loses only the enrichment-borne signals (stall, the running job, the
  // missing-data verdict) — each of which the card reads as "not observed", never
  // as "not happening". The cause is logged WITH its stack so the next occurrence
  // is diagnosable instead of a bare RangeError.
  const found = await Promise.all(
    [...capped, ...beyondCap].map(async (run) => {
      try {
        return await enrichRun(gh, repo, run, now, stallThresholdMin, andonByRef);
      } catch (error: unknown) {
        console.error(`run monitor: enrichment failed for run ${run.id} (degraded row served)`, error);
        const andonIssue = run.headBranch ? (andonByRef.get(run.headBranch) ?? null) : null;
        return {
          key: String(run.id),
          id: run.id,
          name: run.name,
          sessionKey: run.headBranch,
          status: run.status,
          conclusion: run.conclusion,
          displayState: displayState({
            run: { status: run.status, conclusion: run.conclusion },
            referencedByOpen: andonIssue !== null,
            jobs: [],
            now,
            stallThresholdMin,
          }),
          actionRequired: actionRequired({
            conclusion: run.conclusion,
            hasOpenAndon: andonIssue !== null,
            hasMissingDataSignal: false,
          }),
          andonIssue,
          lastActivity: null,
          workloadSlug: slugFromPlanRef(run.headBranch),
          activeJob: null,
          missingData: false,
        } satisfies RunMonitorRow;
      }
    }),
  );

  // FR-015 lost: an open plan/andon points at a run that no longer resolves.
  // The monitor surfaces it as a distinct row rather than dropping it silently
  // (constitution: absent ≠ success). displayState(null, referencedByOpen) → 'lost'.
  const lost: RunMonitorRow[] = [...referencedRefs]
    .filter((ref) => !foundBranches.has(ref))
    .map((ref) => ({
      key: `lost:${ref}`,
      id: null,
      name: null,
      sessionKey: ref,
      status: null,
      conclusion: null,
      displayState: displayState({ run: null, referencedByOpen: true, jobs: [], now, stallThresholdMin }),
      actionRequired: actionRequired({ conclusion: null, hasOpenAndon: true, hasMissingDataSignal: false }),
      andonIssue: andonByRef.get(ref) ?? null,
      lastActivity: null,
      // The session key is the ONLY thing a lost row still knows, and it is enough
      // to name the workload — which is what makes the card offer a destination at
      // all when the run itself has none.
      workloadSlug: slugFromPlanRef(ref),
      activeJob: null,
      missingData: false,
    }));

  const rows = [...found, ...lost].sort(
    (a, b) => rowRank(a) - rowRank(b) || (b.id ?? -1) - (a.id ?? -1) || (a.sessionKey ?? '').localeCompare(b.sessionKey ?? ''),
  );

  return { rows, stallThresholdMin, generatedAt: new Date(now).toISOString() };
}
