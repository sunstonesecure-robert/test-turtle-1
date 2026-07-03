import type { Octokit } from '@octokit/rest';
import { createClient, repoFromEnv, type RepoRef } from '../dashboard/lib/github/client';
import { ALL_LABELS } from '../dashboard/lib/github/labels';
import { checkReadiness, unmetItems, PLAN_RULESET, CURRENT_RULESET, MAIN_RULESET } from './gates/lib/readiness';
import { runGates, printReport } from './gates/lib/runner';
import { installOversightFiles } from './install';
import { apiMessage, errorMessage, errorStatus } from '../dashboard/lib/github/errors';

/**
 * Day-1 `init` (T017/T126, FR-028/FR-030): reconcile the repository to the
 * desired oversight state — idempotent, reports `already_initialized` when a
 * re-run changes nothing, never destructive. `--verify` runs readiness I1–I6.
 */

export interface InitResult {
  changed: string[];
  /** reconcile targets waived on this repo (e.g. org-only push rules) — not counted as change */
  skipped: string[];
  alreadyInitialized: boolean;
}

export async function init(gh: Octokit, repo: RepoRef): Promise<InitResult> {
  const changed: string[] = [];
  const skipped: string[] = [];

  // Labels — create only the missing ones (idempotent).
  const { data: existing } = await gh.issues.listLabelsForRepo({ ...repo, per_page: 100 });
  const have = new Set(existing.map((l) => l.name));
  for (const name of ALL_LABELS) {
    if (!have.has(name)) {
      await gh.issues.createLabel({ ...repo, name, color: labelColor(name) });
      changed.push(`label ${name}`);
    }
  }

  // Protection rulesets: plan/** branches, plans/**/CURRENT pointer, plan-gate required on main.
  // 403 here = plan limitation (rulesets/environments need GitHub Pro or a paid org plan on
  // private repos) — refuse with the remedy instead of a raw API error.
  const planLimited = (error: unknown): never => {
    throw new Error(
      'this repository plan does not support rulesets/environments on private repos — ' +
        'upgrade to GitHub Pro / a paid org plan or make the repository public, then re-run init ' +
        `(${apiMessage(error)})`,
    );
  };
  const { data: repoInfo } = await gh.repos.get({ ...repo });
  const isOrgRepo = repoInfo.owner?.type === 'Organization';
  const { data: rulesets } = await gh
    .request('GET /repos/{owner}/{repo}/rulesets', { ...repo })
    .catch((error: unknown) => (errorStatus(error) === 403 ? planLimited(error) : Promise.reject(error)));
  const rulesetNames = new Set((rulesets as { name: string }[]).map((r) => r.name));
  const wanted: { name: string; payload: Record<string, unknown> }[] = [
    {
      name: PLAN_RULESET,
      payload: {
        name: PLAN_RULESET,
        target: 'branch',
        enforcement: 'active',
        conditions: { ref_name: { include: ['refs/heads/plan/**'], exclude: [] } },
        rules: [{ type: 'non_fast_forward' }, { type: 'deletion' }],
      },
    },
    {
      name: CURRENT_RULESET,
      payload: {
        name: CURRENT_RULESET,
        target: 'push',
        enforcement: 'active',
        rules: [{ type: 'file_path_restriction', parameters: { restricted_file_paths: ['plans/**/CURRENT'] } }],
      },
    },
    {
      name: MAIN_RULESET,
      payload: {
        name: MAIN_RULESET,
        target: 'branch',
        enforcement: 'active',
        conditions: { ref_name: { include: ['~DEFAULT_BRANCH'], exclude: [] } },
        // Required checks gate ALL pushes to main, not just PR merges — without these
        // bypasses the post-merge single writer could never update plans/**/CURRENT
        // and admins could never bootstrap. 5 = repository admin role; 15368 = the
        // github-actions integration (the workflows' GITHUB_TOKEN identity — org repos
        // only; personal repos reject Integration bypass actors, so there the CURRENT
        // update runs under an admin credential instead).
        bypass_actors: [
          { actor_id: 5, actor_type: 'RepositoryRole', bypass_mode: 'always' },
          ...(isOrgRepo ? [{ actor_id: 15368, actor_type: 'Integration', bypass_mode: 'always' }] : []),
        ],
        rules: [
          {
            type: 'required_status_checks',
            parameters: { required_status_checks: [{ context: 'plan-gate' }], strict_required_status_checks_policy: false },
          },
        ],
      },
    },
  ];
  const missingAdminScope = (error: unknown): never => {
    throw new Error(
      'the credential cannot administer this repository — init needs a token with ' +
        '"Administration: Read and write" (quickstart §0: use a separate admin-scoped PAT for ' +
        `init only). API said: ${apiMessage(error)}`,
    );
  };
  for (const { name, payload } of wanted) {
    if (!rulesetNames.has(name)) {
      try {
        await gh.request('POST /repos/{owner}/{repo}/rulesets', { ...repo, ...payload } as never);
        changed.push(`ruleset ${name}`);
      } catch (error: unknown) {
        const status = errorStatus(error);
        if (status === 403) missingAdminScope(error);
        // Push rulesets (file-path rules) are org-only; on personal repos the CURRENT
        // pointer protection is waived — readiness I2 documents the same waiver.
        if (status === 422 && name === CURRENT_RULESET && /org-owned/i.test(errorMessage(error))) {
          skipped.push(`ruleset ${name} (push rules are org-only; personal-repo waiver)`);
          continue;
        }
        throw error;
      }
    }
  }

  // agent-build environment (PUT is idempotent, but only report a change when absent).
  let hasEnv = true;
  try {
    await gh.request('GET /repos/{owner}/{repo}/environments/{environment_name}', {
      ...repo,
      environment_name: 'agent-build',
    });
  } catch (error: unknown) {
    const status = errorStatus(error);
    if (status === 404) hasEnv = false;
    else if (status === 403) planLimited(error);
    else throw error;
  }
  if (!hasEnv) {
    await gh
      .request('PUT /repos/{owner}/{repo}/environments/{environment_name}', {
        ...repo,
        environment_name: 'agent-build',
      })
      .catch((error: unknown) => (errorStatus(error) === 403 ? missingAdminScope(error) : Promise.reject(error)));
    changed.push('environment agent-build');
  }

  // Install/update the governed-repo files (templates + gate toolchain) as one
  // git-tree commit — idempotent: unchanged content produces no commit (T178).
  // Writing .github/workflows/ files needs the "workflows" permission (quickstart §0).
  try {
    const install = await installOversightFiles(gh, repo);
    if (install.committed) {
      changed.push(`installed oversight files (${install.fileCount} files, ${install.commitSha})`);
    }
  } catch (error: unknown) {
    const status = errorStatus(error);
    if (status === 403 || status === 422) {
      // GitHub returns the same opaque 403 whether Contents or Workflows is missing —
      // name the full required set, and the usual trap (a stale day-to-day token in the shell).
      throw new Error(
        'installing oversight files into the target failed — the install commit needs BOTH ' +
          '"Contents: Read and write" AND "Workflows: Read and write" on the credential ' +
          '(quickstart §0: the bootstrap PAT is Option A\'s permissions PLUS Administration + Workflows). ' +
          'If you exported the day-to-day token earlier (e.g. via `source dashboard/.env.local`), it is ' +
          `still in your shell — pass the bootstrap PAT inline: GITHUB_TOKEN=<bootstrap-pat> npm run init. API said: ${apiMessage(error)}`,
      );
    }
    throw error;
  }

  return { changed, skipped, alreadyInitialized: changed.length === 0 };
}

