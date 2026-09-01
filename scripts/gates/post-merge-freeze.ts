import { createClient } from '../../dashboard/lib/github/client';
import { getApprovalRecord } from '../../dashboard/lib/github/approval';
import { freezeApprovedPlan, parsePlanRef, readPlanAtRef } from '../../dashboard/lib/github/plans';
import { errorMessage } from '../../dashboard/lib/github/errors';

/**
 * Post-merge freeze CLI — invoked ONLY by the plan-post-merge workflow (the
 * single writer). Reads the merged approval PR, derives slug/version from the
 * head branch, and performs tag + andon:resolved — the tag IS the official
 * version (derived, 2026-07-11 GHI #44); nothing is pushed to main.
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
  // ONE parser for the ref grammar (T279). This used to carry its own, looser
  // `[a-z0-9-]+` capture — the very duplication `slugFromPlanRef`'s docblock records as
  // removed — which read `plan/-demo/v1` as the slug `-demo`. It would then have cut a
  // frozen tag naming a slug the namespace readers answer null for, so D5 would reserve
  // all of `.github/**` for that workload and D1 would refuse the deliverable outright.
  // Fail-closed, but two parsers for one grammar is how a gate and a view come to
  // disagree about which workload a run belongs to — and the namespace decision now
  // rests on this grammar.
  const m = parsePlanRef(head);
  if (!m || !pr.merged_at) {
    console.log(`not an approval merge (head=${head}, merged=${Boolean(pr.merged_at)}) — nothing to do`);
    return;
  }
  const record = await getApprovalRecord(gh, repo, Number(prArg));
  if (!record) throw new Error(`PR #${prArg} has no approval record`);
  const plan = await readPlanAtRef(gh, repo, head);

  const { tagRef } = await freezeApprovedPlan(gh, repo, {
    slug: m.slug,
    version: m.version,
    mergeSha: record.mergeSha,
    andonIssue: plan.andon_issue,
    approver: record.approver,
    approvedAt: record.approvedAt,
  });
  console.log(`frozen ${tagRef} — approver @${record.approver} at ${record.approvedAt}`);
}

main().catch((error) => {
  console.error(errorMessage(error));
  process.exit(1);
});
