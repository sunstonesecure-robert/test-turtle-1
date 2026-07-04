import type { Octokit } from '@octokit/rest';
import type { RepoRef } from './client';
import { getAndon } from './andon';
import {
  parseCorrectionMarker,
  serializeCorrectionMarker,
  serializeCorrectionEvent,
  uncheckJudgmentItem,
  checkJudgmentItem,
  parseAddressesTrailer,
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
  itemId: string;
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

export function renderCorrectionBody(andonIssue: number, itemId: string, instruction: string): string {
  return [serializeCorrectionMarker({ andonIssue, itemId }), INSTRUCTION_HEADING, instruction.trim()].join('\n');
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

/** Every correction ever sent for this break — open, addressed, and withdrawn (records are permanent). */
export async function listCorrections(gh: Octokit, repo: RepoRef, andonIssue: number): Promise<Correction[]> {
  const corrections: Correction[] = [];
  for (const label of ['correction:open', 'correction:addressed', 'correction:withdrawn']) {
    const issues = await gh.paginate(gh.issues.listForRepo, { ...repo, labels: label, state: 'all', per_page: 100 });
    for (const issue of issues) {
      const correction = toCorrection(issue);
      if (correction?.andonIssue === andonIssue) corrections.push(correction);
    }
  }
  return corrections;
}

/**
 * ✗ judgment (FR-004): record one actionable instruction as a correction:open
 * sub-issue tied to the flagged item. Re-flagging a previously ✓ item unchecks
 * it — the item is open until the revised plan addresses it.
 */
export async function sendCorrection(
  gh: Octokit,
  repo: RepoRef,
  input: { andonIssue: number; itemId: string; instruction: string },
): Promise<number> {
  const problems = instructionProblems(input.instruction);
  if (problems.length > 0) throw new Error(`correction refused — exactly one actionable instruction (FR-004): ${problems.join('; ')}`);

  const andon = await getAndon(gh, repo, input.andonIssue);
  const item = andon.items.find((i) => i.id === input.itemId);
  if (!item) throw new Error(`judgment item ${input.itemId} not found on Andon #${input.andonIssue}`);

  const existing = await listCorrections(gh, repo, input.andonIssue);
  const open = existing.find((c) => c.itemId === input.itemId && c.state === 'open');
  if (open) {
    throw new Error(
      `item ${input.itemId} already has an open correction (#${open.issueNumber}) — revise or withdraw it before sending another`,
    );
  }

  if (item.judged) {
    const { data: issue } = await gh.issues.get({ ...repo, issue_number: input.andonIssue });
    const unchecked = uncheckJudgmentItem(issue.body ?? '', input.itemId);
    if (unchecked !== null) await gh.issues.update({ ...repo, issue_number: input.andonIssue, body: unchecked });
  }

  const { data: created } = await gh.issues.create({
    ...repo,
    title: `Correction: ${input.itemId} (Andon #${input.andonIssue})`,
    body: renderCorrectionBody(input.andonIssue, input.itemId, input.instruction),
    labels: ['correction:open'],
  });
  return created.number;
}

/** Does any commit on the plan branch cite this correction (`addresses: correction #N`)?
 *  One page from the tip is enough: a plan branch carries the publish commit plus a
 *  handful of revisions, while paginating past them would walk the entire base-branch
 *  history back to root. A citation beyond 100 commits fails CLOSED (re-judge refused). */
export async function revisionCites(gh: Octokit, repo: RepoRef, planRef: string, correctionIssue: number): Promise<boolean> {
  const { data: commits } = await gh.repos.listCommits({ ...repo, sha: planRef, per_page: 100 });
  return commits.some((c) => parseAddressesTrailer(c.commit.message ?? '') === correctionIssue);
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
  input: { andonIssue: number; itemId: string; by: string; at: string },
): Promise<void> {
  const corrections = await listCorrections(gh, repo, input.andonIssue);
  const open = corrections.find((c) => c.itemId === input.itemId && c.state === 'open');
  if (!open) {
    throw new Error(`no open correction for item ${input.itemId} on Andon #${input.andonIssue} — use the plain ✓ judgment`);
  }

  const andon = await getAndon(gh, repo, input.andonIssue);
  if (!(await revisionCites(gh, repo, andon.planRef, open.issueNumber))) {
    throw new Error(
      `re-judge refused: no revision commit on ${andon.planRef} cites correction #${open.issueNumber} ` +
        `(the agent must commit with "addresses: correction #${open.issueNumber}") — the item stays open (FR-004)`,
    );
  }

  await closeCorrection(gh, repo, open.issueNumber, 'addressed', { by: input.by, at: input.at });
  const { data: issue } = await gh.issues.get({ ...repo, issue_number: input.andonIssue });
  const checked = checkJudgmentItem(issue.body ?? '', input.itemId);
  if (checked !== null) await gh.issues.update({ ...repo, issue_number: input.andonIssue, body: checked });
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
 * Cascade for the single writer closing a break unapproved (superseded /
 * workload cancel): every open correction closes as withdrawn with the cause
 * recorded — no orphaned correction:open outlives its break. Returns the count.
 */
export async function withdrawOpenCorrections(
  gh: Octokit,
  repo: RepoRef,
  andonIssue: number,
  input: { by: string; at: string; cause: string },
): Promise<number> {
  const corrections = await listCorrections(gh, repo, andonIssue);
  const open = corrections.filter((c) => c.state === 'open');
  for (const correction of open) {
    await closeCorrection(gh, repo, correction.issueNumber, 'withdrawn', input);
  }
  return open.length;
}
