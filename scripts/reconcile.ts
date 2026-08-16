import { createClient } from '../dashboard/lib/github/client';
import { markContradicted } from '../dashboard/lib/github/evidence';
import { errorMessage } from '../dashboard/lib/github/errors';

/**
 * reconcile CLI — invoked by the reconcile repository-dispatch workflow after
 * the operator's contradiction judgment (FR-022): dependency-closure flags,
 * the batch-issue record, and the plan re-open all happen in one pass.
 */

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const get = (name: string): string | undefined => {
    const i = argv.indexOf(`--${name}`);
    const v = i >= 0 ? argv[i + 1] : undefined;
    return v && v.length > 0 ? v : undefined;
  };
  const workload = get('workload');
  const planRef = get('plan-ref');
  const steps = get('steps');
  const batch = get('batch');
  const repoArg = get('repo');
  if (!workload || !planRef || !steps || !batch || !repoArg) {
    console.error('usage: reconcile --workload <slug> --plan-ref <plan/<slug>/vN> --steps <id,id,...> --batch <issue#> --actor <login> --repo <owner/repo>');
    process.exit(2);
  }
  const [owner, repoName] = repoArg.split('/');
  if (!owner || !repoName) {
    console.error(`invalid --repo: ${repoArg}`);
    process.exit(2);
  }
  const result = await markContradicted(createClient(), { owner, repo: repoName }, {
    workloadSlug: workload,
    planRef,
    contradictedStepIds: steps.split(',').map((s) => s.trim()).filter((s) => s.length > 0),
    batchIssue: Number(batch),
    actor: get('actor') ?? 'reconcile[bot]',
    at: new Date().toISOString(),
  });
  console.log(`flagged closure: ${result.flagged.join(', ')}`);
  console.log(result.reopenedAs ? `re-opened as ${result.reopenedAs}` : 're-open skipped: a proposal is already in review');
}

main().catch((error) => {
  console.error(errorMessage(error));
  process.exit(1);
});
