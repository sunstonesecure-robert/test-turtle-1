import type { Octokit } from '@octokit/rest';
import type { RepoRef } from './client';
import { mergeRecheck } from './read-after-write';
import { errorStatus } from './errors';
import { CONTRADICTION_LABEL } from './labels';
import { parseWorkloadEvent } from './markers';
import { readPlanAtRef, reopenPlan, resolveCurrent, tryReadPlanAtRef } from './plans';
import { getWorkload, type Workload } from './workloads';
import { dependencyClosure } from '../../../scripts/gates/lib/propagate';

/**
 * Contradiction scan for reactivation (lifecycle-gate L8, FR-040): did
 * evidence contradicting the workload's recorded assumptions arrive while it
 * was deferred? Deterministic inputs only (gate-checks-cli.md §3):
 *
 *   1. `evidence:batch` issues CREATED inside the deferral window (at or after
 *      the latest `deferred` event's timestamp) whose title/body names an
 *      assumption step id of the official (frozen) plan;
 *   2. `flagged:wrong-assumption` currently present on the workload issue or
 *      on any plan step's tracking issue. No window here: an unreconciled
 *      flag blocks resumption regardless of when it arrived (fail-safe — B6
 *      is the build-side twin of the same rule, FR-022).
 *
 * US5's reconciliation pipeline feeds richer records through this same seam
 * when it lands; until then a workload with no frozen plan scans only its own
 * flag (there are no recorded assumptions to name). A missing defer event
 * fails safe: the window opens at the beginning of time.
 */

export interface ContradictionScan {
  contradicted: boolean;
  /** Deterministic order: batches by issue number, then flags workload-first. */
  findings: string[];
}

/** at: of the LATEST deferred event on the workload issue (a workload can be
 *  deferred more than once); null when none is recorded. */
async function latestDeferredAt(gh: Octokit, repo: RepoRef, issueNumber: number): Promise<string | null> {
  const comments = await gh.paginate(gh.issues.listComments, { ...repo, issue_number: issueNumber, per_page: 100 });
  let at: string | null = null;
  for (const comment of comments) {
    const event = parseWorkloadEvent(comment.body ?? '');
    if (event?.action === 'deferred') at = event.at; // comments are chronological — last wins
  }
  return at;
}

/** Step ids are schema-validated (^step-[a-z0-9-]+$ — no metacharacters); the
 *  guards stop partial matches: step-a never matches inside step-a-2. */
function tokenRe(stepId: string): RegExp {
  return new RegExp(`(?<![a-z0-9-])${stepId}(?![a-z0-9-])`);
}

export async function scanDeferralContradictions(
  gh: Octokit,
  repo: RepoRef,
  workload: Workload,
): Promise<ContradictionScan> {
  const findings: string[] = [];
  const deferredAt = await latestDeferredAt(gh, repo, workload.issueNumber);

  let assumptionIds: string[] = [];
  let trackingIssues: number[] = [];
  const current = await resolveCurrent(gh, repo, workload.slug);
  if (current) {
    const { plan } = await tryReadPlanAtRef(gh, repo, current);
    if (plan) {
      assumptionIds = plan.steps.filter((s) => s.evidence_tag === 'assumption').map((s) => s.id);
      trackingIssues = [...new Set(plan.steps.map((s) => s.tracking_issue).filter((n): n is number => typeof n === 'number'))].sort((a, b) => a - b);
    }
  }

  if (assumptionIds.length > 0) {
    // `since` filters on updated_at, which is never earlier than created_at —
    // the server returns a SUPERSET of the created_at window (the created_at
    // check below stays authoritative); it just stops paginating batches whose
    // last activity predates the deferral.
    const batches = await gh.paginate(gh.issues.listForRepo, {
      ...repo,
      labels: 'evidence:batch',
      state: 'all',
      per_page: 100,
      ...(deferredAt ? { since: deferredAt } : {}),
    });
    for (const batch of [...batches].sort((a, b) => a.number - b.number)) {
      if (deferredAt && Date.parse(batch.created_at) < Date.parse(deferredAt)) continue;
      const text = `${batch.title}\n${batch.body ?? ''}`;
      const named = assumptionIds.filter((id) => tokenRe(id).test(text));
      if (named.length > 0) {
        findings.push(`evidence batch #${batch.number} names assumption step(s) ${named.join(', ')}`);
      }
    }
  }

  // Independent single-issue reads — fetched concurrently. Promise.all
  // preserves input order (workload first, tracking ascending), so the
  // findings order stays deterministic.
  const flagCandidates = [workload.issueNumber, ...trackingIssues.filter((n) => n !== workload.issueNumber)];
  const labelsByIssue = await Promise.all(
    flagCandidates.map(async (issueNumber) => {
      try {
        const { data: issue } = await gh.issues.get({ ...repo, issue_number: issueNumber });
        return { issueNumber, labels: (issue.labels ?? []).map((l) => (typeof l === 'string' ? l : (l.name ?? ''))) };
      } catch (error: unknown) {
        // A stale tracking_issue link is not evidence of anything — skip it.
        if (errorStatus(error) === 404) return null;
        throw error;
      }
    }),
  );
  for (const entry of labelsByIssue) {
    if (!entry || !entry.labels.includes(CONTRADICTION_LABEL)) continue;
    findings.push(
      entry.issueNumber === workload.issueNumber
        ? `workload issue #${entry.issueNumber} carries flagged:wrong-assumption`
        : `tracking issue #${entry.issueNumber} carries flagged:wrong-assumption`,
    );
  }

  return { contradicted: findings.length > 0, findings };
}

