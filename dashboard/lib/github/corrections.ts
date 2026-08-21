import type { Octokit } from '@octokit/rest';
import type { RepoRef } from './client';
import { getAndon } from './andon';
import { errorMessage } from './errors';
import { mergeRecheck } from './read-after-write';
import {
  parseCorrectionMarker,
  serializeCorrectionMarker,
  serializeCorrectionEvent,
  uncheckJudgmentItem,
  checkJudgmentItem,
  parseAddressesTrailers,
} from './markers';

/**
 * Corrections module (T034, FR-004/FR-005): the ✗ half of the Andon judgment.
 * A correction is a sub-issue of the break (linked via the correction:v1
 * marker) carrying exactly one specific, actionable instruction. State machine
 * (data-model.md "Correction"):
 *
 *   open → addressed   ONLY via an `addresses: correction #N` revision commit
 *                      on the plan branch + the operator's re-judge ✓
 *   open → withdrawn   ONLY by explicit operator action, or the single writer
 *                      closing the parent break unapproved (cascade, cause
 *                      recorded — no orphaned correction:open outlives its break)
 *
 * Terminal corrections are CLOSED, never deleted — the audit trail is forever.
 */

export type CorrectionState = 'open' | 'addressed' | 'withdrawn';

export interface Correction {
  issueNumber: number;
  andonIssue: number;
  /** null = BREAK-LEVEL: about the proposal as a whole, not one item (GHI #73 A1). */
  itemId: string | null;
  state: CorrectionState;
  instruction: string;
}

const INSTRUCTION_HEADING = '**Instruction (exactly one, actionable):**';

/**
 * Exactly-one-instruction template validation (FR-004): the agent receives ONE
 * specific actionable instruction — not a paragraph of context, not a list of
 * asks. Returns the problems; empty means valid.
 */
export function instructionProblems(instruction: string): string[] {
  const problems: string[] = [];
  const trimmed = instruction.trim();
  if (trimmed.length === 0) {
    problems.push('instruction is empty — state exactly one specific, actionable instruction (FR-004)');
    return problems;
  }
  if (/\n\s*\n/.test(trimmed)) {
    problems.push('multiple paragraphs — a correction carries exactly one instruction; send the rest as separate corrections');
  }
  const listItems = trimmed.split('\n').filter((line) => /^\s*([-*+]|\d+[.)])\s+/.test(line));
  if (listItems.length >= 2) {
    problems.push(`${listItems.length} list items — a correction carries exactly one instruction; send one correction per item`);
  }
  return problems;
}

export function renderCorrectionBody(andonIssue: number, itemId: string | null, instruction: string): string {
  return [
    serializeCorrectionMarker({ andonIssue, itemId }),
    // Human-visible linkage (live PB-003 finding E): the marker renders
    // invisibly and a "#N" in the TITLE never linkifies — a GHI operator saw no
    // connection between break and correction. A #N mention in the BODY
    // linkifies AND writes a "mentioned" backreference onto the break's timeline.
    itemId === null
      ? `**Correction** for the proposal as a whole on Andon #${andonIssue} (no single item — a scope/intent request, FR-036)`
      : `**Correction** for judgment item \`${itemId}\` on Andon #${andonIssue}`,
    '',
    INSTRUCTION_HEADING,
    instruction.trim(),
  ].join('\n');
}

export function parseInstruction(body: string): string {
  const index = body.indexOf(INSTRUCTION_HEADING);
  return index === -1 ? '' : body.slice(index + INSTRUCTION_HEADING.length).trim();
}

function correctionState(labels: string[]): CorrectionState | null {
  if (labels.includes('correction:open')) return 'open';
  if (labels.includes('correction:addressed')) return 'addressed';
  if (labels.includes('correction:withdrawn')) return 'withdrawn';
  return null;
}

