import { createClient } from '../../dashboard/lib/github/client';
import { getApprovalRecord } from '../../dashboard/lib/github/approval';
import { freezeApprovedPlan, readPlanAtRef } from '../../dashboard/lib/github/plans';

/**
 * Post-merge freeze CLI — invoked ONLY by the plan-post-merge workflow (the
 * single writer). Reads the merged approval PR, derives slug/version from the
 * head branch, and performs tag + CURRENT + andon:resolved atomically.
 */

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const get = (name: string): string | undefined => {
    const i = argv.indexOf(`--${name}`);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const prArg = get('pr');
  const repoArg = get('repo');
  if (!prArg || !repoArg) {
    console.error('usage: post-merge-freeze --pr <number> --repo <owner/repo>');
    process.exit(2);
  }
  const [owner, repoName] = repoArg.split('/');
  if (!owner || !repoName) {
    console.error(`invalid --repo: ${repoArg}`);
    process.exit(2);
  }
  const repo = { owner, repo: repoName };
  const gh = createClient();

  const { data: pr } = await gh.pulls.get({ ...repo, pull_number: Number(prArg) });
  const head = pr.head.ref;
  const m = /^plan\/([a-z0-9-]+)\/v(\d+)$/.exec(head);
  if (!m || !pr.merged_at) {
    console.log(`not an approval merge (head=${head}, merged=${Boolean(pr.merged_at)}) — nothing to do`);
    return;
  }
  const record = await getApprovalRecord(gh, repo, Number(prArg));
  if (!record) throw new Error(`PR #${prArg} has no approval record`);
  const plan = await readPlanAtRef(gh, repo, head);

  const { tagRef } = await freezeApprovedPlan(gh, repo, {
    slug: m[1]!,
    version: Number(m[2]),
    mergeSha: record.mergeSha,
    andonIssue: plan.andon_issue,
    approver: record.approver,
    approvedAt: record.approvedAt,
  });
  console.log(`frozen ${tagRef} — approver @${record.approver} at ${record.approvedAt}`);
}

main().catch((error) => {
  console.error(error.message ?? error);
  process.exit(1);
});