// ---------------------------------------------------------------------------
// Evidence batches + reconciliation (T098 tracer surface, FR-021/FR-022)
// ---------------------------------------------------------------------------

export type EvidenceKind = 'feedback' | 'analytics' | 'test-results';

export interface EvidenceItem {
  summary: string;
  /** step ids this observation bears on (schema-shaped: step-*) */
  relates_to?: string[];
}

export interface EvidenceBatch {
  source: string;
  kind: EvidenceKind;
  items: EvidenceItem[];
}

const BATCH_TITLE_RE = /^Evidence (\d{4}-\d{2}-\d{2})$/;

function batchPath(date: string): string {
  return `evidence/${date}.json`;
}

/**
 * Record a dated evidence batch (FR-021): the durable record is the committed
 * JSON; the `evidence:batch` issue is its reviewable surface (and what the L8
 * deferral scan reads). Committed FIRST — an issue pointing at a missing file
 * is a broken record, a file without an issue is only an unsurfaced one, and a
 * re-run converges.
 */
export async function recordEvidenceBatch(
  gh: Octokit,
  repo: RepoRef,
  input: { date: string; source: string; kind: EvidenceKind; items: EvidenceItem[] },
): Promise<{ issueNumber: number; path: string }> {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.date)) throw new Error(`invalid batch date: ${input.date} (expected YYYY-MM-DD)`);
  const path = batchPath(input.date);
  const batch: EvidenceBatch = { source: input.source, kind: input.kind, items: input.items };

  // Batches are append-only interval records (FR-021): a second record on the
  // same date would silently REPLACE the committed JSON while the earlier
  // issue's link keeps pointing at it — the original observations would
  // become unreachable through their own record. Refuse instead.
  try {
    const { data } = await gh.repos.getContent({ ...repo, path });
    if (!Array.isArray(data) && 'sha' in data) {
      const existing = (await listEvidenceBatches(gh, repo)).find((b) => b.date === input.date);
      throw new Error(
        `an evidence batch for ${input.date} already exists${existing ? ` (issue #${existing.issueNumber})` : ''} — ` +
          'batches are append-only records: add observations to that batch or record under a distinct date',
      );
    }
  } catch (error: unknown) {
    if (errorStatus(error) !== 404) throw error;
  }
  await gh.repos.createOrUpdateFileContents({
    ...repo,
    path,
    message: `evidence: batch ${input.date} (${input.kind}, ${input.source})`,
    content: Buffer.from(JSON.stringify(batch, null, 2)).toString('base64'),
  });

  // The body enumerates every step id the observations name: the L8 deferral
  // scan reads ONLY issue title+body, so references buried in the committed
  // JSON (or later comments) would be invisible to it — and an assumption
  // without a tracking issue has no label fallback (PR #74 bot finding).
  const named = [...new Set(input.items.flatMap((item) => item.relates_to ?? []))].sort();
  const { data: issue } = await gh.issues.create({
    ...repo,
    title: `Evidence ${input.date}`,
    body: [
      `Committed evidence batch: \`${path}\` — ${input.kind} from ${input.source}, ${input.items.length} item(s).`,
      ...(named.length > 0 ? ['', `Names step(s): ${named.join(', ')}`] : []),
    ].join('\n'),
    labels: ['evidence:batch'],
  });
  return { issueNumber: issue.number, path };
}

export interface EvidenceBatchRef {
  issueNumber: number;
  date: string;
  path: string;
}

