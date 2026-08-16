import { readFileSync } from 'node:fs';
import { createClient } from '../dashboard/lib/github/client';
import { performLifecycleTransition } from '../dashboard/lib/github/lifecycle';
import { errorMessage } from '../dashboard/lib/github/errors';

/**
 * Lifecycle apply CLI — invoked ONLY by the workload-lifecycle workflow after
 * lifecycle-gate passes: performs the post-gate effects (cancel: REST run
 * cancellation + live breaks → andon:superseded with corrections withdrawn;
 * contradicted reactivate: plan re-open, FR-040) and then flips the
 * workload:* label and appends the workload-event:v1 comment (close+lock on
 * archive happens in the module). --gate-report points at the gate step's
 * --json output so L8's requires_review verdict — not a re-scan that could
 * disagree with it — is what decides the re-open.
 */

const ACTIONS = ['activate', 'complete', 'cancel', 'defer', 'reactivate', 'archive'];

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const get = (name: string): string | undefined => {
    const i = argv.indexOf(`--${name}`);
    const v = i >= 0 ? argv[i + 1] : undefined;
    return v && v.length > 0 ? v : undefined;
  };
  const slug = get('workload');
  const action = get('action');
  const repoArg = get('repo');
  if (!slug || !action || !repoArg || !ACTIONS.includes(action)) {
    console.error('usage: lifecycle-apply --workload <slug> --action <activate|complete|cancel|defer|reactivate|archive> --actor <login> --repo <owner/repo> [--reason ..] [--revisit ..] [--gate-report <path>]');
    process.exit(2);
  }
  const [owner, repoName] = repoArg.split('/');
  if (!owner || !repoName) {
    console.error(`invalid --repo: ${repoArg}`);
    process.exit(2);
  }

  let requiresReview: boolean | undefined;
  const gateReportPath = get('gate-report');
  if (gateReportPath) {
    const report = JSON.parse(readFileSync(gateReportPath, 'utf8')) as { requires_review?: boolean };
    requiresReview = report.requires_review;
  }

  const gh = createClient();
  const reason = get('reason');
  const revisit = get('revisit');
  const result = await performLifecycleTransition(gh, { owner, repo: repoName }, {
    slug,
    action,
    actor: get('actor') ?? 'workload-lifecycle[bot]',
    at: new Date().toISOString(),
    ...(reason !== undefined ? { reason } : {}),
    ...(revisit !== undefined ? { revisit } : {}),
    ...(requiresReview !== undefined ? { requiresReview } : {}),
  });
  console.log(`workload ${slug} → workload:${result.workload.state}`);
  for (const run of result.canceledRuns) console.log(`canceled in-flight run ${run.id} (${run.headBranch})`);
  for (const issue of result.supersededBreaks) console.log(`Andon #${issue} → andon:superseded (cause: workload canceled), open corrections withdrawn`);
  if (result.reopened) console.log(`plan re-opened for review: ${result.reopened.planRef} (Andon #${result.reopened.andonIssue}) — FR-040`);
}

main().catch((error) => {
  console.error(errorMessage(error));
  process.exit(1);
});
