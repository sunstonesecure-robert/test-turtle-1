import type { Octokit } from '@octokit/rest';
import type { RepoRef } from './client';
import { errorStatus } from './errors';
// CONFLICT_LABEL is the same constant xlinks.ts propagates — this view READS BACK what
// that module writes, so both take the name from the taxonomy rather than spelling it.
import { CONFLICT_LABEL, type WorkloadState } from './labels';
import { parseAndonHeader, parseCorrectionMarker } from './markers';
// slugFromPlanRef is the inverse of planBranch and lives beside it: a run row, an Andon
// header and the build gate must all resolve a ref to the SAME workload (FR-044/FR-046).
import { resolveCurrent, slugFromPlanRef, tryReadPlanAtRef } from './plans';
import { listWorkloads, type Workload } from './workloads';
import { mergeRecheck } from './read-after-write';
import { listXLinks } from './xlinks';
import { buildRunMonitorSnapshot, type RunMonitorRow } from './run-monitor';
import { listDeliverablePrs } from './builds';
// The gate functions' own verdict on whether a workload's official plan could pass
// preflight today (GHI #109) — reused, never re-derived, so a plan this view calls
// unbuildable is one the build actually refuses.
import { scanBuildability } from '../../../scripts/gates/lib/buildability';

/**
 * Portfolio rollup (T147, FR-045/FR-046, SC-015): every NON-ARCHIVED workload's
 * lifecycle state plus a per-workload action-required verdict, so an operator running
 * three or more workloads in parallel sees what needs them in ONE view.
 *
 * Deterministic-First split, mirroring runs.ts / snapshot.ts: `portfolioRollup` is PURE
 * — signals in, rows out, no I/O and no clock — and `loadPortfolio` is the only impure
 * layer. That is what makes the whole "is this workload asking for me?" policy testable
 * as a function.
 *
 * The run signal is NOT re-derived here. `loadPortfolio` builds the US3 monitor snapshot
 * (buildRunMonitorSnapshot) and attributes its rows to slugs by their plan ref, so the
 * portfolio's "this run needs you" is byte-for-byte the monitor's displayState /
 * actionRequired verdict. A second implementation over the same raw API fields is exactly
 * the drift the one-derivation rule forbids (checks-scope.ts precedent) — the operator
 * must never see a run called action-required on /runs and healthy on /workloads. The
 * import direction (lib → app/runs) is deliberate for that reason; snapshot.ts is plain
 * TypeScript with no React and no next/* imports, so nothing UI-shaped comes with it.
 *
 * There is no `now` parameter: time enters this rollup ONLY through run rows whose
 * verdicts were already derived, and the clock is driven exactly once, inside
 * buildRunMonitorSnapshot. Adding a second `now` here would let the portfolio's stall
 * boundary disagree with the monitor's for the same run.
 *
 * FR-046 (one workload's pause must never block another) is structural: every signal
 * below is attributed to a slug BEFORE the rollup sees it, and a row is built from
 * `record.slug === w.slug` records and nothing else. No cross-workload read exists to go
 * wrong — one workload's Andon break, correction, conflict, or stalled run can neither
 * appear in nor gate another workload's row.
 */

export interface PortfolioRow {
  slug: string;
  /** the workload issue's number — posted back by the lifecycle forms so the gate
   *  can resolve through the read-after-write-consistent single-issue GET rather
   *  than the lagging list (PR #123 bot review) */
  issueNumber: number;
  title: string;
  /** null = the issue does not carry exactly one workload:* label (SC-011 violation) */
  state: WorkloadState | null;
  /** true when anything below wants the operator — renders as the unmissable banner */
  actionRequired: boolean;
  /** human-readable, actionable text; this IS what renders, so "open Andon break #12"
   *  rather than "andon". Empty exactly when actionRequired is false. */
  reasons: string[];
  /**
   * WHERE the operator acts on this row — the most specific in-app destination,
   * null when no single one exists.
   *
   * Structured rather than parsed back out of `reasons`: the reason text names
   * a record ("open Andon break #12") and the view was left to render that as
   * prose, so an action-required portfolio told the operator what needed them
   * and gave them nothing to click (live finding, 2026-08-16). Deriving the
   * href here — where the issue numbers are already in hand — keeps the view
   * from re-parsing English to rebuild a number the rollup threw away.
   *
   * Most specific wins: a live plan review is a place to judge, a run is only a
   * place to watch, so the review is preferred when both apply.
   */
  actionHref: string | null;
}

