import type { Octokit } from '@octokit/rest';
import type { RepoRef } from './client';
import { mergeRecheck } from './read-after-write';
import { errorStatus, isRefusal, Refusal } from './errors';
import { CONTRADICTION_LABEL } from './labels';
import { EVIDENCE_DIR, commitEvidenceFile, readEvidenceFile, type StoredEvidenceFile } from './evidence-store';
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
      // Title AND body, and since GHI #136 the title carries the source slug — so a
      // source named after a step id ("step-clock") makes its batch read as naming
      // that step. Left as is: the error direction is one extra review on
      // reactivation, never a skipped one, and narrowing the match to the body
      // would drop the title, which is where a hand-written batch names its step.
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
  /**
   * The `evidence:batch` issue that surfaces this record — the reverse of the link
   * `batchBody` already writes into the issue (Codex on PR #138, 2026-08-25).
   *
   * OPTIONAL, and it has to be: the file is committed BEFORE the issue exists (an
   * issue pointing at a missing file is a broken record; a file without an issue is
   * only an unsurfaced one), so a brand-new record carries no number until a second
   * commit adds it, and every record written before today has none at all.
   *
   * WHY IT EXISTS. Recovering the issue by LISTING issues is not sound: the list
   * endpoint is not read-after-write consistent — this repo has known that since
   * PB-003 and says so in `getWorkloadByIssue` — so a batch recorded and then
   * appended to seconds later found the file, missed its own issue, and opened a
   * SECOND one with the same title and label. Two review surfaces for one durable
   * record, in exactly the immediate-repeat case GHI #136 exists to support. With the
   * number in the record, recovery goes through `issues.get`, which IS consistent.
   */
  issue?: number;
}

/**
 * A batch is identified by **(date, source)**, and recording the same pair again
 * APPENDS to it (operator decision 2026-08-21, GHI #136).
 *
 * The date alone used to be the identity, so a repository could hold one batch
 * per day — a limit hit within minutes of the first batch of the PB-011 run. The
 * refusal that enforced it was also unfollowable: it said *"add observations to
 * that batch or record under a distinct date"*, and no code anywhere added
 * observations to a batch, so one of the two ways out did not exist and the
 * other meant waiting until tomorrow.
 *
 * Timestamp identity (1-second) was considered and DECLINED. It never refuses,
 * which sounds like the point but is the flaw: it removes duplicate protection
 * entirely, and an invisible success (GHI #135) plus no duplicate protection
 * means a double click quietly produces two evidence records that then flag the
 * same work items twice. It also still collides for automated callers, so the
 * refusal would fire unpredictably rather than never.
 *
 * So: same date and source → the observations join that batch's record. Same
 * date, different source → a new batch, and the filename says which source it
 * came from, because the honest reason to want two records in one day is that
 * they came from two places.
 *
 * The date remains only a NAME. Ordering runs on real timestamps — L8's deferral
 * window compares the batch issue's `created_at` — so nothing downstream had to
 * change for a second batch to exist on one date.
 */
const BATCH_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Both halves of the identity have to survive a round trip through a filename
 * and an issue title, so the SLUG is the identity — `Support Inbox` and
 * `support-inbox` are the same source, and appending is what a second
 * submission from either does.
 *
 * Anchored to `[a-z0-9-]` because these characters end up inside a committed
 * path and inside the anchored title pattern below; a raw source string is
 * operator (or dispatch-input) text and belongs in the JSON payload, not in a
 * name a parser has to trust.
 */
const MAX_SOURCE_SLUG = 40;

/** The consequence of the cap, stated rather than discovered: two sources whose
 *  first 40 slug characters match are ONE source here, so a second submission
 *  from either appends to the first's record. That is the right failure of the
 *  two available — appending to a neighbouring record keeps both sets of
 *  observations reachable, where a silently truncated separate name would leave
 *  two records nobody can tell apart. Distinguish such sources by their first
 *  words, not their last. */
export function sourceSlug(source: string): string {
  return source
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, MAX_SOURCE_SLUG)
    .replace(/-+$/g, '');
}