function toCorrection(issue: { number: number; body?: string | null; labels?: unknown[] }): Correction | null {
  const marker = parseCorrectionMarker(issue.body ?? '');
  if (!marker) return null;
  const labels = (issue.labels ?? []).map((l) => (typeof l === 'string' ? l : ((l as { name?: string }).name ?? '')));
  const state = correctionState(labels);
  if (!state) return null;
  return {
    issueNumber: issue.number,
    andonIssue: marker.andonIssue,
    itemId: marker.itemId,
    state,
    instruction: parseInstruction(issue.body ?? ''),
  };
}

export async function getCorrection(gh: Octokit, repo: RepoRef, issueNumber: number): Promise<Correction> {
  const { data: issue } = await gh.issues.get({ ...repo, issue_number: issueNumber });
  const correction = toCorrection(issue);
  if (!correction) throw new Error(`issue #${issueNumber} is not a correction (no correction:v1 marker or correction:* label)`);
  return correction;
}

/** Every correction ever sent for this break — open, addressed, and withdrawn (records are permanent).
 *  Three paginated calls by necessity; callers that only need OPEN corrections
 *  (the dup check, re-judge, cascade, the activity guard) use listOpenCorrections.
 *
 *  `recheck` names corrections the caller KNOWS the current state of because it
 *  just wrote them, and whose state therefore comes from the single-issue GET
 *  instead of the LIST. GitHub's LIST endpoints are not read-after-write
 *  consistent (PB-003 finding B — the same lag `sendCorrection`'s supersedes
 *  path already guards against), so a render immediately after a write can miss
 *  a correction that was just created or still show the pre-write labels on one
 *  that was just changed. Either way the operator sees the page they had BEFORE
 *  their click and concludes the action did nothing — hit live 2026-08-16 on a
 *  ✗ against `st-unresolved-tz`, where the correction (#32) was created
 *  correctly and the re-render showed no sign of it until a later write pushed
 *  a second render past the lag.
 *
 *  Unknown, foreign, or already-deleted numbers are ignored rather than trusted:
 *  the caller is a URL parameter away from the browser, so this must not be a
 *  way to inject a record into somebody else's review. */
export async function listCorrections(
  gh: Octokit,
  repo: RepoRef,
  andonIssue: number,
  opts: { recheck?: number[] } = {},
): Promise<Correction[]> {
  const corrections: Correction[] = [];
  for (const label of ['correction:open', 'correction:addressed', 'correction:withdrawn']) {
    const issues = await gh.paginate(gh.issues.listForRepo, { ...repo, labels: label, state: 'all', per_page: 100 });
    for (const issue of issues) {
      const correction = toCorrection(issue);
      if (correction?.andonIssue === andonIssue) corrections.push(correction);
    }
  }

  // A correction belonging to ANOTHER review is declined, not merged: the hint is
  // a URL parameter away from the browser, so it must not be a way to pull a
  // foreign record into this review (FR-046).
  return mergeRecheck(
    corrections,
    opts.recheck,
    async (issueNumber) => {
      const live = await getCorrection(gh, repo, issueNumber);
      // `null`, never `'absent'`: a correction belonging to another review is not
      // ours to remove, and corrections never leave this list (state: 'all').
      return live.andonIssue === andonIssue ? { item: live } : null;
    },
    (c) => c.issueNumber,
  );
}

/** Only the OPEN corrections for this break — one filtered call (label + state),
 *  the same idiom as openCorrectionCount / plan-gate G7. */
export async function listOpenCorrections(gh: Octokit, repo: RepoRef, andonIssue: number): Promise<Correction[]> {
  const issues = await gh.paginate(gh.issues.listForRepo, { ...repo, labels: 'correction:open', state: 'open', per_page: 100 });
  return issues
    .map((issue) => toCorrection(issue))
    .filter((c): c is Correction => c !== null && c.andonIssue === andonIssue);
}

/**
 * ✗ judgment (FR-004): record one actionable instruction as a correction:open
 * sub-issue tied to the flagged item. Re-flagging a previously ✓ item unchecks
 * it — the item is open until the revised plan addresses it.
 */
