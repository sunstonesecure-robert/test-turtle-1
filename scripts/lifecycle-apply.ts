import { createClient } from '../dashboard/lib/github/client';
import { applyLifecycleTransition } from '../dashboard/lib/github/workloads';
import type { WorkloadAction } from '../dashboard/lib/github/markers';
import { errorMessage } from '../dashboard/lib/github/errors';

/**
 * Lifecycle apply CLI — invoked ONLY by the workload-lifecycle workflow after
 * lifecycle-gate passes: flips the workload:* label and appends the
 * workload-event:v1 comment (close+lock on archive happens in the module).
 */

const PAST_TENSE: Record<string, WorkloadAction> = {
  activate: 'activated',
  complete: 'completed',
  cancel: 'canceled',
  defer: 'deferred',
  reactivate: 'reactivated',
  archive: 'archived',
};

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
  if (!slug || !action || !repoArg || !PAST_TENSE[action]) {
    console.error('usage: lifecycle-apply --workload <slug> --action <activate|complete|cancel|defer|reactivate|archive> --actor <login> --repo <owner/repo> [--reason ..] [--revisit ..]');
    process.exit(2);
  }
  const [owner, repoName] = repoArg.split('/');
  if (!owner || !repoName) {
    console.error(`invalid --repo: ${repoArg}`);
    process.exit(2);
  }
  const gh = createClient();
  const reason = get('reason');
  const revisit = get('revisit');
  const result = await applyLifecycleTransition(gh, { owner, repo: repoName }, {
    slug,
    action: PAST_TENSE[action] as Exclude<WorkloadAction, 'introduced' | 'edited'>,
    actor: get('actor') ?? 'workload-lifecycle[bot]',
    at: new Date().toISOString(),
    ...(reason !== undefined ? { reason } : {}),
    ...(revisit !== undefined ? { revisit } : {}),
  });
  console.log(`workload ${slug} → workload:${result.state}`);
}

main().catch((error) => {
  console.error(errorMessage(error));
  process.exit(1);
});