/**
 * `Evidence <date> (<source>)`, or the source-less `Evidence <date>` for a batch
 * recorded before (date, source) identity existed. The optional group is what
 * keeps every legacy batch a valid batch — its title, its path and its issue all
 * still resolve, and nothing was rewritten to get there.
 */
const BATCH_TITLE_RE = /^Evidence (\d{4}-\d{2}-\d{2})(?: \(([a-z0-9][a-z0-9-]*)\))?$/;

/** `null` source = the legacy, source-less name. */
export function batchPath(date: string, source: string | null): string {
  return `${EVIDENCE_DIR}/${source ? `${date}-${source}` : date}.json`;
}

export function batchTitle(date: string, source: string | null): string {
  return `Evidence ${date}${source ? ` (${source})` : ''}`;
}

/** The parsed record, or a refusal naming the file — a malformed record is a
 *  handled read failure at a boundary, never a page crash on items.length. */
function parseBatch(path: string, raw: string): EvidenceBatch {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Refusal(`${path} is not valid JSON — repair the committed record before recording against it`);
  }
  const batch = parsed as Partial<EvidenceBatch>;
  if (
    typeof batch !== 'object' || batch === null ||
    typeof batch.source !== 'string' ||
    (batch.issue !== undefined && (typeof batch.issue !== 'number' || !Number.isInteger(batch.issue) || batch.issue <= 0)) ||
    !(['feedback', 'analytics', 'test-results'] as const).includes(batch.kind as EvidenceKind) ||
    !Array.isArray(batch.items) ||
    batch.items.some((item) => typeof item !== 'object' || item === null || typeof (item as EvidenceItem).summary !== 'string')
  ) {
    throw new Refusal(`${path} does not match the evidence batch shape (source, kind, items[])`);
  }
  return batch as EvidenceBatch;
}

/**
 * The issue body, regenerated from the record.
 *
 * It enumerates every step id the observations name because the L8 deferral scan
 * reads ONLY issue title + body: a reference buried in the committed JSON — or
 * in an append COMMENT — is invisible to it, and an assumption step without a
 * tracking issue has no label fallback (PR #74 bot finding). That is why an
 * append rewrites this body and does not merely comment: the comment is the
 * audit record of what was added, the body is what the scan can see.
 */
function batchBody(path: string, batch: EvidenceBatch): string {
  const named = [...new Set(batch.items.flatMap((item) => item.relates_to ?? []))].sort();
  return [
    `Committed evidence batch: \`${path}\` — ${batch.kind} from ${batch.source}, ${batch.items.length} item(s).`,
    ...(named.length > 0 ? ['', `Names step(s): ${named.join(', ')}`] : []),
    '',
    '_Regenerated when observations are appended to this batch — add notes as a comment rather than editing this text._',
  ].join('\n');
}

/** What a record call did — the caller needs all of it to tell the operator
 *  whether their observations started a batch or joined one (GHI #135). */
export interface RecordedBatch {
  issueNumber: number;
  path: string;
  /** the slugged source that keys this batch, or null for a legacy record joined in place */
  source: string | null;
  /** true when this call opened the batch, false when it appended to one */
  created: boolean;
  /** observations this call added — 0 is valid: an interval that reported nothing
   *  is still evidence that we looked */
  appended: number;
  /** observations this call offered that the record ALREADY held, and which were
   *  therefore not duplicated (Codex on PR #138). Surfaced rather than swallowed: a
   *  submission that added nothing because it was a retry is a different fact from
   *  one that added nothing because it carried nothing, and the operator is told
   *  which they got. */
  alreadyPresent: number;
  /** observations the batch holds after this call — what the operator is told the
   *  record now contains, which is not derivable from `appended` on an append */
  total: number;
}

/** The record for (date, source), preferring the canonical name and accepting a
 *  legacy source-less one as the same batch when its recorded source matches. */