export async function sendCorrection(
  gh: Octokit,
  repo: RepoRef,
  input: { andonIssue: number; itemId?: string; instruction: string; supersedes?: number },
): Promise<number> {
  const problems = instructionProblems(input.instruction);
  if (problems.length > 0) throw new Error(`correction refused — exactly one actionable instruction (FR-004): ${problems.join('; ')}`);

  // An absent itemId is a BREAK-LEVEL correction: the request is about the proposal
  // as a whole, not one of its judgment items (US11 scope requests — GHI #73 option
  // A1). It still blocks approval, because G7 counts corrections linked to the
  // break and never reads an item.
  const itemId = input.itemId ?? null;
  const andon = await getAndon(gh, repo, input.andonIssue);
  if (itemId !== null && !andon.items.some((i) => i.id === itemId)) {
    throw new Error(`judgment item ${itemId} not found on Andon #${input.andonIssue}`);
  }
  const item = itemId === null ? undefined : andon.items.find((i) => i.id === itemId);

  // One open correction per subject: per item as before, and at most one
  // break-level one — otherwise a retried scope edit would stack duplicates that
  // each need withdrawing before approval can proceed.
  const open = (await listOpenCorrections(gh, repo, input.andonIssue)).find((c) => c.itemId === itemId);
  if (open && open.issueNumber === input.supersedes) {
    // The caller just withdrew this exact correction (the revise path), but the
    // LIST endpoint is not read-after-write consistent (PB-003 finding B) and can
    // serve the stale correction:open row for a beat — hit live 2026-08-16: a
    // revise withdrew #30, then refused its own replacement because the list
    // still showed #30 open. The GET endpoint IS consistent: re-read the single
    // issue, and only trust the hint when it confirms the withdrawal.
    const live = await getCorrection(gh, repo, open.issueNumber);
    if (live.state === 'open') {
      throw new Error(
        `correction #${open.issueNumber} is still open — supersedes may only name a correction that was just withdrawn`,
      );
    }
  } else if (open) {
    throw new Error(
      itemId === null
        ? `Andon #${input.andonIssue} already has an open break-level correction (#${open.issueNumber}) — revise or withdraw it before sending another`
        : `item ${itemId} already has an open correction (#${open.issueNumber}) — revise or withdraw it before sending another`,
    );
  }

  // Only an item-scoped correction unchecks anything: a break-level one flags no
  // checkbox, so there is none to clear (and G8's per-item judgment is untouched).
  if (item?.judged) {
    const { data: issue } = await gh.issues.get({ ...repo, issue_number: input.andonIssue });
    const unchecked = uncheckJudgmentItem(issue.body ?? '', item.id);
    if (unchecked !== null) await gh.issues.update({ ...repo, issue_number: input.andonIssue, body: unchecked });
  }

  const { data: created } = await gh.issues.create({
    ...repo,
    title: itemId === null
      ? `Correction: proposal scope (Andon #${input.andonIssue})`
      : `Correction: ${itemId} (Andon #${input.andonIssue})`,
    body: renderCorrectionBody(input.andonIssue, itemId, input.instruction),
    labels: ['correction:open'],
  });

  // Native sub-issue attach (data-model: a correction IS a sub-issue of its
  // break) so the GitHub UI shows the parent/child tree. Best-effort: the
  // correction:v1 marker stays the authoritative machine linkage — it alone
  // carries the item id, and the gates key on it — so an API/plan without
  // sub-issues must not block the correction (FR-004); the body reference
  // above still links the records for the operator.
  try {
    await gh.request('POST /repos/{owner}/{repo}/issues/{issue_number}/sub_issues', {
      ...repo,
      issue_number: input.andonIssue,
      sub_issue_id: created.id,
    });
  } catch (error: unknown) {
    console.warn(`sub-issue attach failed for correction #${created.number} → Andon #${input.andonIssue} (non-fatal): ${errorMessage(error)}`);
  }
  return created.number;
}

/**
 * Every correction cited by a commit on the plan branch, with the citing
 * commit's sha and date — the review page's "revision landed" indicator (live
 * finding, PB run 2026-08-16: the agent ran and landed a revision and the page
 * showed NOTHING — every state change must be visible). One page from the tip,
 * same bound and rationale as revisionCites below.
 */