/** One batch by issue number, through the read-after-write-consistent GET.
 *  `null` for a PR number, an issue that is not a batch, or a title the batch
 *  grammar does not match — which is what makes an untrusted URL hint safe. */
async function getEvidenceBatchRef(gh: Octokit, repo: RepoRef, issueNumber: number): Promise<EvidenceBatchRef | null> {
  const { data: issue } = await gh.issues.get({ ...repo, issue_number: issueNumber });
  if (issue.pull_request) return null;
  // The SAME membership the list query enforces (`labels: 'evidence:batch'`), or
  // the direct read is the weaker of the two and the hint becomes a way in. The
  // hint is untrusted URL input: without this, any issue merely TITLED
  // `Evidence YYYY-MM-DD` is accepted, and since `path` is derived from the date,
  // a crafted `?just=` could pin a foreign issue number onto a real batch's
  // committed JSON — or add a second row for a date that already has one, on a
  // record type whose date IS its identity (PR #123 bot review).
  const labels = (issue.labels ?? []).map((l) => (typeof l === 'string' ? l : (l.name ?? '')));
  if (!labels.includes('evidence:batch')) return null;
  const m = BATCH_TITLE_RE.exec(issue.title);
  return m ? { issueNumber: issue.number, date: m[1]!, path: batchPath(m[1]!) } : null;
}

/**
 * Every dated evidence batch.
 *
 * `recheck` names the issues a caller just wrote (the contract's list-lag rule in
 * `contracts/dashboard-github-api.md`): the Evidence page renders from here
 * immediately after recording a batch, and without the hint the batch the
 * operator just recorded is absent from the list that was supposed to confirm it.
 * A batch is append-only and its date is its identity, so a re-render that shows
 * nothing invites a second attempt on the same date — which is refused, leaving
 * the operator with a refusal about a record they cannot see.
 */
export async function listEvidenceBatches(
  gh: Octokit,
  repo: RepoRef,
  opts: { recheck?: number[] } = {},
): Promise<EvidenceBatchRef[]> {
  const issues = await gh.paginate(gh.issues.listForRepo, {
    ...repo,
    labels: 'evidence:batch',
    state: 'all',
    per_page: 100,
  });
  const listed = issues
    .filter((issue) => !issue.pull_request)
    .map((issue) => {
      const m = BATCH_TITLE_RE.exec(issue.title);
      return m ? { issueNumber: issue.number, date: m[1]!, path: batchPath(m[1]!) } : null;
    })
    .filter((b): b is EvidenceBatchRef => b !== null);
  const merged = await mergeRecheck(
    listed,
    opts.recheck,
    // Never `'absent'`: batches are append-only records read `state: 'all'`.
    async (n) => {
      const ref = await getEvidenceBatchRef(gh, repo, n);
      return ref ? { item: ref } : null;
    },
    (b) => b.issueNumber,
  );
  return merged.sort((a, b) => a.date.localeCompare(b.date) || a.issueNumber - b.issueNumber);
}

export async function readEvidenceBatch(gh: Octokit, repo: RepoRef, date: string): Promise<EvidenceBatch> {
  const { data } = await gh.repos.getContent({ ...repo, path: batchPath(date) });
  if (Array.isArray(data) || !('content' in data)) throw new Error(`${batchPath(date)} is not a file`);
  const raw = JSON.parse(Buffer.from(data.content, 'base64').toString('utf8')) as Partial<EvidenceBatch>;
  // Committed files are still untrusted input at a read boundary: a malformed
  // record must be a handled read failure, not a page crash on items.length.
  if (
    typeof raw !== 'object' || raw === null ||
    typeof raw.source !== 'string' ||
    !(['feedback', 'analytics', 'test-results'] as const).includes(raw.kind as EvidenceKind) ||
    !Array.isArray(raw.items) ||
    raw.items.some((item) => typeof item !== 'object' || item === null || typeof (item as EvidenceItem).summary !== 'string')
  ) {
    throw new Error(`${batchPath(date)} does not match the evidence batch shape (source, kind, items[])`);
  }
  return raw as EvidenceBatch;
}

export interface ReconcileResult {
  /** dependency closure of the contradicted steps (step ids, sorted) */
  flagged: string[];
  /** the new in-review plan ref, or null when a proposal was already in flight */
  reopenedAs: string | null;
}

/**
 * The operator's contradiction judgment applied (FR-022, SC-005): data wins.
 * Judgment (WHICH steps the evidence contradicts) stays with the human; what
 * follows is deterministic — the transitive dependency closure gets
 * flagged:wrong-assumption on every tracked issue, the batch issue gets a
 * structured record of the call, and the plan re-opens as v<N+1> for
 * correction. Holds equally when the contradicted step was tagged `verified`:
 * the evidence supersedes the tag either way.
 */