async function locateBatchRecord(
  gh: Octokit,
  repo: RepoRef,
  date: string,
  source: string,
): Promise<{ path: string; stored: StoredEvidenceFile; batch: EvidenceBatch; legacy: boolean } | null> {
  const canonical = batchPath(date, source);
  const onCanonical = await readEvidenceFile(gh, repo, canonical);
  // Strict here: a malformed record at the canonical path refuses the write,
  // because appending to something unparseable would replace it.
  if (onCanonical) return { path: canonical, stored: onCanonical, batch: parseBatch(canonical, onCanonical.content), legacy: false };

  const legacyPath = batchPath(date, null);
  const onLegacy = await readEvidenceFile(gh, repo, legacyPath);
  if (onLegacy) {
    // Lenient here, deliberately: a malformed LEGACY file cannot say which
    // source it belongs to, so it cannot be claimed as this batch — the new
    // record takes the canonical name and the broken file is left untouched.
    try {
      const batch = parseBatch(legacyPath, onLegacy.content);
      if (sourceSlug(batch.source) === source) return { path: legacyPath, stored: onLegacy, batch, legacy: true };
    } catch {
      return null;
    }
  }
  return null;
}

/**
 * The batch issue for this record, opened if the record genuinely has none — a file
 * without an issue is an unsurfaced record, and a re-run converges.
 *
 * THREE LOOKUPS, IN THIS ORDER, and the first one is the fix (Codex on PR #138,
 * 2026-08-25):
 *
 *  1. **The record's own `issue` field, via `issues.get`.** Read-after-write
 *     consistent, so a batch appended to seconds after it was created finds its own
 *     issue. Without this the list below missed it and a SECOND issue was opened with
 *     the same title and label — two review and reconciliation surfaces for one
 *     durable record, in precisely the immediate-repeat case GHI #136 exists to
 *     support. The `get` is verified rather than trusted: a number pointing at a
 *     closed issue, a pull request, or something that is not a batch is treated as no
 *     link at all, because the file is operator-editable text.
 *  2. **The list**, for records written before the field existed. Still lag-prone;
 *     that is now a fallback for legacy data rather than the primary path.
 *  3. **Create one**, and hand the number back so the caller can write it into the
 *     record — which is what stops step 3 from happening twice.
 */
async function batchIssueFor(
  gh: Octokit,
  repo: RepoRef,
  input: { date: string; source: string | null; path: string; batch: EvidenceBatch },
): Promise<{ issueNumber: number; recordedInFile: boolean }> {
  if (input.batch.issue !== undefined) {
    const named = await getEvidenceBatchRef(gh, repo, input.batch.issue);
    // The ref parser only answers for an issue whose TITLE matches the batch
    // grammar, which is what makes believing a number out of a text file safe.
    if (named && named.date === input.date && (named.source ?? null) === input.source) {
      return { issueNumber: input.batch.issue, recordedInFile: true };
    }
  }
  const existing = (await listEvidenceBatches(gh, repo)).find(
    (b) => b.date === input.date && (b.source ?? null) === input.source,
  );
  if (existing) return { issueNumber: existing.issueNumber, recordedInFile: false };
  const { data: issue } = await gh.issues.create({
    ...repo,
    title: batchTitle(input.date, input.source),
    body: batchBody(input.path, input.batch),
    labels: ['evidence:batch'],
  });
  return { issueNumber: issue.number, recordedInFile: false };
}

/**
 * Write the issue number INTO the durable record, so the next call can find the
 * issue without asking a lagging list (Codex on PR #138).
 *
 * A second commit, and unavoidably so: the file is committed before the issue exists
 * — deliberately, because an issue pointing at a missing file is a broken record
 * while a file without an issue is merely unsurfaced. This is the converging half of
 * that trade.
 *
 * Best-effort ON PURPOSE. If this commit fails the record is still correct and its
 * issue still exists; the only loss is that the next call falls back to the list. So
 * a failure here must not fail the operator's write, which already succeeded — it
 * would report "nothing was written" about a record that is sitting there.
 */
async function linkIssueIntoRecord(
  gh: Octokit,
  repo: RepoRef,
  input: { path: string; batch: EvidenceBatch; issueNumber: number },
): Promise<void> {
  try {
    const current = await readEvidenceFile(gh, repo, input.path);
    if (!current) return;
    const batch = parseBatch(input.path, current.content);
    if (batch.issue === input.issueNumber) return; // already converged
    await commitEvidenceFile(gh, repo, {
      path: input.path,
      content: `${JSON.stringify({ ...batch, issue: input.issueNumber }, null, 2)}\n`,
      message: `evidence: link ${input.path} to its batch issue #${input.issueNumber}`,
      sha: current.sha,
    });
  } catch {
    // Deliberately swallowed — see the docblock. The record and the issue both
    // exist; only the shortcut between them is missing, and the list fallback covers
    // it until the next append converges.
  }
}