export async function citedCorrections(
  gh: Octokit,
  repo: RepoRef,
  planRef: string,
): Promise<Map<number, { sha: string; at: string | null }>> {
  const { data: commits } = await gh.repos.listCommits({ ...repo, sha: planRef, per_page: 100 });
  const cited = new Map<number, { sha: string; at: string | null }>();
  // Walk oldest-last so the NEWEST citing commit wins for each correction.
  for (const c of [...commits].reverse()) {
    for (const n of parseAddressesTrailers(c.commit.message ?? '')) {
      cited.set(n, { sha: c.sha, at: c.commit.committer?.date ?? c.commit.author?.date ?? null });
    }
  }
  return cited;
}

/** Does any commit on the plan branch cite this correction (`addresses: correction #N`)?
 *  One page from the tip is enough: a plan branch carries the publish commit plus a
 *  handful of revisions, while paginating past them would walk the entire base-branch
 *  history back to root. A citation beyond 100 commits fails CLOSED (re-judge refused). */
export async function revisionCites(gh: Octokit, repo: RepoRef, planRef: string, correctionIssue: number): Promise<boolean> {
  const { data: commits } = await gh.repos.listCommits({ ...repo, sha: planRef, per_page: 100 });
  // ALL trailers per commit: one plan-revise commit may carry out several
  // corrections, and matching only the first would strand the rest (2026-08-16).
  return commits.some((c) => parseAddressesTrailers(c.commit.message ?? '').includes(correctionIssue));
}

async function closeCorrection(
  gh: Octokit,
  repo: RepoRef,
  issueNumber: number,
  to: Exclude<CorrectionState, 'open'>,
  event: { by: string; at: string; cause?: string },
): Promise<void> {
  await gh.issues.createComment({
    ...repo,
    issue_number: issueNumber,
    body: serializeCorrectionEvent({ action: to, by: event.by, at: event.at, ...(event.cause !== undefined ? { cause: event.cause } : {}) }),
  });
  await gh.issues.removeLabel({ ...repo, issue_number: issueNumber, name: 'correction:open' }).catch(() => {});
  await gh.issues.addLabels({ ...repo, issue_number: issueNumber, labels: [`correction:${to}`] });
  await gh.issues.update({ ...repo, issue_number: issueNumber, state: 'closed' });
}

/**
 * Operator re-judge ✓ on a corrected item: the ONLY path to correction:addressed.
 * Refused until the agent's revision commit on the plan branch cites the
 * correction id — a ✓ on an unrevised plan would silently drop the instruction.
 */
export async function rejudgeItem(
  gh: Octokit,
  repo: RepoRef,
  /** itemId absent = re-judge the BREAK-LEVEL request (GHI #73 A1) — the scope/intent
   *  correction that has no item. Same contract either way: refused until a revision
   *  cites it, so a ✓ can never silently drop the instruction. */
  input: { andonIssue: number; itemId?: string; by: string; at: string },
  /** the correction this ✓ addressed — the caller re-reads it past the list lag */
): Promise<number> {
  const itemId = input.itemId ?? null;
  const open = (await listOpenCorrections(gh, repo, input.andonIssue)).find((c) => c.itemId === itemId);
  if (!open) {
    throw new Error(
      itemId === null
        ? `no open break-level correction on Andon #${input.andonIssue} — nothing to re-judge`
        : `no open correction for item ${itemId} on Andon #${input.andonIssue} — use the plain ✓ judgment`,
    );
  }

  const andon = await getAndon(gh, repo, input.andonIssue);
  if (!(await revisionCites(gh, repo, andon.planRef, open.issueNumber))) {
    throw new Error(
      `re-judge refused: no revision commit on ${andon.planRef} cites correction #${open.issueNumber} ` +
        `(the agent must commit with "addresses: correction #${open.issueNumber}") — the item stays open (FR-004)`,
    );
  }

  await closeCorrection(gh, repo, open.issueNumber, 'addressed', { by: input.by, at: input.at });
  // A break-level request flags no checkbox, so there is none to tick — its
  // resolution IS the correction closing, which is what releases G7.
  if (itemId !== null) {
    const { data: issue } = await gh.issues.get({ ...repo, issue_number: input.andonIssue });
    const checked = checkJudgmentItem(issue.body ?? '', itemId);
    if (checked !== null) await gh.issues.update({ ...repo, issue_number: input.andonIssue, body: checked });
  }
  return open.issueNumber;
}