function labelColor(name: string): string {
  if (name.startsWith('andon:')) return 'd93f0b';
  if (name.startsWith('correction:')) return 'fbca04';
  if (name.startsWith('workload:')) return '0e8a16';
  if (name.startsWith('chunk:')) return 'c5def5';
  if (name.startsWith('high-stakes:')) return 'b60205';
  if (name.startsWith('confirmed:')) return '0052cc';
  return 'ededed';
}

const isMain = process.argv[1]?.endsWith('setup-repo.ts');
if (isMain) {
  const gh = createClient();
  const repo = repoFromEnv();
  const verify = process.argv.includes('--verify');
  const json = process.argv.includes('--json');
  (async () => {
    if (verify) {
      const results = await checkReadiness(gh, repo);
      const report = await runGates(`${repo.owner}/${repo.repo}`, results.map((r) => () => r));
      printReport(report, json);
      if (report.result !== 'pass') {
        console.error(`not ready — unmet: ${unmetItems(results).join(' · ')}`);
        process.exit(1);
      }
      console.log('ready');
      return;
    }
    const result = await init(gh, repo);
    if (result.alreadyInitialized) console.log('already_initialized');
    else console.log(`initialized: ${result.changed.join(', ')}`);
    for (const s of result.skipped) console.log(`skipped: ${s}`);
  })().catch((error) => {
    console.error(errorMessage(error));
    process.exit(2);
  });
}