export async function markContradicted(
  gh: Octokit,
  repo: RepoRef,
  input: {
    workloadSlug: string;
    planRef: string;
    contradictedStepIds: string[];
    batchIssue: number;
    actor: string;
    at: string;
  },
): Promise<ReconcileResult> {
  if (input.contradictedStepIds.length === 0) throw new Error('nothing marked contradicted');

  // Terminal workloads are read-only records: reconciling one would cut a new
  // plan branch and open a review on a workload that can never act on it
  // (FR-041/FR-043). Active takes the correction now; deferred takes it and
  // L8 forces review on reactivation.
  const workload = await getWorkload(gh, repo, input.workloadSlug);
  if (!workload) throw new Error(`workload not found: ${input.workloadSlug}`);
  if (workload.state !== 'active' && workload.state !== 'deferred') {
    throw new Error(
      `reconciliation refused: workload "${input.workloadSlug}" is workload:${workload.state} — ` +
        'only an active or deferred workload can take a correction (a terminal record is read-only)',
    );
  }

  // The judgment must be made against the OFFICIAL version: a queued/stale
  // dispatch carrying v1 after v2 froze would flag steps that may no longer
  // exist while the re-open forks from v2 — audit and correction would
  // describe two different plans.
  const current = await resolveCurrent(gh, repo, input.workloadSlug);
  if (current !== input.planRef) {
    throw new Error(
      `stale reconciliation: ${input.planRef} is not the official version (${current ?? 'nothing frozen'}) — re-judge against the current plan`,
    );
  }

  const plan = await readPlanAtRef(gh, repo, input.planRef);
  // Every requested id must name a real step: silently dropping a typo would
  // leave an audit record claiming a reconciliation that never happened.
  const known = new Set(plan.steps.map((s) => s.id));
  const unknown = input.contradictedStepIds.filter((id) => !known.has(id));
  if (unknown.length > 0) {
    throw new Error(`unknown step id(s) for ${input.planRef}: ${unknown.join(', ')} — nothing was flagged; correct the ids and re-submit the judgment`);
  }
  const flagged = dependencyClosure(plan, input.contradictedStepIds);

  // Flags land on the steps' tracking issues (dedup: several steps may share
  // one). Steps without a tracking issue are still in the audit record below.
  const stepsById = new Map(plan.steps.map((s) => [s.id, s]));
  const trackingIssues = [
    ...new Set(
      flagged
        .map((id) => stepsById.get(id)?.tracking_issue)
        .filter((n): n is number => typeof n === 'number'),
    ),
  ].sort((a, b) => a - b);
  for (const issueNumber of trackingIssues) {
    await gh.issues.addLabels({ ...repo, issue_number: issueNumber, labels: [CONTRADICTION_LABEL] });
  }

  // The attributable reconciliation record on the batch issue (read back by
  // the L8 deferral scan, which matches step ids in batch-issue text).
  await gh.issues.createComment({
    ...repo,
    issue_number: input.batchIssue,
    body: [
      `<!-- reconcile:v1 plan:${input.planRef} by:@${input.actor} at:${input.at} -->`,
      `**Contradicted** (operator judgment): ${input.contradictedStepIds.join(', ')}`,
      `**Flagged closure** (deterministic, FR-022): ${flagged.join(', ')}`,
      trackingIssues.length > 0
        ? `Tracking issues flagged \`flagged:wrong-assumption\`: ${trackingIssues.map((n) => `#${n}`).join(', ')}`
        : 'No tracking issues to flag (steps carry no tracking_issue).',
    ].join('\n'),
  });

  // Data wins: the contradicted plan re-opens for correction. If a proposal is
  // already in review, the flags stand and that live review absorbs the
  // correction — a second fork would split the operator's attention. ONLY the
  // verified in-flight-review refusal ('awaiting review') is absorbed: the
  // branch-exists TOCTOU flavor can also mean an ORPHAN branch from a partial
  // prior re-open (branch cut, Andon never created), and converting that into
  // success would report a correction path that does not exist.
  let reopenedAs: string | null = null;
  try {
    const reopened = await reopenPlan(gh, repo, { slug: input.workloadSlug, actor: input.actor, at: input.at });
    reopenedAs = reopened.planRef;
  } catch (error: unknown) {
    if (!(error instanceof Error) || !error.message.includes('awaiting review')) throw error;
  }
  return { flagged, reopenedAs };
}