/**
 * Explicit operator withdrawal (FR-004): the operator retracts the instruction;
 * the cause is recorded. The item remains unjudged — withdrawal is not a ✓.
 * Idempotent on an already-withdrawn correction (double submit).
 */
export async function withdrawCorrection(
  gh: Octokit,
  repo: RepoRef,
  issueNumber: number,
  input: { by: string; at: string; cause: string },
): Promise<void> {
  if (input.cause.trim().length === 0) throw new Error('withdrawal refused: a cause must be recorded (data-model "Correction")');
  const correction = await getCorrection(gh, repo, issueNumber);
  if (correction.state === 'withdrawn') return;
  if (correction.state === 'addressed') {
    throw new Error(`correction #${issueNumber} is already addressed — the round-trip is closed; it cannot be withdrawn`);
  }
  await closeCorrection(gh, repo, issueNumber, 'withdrawn', input);
}

/**
 * Revise an open ITEM correction's instruction (live operator finding, PB run
 * 2026-08-16: a terse instruction could not be improved — one open correction
 * per item, and no path to replace its text, so the better wording had nowhere
 * to land). One act, two records: the old correction closes as withdrawn with
 * a "superseded by revised instruction" cause, and a fresh correction carries
 * the new text — the audit keeps both, the agent sees only the live one.
 * The NEW instruction is validated FIRST, so a bad revision refuses before
 * anything is withdrawn and the old correction keeps blocking (fail-safe).
 * Break-level requests are deliberately excluded: they are authored by the
 * scope-edit route and revising them here would fork that record.
 */
export async function reviseCorrection(
  gh: Octokit,
  repo: RepoRef,
  correctionIssue: number,
  input: { andonIssue: number; itemId: string; instruction: string; by: string; at: string },
): Promise<number> {
  const problems = instructionProblems(input.instruction);
  if (problems.length > 0) {
    throw new Error(`revision refused — exactly one actionable instruction (FR-004): ${problems.join('; ')}`);
  }
  const correction = await getCorrection(gh, repo, correctionIssue);
  if (correction.state !== 'open') {
    throw new Error(`correction #${correctionIssue} is ${correction.state} — only an open correction can be revised`);
  }
  if (correction.itemId !== input.itemId) {
    throw new Error(`correction #${correctionIssue} belongs to ${correction.itemId ?? 'the whole proposal'}, not ${input.itemId}`);
  }
  await withdrawCorrection(gh, repo, correctionIssue, {
    by: input.by,
    at: input.at,
    cause: 'superseded by a revised instruction (re-sent with new text)',
  });
  // supersedes: the list endpoint may still serve the just-withdrawn correction
  // as open (read-after-write lag, PB-003 finding B — hit live 2026-08-16);
  // naming it lets the dup-check verify via the consistent GET instead.
  return sendCorrection(gh, repo, {
    andonIssue: input.andonIssue,
    itemId: input.itemId,
    instruction: input.instruction,
    supersedes: correctionIssue,
  });
}

/**
 * Cascade for the single writer closing a break unapproved (superseded /
 * workload cancel): every open correction closes as withdrawn with the cause
 * recorded — no orphaned correction:open outlives its break. Returns the count.
 */
export async function withdrawOpenCorrections(
  gh: Octokit,
  repo: RepoRef,
  andonIssue: number,
  input: { by: string; at: string; cause: string },
  /** the corrections withdrawn, by number — callers that re-render need them to
   *  read past the list lag; `.length` is the count this used to return. */
): Promise<number[]> {
  const open = await listOpenCorrections(gh, repo, andonIssue);
  for (const correction of open) {
    await closeCorrection(gh, repo, correction.issueNumber, 'withdrawn', input);
  }
  return open.map((c) => c.issueNumber);
}
