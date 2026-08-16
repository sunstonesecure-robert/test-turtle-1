import type { Octokit } from '@octokit/rest';
import type { RepoRef } from './client';
import { errorStatus } from './errors';
import { parseIntentConfirmed, serializeIntentConfirmed } from './markers';

/**
 * Chunks module (T082, FR-016–FR-018): the just-in-time elaboration backlog.
 * A chunk is an Issue carrying exactly one `chunk:*` label:
 *   chunk:title-only  — a one-line title IS a valid backlog item (FR-016)
 *   chunk:ready       — full requirement present: Intent + empirically testable
 *                       outcome metric + Acceptance (FR-017)
 * `intent:confirmed` (label + structured comment, FR-018) additionally permits
 * UNATTENDED runs — preflight B4 requires the well-formed comment, not just the
 * label, because only the comment carries identity + timestamp.
 */

export interface Chunk {
  issueNumber: number;
  title: string;
  state: 'title-only' | 'ready';
  intentConfirmed: boolean;
  intent: string | null;
  outcomeMetric: string | null;
  acceptance: string | null;
  assignee: string | null;
}

// Body sections mirror the chunk issue form (templates/ISSUE_TEMPLATE/chunk.yml):
// GitHub issue forms render each field as `### <label>` followed by the value.
const SECTIONS = {
  intent: '### Intent',
  outcomeMetric: '### Empirically testable outcome metric',
  acceptance: '### Acceptance',
} as const;

export function renderChunkBody(fields: { intent: string; outcomeMetric: string; acceptance: string }): string {
  return [
    SECTIONS.intent,
    '',
    fields.intent,
    '',
    SECTIONS.outcomeMetric,
    '',
    fields.outcomeMetric,
    '',
    SECTIONS.acceptance,
    '',
    fields.acceptance,
  ].join('\n');
}