/**
 * Everything the verdict is a function of. Signals arrive as FLAT slug-tagged records
 * (conflictFlagTargets' shape, not pre-grouped maps): the loader knows how to attribute
 * a record to a slug, the pure rollup owns the grouping, the deduping and the policy.
 */
export interface PortfolioInput {
  /** every workload, archived included — dropping them is part of the FR-045 verdict */
  workloads: Workload[];
  /** live Andon breaks (open or under-review), attributed by their plan ref */
  andons: { slug: string; issueNumber: number }[];
  /** open corrections, attributed through their parent break's plan ref */
  corrections: { slug: string; issueNumber: number; itemId: string }[];
  /** issues carrying conflict:open, attributed to the workload that owns the issue */
  conflicts: { slug: string; issueNumber: number }[];
  /** US3 monitor rows, attributed by sessionKey (= head_branch = the plan ref) */
  runs: { slug: string; row: RunMonitorRow }[];
  /**
   * Workloads whose OFFICIAL plan cannot pass today's structural preflight
   * (GHI #109) — one entry per workload, carrying every cause.
   *
   * An unbuildable official plan is exactly as blocking as a stalled run or an
   * open conflict, and until this existed it was the only one of the three that
   * nothing anywhere reported: the operator found out by dispatching a build and
   * reading a failed Actions run, while this very view called the workload healthy.
   */
  unbuildable: { slug: string; reasons: string[]; andonIssue: number | null }[];
  /** Deliverable pull requests awaiting the OPERATOR'S OWN merge (US18, FR-064).
   *  Only the operator-required ones: a pre-authorized PR waiting on the
   *  deterministic merger is in progress, not blocked on a human, and flagging it
   *  would teach the operator that action-required sometimes means "wait". */
  deliverables?: { slug: string; prNumber: number; url: string; stepId: string }[];
}

/** One slug's issue-shaped signals, deduped by issue number and issue-ordered. Deduping
 *  is the rollup's job because the loader's sources legitimately repeat: several runs
 *  share one plan ref, so the same live Andon break arrives once per run row. */
function forSlug<T extends { slug: string; issueNumber: number }>(records: T[], slug: string): T[] {
  const byIssue = new Map<number, T>();
  for (const record of records) {
    if (record.slug === slug) byIssue.set(record.issueNumber, record);
  }
  return [...byIssue.values()].sort((a, b) => a.issueNumber - b.issueNumber);
}

/** One slug's run rows, deduped by the monitor's own stable key, newest run first —
 *  snapshot.ts's tiebreak, so the two views order one workload's runs identically. */
function runsForSlug(records: { slug: string; row: RunMonitorRow }[], slug: string): RunMonitorRow[] {
  const byKey = new Map<string, RunMonitorRow>();
  for (const record of records) {
    if (record.slug === slug) byKey.set(record.row.key, record.row);
  }
  return [...byKey.values()].sort((a, b) => (b.id ?? -1) - (a.id ?? -1) || a.key.localeCompare(b.key));
}

/**
 * The run half of the verdict: the US3 row is a reason when its derivation says
 * action-required OR stalled. Everything else — queued, in progress, complete — is work
 * proceeding, and listing it would bury the rows that need the operator (SC-015 is about
 * seeing action-required at a glance, not about seeing everything).
 *
 * One reason per run, most specific state first: `lost` and `stalled` say WHY far better
 * than "needs intervention", and a run that is action-required *because* of an open Andon
 * break already contributes that break's own reason.
 */
function runReason(row: RunMonitorRow): string | null {
  if (!row.actionRequired && row.displayState !== 'stalled') return null;
  const which = row.id !== null ? `run #${row.id}` : 'run';
  const where = row.sessionKey ?? '(no plan ref)';
  switch (row.displayState) {
    case 'lost':
      return `${which} for ${where} is lost — an open record still points at a run that no longer resolves`;
    case 'stalled':
      return `${which} for ${where} is stalled — no step activity inside the stall window`;
    default:
      return `${which} for ${where} needs operator intervention (${row.displayState})`;
  }
}

