import type { Octokit } from '@octokit/rest';
import type { RepoRef } from './client';
import type { PlanDoc } from '../../../schemas/plan';
import {
  parseAndonHeader,
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

/** Operator opens the break: andon:open → andon:under-review (FR-003). */
export async function openAndon(gh: Octokit, repo: RepoRef, issueNumber: number): Promise<void> {
  await gh.issues.removeLabel({ ...repo, issue_number: issueNumber, name: 'andon:open' });
  await gh.issues.addLabels({ ...repo, issue_number: issueNumber, labels: ['andon:under-review'] });
}

/** Operator judges one item ✓ (task-list PATCH). */
export async function judgeItem(gh: Octokit, repo: RepoRef, issueNumber: number, itemId: string): Promise<void> {
  const { data: issue } = await gh.issues.get({ ...repo, issue_number: issueNumber });
  const updated = checkJudgmentItem(issue.body ?? '', itemId);
  if (updated === null) throw new Error(`judgment item ${itemId} not found on Andon #${issueNumber}`);
  await gh.issues.update({ ...repo, issue_number: issueNumber, body: updated });
}

/** Open corrections linked to this Andon (G7 input). */
export async function openCorrectionCount(gh: Octokit, repo: RepoRef, andonIssue: number): Promise<number> {
  const { data } = await gh.issues.listForRepo({ ...repo, labels: 'correction:open', state: 'open', per_page: 100 });
  return data.filter((issue) => (issue.body ?? '').includes(`andon:${andonIssue}`)).length;
}
