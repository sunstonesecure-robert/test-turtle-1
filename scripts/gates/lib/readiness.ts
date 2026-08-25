import type { Octokit } from '@octokit/rest';
import type { RepoRef } from '../../../dashboard/lib/github/client';
import { ALL_LABELS } from '../../../dashboard/lib/github/labels';
import { EVIDENCE_BRANCH } from '../../../dashboard/lib/github/evidence-store';
import type { GateResult } from './runner';
import { apiMessage, errorStatus } from '../../../dashboard/lib/github/errors';

/**
 * Readiness checks (gate-checks-cli.md §4) — a pure function of live repo state,
 * never a stored flag. Shared by `init --verify` and the dashboard's
 * intake-refusal banner (FR-029), so UX preview and enforcement cannot drift.
 *
 * The set is I1–I8. **I7 was reserved and is now built** (2026-08-24, T222): the
 * deliverable-path check — the US18 workflows installed AND `deliverable-gate`
 * registered as a required status check. The evidence record store took I8 rather
 * than the then-free-looking I7 because a readiness id, once written into the
 * contract, is a stable identifier: reusing it would have made two different checks
 * answer to one name in the record. The out-of-order pair is the cost of having kept
 * that promise, and it is the cheaper cost.
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
 * The deliverable path (US18) — asserted by **I7**, separately from I5.
 *
 * Separate because the two failures read differently to an operator. A target
 * missing one of the I5 workflows cannot plan or complete at all, which is loud. A
 * target missing these four can do everything up to freeze and then quietly build
 * nothing — the state every live run before 2026-08-24 was in, where the product
 * governed a build that could not produce anything and no surface said so.
 *
 * `build-publish`  the only writer of a deliverable branch and pull request
 * `deliverable-gate` the required check D1–D5, without which nothing judges a patch
 * `build-merge`    the actor that merges a pre-authorized deliverable and moves its
 *                  label — without it the default path stalls one step before
 *                  verification, forever
 * `build-verify`   verification on the MERGED commit; without it no `vt-*` check run
 *                  is ever written, because vt-report triggers on this workflow
 */
export const DELIVERABLE_WORKFLOWS = ['build-publish', 'deliverable-gate', 'build-merge', 'build-verify'] as const;

/** The required-status-check contexts the default-branch ruleset must carry.
 *  `plan-gate` blocks an unapproved plan from freezing; `deliverable-gate` blocks an
 *  ungated deliverable from landing. Registered together by `setup-repo.ts`, and
 *  asserted here — because a gate that runs without being REQUIRED reports its
 *  verdict and blocks nothing. */
export const REQUIRED_CHECK_CONTEXTS = ['plan-gate', 'deliverable-gate'] as const;
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

/**
 * Every installed workflow file that SOME readiness check demands — I5's set plus
 * I7's. The GHI #97 drift guard reconciles the installed templates against this,
 * not against I5 alone: the deliverable-path workflows are verified, just by a
 * different check, and a guard that did not know that would demand they be listed
 * as deliberately UNVERIFIED — recording the opposite of the truth.
 */
export const VERIFIED_WORKFLOW_FILES: readonly string[] = [
  ...OVERSIGHT_WORKFLOW_FILES,
  ...DELIVERABLE_WORKFLOWS.map((w) => `${w}.yml`),
];

export const PLAN_RULESET = 'oversight: protect plan branches';
/** LEGACY (pre-2026-07-11, GHI #44): the CURRENT pointer file is gone — the
 *  official version is derived from frozen tags. The name survives only so
 *  init can DELETE a stale instance on reconcile; nothing requires it. */
export const CURRENT_RULESET = 'oversight: protect CURRENT pointers';
export const MAIN_RULESET = 'oversight: require plan-gate on main';
/** The evidence record store's own protection (GHI #134): the branch every batch
 *  is committed to is append-only — no force-push, no deletion. Records moved off
 *  the default branch because its required-check rule refused every machine
 *  write; this ruleset is what keeps the move from weakening the record. */