/**
 * PURE verdict: one row per non-archived workload, with every reason it wants the
 * operator (FR-045). Reason groups run human-gate first (an Andon break is the operator's
 * own queue), then the agent round-trip, then cross-workload conflicts, then runs.
 */
export function portfolioRollup(input: PortfolioInput): PortfolioRow[] {
  const rows = input.workloads
    // FR-045 scopes the portfolio to NON-ARCHIVED workloads: archival is precisely the
    // point at which a workload leaves the active views and becomes a retained record
    // (FR-043 — its issue is closed AND locked). A null state is NOT filtered: it is an
    // SC-011 contract violation, and hiding a broken workload is how it stays broken.
    .filter((w) => w.state !== 'archived')
    .map((w) => {
      const reasons: string[] = [];
      const issueNumber = w.issueNumber;

      if (w.state === null) {
        reasons.push(
          `workload issue #${w.issueNumber} does not carry exactly one workload:* label — its lifecycle state is unreadable until the labels are fixed`,
        );
      }
      const liveBreaks = forSlug(input.andons, w.slug);
      for (const andon of liveBreaks) {
        reasons.push(`open Andon break #${andon.issueNumber} — a proposed plan is waiting on your judgment`);
      }
      for (const correction of forSlug(input.corrections, w.slug)) {
        reasons.push(
          `open correction #${correction.issueNumber} on item ${correction.itemId} — waiting on the agent's revision`,
        );
      }
      for (const conflict of forSlug(input.conflicts, w.slug)) {
        // "affected item", not "plan step": the flagged issue is whatever the link's item
        // refs name (issue-tracker-contract.md's own wording for them), and a mirrored
        // conflicts-with link names the work items of BOTH ends.
        reasons.push(
          conflict.issueNumber === w.issueNumber
            ? `${CONFLICT_LABEL} on this workload's issue #${conflict.issueNumber} — an unresolved cross-workload conflict`
            : `${CONFLICT_LABEL} on affected item #${conflict.issueNumber} — an unresolved cross-workload conflict`,
        );
      }
      // Before the run signals: a plan that cannot be built at all is upstream of
      // every run reason below it — there will never BE a run to stall.
      const unbuildable = input.unbuildable.filter((u) => u.slug === w.slug);
      for (const reason of unbuildable.flatMap((u) => u.reasons)) {
        reasons.push(reason);
      }
      // A deliverable waiting on the operator's own merge (FR-064). Placed AFTER the
      // buildability reasons and BEFORE the run signals, which is where it belongs in
      // the arc: the plan built fine, so nothing upstream is broken, and the run that
      // produced it has already finished — what is left is a decision only the
      // operator can make.
      let deliverableAwaitingOperator: number | null = null;
      for (const d of (input.deliverables ?? []).filter((x) => x.slug === w.slug)) {
        reasons.push(
          `deliverable pull request #${d.prNumber} for ${d.stepId} is waiting on YOUR merge — this step needs an ` +
            'operator checkpoint (a configured checkpoint, or an external authority\'s confirmation the merge cannot ' +
            'be pre-authorized past)',
        );
        deliverableAwaitingOperator ??= d.prNumber;
      }
      let runNeedsOperator = false;
      for (const row of runsForSlug(input.runs, w.slug)) {
        const reason = runReason(row);
        if (reason !== null) {
          reasons.push(reason);
          runNeedsOperator = true;
        }
      }

      // WHERE the operator acts, most specific first. A live break is where a
      // judgment is MADE; an unbuildable plan is repaired by re-opening it, which
      // is offered on the review that approved it; a run is only somewhere to
      // watch. A row with none of those has no single destination and says null —
      // the view must then not invent one, which is the defect this ordering was
      // extended to fix: the buildability reason (GHI #109) arrived with no
      // destination, and the card rendered a button to the Inbox, where nothing
      // was waiting (live finding, 2026-08-18 — demo2).
      const unbuildableReview = unbuildable.find((u) => u.andonIssue !== null)?.andonIssue ?? null;
      const actionHref =
        liveBreaks.length > 0
          ? `/andon/${liveBreaks[0]!.issueNumber}`
          : unbuildableReview !== null
            ? `/andon/${unbuildableReview}`
            : // A deliverable awaiting the operator's merge has a REAL destination and
              // ranks above a run: the run is somewhere to watch, the pull request is
              // somewhere to act. Sending them to /runs instead — which is what an
              // un-extended ordering would do — is the GHI #109 defect repeated, a
              // button to a page where nothing is waiting.
              deliverableAwaitingOperator !== null
              ? '/builds'
              : runNeedsOperator
                ? '/runs'
                : null;

      return {
        slug: w.slug,
        issueNumber,
        title: w.title,
        state: w.state,
        actionRequired: reasons.length > 0,
        reasons,
        actionHref,
      };
    });

  // Severity first (snapshot.ts's rowRank precedent — what needs the operator floats to
  // the top), then slug: a total, stable order, so the portfolio never reshuffles between
  // renders and a workload keeps its place while nothing about it changed.
  return rows.sort((a, b) => Number(b.actionRequired) - Number(a.actionRequired) || a.slug.localeCompare(b.slug));
}

