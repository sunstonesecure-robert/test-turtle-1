import type { Octokit } from '@octokit/rest';
import { createClient, repoFromEnv, type RepoRef } from '../dashboard/lib/github/client';
import { ALL_LABELS } from '../dashboard/lib/github/labels';
import { checkReadiness, unmetItems, PLAN_RULESET, CURRENT_RULESET, MAIN_RULESET, EVIDENCE_RULESET, REQUIRED_CHECK_CONTEXTS } from './gates/lib/readiness';
import { EVIDENCE_BRANCH, ensureEvidenceBranch } from '../dashboard/lib/github/evidence-store';
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

  // Protection rulesets: plan/** branches, plan-gate required on main. (The
  // plans/**/CURRENT push ruleset is GONE — the official version is derived
  // from frozen tags since 2026-07-11, GHI #44; a stale one is deleted below.)
  // 403 here = plan limitation (rulesets/environments need GitHub Pro or a paid org plan on
  // private repos) — refuse with the remedy instead of a raw API error.
  const planLimited = (error: unknown): never => {
    throw new Error(
      'this repository plan does not support rulesets/environments on private repos — ' +
        'upgrade to GitHub Pro / a paid org plan or make the repository public, then re-run init ' +
        `(${apiMessage(error)})`,
    );
  };
  const { data: rulesets } = await gh
    .request('GET /repos/{owner}/{repo}/rulesets', { ...repo })
    .catch((error: unknown) => (errorStatus(error) === 403 ? planLimited(error) : Promise.reject(error)));
  const rulesetList = rulesets as { id: number; name: string }[];
  const rulesetNames = new Set(rulesetList.map((r) => r.name));
  const rulesetsByName = new Map(rulesetList.map((r) => [r.name, r]));
  // Reconcile away the pre-2026-07-11 CURRENT push ruleset where it exists
  // (org repos only — user-owned repos never could create it): the file it
  // protected no longer exists, and a stale push rule would block nothing real
  // while confusing the readiness report.
  const staleCurrent = rulesetList.find((r) => r.name === CURRENT_RULESET);
  if (staleCurrent) {
    await gh.request('DELETE /repos/{owner}/{repo}/rulesets/{ruleset_id}', { ...repo, ruleset_id: staleCurrent.id });
    changed.push(`ruleset ${CURRENT_RULESET} deleted (obsolete: CURRENT derived from tags, GHI #44)`);
  }
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
      name: MAIN_RULESET,
      payload: {
        name: MAIN_RULESET,
        target: 'branch',
        enforcement: 'active',
        conditions: { ref_name: { include: ['~DEFAULT_BRANCH'], exclude: [] } },
        // Required checks gate ALL pushes to main, not just PR merges. The
        // ONLY bypass is the repo-admin role (bootstrap/ops): since the
        // official version is derived from frozen tags (2026-07-11, GHI #44)
        // the post-merge writer never pushes to main, so no machine credential
        // carries a bypass on any repo type. 5 = repository admin role.
        //
        // `build-merge` performs the pre-authorized deliverable merge as
        // github-actions[bot] and is deliberately NOT given a bypass: it merges a
        // pull request whose required checks are green, which is the ordinary path
        // these rules exist to permit. A bypass there would mean automation could
        // land work the gates refused.
        bypass_actors: [{ actor_id: 5, actor_type: 'RepositoryRole', bypass_mode: 'always' }],
        rules: [
          {
            type: 'required_status_checks',
            // TWO CONTEXTS, and the second is half of the gate (T208(d), FR-068).
            // `deliverable-gate` running on a build PR without being REGISTERED AS
            // REQUIRED reports its verdict and blocks nothing: D2 scope containment
            // and D5 the subject boundary become advisory, silently, on a
            // green-looking PR. Registered from REQUIRED_CHECK_CONTEXTS rather than
            // spelled here so readiness item I7 asserts the same list this writes —
            // two hand-maintained copies is how a gate comes to run and block
            // nothing.
            parameters: {
              required_status_checks: REQUIRED_CHECK_CONTEXTS.map((context) => ({ context })),
              strict_required_status_checks_policy: false,
            },
          },
        ],
      },
    },
    {
      name: EVIDENCE_RULESET,
      payload: {
        name: EVIDENCE_RULESET,
        target: 'branch',
        enforcement: 'active',
        conditions: { ref_name: { include: [`refs/heads/${EVIDENCE_BRANCH}`], exclude: [] } },
        // The same two rules the plan branches carry, for the same reason: an
        // evidence batch is an append-only record, so its branch may only ever
        // grow. No bypass actor — nobody has a reason to rewrite a record, and
        // the records live here precisely BECAUSE the default branch's
        // required-check rule refused every machine write (GHI #134).
        rules: [{ type: 'non_fast_forward' }, { type: 'deletion' }],
      },
    },
  ];
  const missingContentsScope = (error: unknown): never => {
    throw new Error(
      'the credential cannot write to this repository — creating the evidence record store needs a ' +
        `token with "Contents: Read and write" (quickstart §0). API said: ${apiMessage(error)}`,
    );
  };
  const missingAdminScope = (error: unknown): never => {
    throw new Error(
      'the credential cannot administer this repository — init needs a token with ' +
        '"Administration: Read and write" (quickstart §0: use a separate admin-scoped PAT for ' +
        `init only). API said: ${apiMessage(error)}`,
    );
  };
  // The evidence record store (GHI #134). Created BEFORE its ruleset so the
  // protection lands on a branch that exists. Idempotent: an existing branch is
  // left exactly as it is — this never touches a record.
  const evidenceBranch = await ensureEvidenceBranch(gh, repo).catch((error: unknown) =>
    errorStatus(error) === 403 ? missingContentsScope(error) : Promise.reject(error),
  );
  if (evidenceBranch.created) changed.push(`branch ${EVIDENCE_BRANCH} (the evidence record store)`);

  for (const { name, payload } of wanted) {
    if (!rulesetNames.has(name)) {
      try {
        await gh.request('POST /repos/{owner}/{repo}/rulesets', { ...repo, ...payload } as never);
        changed.push(`ruleset ${name}`);
      } catch (error: unknown) {
        if (errorStatus(error) === 403) missingAdminScope(error);
        throw error;
      }
      continue;
    }
    // RECONCILE AN EXISTING RULESET, not just create a missing one (2026-08-24).
    //
    // `init` is specified as idempotent reconciliation to a desired state (FR-028),
    // and for rulesets it was only ever create-if-absent. That gap has teeth: adding
    // `deliverable-gate` to the required-check list changes nothing on any repo
    // initialized before the change, so the gate would run and block nothing —
    // silently, on a green-looking pull request, which is the exact absent-≠-success
    // failure the required-check registration exists to prevent (GHI #108). An
    // operator re-running `npm run init` has every reason to expect the rules to
    // catch up, and nothing told them otherwise.
    //
    // Compared on the RULES rather than the whole payload: name, target and
    // conditions are what identify the ruleset, and rewriting those on every run
    // would make the reconcile itself a change. Bypass actors are compared too —
    // dropping the machine bypass (GHI #44) is precisely the kind of tightening that
    // must reach an already-initialized repo.
    const existing = rulesetsByName.get(name);
    if (!existing) continue;
    try {
      const { data: full } = await gh.request('GET /repos/{owner}/{repo}/rulesets/{ruleset_id}', {
        ...repo,
        ruleset_id: existing.id,
      });
      const current = full as { rules?: unknown; bypass_actors?: unknown };
      const same =
        JSON.stringify(current.rules ?? []) === JSON.stringify(payload.rules ?? []) &&
        JSON.stringify(current.bypass_actors ?? []) === JSON.stringify(payload.bypass_actors ?? []);
      if (!same) {
        await gh.request('PUT /repos/{owner}/{repo}/rulesets/{ruleset_id}', {
          ...repo,
          ruleset_id: existing.id,
          ...payload,
        } as never);
        changed.push(`ruleset ${name} (rules reconciled)`);
      }
    } catch (error: unknown) {
      if (errorStatus(error) === 403) missingAdminScope(error);
      throw error;
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