export const EVIDENCE_RULESET = 'oversight: protect the evidence branch';

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
  /** name → enforcement. **PRESENT IS NOT ENFORCING** (found reviewing the US18 wave,
   *  2026-08-25): a ruleset flipped to `evaluate` (dry run) or `disabled` from
   *  Settings → Rules keeps its name, its rules and its registered check contexts — so
   *  every readiness item that asked "does a ruleset by this name exist?" reported green
   *  while nothing was enforced at all, and `init`'s reconcile saw no difference either.
   *  Every gate in the product ran, reported, and blocked no merge. That is the
   *  present-reporting-and-inert failure this project refuses everywhere else (GHI #108),
   *  reached from the one direction nothing was looking at. */
  let rulesetEnforcement: Map<string, string> | null = null;
  let planLimitDetail: string | null = null;
  try {
    const { data: rulesets } = await gh.request('GET /repos/{owner}/{repo}/rulesets', { ...repo });
    const listed = rulesets as { name: string; enforcement?: string }[];
    rulesetNames = new Set(listed.map((r) => r.name));
    rulesetEnforcement = new Map(listed.map((r) => [r.name, r.enforcement ?? 'unknown']));
  } catch (error: unknown) {
    if (errorStatus(error) !== 403) throw error;
    planLimitDetail = `rulesets unavailable on this plan (${apiMessage(error)}) — upgrade to GitHub Pro / a paid org plan or make the repository public`;
  }

  /**
   * One ruleset's verdict: it must EXIST and be ENFORCING.
   *
   * Two states, reported apart, because they need different actions from the operator: a
   * missing ruleset is a re-run of `init`, while a disabled one is a deliberate change
   * somebody made in the UI and `init` will put back. Saying "missing" for a disabled
   * ruleset would send them looking for something that is sitting right there.
   */
  const rulesetVerdict = (name: string, missingDetail: string): { status: 'pass' | 'fail'; detail?: string } => {
    if (planLimitDetail) return { status: 'fail', detail: planLimitDetail };
    if (!rulesetNames?.has(name)) return { status: 'fail', detail: missingDetail };
    const enforcement = rulesetEnforcement?.get(name) ?? 'unknown';
    if (enforcement !== 'active') {
      return {
        status: 'fail',
        detail:
          `ruleset "${name}" EXISTS but its enforcement is "${enforcement}", not "active" — it reports and blocks ` +
          'nothing, so every required check on this path is advisory. Re-run `npm run init` (it reconciles ' +
          'enforcement), or set it back under Settings → Rules → Rulesets',
      };
    }
    return { status: 'pass' };
  };

  const i2 = rulesetVerdict(PLAN_RULESET, `missing ruleset: ${PLAN_RULESET}`);
  results.push({ id: 'I2', status: i2.status, requirement: 'FR-028', ...(i2.detail ? { detail: i2.detail } : {}) });
  const i3 = rulesetVerdict(MAIN_RULESET, `missing ruleset: ${MAIN_RULESET} (required plan-gate check)`);
  results.push({ id: 'I3', status: i3.status, requirement: 'FR-028', ...(i3.detail ? { detail: i3.detail } : {}) });

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

  // I8 — the evidence record store: the `evidence` branch exists AND is
  // protected (GHI #134). Both halves matter and they fail differently. Without
  // the BRANCH the scheduled collector has nowhere to write — though it creates
  // it itself rather than losing a record, which is why this reports rather than
  // blocks. Without the RULESET the records are writable history: a force-push
  // could rewrite an append-only record, which is the property the whole move
  // off the default branch was made to keep.
  let hasEvidenceBranch = false;
  try {
    await gh.git.getRef({ ...repo, ref: `heads/${EVIDENCE_BRANCH}` });
    hasEvidenceBranch = true;
  } catch (error: unknown) {
    if (errorStatus(error) !== 404) throw error;
  }
  const evidenceRuleset = rulesetVerdict(EVIDENCE_RULESET, `missing ruleset: ${EVIDENCE_RULESET} (append-only records)`);
  const evidenceUnmet = [
    ...(hasEvidenceBranch ? [] : [`missing branch: ${EVIDENCE_BRANCH} (the evidence record store)`]),
    // Enforcement matters here for the same reason it matters on the other two, and
    // arguably more: a disabled evidence ruleset means the append-only record can be
    // force-pushed, which is the one property the whole move off the default branch
    // existed to keep (GHI #134).
    ...(evidenceRuleset.detail ? [evidenceRuleset.detail] : []),
  ];
  // I7 — the deliverable path is INSTALLED, PERMITTED and ENFORCED
  // (T222, FR-028/FR-060/FR-061/FR-062/FR-068).
  //
  // THREE HALVES, and the middle one was found the hard way (live, 2026-08-25):
  // `build-publish` created the branch and the commit, then died on
  // `POST /pulls` — "GitHub Actions is not permitted to create or approve pull
  // requests". That is a repository setting
  // (`can_approve_pull_request_reviews`, Settings → Actions → General →
  // Workflow permissions), off by default on many repos, and with it off the
  // deliverable path can NEVER complete: every build produces a branch nobody
  // can review and no pull request at all. `init` now sets it, and readiness
  // asserts it, because discovering it from a failed build after paying for an
  // agent run is the expensive way to learn a boolean.
  //
  // The other two halves fail differently and only one of them is visible.
  // A missing workflow FILE means nothing can land: loud, and an operator notices the
  // first time a build produces no pull request. An unregistered required CHECK means
  // everything lands UNGATED — D2 scope containment and D5 the subject boundary both
  // become advisory, silently, on a green-looking PR. That second failure is the
  // absent-≠-success mistake this project refuses everywhere else (GHI #108), and it
  // is invisible from every surface, which is exactly why readiness asserts it rather
  // than an operator eyeballing the Actions tab.
  const missingDeliverable: string[] = [];
  for (const workflow of DELIVERABLE_WORKFLOWS) {
    try {
      await gh.repos.getContent({ ...repo, path: `.github/workflows/${workflow}.yml` });
    } catch (error: unknown) {
      if (errorStatus(error) === 404) missingDeliverable.push(`${workflow}.yml`);
      else throw error;
    }
  }
  // The registration half. Read from the ruleset itself rather than from what init
  // intended to write: "we call setup-repo, so it must be registered" is precisely
  // the assumption that let a shipped feature never once work (GHI #134).
  let registered: string[] | null = null;
  if (!planLimitDetail) {
    try {
      const { data: rulesets } = await gh.request('GET /repos/{owner}/{repo}/rulesets', { ...repo });
      const main = (rulesets as { id: number; name: string }[]).find((r) => r.name === MAIN_RULESET);
      if (main) {
        const { data: full } = await gh.request('GET /repos/{owner}/{repo}/rulesets/{ruleset_id}', {
          ...repo,
          ruleset_id: main.id,
        });
        const rules = (full as { rules?: { type: string; parameters?: { required_status_checks?: { context: string }[] } }[] }).rules ?? [];
        registered = rules
          .filter((r) => r.type === 'required_status_checks')
          .flatMap((r) => (r.parameters?.required_status_checks ?? []).map((c) => c.context));
      } else {
        registered = [];
      }
    } catch (error: unknown) {
      if (errorStatus(error) === 403) registered = null; // plan limitation, reported below
      else throw error;
    }
  }
  const unregistered = registered === null ? [] : REQUIRED_CHECK_CONTEXTS.filter((c) => !registered!.includes(c));
  // A registered context on a ruleset that is not ENFORCING is a required check in name
  // only — and this is the gate family where that matters most, because D5 going advisory
  // is how a deliverable touching the oversight machinery lands (FR-068).
  const mainEnforcement = rulesetVerdict(MAIN_RULESET, `missing ruleset: ${MAIN_RULESET}`);
  // Can Actions open a pull request at all? Without this, build-publish writes the
  // branch and then 403s at POST /pulls — loud on the run, invisible everywhere else.
  let canOpenPrs: boolean | null = null;
  try {
    const { data } = await gh.request('GET /repos/{owner}/{repo}/actions/permissions/workflow', { ...repo });
    canOpenPrs = (data as { can_approve_pull_request_reviews?: boolean }).can_approve_pull_request_reviews ?? false;
  } catch (error: unknown) {
    if (errorStatus(error) === 403 || errorStatus(error) === 404) canOpenPrs = null;
    else throw error;
  }
  const deliverableUnmet = [
    ...(missingDeliverable.length ? [`missing deliverable-path workflows: ${missingDeliverable.join(', ')}`] : []),
    ...(canOpenPrs === false
      ? [
          'GitHub Actions is NOT permitted to create pull requests on this repository — build-publish will write the ' +
            'deliverable branch and then fail at POST /pulls, so no deliverable can ever be reviewed or merged. Enable ' +
            'Settings → Actions → General → Workflow permissions → "Allow GitHub Actions to create and approve pull ' +
            'requests", or re-run `npm run init` with an admin-scoped token',
        ]
      : []),
    ...(mainEnforcement.status === 'fail' && mainEnforcement.detail && !planLimitDetail ? [mainEnforcement.detail] : []),
    ...(planLimitDetail || registered === null
      ? [planLimitDetail ?? 'rulesets unreadable on this plan — the required-check registration cannot be verified']
      : unregistered.length
        ? [
            `required status check(s) NOT registered on ${MAIN_RULESET}: ${unregistered.join(', ')} — ` +
              'the gate runs and blocks nothing, so deliverables land ungated (GHI #108)',
          ]
        : []),
  ];
  results.push({
    id: 'I7',
    status: deliverableUnmet.length === 0 ? 'pass' : 'fail',
    requirement: 'FR-028',
    ...(deliverableUnmet.length ? { detail: deliverableUnmet.join(' · ') } : {}),
  });

  results.push({
    id: 'I8',
    status: evidenceUnmet.length === 0 ? 'pass' : 'fail',
    requirement: 'FR-021',
    ...(evidenceUnmet.length ? { detail: evidenceUnmet.join(' · ') } : {}),
  });

  return results;
}

export function unmetItems(results: GateResult[]): string[] {
  return results.filter((r) => r.status === 'fail').map((r) => `${r.id}: ${r.detail ?? 'unmet'}`);
}