/* ------------------------------------------------------------------------- *
 * Loader — the only impure layer: it drives the I/O and the attribution, then
 * hands flat slug-tagged signals to the pure rollup above.
 * ------------------------------------------------------------------------- */

/** Every issue carrying conflict:open. `state:'all'` and the PR filter for the same two
 *  reasons propagateConflictFlags uses them: a step issue can be CLOSED while still
 *  flagged (records are never deleted, FR-042), and the issues endpoint answers with PRs
 *  too. Ascending and deduped so the rollup's reason order is deterministic.
 *
 *  `recheck` matters MORE here than on any other list, and in the opposite direction
 *  (GHI #122). This is a membership set, and `propagateConflictFlags` both adds the
 *  label and removes it — so a lagging list makes the portfolio OVER-report: it keeps
 *  asserting a cross-workload conflict the operator just resolved, Action Required chip
 *  and all, and the natural response is to resolve an already-resolved record. Every
 *  other instance of the list-lag bug under-reports. Removal is why `mergeRecheck`
 *  needed an `'absent'` verdict at all. */
async function listConflictFlagged(gh: Octokit, repo: RepoRef, recheck?: number[]): Promise<number[]> {
  const issues = await gh.paginate(gh.issues.listForRepo, { ...repo, labels: CONFLICT_LABEL, state: 'all', per_page: 100 });
  const listed = [...new Set(issues.filter((issue) => !issue.pull_request).map((issue) => issue.number))];
  const merged = await mergeRecheck(
    listed,
    recheck,
    async (issueNumber) => {
      const { data: issue } = await gh.issues.get({ ...repo, issue_number: issueNumber });
      // A PR number is not a flaggable record — declined, never removed.
      if (issue.pull_request) return null;
      const labels = (issue.labels ?? []).map((l) => (typeof l === 'string' ? l : (l.name ?? '')));
      return labels.includes(CONFLICT_LABEL) ? { item: issueNumber } : 'absent';
    },
    (issueNumber) => issueNumber,
  );
  return merged.sort((a, b) => a - b);
}

/** The tracking issues of a workload's OFFICIAL (frozen) plan steps — the same
 *  resolveCurrent → plan.steps[].tracking_issue path the deferral contradiction scan
 *  walks (evidence.ts). Nothing frozen yet means the workload owns no step issues, and
 *  an unreadable plan contributes nothing rather than throwing: an unparseable plan is
 *  the plan gate's business, and it must not blank the whole portfolio. */
async function officialStepIssues(gh: Octokit, repo: RepoRef, slug: string): Promise<number[]> {
  const current = await resolveCurrent(gh, repo, slug);
  if (current === null) return [];
  const { plan } = await tryReadPlanAtRef(gh, repo, current);
  if (!plan) return [];
  return [...new Set(plan.steps.map((s) => s.tracking_issue).filter((n): n is number => typeof n === 'number'))];
}

