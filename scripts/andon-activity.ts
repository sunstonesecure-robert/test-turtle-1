import type { Octokit } from '@octokit/rest';
import { createClient, type RepoRef } from '../dashboard/lib/github/client';
import { parseAndonHeader, parseJudgmentItems, uncheckJudgmentItem } from '../dashboard/lib/github/markers';
import { openAndon } from '../dashboard/lib/github/andon';
import { listOpenCorrections } from '../dashboard/lib/github/corrections';
import { errorMessage } from '../dashboard/lib/github/errors';

/**
 * Andon-activity normalizer for the GitHub-UI review flow. Two jobs:
 *
 * 1. FR-003 (live PB-002 finding D): the first recorded judgment on an
 *    andon:open break flips it to under-review — the operator's first real
 *    engagement is the trigger.
 * 2. FR-004 guard (live PB-003 finding F): a checkbox ✓ recorded directly in
 *    the GitHub UI on an item whose correction is still OPEN is out of
 *    contract — the item must stay open until the revised plan addresses it
 *    or the correction is withdrawn. Such ticks are REVERTED with an
 *    explanatory comment. The dashboard's legitimate re-judge is untouched by
 *    construction: it closes the correction BEFORE checking the item, so by
 *    the time this normalizer sees the edit the correction is no longer open.
 *
 * Idempotent and state-aware; resolved/superseded breaks are never touched.
 */

export interface ActivityResult {
  transition: 'under-review' | null;
  reverted: string[];
}

export async function normalizeAndonActivity(gh: Octokit, repo: RepoRef, issueNumber: number): Promise<ActivityResult> {
  const none: ActivityResult = { transition: null, reverted: [] };
  const { data: issue } = await gh.issues.get({ ...repo, issue_number: issueNumber });
  const labels = (issue.labels ?? []).map((l) => (typeof l === 'string' ? l : (l.name ?? '')));
  const isOpen = labels.includes('andon:open');
  if (!isOpen && !labels.includes('andon:under-review')) return none; // resolved/superseded, or not a break
  if (!parseAndonHeader(issue.body ?? '')) return none; // not yet normalized by plan-publish

  const body = issue.body ?? '';
  const checkedItems = parseJudgmentItems(body).filter((item) => item.judged);

  const reverted: string[] = [];
  if (checkedItems.length > 0) {
    const openCorrected = new Set((await listOpenCorrections(gh, repo, issueNumber)).map((c) => c.itemId));
    let updated = body;
    for (const item of checkedItems) {
      if (!openCorrected.has(item.id)) continue;
      const next = uncheckJudgmentItem(updated, item.id);
      if (next !== null) {
        updated = next;
        reverted.push(item.id);
      }
    }
    if (reverted.length > 0) {
      await gh.issues.update({ ...repo, issue_number: issueNumber, body: updated });
      await gh.issues.createComment({
        ...repo,
        issue_number: issueNumber,
        body:
          `**Judgment reverted**: ${reverted.map((id) => `\`${id}\``).join(', ')} was ✓-ed while its ` +
          `correction is still open — the item stays open until the agent's revised plan addresses it ` +
          `(re-judge in the dashboard) or the correction is explicitly withdrawn (FR-004).`,
      });
    }
  }

  // FR-003 flip: any judgment recorded counts as engagement — even one the
  // guard just reverted; the operator engaged either way.
  let transition: 'under-review' | null = null;
  if (isOpen && checkedItems.length > 0) {
    await openAndon(gh, repo, issueNumber); // state-aware + race-tolerant
    transition = 'under-review';
  }
  return { transition, reverted };
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
    .then((result) => {
      console.log(result.transition ?? 'no transition');
      if (result.reverted.length > 0) console.log(`reverted out-of-contract ✓: ${result.reverted.join(', ')} (FR-004)`);
    })
    .catch((error) => {
      console.error(errorMessage(error));
      process.exit(1);
    });
}