/** Section text between one `###` heading and the next; null when absent or blank. */
export function parseChunkBody(body: string): { intent: string | null; outcomeMetric: string | null; acceptance: string | null } {
  const section = (heading: string): string | null => {
    const start = body.indexOf(heading);
    if (start === -1) return null;
    const rest = body.slice(start + heading.length);
    const next = rest.search(/\n### /);
    const text = (next === -1 ? rest : rest.slice(0, next)).trim();
    return text.length > 0 ? text : null;
  };
  return {
    intent: section(SECTIONS.intent),
    outcomeMetric: section(SECTIONS.outcomeMetric),
    acceptance: section(SECTIONS.acceptance),
  };
}

type IssueLike = {
  number: number;
  title: string;
  body?: string | null;
  labels?: (string | { name?: string })[];
  assignee?: { login: string } | null;
  pull_request?: unknown;
};

function labelNames(issue: IssueLike): string[] {
  return (issue.labels ?? []).map((l) => (typeof l === 'string' ? l : (l.name ?? '')));
}

function toChunk(issue: IssueLike): Chunk | null {
  const labels = labelNames(issue);
  const state = labels.includes('chunk:ready') ? 'ready' : labels.includes('chunk:title-only') ? 'title-only' : null;
  if (state === null) return null;
  const fields = parseChunkBody(issue.body ?? '');
  return {
    issueNumber: issue.number,
    title: issue.title,
    state,
    intentConfirmed: labels.includes('intent:confirmed'),
    intent: fields.intent,
    outcomeMetric: fields.outcomeMetric,
    acceptance: fields.acceptance,
    assignee: issue.assignee?.login ?? null,
  };
}

export async function listChunks(gh: Octokit, repo: RepoRef): Promise<Chunk[]> {
  // Two exact-label queries instead of one unfiltered scan: chunk:* labels are
  // mutually exclusive (FR-025), so the union is complete and disjoint.
  const [titleOnly, ready] = await Promise.all([
    gh.paginate(gh.issues.listForRepo, { ...repo, labels: 'chunk:title-only', state: 'open', per_page: 100 }),
    gh.paginate(gh.issues.listForRepo, { ...repo, labels: 'chunk:ready', state: 'open', per_page: 100 }),
  ]);
  return [...titleOnly, ...ready]
    .filter((issue) => !issue.pull_request)
    .map((issue) => toChunk(issue))
    .filter((c): c is Chunk => c !== null)
    .sort((a, b) => a.issueNumber - b.issueNumber);
}

export async function getChunk(gh: Octokit, repo: RepoRef, issueNumber: number): Promise<Chunk | null> {
  const { data: issue } = await gh.issues.get({ ...repo, issue_number: issueNumber });
  if (issue.pull_request) return null;
  return toChunk(issue);
}

/** A one-line title is a complete, valid backlog item (FR-016). */
export async function createChunk(gh: Octokit, repo: RepoRef, input: { title: string }): Promise<Chunk> {
  if (input.title.trim().length === 0) throw new Error('a chunk needs at least a title');
  const { data: issue } = await gh.issues.create({
    ...repo,
    title: input.title,
    labels: ['chunk:title-only'],
  });
  return toChunk(issue)!;
}

/**
 * Promotion to chunk:ready requires ALL THREE fields non-empty (FR-017) —
 * the empirically testable outcome metric is what makes the requirement
 * testable, so an empty field is a refusal, not a default.
 */
export async function promoteChunk(
  gh: Octokit,
  repo: RepoRef,
  input: { issueNumber: number; intent: string; outcomeMetric: string; acceptance: string },
): Promise<Chunk> {
  const missing = (['intent', 'outcomeMetric', 'acceptance'] as const).filter((f) => input[f].trim().length === 0);
  if (missing.length > 0) {
    throw new Error(`promotion refused — empty field(s): ${missing.join(', ')} (FR-017 needs the full requirement)`);
  }
  await gh.issues.update({
    ...repo,
    issue_number: input.issueNumber,
    body: renderChunkBody({ intent: input.intent, outcomeMetric: input.outcomeMetric, acceptance: input.acceptance }),
  });
  // Writing the requirement REVOKES any prior intent confirmation: the operator
  // confirmed the OLD text, and B4 would otherwise accept the stale record to
  // authorize an unattended run on requirements nobody confirmed (FR-018;
  // PR #74 bot finding). The confirmation comment stays — append-only audit —
  // but without the label, B4 blocks until a fresh confirmation.
  await removeLabelIfPresent(gh, repo, input.issueNumber, 'intent:confirmed');
  await removeLabelIfPresent(gh, repo, input.issueNumber, 'chunk:title-only');
  await gh.issues.addLabels({ ...repo, issue_number: input.issueNumber, labels: ['chunk:ready'] });
  const chunk = await getChunk(gh, repo, input.issueNumber);
  if (!chunk) throw new Error(`issue #${input.issueNumber} is not a chunk after promotion`);
  return chunk;
}

/** Demotion back to title-only is allowed only while the chunk is UNASSIGNED —
 *  once an agent (or anyone) holds it, the requirement may be in use. */
export async function demoteChunk(gh: Octokit, repo: RepoRef, issueNumber: number): Promise<Chunk> {
  const { data: issue } = await gh.issues.get({ ...repo, issue_number: issueNumber });
  if (issue.assignee) {
    throw new Error(`demotion refused — chunk #${issueNumber} is assigned to @${issue.assignee.login}; demotion is only allowed while unassigned`);
  }
  // A demoted chunk has no requirement to have confirmed intent about (FR-018):
  // revoke the label so a later re-promotion cannot ride the old confirmation.
  await removeLabelIfPresent(gh, repo, issueNumber, 'intent:confirmed');
  await removeLabelIfPresent(gh, repo, issueNumber, 'chunk:ready');
  await gh.issues.addLabels({ ...repo, issue_number: issueNumber, labels: ['chunk:title-only'] });
  const chunk = await getChunk(gh, repo, issueNumber);
  if (!chunk) throw new Error(`issue #${issueNumber} is not a chunk after demotion`);
  return chunk;
}

/** 404-only tolerance: an absent label is the expected no-op; any other failure
 *  (auth, transport, server) must abort, or the chunk ends up carrying two
 *  mutually exclusive chunk:* labels (same convention as GHI #52). */
async function removeLabelIfPresent(gh: Octokit, repo: RepoRef, issueNumber: number, name: string): Promise<void> {
  try {
    await gh.issues.removeLabel({ ...repo, issue_number: issueNumber, name });
  } catch (error: unknown) {
    if (errorStatus(error) !== 404) throw error;
  }
}

/**
 * Operator confirms the chunk's intent is aligned (FR-018): a structured,
 * attributable comment PLUS the intent:confirmed label. Comment first — if the
 * label write then fails, the durable record exists and a re-run converges;
 * the reverse order could leave a label with no record behind it.
 */
export async function confirmIntent(
  gh: Octokit,
  repo: RepoRef,
  input: { issueNumber: number; actor: string; at: string },
): Promise<void> {
  await gh.issues.createComment({
    ...repo,
    issue_number: input.issueNumber,
    body: serializeIntentConfirmed({ by: input.actor, at: input.at, chunk: input.issueNumber }),
  });
  await gh.issues.addLabels({ ...repo, issue_number: input.issueNumber, labels: ['intent:confirmed'] });
}

/** The well-formed confirmation comment for this chunk, or null (B4's input). */
export async function findIntentConfirmation(
  gh: Octokit,
  repo: RepoRef,
  issueNumber: number,
): Promise<{ by: string; at: string } | null> {
  const comments = await gh.paginate(gh.issues.listComments, { ...repo, issue_number: issueNumber, per_page: 100 });
  for (const comment of comments) {
    const parsed = parseIntentConfirmed(comment.body ?? '');
    if (parsed && parsed.chunk === issueNumber) return { by: parsed.by, at: parsed.at };
  }
  return null;
}