/**
 * Which incoming observations are NOT already in the record (Codex on PR #138,
 * 2026-08-25) — the fix for a retry duplicating a whole batch.
 *
 * THE FAILURE IT CLOSES. The create path commits the file and then opens the issue.
 * If `issues.create` fails — a transient 5xx, a secondary rate limit — the file
 * exists with its observations and no issue. The retry then takes the APPEND path,
 * correctly opens the missing issue, and unconditionally concatenated the same
 * observations onto the ones already committed. Every item duplicated, permanently:
 * nothing deletes from this record (FR-042), and the scheduled collector re-collects
 * the same observations on its next interval, so the retry is the expected path
 * rather than an unlucky one.
 *
 * IDENTITY IS THE CONTENT: summary plus the step ids it bears on. Deliberately not a
 * generated id — the whole point is to recognise an observation we have already
 * committed, and only its content can do that across two runs.
 *
 * THE COST, STATED: two genuinely distinct observations that say exactly the same
 * thing about exactly the same steps collapse into one. A duplicate identical line
 * carries no information a reader could act on differently, and the alternative is
 * permanent duplication of an audit record on any transient API blip. The caller
 * reports how many were skipped, so this is never silent.
 */
export function newObservations(existing: EvidenceItem[], incoming: EvidenceItem[]): EvidenceItem[] {
  const key = (item: EvidenceItem): string =>
    JSON.stringify([item.summary.trim(), [...(item.relates_to ?? [])].sort()]);
  const seen = new Set(existing.map(key));
  const out: EvidenceItem[] = [];
  for (const item of incoming) {
    const k = key(item);
    // Also guards duplicates WITHIN one submission, which the old path would have
    // committed twice just as happily.
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(item);
  }
  return out;
}

/**
 * Record a dated evidence batch, or append to the one that already covers this
 * (date, source) (FR-021, amended by GHI #136).
 *
 * The durable record is the committed JSON on the `evidence` branch (GHI #134 —
 * the default branch refuses every machine write); the `evidence:batch` issue is
 * its reviewable surface, and what the L8 deferral scan reads. Committed FIRST —
 * an issue pointing at a missing file is a broken record, a file without an
 * issue is only an unsurfaced one, and a re-run converges.
 */
