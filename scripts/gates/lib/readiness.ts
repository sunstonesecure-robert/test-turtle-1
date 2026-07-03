import type { Octokit } from '@octokit/rest';
import type { RepoRef } from '../../../dashboard/lib/github/client';
import { ALL_LABELS } from '../../../dashboard/lib/github/labels';
import type { GateResult } from './runner';
import { apiMessage, errorStatus } from '../../../dashboard/lib/github/errors';

/**
 * Readiness checks I1–I6 (gate-checks-cli.md §4) — a pure function of live repo
 * state, never a stored flag. Shared by `init --verify` and the dashboard's
 * intake-refusal banner (FR-029), so UX preview and enforcement cannot drift.
 */

/** Agentic workflows: gh-aw markdown compiled to pinned .lock.yml. */
export const AGENTIC_WORKFLOWS = ['plan-propose', 'build-template'] as const;
/** Deterministic single-writers/gates: plain Actions YAML — gh-aw has no non-LLM
 *  engine and its strict mode (rightly) forbids the direct writes these need. */
export const DETERMINISTIC_WORKFLOWS = ['plan-gate', 'plan-post-merge', 'workload-lifecycle'] as const;
/** All oversight workflows with the file each must exist as (I5). */
export const OVERSIGHT_WORKFLOW_FILES: readonly string[] = [
  ...AGENTIC_WORKFLOWS.map((w) => `${w}.lock.yml`),
  ...DETERMINISTIC_WORKFLOWS.map((w) => `${w}.yml`),
];

export const PLAN_RULESET = 'oversight: protect plan branches';
export const CURRENT_RULESET = 'oversight: protect CURRENT pointers';
export const MAIN_RULESET = 'oversight: require plan-gate on main';

export async function checkReadiness(gh: Octokit, repo: RepoRef): Promise<GateResult[]> {
  const results: GateResult[] = [];

  // I1 — all taxonomy labels exist
  const { data: labels } = await gh.issues.listLabelsForRepo({ ...repo, per_page: 100 });
  const names = new Set(labels.map((l) => l.name));
  const missingLabels = ALL_LABELS.filter((l) => !names.has(l));
  results.push({
    id: 'I1',
    status: missingLabels.length === 0 ? 'pass' : 'fail',
    requirement: 'FR-028',
    ...(missingLabels.length ? { detail: `missing labels: ${missingLabels.join(', ')}` } : {}),
  });

  // I2/I3 — protection rulesets on plan/**, CURRENT paths, and required plan-gate check on main.
  // Rulesets 403 on private repos below GitHub Pro / paid org plans — that is an unmet
  // readiness item to report, not a crash.
  let rulesetNames: Set<string> | null = null;
  let planLimitDetail: string | null = null;
  try {
    const { data: rulesets } = await gh.request('GET /repos/{owner}/{repo}/rulesets', { ...repo });
    rulesetNames = new Set((rulesets as { name: string }[]).map((r) => r.name));
  } catch (error: unknown) {
    if (errorStatus(error) !== 403) throw error;
    planLimitDetail = `rulesets unavailable on this plan (${apiMessage(error)}) — upgrade to GitHub Pro / a paid org plan or make the repository public`;
  }
  // Push rulesets (the CURRENT-pointer file-path rule) are org-only: on user-owned repos
  // that protection is waived — same waiver init applies when creation 422s.
  const { data: repoInfo } = await gh.repos.get({ ...repo });
  const isOrgRepo = repoInfo.owner?.type === 'Organization';
  const requiredProtection = isOrgRepo ? [PLAN_RULESET, CURRENT_RULESET] : [PLAN_RULESET];
  const missingProtection = requiredProtection.filter((n) => !(rulesetNames?.has(n) ?? false));
  const currentWaived = !isOrgRepo && !(rulesetNames?.has(CURRENT_RULESET) ?? false);
  results.push({
    id: 'I2',
    status: rulesetNames && missingProtection.length === 0 ? 'pass' : 'fail',
    requirement: 'FR-028',
    ...(planLimitDetail
      ? { detail: planLimitDetail }
      : missingProtection.length
        ? { detail: `missing rulesets: ${missingProtection.join(', ')}` }
        : currentWaived
          ? { detail: `${CURRENT_RULESET} waived: push rules are org-only; CURRENT single-writer enforcement rests on plan-gate + the post-merge workflow` }
          : {}),
  });
  results.push({
    id: 'I3',
    status: rulesetNames?.has(MAIN_RULESET) ? 'pass' : 'fail',
    requirement: 'FR-028',
    ...(planLimitDetail
      ? { detail: planLimitDetail }
      : rulesetNames?.has(MAIN_RULESET)
        ? {}
        : { detail: `missing ruleset: ${MAIN_RULESET} (required plan-gate check)` }),
  });

  // I4 — agent-build environment exists (environments are also plan-gated on private repos)
  let hasEnv = false;
  let envDetail = 'agent-build environment missing';
  try {
    await gh.request('GET /repos/{owner}/{repo}/environments/{environment_name}', {
      ...repo,
      environment_name: 'agent-build',
    });
    hasEnv = true;
  } catch (error: unknown) {
    const status = errorStatus(error);
    if (status === 403) {
      envDetail = `environments unavailable on this plan — upgrade to GitHub Pro / a paid org plan or make the repository public`;
    } else if (status !== 404) {
      throw error;
    }
  }
  results.push({
    id: 'I4',
    status: hasEnv ? 'pass' : 'fail',
    requirement: 'FR-028',
    ...(hasEnv ? {} : { detail: envDetail }),
  });

  // I5 — every oversight workflow present: compiled .lock.yml (agentic) / .yml (deterministic)
  const missingLocks: string[] = [];
  for (const file of OVERSIGHT_WORKFLOW_FILES) {
    try {
      await gh.repos.getContent({ ...repo, path: `.github/workflows/${file}` });
    } catch (error: unknown) {
      if (errorStatus(error) === 404) missingLocks.push(file);
      else throw error;
    }
  }
  results.push({
    id: 'I5',
    status: missingLocks.length === 0 ? 'pass' : 'fail',
    requirement: 'FR-028',
    ...(missingLocks.length ? { detail: `missing compiled workflows: ${missingLocks.join(', ')}` } : {}),
  });

  // I6 — operator identity resolvable
  let operator: string | null = null;
  try {
    const { data } = await gh.users.getAuthenticated();
    operator = data.login;
  } catch {
    operator = null;
  }
  results.push({
    id: 'I6',
    status: operator ? 'pass' : 'fail',
    requirement: 'FR-029',
    ...(operator ? {} : { detail: 'authenticated actor not resolvable' }),
  });

  return results;
}

export function unmetItems(results: GateResult[]): string[] {
  return results.filter((r) => r.status === 'fail').map((r) => `${r.id}: ${r.detail ?? 'unmet'}`);
}
