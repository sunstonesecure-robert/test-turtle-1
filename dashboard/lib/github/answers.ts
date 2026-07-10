import { posix } from 'node:path';
import type { Octokit } from '@octokit/rest';
import type { RepoRef } from './client';
import { getAndon } from './andon';
import { listOpenCorrections } from './corrections';
import { errorStatus } from './errors';
import { parseAnswer, parseAnswerText, serializeAnswer, checkJudgmentItem } from './markers';
import {
  violatesSpecialFolderRules,
  contextMaxFileBytes,
  CONTEXT_FOLDERS,
} from '../../../scripts/intake-normalize';

/**
 * Answers module (T195 lib seam, FR-055/FR-056): the operator's channel for
 * agent-posed `q-` question items. An answer is a structured comment on the
 * Andon issue (answer:v1 marker — attributed, timestamped, tied to the item);
 * recording it checks the item. An answer NEVER creates or implies a
 * correction — the two coexist as separate records when the operator
 * additionally flags ✗ (issue-tracker-contract.md §Andon Break).
 *
 * Consumed by both the dashboard composer and plan-gate G11 (checks-core) so
 * UX preview and enforcement read answers identically.
 */

export interface Answer {
  andonIssue: number;
  itemId: string; // q-* only
  by: string;
  at: string; // ISO8601
  text: string; // visible answer text (references included)
}

/** Every recorded answer on this break — matched via the answer:v1 marker,
 *  not substring (andon:12 must not match andon:123), same rule as G7.
 *  The marker's by:@login is attribution, not proof: anyone with comment
 *  rights could paste a marker claiming the operator's identity, and a forged
 *  "answer" would satisfy G11 AND permanently block the real one (answers are
 *  single permanent records). The comment's GitHub author is the ground truth
 *  the forger cannot fake — a mismatch is discarded, fail-closed. */
export async function listAnswers(gh: Octokit, repo: RepoRef, andonIssue: number): Promise<Answer[]> {
  const comments = await gh.paginate(gh.issues.listComments, { ...repo, issue_number: andonIssue, per_page: 100 });
  const answers: Answer[] = [];
  for (const comment of comments) {
    const marker = parseAnswer(comment.body ?? '');
    // Case-insensitive: GitHub logins are case-insensitively unique, and a
    // casing mismatch between OPERATOR_LOGIN and the canonical login must not
    // discard a legitimate answer (it would ALSO blind recordAnswer's
    // duplicate lookup — every retry posting another comment, G11 blocked).
    if (marker && marker.andonIssue === andonIssue && comment.user?.login?.toLowerCase() === marker.by.toLowerCase()) {
      answers.push({ ...marker, text: parseAnswerText(comment.body ?? '') });
    }
  }
  return answers;
}

/**
 * FR-056 reference validation — the SAME rules as FR-053 intake context
 * (special-folder prefix, no traversal/absolute/backslash, must exist, per-file
 * size cap), with existence checked against the TARGET repo via the contents
 * API: the dashboard reviews a remote repo, so the local filesystem is not the
 * checkout the agent will read. Returns the problems; empty means valid.
 */
export async function answerReferenceProblems(
  gh: Octokit,
  repo: RepoRef,
  references: string[],
  opts: { maxFileBytes?: number } = {},
): Promise<string[]> {
  const problems: string[] = [];
  const maxBytes = contextMaxFileBytes(opts.maxFileBytes);
  for (const ref of references) {
    if (violatesSpecialFolderRules(ref)) {
      problems.push(
        `\`${ref}\` is not a repo-relative path inside \`${CONTEXT_FOLDERS.join('/`, `')}/\` (FR-053)`,
      );
      continue;
    }
    const path = posix.normalize(ref);
    try {
      const { data } = await gh.repos.getContent({ ...repo, path });
      // A file reference is size-capped like intake context (PB-004 hang
      // guard); a directory reference is existence-checked only — its files
      // were size-checked when designated, and an API walk is not worth the
      // rate budget here.
      if (!Array.isArray(data) && data.type === 'file' && data.size > maxBytes) {
        const limitMb = (maxBytes / (1024 * 1024)).toFixed(0);
        problems.push(`\`${ref}\` is too large (${(data.size / (1024 * 1024)).toFixed(1)} MB > ${limitMb} MB limit, FR-053)`);
      }
    } catch (error: unknown) {
      if (errorStatus(error) === 404) {
        problems.push(`\`${ref}\` does not exist in the repository (FR-053)`);
      } else {
        throw error;
      }
    }
  }
  return problems;
}