/**
 * Attribute each conflict:open label to every workload the flagged issue belongs to. A
 * workload's issues are its OWN issue, its official plan's step tracking issues, and the
 * items its own `xlink:v1` records name — the last of those because FR-047's item refs are
 * the operator's own statement of what a link affects, and because `tracking_issue` is
 * null on every plan the current pipeline writes (the chunk-issue writer lands with a
 * later story), so plan steps alone would place nothing today.
 *
 * Attribution is deliberately NOT exclusive: a `conflicts-with` link mirrors ONE item set
 * onto both ends, and FR-047 says the affected items are flagged "in BOTH workloads" — so
 * one flagged item legitimately appears on both rows, and making ownership exclusive would
 * hide the conflict from whichever row lost the race. This is not an FR-046 leak: each
 * row's item set comes from THAT workload's own issue and its own link records; no
 * workload reads another's state.
 *
 * Reads the LABEL rather than deriving purely from open links, deliberately: the label is
 * what actually marks the work item, so a propagation that half-landed — or a resolution
 * whose flag-clearing crashed — still surfaces here. That is the fail-safe direction: an
 * operator told "no conflicts" while a flag sits on live work is the FR-047 failure that
 * matters, because work proceeds as though the dispute were settled.
 *
 * Skips the per-workload reads entirely when nothing is flagged, exactly as
 * propagateConflictFlags skips its label scan on an empty jurisdiction.
 */
async function attributeConflicts(
  gh: Octokit,
  repo: RepoRef,
  active: Workload[],
  flagged: number[],
): Promise<{ slug: string; issueNumber: number }[]> {
  if (flagged.length === 0) return [];
  const isFlagged = new Set(flagged);
  // Independent per-workload reads — concurrent; each touches only its own workload's
  // refs, plan and issue timeline (FR-046).
  const perWorkload = await Promise.all(
    active.map(async (workload) => {
      const [steps, links] = await Promise.all([
        officialStepIssues(gh, repo, workload.slug),
        listXLinks(gh, repo, workload.slug),
      ]);
      const owned = new Set<number>([workload.issueNumber, ...steps, ...links.flatMap((link) => link.items)]);
      return [...owned]
        .filter((issueNumber) => isFlagged.has(issueNumber))
        .sort((a, b) => a - b)
        .map((issueNumber) => ({ slug: workload.slug, issueNumber }));
    }),
  );
  return perWorkload.flat();
}

/** The slug of an Andon break resolved by a single GET — read-after-write consistent and
 *  used only for breaks the monitor's live index does not know about (see
 *  attributeCorrections). A break that no longer resolves attributes nothing. */
async function slugOfAndon(gh: Octokit, repo: RepoRef, issueNumber: number): Promise<string | null> {
  try {
    const { data: issue } = await gh.issues.get({ ...repo, issue_number: issueNumber });
    return slugFromPlanRef(parseAndonHeader(issue.body ?? '')?.planRef);
  } catch (error: unknown) {
    if (errorStatus(error) === 404) return null;
    throw error;
  }
}

/**
 * Attribute every open correction to a slug through its parent break's plan ref.
 *
 * `slugByAndon` is the monitor snapshot's live-break index, which covers the normal case
 * by construction: a correction:open cannot outlive its break (withdrawOpenCorrections
 * cascades on every unapproved closure), so its parent is live. The fallback GET exists
 * for the abnormal one — a cascade that crashed mid-way strands a correction:open whose
 * break is already closed, and that correction blocks plan-gate G7 forever. Dropping it
 * silently is precisely the invisible blocker the portfolio exists to surface, and the
 * cost is one GET per distinct orphan (normally zero).
 */
async function attributeCorrections(
  gh: Octokit,
  repo: RepoRef,
  slugByAndon: Map<number, string>,
): Promise<{ slug: string; issueNumber: number; itemId: string }[]> {
  const issues = await gh.paginate(gh.issues.listForRepo, { ...repo, labels: 'correction:open', state: 'open', per_page: 100 });
  // The correction:v1 marker is the authoritative linkage (never a substring of the body:
  // andon:12 must not match andon:123) — an issue without one is not a correction.
  const parsed = issues
    .map((issue) => ({ issueNumber: issue.number, marker: parseCorrectionMarker(issue.body ?? '') }))
    .filter((c): c is { issueNumber: number; marker: { andonIssue: number; itemId: string } } => c.marker !== null);

  const resolved = new Map(slugByAndon); // never mutate the caller's index
  const unknown = [...new Set(parsed.map((c) => c.marker.andonIssue))].filter((n) => !resolved.has(n)).sort((a, b) => a - b);
  for (const andonIssue of unknown) {
    const slug = await slugOfAndon(gh, repo, andonIssue);
    if (slug !== null) resolved.set(andonIssue, slug);
  }

  const attributed: { slug: string; issueNumber: number; itemId: string }[] = [];
  for (const correction of parsed) {
    const slug = resolved.get(correction.marker.andonIssue);
    if (slug !== undefined) attributed.push({ slug, issueNumber: correction.issueNumber, itemId: correction.marker.itemId });
  }
  return attributed;
}