export async function recordEvidenceBatch(
  gh: Octokit,
  repo: RepoRef,
  input: { date: string; source: string; kind: EvidenceKind; items: EvidenceItem[]; actor?: string; at?: string },
): Promise<RecordedBatch> {
  if (!BATCH_DATE_RE.test(input.date)) throw new Refusal(`invalid batch date: ${input.date} (expected YYYY-MM-DD)`);
  const source = sourceSlug(input.source);
  if (!source) {
    throw new Refusal(
      `"${input.source}" cannot name a source — a batch is identified by its date AND its source, ` +
        'so name where the observations came from using letters, digits or dashes (e.g. support-inbox)',
    );
  }

  const located = await locateBatchRecord(gh, repo, input.date, source);
  if (located) {
    // Same date, same source: the observations join that record. This is exactly
    // what the old refusal promised and nothing implemented (GHI #136).
    if (located.batch.kind !== input.kind) {
      throw new Refusal(
        `the ${input.date} batch from ${located.batch.source} records ${located.batch.kind}, not ${input.kind} — ` +
          'observations of a different kind belong in their own batch: record them under a distinct source',
      );
    }
    const surfaced = await batchIssueFor(gh, repo, {
      date: input.date,
      source: located.legacy ? null : source,
      path: located.path,
      batch: located.batch,
    });
    const issueNumber = surfaced.issueNumber;
    // ONLY the new observations. An append that re-offers what the record already
    // holds is the create-retry path, and concatenating it duplicated the batch
    // permanently (Codex on PR #138).
    const fresh = newObservations(located.batch.items, input.items);
    const skipped = input.items.length - fresh.length;
    // Nothing to add is a valid outcome, not a refusal: a scheduled interval
    // that reported nothing is still evidence that we looked, and re-running it
    // must not litter the record with empty appends.
    if (fresh.length === 0) {
      // Nothing NEW to add — either an empty submission (a scheduled interval that
      // reported nothing is still evidence that we looked) or a retry of observations
      // already committed. Both are valid outcomes, not refusals, and both must leave
      // the record exactly as it is. The issue link is still repaired below-by-way-of
      // `batchIssueFor` above, which is the converging half.
      if (!surfaced.recordedInFile && located.batch.issue === undefined) {
        await linkIssueIntoRecord(gh, repo, { path: located.path, batch: located.batch, issueNumber });
      }
      return {
        issueNumber,
        path: located.path,
        source: located.legacy ? null : source,
        created: false,
        appended: 0,
        alreadyPresent: skipped,
        total: located.batch.items.length,
      };
    }
    // Two writers share this record — the scheduled collector and the operator's
    // dashboard — so the commit carries the blob sha it read. A concurrent append
    // therefore FAILS rather than silently dropping the other writer's
    // observations; one retry re-reads and re-merges, which is all a
    // single-conflict race needs and is bounded so a persistent conflict still
    // surfaces instead of looping.
    let merged: EvidenceBatch = { ...located.batch, issue: issueNumber, items: [...located.batch.items, ...fresh] };
    try {
      await commitEvidenceFile(gh, repo, {
        path: located.path,
        content: `${JSON.stringify(merged, null, 2)}\n`,
        message: `evidence: append ${fresh.length} observation(s) to ${input.date} (${located.batch.source})`,
        sha: located.stored.sha,
      });
    } catch (error: unknown) {
      if (errorStatus(error) !== 409 && errorStatus(error) !== 422) throw error;
      const reread = await locateBatchRecord(gh, repo, input.date, source);
      if (!reread) throw error;
      // Re-dedupe against what the OTHER writer just committed: the whole reason this
      // retry exists is that someone else appended between our read and our write, so
      // their observations may be the same ones we are holding.
      const stillNew = newObservations(reread.batch.items, fresh);
      merged = { ...reread.batch, issue: issueNumber, items: [...reread.batch.items, ...stillNew] };
      await commitEvidenceFile(gh, repo, {
        path: reread.path,
        content: `${JSON.stringify(merged, null, 2)}\n`,
        message: `evidence: append ${stillNew.length} observation(s) to ${input.date} (${reread.batch.source})`,
        sha: reread.stored.sha,
      });
    }
    await gh.issues.update({ ...repo, issue_number: issueNumber, body: batchBody(located.path, merged) });
    const named = [...new Set(fresh.flatMap((item) => item.relates_to ?? []))].sort();
    await gh.issues.createComment({
      ...repo,
      issue_number: issueNumber,
      body: [
        `<!-- evidence-append:v1 date:${input.date} source:${source} items:${fresh.length}` +
          `${input.actor ? ` by:@${input.actor}` : ''}${input.at ? ` at:${input.at}` : ''} -->`,
        `**Appended** ${fresh.length} observation(s) to \`${located.path}\` (${merged.items.length} in the batch now)` +
          `${skipped > 0 ? `; ${skipped} already in the record and not duplicated` : ''}:`,
        ...fresh.map((item) => `- ${item.summary}${item.relates_to?.length ? ` — ${item.relates_to.join(', ')}` : ''}`),
        ...(named.length > 0 ? ['', `Names step(s): ${named.join(', ')}`] : []),
      ].join('\n'),
    });
    return {
      issueNumber,
      path: located.path,
      source: located.legacy ? null : source,
      created: false,
      appended: fresh.length,
      alreadyPresent: skipped,
      total: merged.items.length,
    };
  }

  // A new batch. The canonical name carries the source, so a second source on
  // the same date is a second record rather than a refusal.
  const path = batchPath(input.date, source);
  // Deduped within the submission too: the old path would have committed a repeated
  // observation twice as happily as it duplicated a whole retried batch.
  const items = newObservations([], input.items);
  const batch: EvidenceBatch = { source: input.source, kind: input.kind, items };
  await commitEvidenceFile(gh, repo, {
    path,
    content: `${JSON.stringify(batch, null, 2)}\n`,
    message: `evidence: batch ${input.date} (${input.kind}, ${input.source})`,
  });
  const { data: issue } = await gh.issues.create({
    ...repo,
    title: batchTitle(input.date, source),
    body: batchBody(path, batch),
    labels: ['evidence:batch'],
  });
  // The reverse link, so an append seconds from now finds THIS issue instead of
  // opening a second one past the list lag.
  await linkIssueIntoRecord(gh, repo, { path, batch, issueNumber: issue.number });
  return {
    issueNumber: issue.number,
    path,
    source,
    created: true,
    appended: items.length,
    alreadyPresent: input.items.length - items.length,
    total: items.length,
  };
}