/** Render the recorded answer text: operator's words plus the validated
 *  references as machine-findable lines the agent's revision consumes (FR-056). */
export function renderAnswerText(text: string, references: string[]): string {
  const body = text.trim();
  if (references.length === 0) return body;
  return `${body}\n\nReferences:\n${references.map((r) => `- ${posix.normalize(r)}`).join('\n')}`;
}

/**
 * Record the operator's answer to a `q-` item (FR-055): validates the target
 * item, validates FR-053 references, writes the answer:v1 comment, and checks
 * the item — UNLESS an open correction holds it ✗ (the coexistence case: the
 * checkbox then belongs to the correction round-trip, and only the re-judge
 * may flip it back). Idempotent on a double submit of the identical answer;
 * a DIFFERENT second answer is refused — the record is permanent.
 */
export async function recordAnswer(
  gh: Octokit,
  repo: RepoRef,
  input: { andonIssue: number; itemId: string; by: string; at: string; text: string; references?: string[] },
): Promise<void> {
  if (!input.itemId.startsWith('q-')) {
    throw new Error(`item ${input.itemId} is not a question — answers attach only to q- items (FR-055); use ✓/✗ judgment`);
  }
  const andon = await getAndon(gh, repo, input.andonIssue);
  const item = andon.items.find((i) => i.id === input.itemId);
  if (!item) throw new Error(`question item ${input.itemId} not found on Andon #${input.andonIssue}`);

  // CRLF-normalize before comparing: browser form submissions canonicalize
  // textarea content to \r\n while listAnswers round-trips through
  // parseAnswerText's LF join — without this, the idempotent double submit of
  // any multi-line answer would misread as a DIFFERENT answer and be refused.
  const text = input.text.replace(/\r\n?/g, '\n').trim();
  if (text.length === 0) throw new Error('answer refused: the answer text must not be blank (FR-055)');

  const references = (input.references ?? []).map((r) => r.trim()).filter((r) => r.length > 0);
  const problems = await answerReferenceProblems(gh, repo, references);
  if (problems.length > 0) throw new Error(`answer refused — invalid context reference(s): ${problems.join('; ')}`);

  const rendered = renderAnswerText(text, references);
  const existing = (await listAnswers(gh, repo, input.andonIssue)).find((a) => a.itemId === input.itemId);
  if (existing && existing.text !== rendered) {
    throw new Error(
      `question ${input.itemId} already carries an answer by @${existing.by} at ${existing.at} — answers are permanent records; ` +
        `if the plan is wrong, flag the item ✗ with a correction instead (FR-055)`,
    );
  }

  // Check-then-create: two concurrent first submissions can both pass the
  // lookup and both comment (GitHub has no conditional create). Accepted —
  // listAnswers/G11 read the first record and the duplicate is inert prose.
  if (!existing) {
    await gh.issues.createComment({
      ...repo,
      issue_number: input.andonIssue,
      body: serializeAnswer({ andonIssue: input.andonIssue, itemId: input.itemId, by: input.by, at: input.at }, rendered),
    });
  }

  // The ✓ reconciles on the identical re-submit too, not only the fresh
  // record: when a correction held the box at record time and was later
  // withdrawn (withdrawal is not a ✓, and rejudge requires an OPEN
  // correction), re-submitting the recorded answer is the only path that
  // flips the answered question to ✓ — without it G11 blocks forever.
  const openCorrection = (await listOpenCorrections(gh, repo, input.andonIssue)).some((c) => c.itemId === input.itemId);
  if (!openCorrection) {
    const { data: issue } = await gh.issues.get({ ...repo, issue_number: input.andonIssue });
    const checked = checkJudgmentItem(issue.body ?? '', input.itemId);
    // Skip the no-op PATCH when the box is already ✓ (identical re-submit of
    // an already-reconciled answer) — a wasted write against the rate budget.
    if (checked !== null && checked !== issue.body) {
      await gh.issues.update({ ...repo, issue_number: input.andonIssue, body: checked });
    }
  }
}