/**
 * Assemble the portfolio (FR-045, SC-015). The Andon and run signals both come out of the
 * ONE monitor snapshot: every live break's plan ref is in it by construction — a
 * referenced ref either matches a run row or becomes an FR-015 `lost` row — so the
 * portfolio's "open Andon break" set is the monitor's live-break index, at no extra read
 * and with no second query to drift from it.
 */
export async function loadPortfolio(
  gh: Octokit,
  repo: RepoRef,
  opts: { recheck?: number[] } = {},
): Promise<PortfolioRow[]> {
  const [workloads, snapshot, flagged] = await Promise.all([
    listWorkloads(gh, repo, { ...(opts.recheck ? { recheck: opts.recheck } : {}) }),
    buildRunMonitorSnapshot(gh, repo),
    listConflictFlagged(gh, repo, opts.recheck),
  ]);

  const runs: PortfolioInput['runs'] = [];
  const andons: PortfolioInput['andons'] = [];
  const slugByAndon = new Map<number, string>();
  for (const row of snapshot.rows) {
    const slug = slugFromPlanRef(row.sessionKey);
    if (slug === null) continue; // not a workload plan ref — belongs to no workload
    runs.push({ slug, row });
    if (row.andonIssue !== null) {
      andons.push({ slug, issueNumber: row.andonIssue });
      slugByAndon.set(row.andonIssue, slug);
    }
  }

  // The conflict attribution reads only NON-archived workloads' plans: an archived
  // workload owns no row, so resolving its steps would buy nothing (FR-045).
  const active = workloads.filter((w) => w.state !== 'archived');
  const [corrections, conflicts, buildability, deliverables] = await Promise.all([
    attributeCorrections(gh, repo, slugByAndon),
    attributeConflicts(gh, repo, active, flagged),
    // Scoped to `active` for the same reason (GHI #109): a deferred or completed
    // workload is not about to dispatch a build, so telling its operator that its
    // plan would be refused is a banner about nothing. It becomes true and visible
    // again the moment the workload is reactivated.
    scanBuildability(
      gh,
      repo,
      active.filter((w) => w.state === 'active').map((w) => w.slug),
    ),
    // THE DELIVERABLES THE ROLLUP NEEDS (Codex on PR #145, 2026-08-25). The pure
    // rollup grew a `deliverables` input and its tests passed by injecting one, while
    // this loader never populated it — so in production the rollup always took the
    // `[]` fallback and an operator-required deliverable could wait forever without
    // ever becoming an action-required reason or a `/builds` link. The tests were
    // green and the feature was absent, which is the shape this repo has been bitten
    // by before (GHI #134): authoring a thing is not wiring it.
    listDeliverablePrs(gh, repo),
  ]);

  return portfolioRollup({
    workloads,
    andons,
    corrections,
    conflicts,
    runs,
    unbuildable: buildability
      .filter((v) => !v.buildable)
      .map(({ slug, reasons, andonIssue }) => ({ slug, reasons, andonIssue })),
    // Only the ones actually waiting on the operator. `actionRequired` is the view's
    // own derivation (operator-merge-required AND still awaiting), so filtering here
    // keeps the rollup from having to re-derive it.
    deliverables: deliverables
      .filter((d) => d.actionRequired)
      .map((d) => ({
        slug: d.marker ? (slugFromPlanRef(d.marker.planRef) ?? d.branch.split('/')[1] ?? '') : (d.branch.split('/')[1] ?? ''),
        prNumber: d.number,
        url: d.url,
        stepId: d.marker?.stepId ?? '(unknown step)',
      })),
  });
}
