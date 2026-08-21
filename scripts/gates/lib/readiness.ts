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
export const AGENTIC_WORKFLOWS = ['plan-propose', 'plan-revise', 'build-template'] as const;
/** Deterministic single-writers/gates: plain Actions YAML — gh-aw has no non-LLM
 *  engine and its strict mode (rightly) forbids the direct writes these need. */
// vt-report is required, not optional: it is the ONLY writer of the `vt-*` check
// runs lifecycle-gate L3 reads, so a target missing it can never complete a
// workload (FR-034) — and readiness reporting green while completion is
// structurally impossible is exactly the false "ready" I5 exists to prevent.
// confirm-record joins for the same reason: it is the ONLY writer of the
// `confirmed:<authority>` labels the review panel and the board read. Its absence does
// NOT let a high-stakes build through — B5 reads the record FILE, never the label — but
// it makes every confirmation invisible, so a target missing it reports ready while the
// operator can obtain sign-offs the board will never show.
// plan-publish is the third, and the most consequential of the three: it is the ONLY
// writer of `plan/<slug>/v<N>`. The plan-propose agent is read-only by design — its safe
// outputs cannot push a branch — so it raises the Andon break, uploads plan.json, and
// stops. Without the publisher that artifact is never turned into a plan branch, so there
// is no document to review, approve or freeze: a target missing it reports READY while
// planning, the first step of the whole workflow, cannot complete even once. Found
// 2026-08-20 while auditing which installed templates I5 actually verifies — it installs
// into every target (install.ts globs templates/workflows/*) and was checked by nothing.
export const DETERMINISTIC_WORKFLOWS = [
  'plan-gate',
  'plan-post-merge',
  'workload-lifecycle',
  'vt-report',
  'confirm-record',
  'plan-publish',
] as const;
/**
 * Templates `install.ts` vendors that I5 deliberately does NOT verify, each with
 * the reason. Membership here is a STATED choice; absence from both this map and
 * `OVERSIGHT_WORKFLOW_FILES` is a DECISION NOT YET MADE, and the drift guard in
 * `tests/unit/readiness.test.ts` fails on it (GHI #97 item 4).
 *
 * That guard is the point. `install.ts` globs the whole `templates/workflows/`
 * directory, so a new template joins every target automatically while I5 keeps
 * checking the same hand-maintained list — which is how `plan-publish`, the only
 * writer of a plan branch, went unverified long enough for a target to report
 * ready while planning could not complete once (2026-08-20).
 *
 * This map does NOT settle what I5 promises — "nothing structurally impossible"
 * versus "the installed surface is intact" is still open in GHI #97. It records
 * the status quo with its reasoning so the question is answered deliberately
 * rather than re-litigated one workflow at a time.
 *
 * Scoped to `.yml`: the `.md` gh-aw sources are vendored too, but GitHub runs the
 * compiled `.lock.yml`, so a missing source changes nothing at runtime.
 */
export const I5_UNVERIFIED_TEMPLATES: Readonly<Record<string, string>> = {
  'workload-intake.yml':
    'Normalizes GitHub-UI intake into the workload:v1 marker. Without it, issues created from the ' +
    'intake template keep their form-rendered markdown and are invisible downstream (FR-031\'s ' +
    'GitHub-UI path) — but dashboard intake writes the marker itself, so one intake route survives. ' +
    'Degradation, not impossibility: the same weaker class confirm-record was admitted on, and the ' +
    'strongest candidate for promotion if GHI #97 settles on "surface intact".',
  'andon-activity.yml':
    'Deterministic normalizer for the GitHub-UI review flow: the first recorded judgment flips ' +
    'andon:open → andon:under-review (FR-003), and it guards FR-004 against a checkbox ✓ recorded in ' +
    'the GitHub UI. The dashboard review path does both itself, so its absence degrades the GitHub-UI ' +
    'route only. Same class as workload-intake.',
  'evidence-collect.yml':
    'Scheduled dated evidence batches (FR-021). A scheduled writer\'s absence is never structurally ' +
    'impossible, only eventually wrong — and what would reveal it is the absence of a record, which is ' +
    'unobservable by construction. GHI #97 names this the case that shows the strict criterion cannot ' +
    'be the whole rule. The operator can still record batches from the Evidence page.',
  'reconcile.yml':
    'Wrong-assumption propagation, dispatched by the dashboard after the operator marks which steps a ' +
    'batch contradicts. markContradictedAction performs the identical single-writer sequence in ' +
    'process, so the operator path survives its absence; only the dispatched route is lost.',
  'agentics-maintenance.yml':
    'Generated by gh-aw itself (pkg/workflow/maintenance_workflow.go) for toolchain housekeeping. ' +
    'Nothing in the oversight model reads its output: no gate, record, label or check run depends on ' +
    'it, so a target without it behaves identically.',
};

/** All oversight workflows with the file each must exist as (I5). */
export const OVERSIGHT_WORKFLOW_FILES: readonly string[] = [
  ...AGENTIC_WORKFLOWS.map((w) => `${w}.lock.yml`),
  ...DETERMINISTIC_WORKFLOWS.map((w) => `${w}.yml`),
];

export const PLAN_RULESET = 'oversight: protect plan branches';
/** LEGACY (pre-2026-07-11, GHI #44): the CURRENT pointer file is gone — the
 *  official version is derived from frozen tags. The name survives only so
 *  init can DELETE a stale instance on reconcile; nothing requires it. */
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

  // I2/I3 — plan/** protection and the required plan-gate check on main. (The
  // CURRENT push ruleset and its personal-repo waiver are GONE — the official
  // version is derived from frozen tags, 2026-07-11 GHI #44; org and user
  // repos now have identical requirements.) Rulesets 403 on private repos
  // below GitHub Pro / paid org plans — that is an unmet readiness item to
  // report, not a crash.
  let rulesetNames: Set<string> | null = null;
  let planLimitDetail: string | null = null;
  try {
    const { data: rulesets } = await gh.request('GET /repos/{owner}/{repo}/rulesets', { ...repo });
    rulesetNames = new Set((rulesets as { name: string }[]).map((r) => r.name));
  } catch (error: unknown) {
    if (errorStatus(error) !== 403) throw error;
    planLimitDetail = `rulesets unavailable on this plan (${apiMessage(error)}) — upgrade to GitHub Pro / a paid org plan or make the repository public`;
  }
  results.push({
    id: 'I2',
    status: rulesetNames?.has(PLAN_RULESET) ? 'pass' : 'fail',
    requirement: 'FR-028',
    ...(planLimitDetail
      ? { detail: planLimitDetail }
      : rulesetNames?.has(PLAN_RULESET)
        ? {}
        : { detail: `missing ruleset: ${PLAN_RULESET}` }),
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
