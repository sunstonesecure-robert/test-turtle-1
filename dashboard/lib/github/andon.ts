import type { Octokit } from '@octokit/rest';
import type { RepoRef } from './client';
import type { PlanDoc } from '../../../schemas/plan';
import { errorStatus } from './errors';
import {
  parseAndonHeader,
  parseCorrectionMarker,
  parseJudgmentItems,
  serializeAndonHeader,
  serializeJudgmentItem,
  checkJudgmentItem,
  type JudgmentItem,
} from './markers';

/**
 * Andon-break module (tracer surface of T037/T042/T043): create the labeled
 * Andon issue for a proposed plan, open it (open → under-review), judge items ✓.
 * Corrections (✗ path) arrive with the first expansion increment — not the tracer.
 */

export interface AndonBreak {
  issueNumber: number;
  runId: string;
  planRef: string;
  items: JudgmentItem[];
  labels: string[];
}

export function renderAndonBody(plan: PlanDoc, planRef: string): string {
  const items: JudgmentItem[] = [
    ...plan.boundary_cases.map((bc) => ({ id: bc.id, description: bc.description, judged: false })),
  ];
  return [
    serializeAndonHeader({ runId: plan.run_id, planRef }),
    '## Proposed plan',
    `Plan branch: \`${planRef}\` (plan.json)`,
    '',
    '## Judgments required',
    ...items.map(serializeJudgmentItem),
  ].join('\n');
}

/** Agent side (safe output create-issue in production): raise the Andon break. */
export async function createAndonIssue(
  gh: Octokit,
  repo: RepoRef,
  input: { slug: string; plan: PlanDoc; planRef: string },
): Promise<number> {
  const { data: issue } = await gh.issues.create({
    ...repo,
    title: `Andon break: validate plan ${input.planRef}`,
    body: renderAndonBody(input.plan, input.planRef),
    labels: ['andon:open'],
  });
  return issue.number;
}

export async function getAndon(gh: Octokit, repo: RepoRef, issueNumber: number): Promise<AndonBreak> {
  const { data: issue } = await gh.issues.get({ ...repo, issue_number: issueNumber });
  const header = parseAndonHeader(issue.body ?? '');
  if (!header) throw new Error(`issue #${issueNumber} has no andon:v1 header`);
  return {
    issueNumber,
    runId: header.runId,
    planRef: header.planRef,
    items: parseJudgmentItems(issue.body ?? ''),
    labels: (issue.labels ?? []).map((l) => (typeof l === 'string' ? l : (l.name ?? ''))),
  };
}

/**
 * Operator opens the break: andon:open → andon:under-review (FR-003).
 * Idempotent — already under review is a no-op (double submit, stale inbox);
 * a resolved break is refused rather than silently resurrected.
 */
export async function openAndon(gh: Octokit, repo: RepoRef, issueNumber: number): Promise<void> {
  const { data: issue } = await gh.issues.get({ ...repo, issue_number: issueNumber });
  const labels = (issue.labels ?? []).map((l) => (typeof l === 'string' ? l : (l.name ?? '')));
  if (labels.includes('andon:under-review')) return;
  if (!labels.includes('andon:open')) {
    throw new Error(`Andon #${issueNumber} is not open for review (labels: ${labels.join(', ') || 'none'})`);
  }
  try {
    await gh.issues.removeLabel({ ...repo, issue_number: issueNumber, name: 'andon:open' });
  } catch (error: unknown) {
    // TOCTOU: a concurrent open won the race and already removed the label —
    // the same no-op as the under-review check above.
    if (errorStatus(error) !== 404) throw error;
  }
  await gh.issues.addLabels({ ...repo, issue_number: issueNumber, labels: ['andon:under-review'] });
}

/** Operator judges one item ✓ (task-list PATCH). Questions are refused: a
 *  q- item's ✓ comes ONLY through a recorded answer:v1 (recordAnswer) — the
 *  dashboard hides the plain ✓ for questions, and this guard stops a replayed
 *  form POST from checking one without an answer (it would pass the UI's
 *  allJudged and open an approval PR that plan-gate G11 then fails). */
export async function judgeItem(gh: Octokit, repo: RepoRef, issueNumber: number, itemId: string): Promise<void> {
  if (itemId.startsWith('q-')) {
    throw new Error(`question item ${itemId} is answered, not judged ✓ — record an answer instead (FR-055)`);
  }
  const { data: issue } = await gh.issues.get({ ...repo, issue_number: issueNumber });
  const updated = checkJudgmentItem(issue.body ?? '', itemId);
  if (updated === null) throw new Error(`judgment item ${itemId} not found on Andon #${issueNumber}`);
  await gh.issues.update({ ...repo, issue_number: issueNumber, body: updated });
}

/** The LIVE Andon break (open or under-review — both are in-flight reviews;
 *  a review the operator has picked up must still be findable) whose header
 *  references this plan ref; null when none. The labels param is AND-semantic,
 *  so the two states need two queries. */
export async function findOpenAndonByPlanRef(gh: Octokit, repo: RepoRef, planRef: string): Promise<number | null> {
  for (const label of ['andon:open', 'andon:under-review']) {
    const breaks = await gh.paginate(gh.issues.listForRepo, { ...repo, labels: label, state: 'open', per_page: 100 });
    const match = breaks.find((issue) => parseAndonHeader(issue.body ?? '')?.planRef === planRef);
    if (match) return match.number;
  }
  return null;
}

/** Open corrections linked to this Andon (G7 input) — matched via the machine-readable
 *  correction:v1 marker, not substring (andon:12 must not match andon:123). */
export async function openCorrectionCount(gh: Octokit, repo: RepoRef, andonIssue: number): Promise<number> {
  // Paginated: undercounting past page one would let plan-gate G7 pass with corrections open.
  const data = await gh.paginate(gh.issues.listForRepo, { ...repo, labels: 'correction:open', state: 'open', per_page: 100 });
  return data.filter((issue) => parseCorrectionMarker(issue.body ?? '')?.andonIssue === andonIssue).length;
}