export interface EvidenceBatchRef {
  issueNumber: number;
  date: string;
  /** the slugged source that keys this batch — null for a legacy, source-less record */
  source: string | null;
  path: string;
}

function refFromTitle(issueNumber: number, title: string): EvidenceBatchRef | null {
  const m = BATCH_TITLE_RE.exec(title);
  if (!m) return null;
  const source = m[2] ?? null;
  return { issueNumber, date: m[1]!, source, path: batchPath(m[1]!, source) };
}

/** One batch by issue number, through the read-after-write-consistent GET.
 *  `null` for a PR number, an issue that is not a batch, a title the batch grammar
 *  does not match, or an issue number that does not exist — which is what makes an
 *  untrusted URL hint safe.
 *
 *  THE 404 CASE WAS MISSING (found 2026-08-25 by a test written for a different fix).
 *  Every other way of being wrong about the number returned `null`; a number naming
 *  no issue at all threw, and the callers are both untrusted-input paths — the
 *  `?just=` re-read hint on the evidence page, and now a batch record's own `issue`
 *  pointer. So `/evidence?just=99999` crashed the page with a fault, which is exactly
 *  the crash-page outcome FR-067 exists to end, and a hand-edited record pointer
 *  would have failed an operator's write instead of falling back to the list.
 *  Absence is the same class of wrongness as the rest: it returns `null`. */
async function getEvidenceBatchRef(gh: Octokit, repo: RepoRef, issueNumber: number): Promise<EvidenceBatchRef | null> {
  let issue;
  try {
    ({ data: issue } = await gh.issues.get({ ...repo, issue_number: issueNumber }));
  } catch (error: unknown) {
    if (errorStatus(error) === 404) return null;
    throw error;
  }
  if (issue.pull_request) return null;
  // The SAME membership the list query enforces (`labels: 'evidence:batch'`), or
  // the direct read is the weaker of the two and the hint becomes a way in. The
  // hint is untrusted URL input: without this, any issue merely TITLED
  // `Evidence YYYY-MM-DD` is accepted, and since `path` is derived from the title,
  // a crafted `?just=` could pin a foreign issue number onto a real batch's
  // committed JSON — or add a second row for a (date, source) that already has
  // one (PR #123 bot review).
  const labels = (issue.labels ?? []).map((l) => (typeof l === 'string' ? l : (l.name ?? '')));
  if (!labels.includes('evidence:batch')) return null;
  return refFromTitle(issue.number, issue.title);
}

/**
 * Every recorded evidence batch.
 *
 * `recheck` names the issues a caller just wrote (the contract's list-lag rule in
 * `contracts/dashboard-github-api.md`): the Evidence page renders from here
 * immediately after recording a batch, and without the hint the batch the
 * operator just recorded is absent from the list that was supposed to confirm it.
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
    .map((issue) => refFromTitle(issue.number, issue.title))
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
  return merged.sort(
    (a, b) =>
      a.date.localeCompare(b.date) ||
      (a.source ?? '').localeCompare(b.source ?? '') ||
      a.issueNumber - b.issueNumber,
  );
}

/**
 * One batch record by its committed path (`EvidenceBatchRef.path`).
 *
 * Path rather than date since GHI #136: a date no longer identifies a record.
 * The read prefers the `evidence` branch and falls back to the default branch,
 * so a batch recorded before GHI #134 keeps resolving from where it was written.
 */
