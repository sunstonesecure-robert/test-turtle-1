import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { Octokit } from '@octokit/rest';
import { createClient, type RepoRef } from '../dashboard/lib/github/client';
import { PlanDoc } from '../schemas/plan';
import { planBranch, tagExists } from '../dashboard/lib/github/plans';
import { parseAndonHeader } from '../dashboard/lib/github/markers';
import { errorMessage, errorStatus } from '../dashboard/lib/github/errors';

/**
 * plan-publish — the deterministic writer that lands an agent-proposed plan.
 * The plan-propose agentic job is read-only (contents: read, safe outputs
 * create-issue + upload-artifact only): it CANNOT push the plan branch its
 * instructions describe. This publisher, triggered on plan-propose's
 * workflow_run completion, takes the uploaded plan.json artifact, finds the
 * agent's Andon break by its plan-ref header, patches the real andon_issue
 * number in (the agent can't know it before the issue exists), validates the
 * document against the schema, and creates `plan/<slug>/v<N>` with plan.json
 * committed — the same write the demo seed script performs, moved behind the
 * substrate split: agent proposes, deterministic single writer publishes.
 * Idempotent: an existing branch for this plan ref is a no-op re-run; an
 * existing TAG for it is a version collision with a frozen plan and errors.
 */

export type PublishResult =
  | { outcome: 'published'; planRef: string; andonIssue: number }
  | { outcome: 'already_published'; planRef: string };

export async function publishPlan(
  gh: Octokit,
  repo: RepoRef,
  planRaw: unknown,
  opts: { base?: string } = {},
): Promise<PublishResult> {
  // The agent cannot know the Andon number before the issue exists, so its
  // andon_issue is a placeholder — neutralize it for validation and patch the
  // real number in below.
  const draft = typeof planRaw === 'object' && planRaw !== null ? { ...(planRaw as Record<string, unknown>), andon_issue: 1 } : planRaw;
  const parsed = PlanDoc.safeParse(draft);
  if (!parsed.success) {
    throw new Error(`plan.json failed schema validation: ${parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`);
  }
  const planRef = planBranch(parsed.data.feature, parsed.data.version);

  if (await tagExists(gh, repo, planRef)) {
    throw new Error(`refusing to publish ${planRef}: a frozen tag with that version already exists — the agent must propose v${parsed.data.version + 1}`);
  }

  // The agent's Andon break carries the plan ref in its machine-readable header (paginated —
  // parallel workloads can hold many breaks open at once).
  const openBreaks = await gh.paginate(gh.issues.listForRepo, { ...repo, labels: 'andon:open', state: 'open', per_page: 100 });
  const andon = openBreaks.find((issue) => parseAndonHeader(issue.body ?? '')?.planRef === planRef);
  if (!andon) {
    throw new Error(`no andon:open break references ${planRef} — plan-propose must raise the Andon before publish`);
  }
  const plan = PlanDoc.parse({ ...parsed.data, andon_issue: andon.number });

  try {
    const { data: baseRef } = await gh.git.getRef({ ...repo, ref: `heads/${opts.base ?? 'main'}` });
    await gh.git.createRef({ ...repo, ref: `refs/heads/${planRef}`, sha: baseRef.object.sha });
  } catch (error: unknown) {
    if (errorStatus(error) === 422) return { outcome: 'already_published', planRef }; // workflow_run re-delivery
    throw error;
  }

  await gh.repos.createOrUpdateFileContents({
    ...repo,
    path: 'plan.json',
    message: `plan: publish ${planRef} (proposed by run ${plan.run_id}, Andon #${andon.number})`,
    content: Buffer.from(JSON.stringify(plan, null, 2)).toString('base64'),
    branch: planRef,
  });
  return { outcome: 'published', planRef, andonIssue: andon.number };
}

/** Locate plan.json anywhere under the downloaded-artifacts directory. */
export function findPlanFile(dir: string): string | null {
  if (!existsSync(dir)) return null;
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      const nested = findPlanFile(full);
      if (nested) return nested;
    } else if (entry === 'plan.json') {
      return full;
    }
  }
  return null;
}

const isMain = process.argv[1]?.endsWith('plan-publish.ts');
if (isMain) {
  const argv = process.argv.slice(2);
  const get = (name: string): string | undefined => {
    const i = argv.indexOf(`--${name}`);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const dir = get('dir');
  const repoArg = get('repo');
  const [owner, repoName] = (repoArg ?? '').split('/');
  if (!dir || !owner || !repoName) {
    console.error('usage: plan-publish --dir <artifacts-dir> --repo <owner/repo> [--base <branch>]');
    process.exit(2);
  }
  const planFile = findPlanFile(dir);
  if (!planFile) {
    console.error(`no plan.json found under ${dir} — the plan-propose run uploaded no plan artifact`);
    process.exit(1);
  }
  publishPlan(createClient(), { owner, repo: repoName }, JSON.parse(readFileSync(planFile, 'utf8')), { base: get('base') })
    .then((result) => {
      console.log(result.outcome === 'published' ? `published ${result.planRef} (Andon #${result.andonIssue})` : `already published: ${result.planRef}`);
    })
    .catch((error) => {
      console.error(errorMessage(error));
      process.exit(1);
    });
}
