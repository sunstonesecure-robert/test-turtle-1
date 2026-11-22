import { createClient } from '../../dashboard/lib/github/client';
import { freezeMergedApproval } from '../../dashboard/lib/github/approval-authority';
import { errorMessage } from '../../dashboard/lib/github/errors';

/**
 * Post-merge freeze CLI — invoked ONLY by the plan-post-merge workflow (the
 * single writer). Reads the merged approval PR, derives slug/version from the
 * head branch, and performs tag + andon:resolved — the tag IS the official
 * version (derived, 2026-07-11 GHI #44); nothing is pushed to main.
 *
 * A MERGE ALONE FREEZES NOTHING (GHI #319). The freeze happens only when a person
 * with write access reviewed the exact merged commit — see
 * dashboard/lib/github/approval-authority.ts. A merge without that review exits
 * non-zero with the reason, which is also written on the plan's review; recording
 * the review and re-running this workflow completes it.
 *
 * OPERATOR_SIGN_IN_APP_ID (a repository Actions variable) names the dashboard's
 * operator sign-in App. It is needed only for a decision the pull request's own
 * author recorded while working alone; unset, such a decision cannot be checked and
 * is refused. An approval by a second person needs no configuration.
 */

/** The sign-in App id, or null when unset. A value that is not an id is a fault. */
function signInAppId(): number | null {
  const raw = (process.env.OPERATOR_SIGN_IN_APP_ID ?? '').trim();
  if (raw === '') return null;
  if (!/^[1-9]\d{0,15}$/.test(raw)) {
    console.error('OPERATOR_SIGN_IN_APP_ID must be the numeric App ID of the operator sign-in App');
    process.exit(2);
  }
  return Number(raw);
}

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

  const result = await freezeMergedApproval(gh, repo, Number(prArg), { signInAppId: signInAppId() });
  if (result.outcome === 'not_an_approval') {
    console.log(`not an approval merge (${result.detail}) — nothing to do`);
    return;
  }
  if (result.outcome === 'refused') {
    console.error(
      result.alreadyFrozen
        ? `PR #${prArg} was merged, but ${result.reason}. This version was already frozen by an earlier run; ` +
            'that frozen version is unchanged and this run did nothing.'
        : `PR #${prArg} was merged, but ${result.reason}. Nothing was frozen.` +
            (result.noted ? ` The reason and what to do next are on review #${result.andonIssue}.` : '') +
            (result.code === 'merged_plan_differs'
              ? ' Re-running will not change this: re-open the plan as a new version.'
              : ' Record the approval of that exact commit, then re-run this workflow.'),
    );
    process.exit(1);
  }
  const { tagRef, reconciled, record } = result;
  // A console line in the CLI's main(), captured only as job-log text. The frozen TAG
  // MESSAGE this reports is a separate write, guarded in plans.ts.
  console.log(
    `frozen ${tagRef} — approved by ${record.approver.login} at ${record.approvedAt} ` +
      `(${record.basis === 'second_person_review' ? 'approving review' : "own decision; second person's review deferred"} ` +
      `${record.reviewId} of ${record.headSha}); merged by ${record.mergedBy ?? 'an account GitHub did not report'}`,
  );
  // The items this version tracks now mirror ITS steps (GHI #212) — say which moved.
  for (const r of reconciled) {
    console.log(
      r.rewritten
        ? `work item #${r.issueNumber} (${r.stepId}) rewritten from its changed step${r.confirmationCleared ? '; its intent confirmation was cleared — confirm again' : ''}`
        : `work item #${r.issueNumber} (${r.stepId}) took its step's new title (requirement unchanged)`,
    );
  }
}

main().catch((error) => {
  console.error(errorMessage(error));
  process.exit(1);
});
