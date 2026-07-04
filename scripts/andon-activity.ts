import type { Octokit } from '@octokit/rest';
import { createClient, type RepoRef } from '../dashboard/lib/github/client';
import { parseAndonHeader, parseJudgmentItems } from '../dashboard/lib/github/markers';
import { openAndon } from '../dashboard/lib/github/andon';
import { errorMessage } from '../dashboard/lib/github/errors';

/**
 * Andon-activity normalizer (FR-003 for the GitHub-UI flow): the
 * open → under-review transition previously had only a dashboard trigger, so
 * UI-driven reviews (operator ticking judgment checkboxes directly on the
 * issue) recorded open → resolved, skipping the state that documents when the
 * operator engaged (live PB-002 finding D). Run by the andon-activity
 * workflow on issue edits: the first recorded judgment on an andon:open
 * break flips it to under-review — the operator's first real engagement is
 * the trigger.
 */

export type ActivityResult = 'under-review' | 'no-op';

export async function normalizeAndonActivity(gh: Octokit, repo: RepoRef, issueNumber: number): Promise<ActivityResult> {
  const { data: issue } = await gh.issues.get({ ...repo, issue_number: issueNumber });
  const labels = (issue.labels ?? []).map((l) => (typeof l === 'string' ? l : (l.name ?? '')));
  if (!labels.includes('andon:open')) return 'no-op'; // already under review/closed, or not a break
  if (!parseAndonHeader(issue.body ?? '')) return 'no-op'; // not yet normalized by plan-publish
  const anyJudged = parseJudgmentItems(issue.body ?? '').some((item) => item.judged);
  if (!anyJudged) return 'no-op'; // body edit that wasn't a judgment
  await openAndon(gh, repo, issueNumber); // state-aware + race-tolerant
  return 'under-review';
}

const isMain = process.argv[1]?.endsWith('andon-activity.ts');
if (isMain) {
  const argv = process.argv.slice(2);
  const get = (name: string): string | undefined => {
    const i = argv.indexOf(`--${name}`);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const issueArg = get('issue');
  const [owner, repoName] = (get('repo') ?? '').split('/');
  const issueNumber = Number(issueArg);
  if (!issueArg || !owner || !repoName || !Number.isInteger(issueNumber) || issueNumber <= 0) {
    console.error('usage: andon-activity --issue <positive integer> --repo <owner/repo>');
    process.exit(2);
  }
  normalizeAndonActivity(createClient(), { owner, repo: repoName }, issueNumber)
    .then((result) => console.log(result))
    .catch((error) => {
      console.error(errorMessage(error));
      process.exit(1);
    });
}