export async function readEvidenceBatch(gh: Octokit, repo: RepoRef, path: string): Promise<EvidenceBatch> {
  const stored = await readEvidenceFile(gh, repo, path);
  if (!stored) throw new Refusal(`${path} is not a recorded evidence batch`);
  return parseBatch(path, stored.content);
}

export interface ReconcileResult {
  /** dependency closure of the contradicted steps (step ids, sorted) */
  flagged: string[];
  /** the new in-review plan ref, or null when a proposal was already in flight */
  reopenedAs: string | null;
  /**
   * Why the plan did NOT re-open, when it did not and a live review is not the reason
   * (Codex on PR #138). Non-null means the flags and the reconciliation comment
   * landed and the correction path did not open — a genuine partial outcome, which
   * the caller must report as such rather than as "nothing was written".
   */
  reopenBlocked: string | null;
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
  if (input.contradictedStepIds.length === 0) throw new Refusal('nothing marked contradicted');

  // Terminal workloads are read-only records: reconciling one would cut a new
  // plan branch and open a review on a workload that can never act on it
  // (FR-041/FR-043). Active takes the correction now; deferred takes it and
  // L8 forces review on reactivation.
  const workload = await getWorkload(gh, repo, input.workloadSlug);
  if (!workload) throw new Refusal(`workload not found: ${input.workloadSlug}`);
  if (workload.state !== 'active' && workload.state !== 'deferred') {
    throw new Refusal(
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
    throw new Refusal(
      `stale reconciliation: ${input.planRef} is not the official version (${current ?? 'nothing frozen'}) — re-judge against the current plan`,
    );
  }

  const plan = await readPlanAtRef(gh, repo, input.planRef);
  // Every requested id must name a real step: silently dropping a typo would
  // leave an audit record claiming a reconciliation that never happened.
  const known = new Set(plan.steps.map((s) => s.id));
  const unknown = input.contradictedStepIds.filter((id) => !known.has(id));
  if (unknown.length > 0) {
    throw new Refusal(`unknown step id(s) for ${input.planRef}: ${unknown.join(', ')} — nothing was flagged; correct the ids and re-submit the judgment`);
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
  //
  // A REFUSAL HERE MUST NOT ESCAPE (Codex on PR #138, 2026-08-25). The labels above
  // and the reconciliation comment have ALREADY landed. `operatorWrite` catches a
  // `Refusal` and redirects to a banner that says, in as many words, that nothing was
  // written — so the one thing this function must never do is throw a Refusal after
  // its own writes have succeeded. It reported a zero-write outcome for a call that
  // flagged a dependency closure and left a permanent comment on the batch issue.
  //
  // Reachable, not theoretical: `reopenPlan` throws `Refusal('already re-opened:
  // branch <ref> exists')` for the branch-creation TOCTOU, which is a different
  // message from the 'awaiting review' case that was already absorbed here.
  //
  // So the re-open's failure becomes part of the OUTCOME rather than an exception.
  // `reopenedAs` stays null — a correction path that does not exist is never claimed
  // (which is why the orphan-branch case was re-thrown in the first place) — and
  // `reopenBlocked` carries the reason, so the caller can report both halves of what
  // truly happened: the flags landed, the re-open did not, and here is why.
  let reopenedAs: string | null = null;
  let reopenBlocked: string | null = null;
  try {
    const reopened = await reopenPlan(gh, repo, { slug: input.workloadSlug, actor: input.actor, at: input.at });
    reopenedAs = reopened.planRef;
  } catch (error: unknown) {
    if (!(error instanceof Error)) throw error;
    // 'awaiting review' keeps its established meaning: a live review absorbs the
    // correction, which is a complete outcome and not a blockage.
    if (error.message.includes('awaiting review')) {
      // nothing to record — the caller's existing copy covers this case
    } else if (isRefusal(error)) {
      reopenBlocked = error.message;
    } else {
      // A genuine fault (a 5xx, an unparseable document) still throws: it is not an
      // expected decision, and the flags having landed does not make it one.
      throw error;
    }
  }
  return { flagged, reopenedAs, reopenBlocked };
}
