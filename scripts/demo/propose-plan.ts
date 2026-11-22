import { Octokit } from '@octokit/rest';
import { createClient, repoFromEnv, type RepoRef } from '../../dashboard/lib/github/client';
import { createAndonIssue } from '../../dashboard/lib/github/andon';
import { getWorkload, introduceWorkload, applyLifecycleTransition } from '../../dashboard/lib/github/workloads';
import { parseAndonHeader } from '../../dashboard/lib/github/markers';
import { planBranch } from '../../dashboard/lib/github/plans';
import { publishPlan } from '../plan-publish';
import type { PlanDoc } from '../../schemas/plan';
import { errorMessage } from '../../dashboard/lib/github/errors';

/**
 * Demo seed (T047, quickstart §4): simulates the agent side of the tracer —
 * introduces + activates the "demo" workload when absent, pushes a one-step
 * plan (one boundary case, one verification target) to plan/demo/v1, and
 * raises the Andon break. In production this runs inside the plan-propose
 * gh-aw workflow via safe outputs; the seed writes through the same seam.
 *
 * THE SUBJECT IS A STANDALONE SCRIPT, DELIBERATELY (T243, FR-068). This plan
 * used to describe "the operator-facing hello-world greeting on the demo page"
 * with acceptance "GET /demo returns HTTP 200" — a route that does not exist in
 * dashboard/app/, so the only way to satisfy it was to ADD ONE TO THE OVERSIGHT
 * DASHBOARD. The suite's most-copied example therefore modelled exactly the
 * failure GHI #141 found live: a plan aimed at the installed machinery rather
 * than at the operator's own software. It now matches the tracer's own example
 * everywhere else in the suite (plan.md, contracts/build-executor.md, T213):
 * a standalone hello.py at the repo root.
 *
 * IDs are unchanged on purpose — step-hello, vt-hello-copy and bc-empty-name
 * are keyed on by four integration suites, and bc-empty-name is the
 * deliberately-wrong boundary case quickstart §4 and PB-001 depend on. No
 * `scope` field is added: PlanStep is additionalProperties:false until T223.
 */

/** The file the seeded plan delivers when the caller names none. */
export const DEMO_FILENAME = 'hello.py';

/**
 * A deliverable name the seed will write into the plan: one Python file at the
 * repository root. Deliberately narrow — the name lands verbatim inside the
 * `run` shell command the operator approves, so nothing that could mean
 * anything to a shell (a space, a quote, `$`, `;`, a slash) is accepted.
 */
export const DEMO_FILENAME_PATTERN = /^[a-z0-9][a-z0-9_-]*\.py$/;

/**
 * `filename` exists for live runs that repeat (PB-021): a target that already
 * holds `hello.py` from an earlier run fails the seeded plan's negative
 * control, and renaming six occurrences by hand in the GitHub editor is where
 * a missed one costs a paid build. Every mention moves together here instead.
 * IDs stay `step-hello` / `vt-hello-copy` whatever the file is called.
 */
export function demoPlan(runId: string, filename: string = DEMO_FILENAME): PlanDoc {
  if (!DEMO_FILENAME_PATTERN.test(filename)) {
    throw new Error(`demo plan filename must be a root-level Python file matching ${DEMO_FILENAME_PATTERN} — got "${filename}"`);
  }
  return {
    feature: 'demo',
    version: 1,
    supersedes: null,
    run_id: runId,
    andon_issue: 1, // patched after the Andon issue is created
    steps: [
      {
        id: 'step-hello',
        title: `Print the demo greeting from ${filename}`,
        intent: `Add a standalone ${filename} at the repo root that prints the operator-facing greeting`,
        acceptance: `Running \`python ${filename}\` exits 0 and prints exactly the greeting string`,
        priority: 'MUST',
        evidence_tag: 'verified',
        stand_in: null,
        high_stakes: false,
        authority: null,
        depends_on: [],
        // THE STEP'S DECLARED SCOPE (T223 landed, so this is now expressible — the
        // T243 note said "not until then"). G16 refuses a plan whose step declares
        // none, because approving a step with an undeclared blast radius is approving
        // work whose containment D2 cannot check (Codex on PR #145).
        //
        // An EXACT path, not `hello.py/**`: a bare name is read exactly in the scope
        // direction, so this authorizes the one file and nothing beneath it.
        scope: [filename],
        tracking_issue: null,
      },
    ],
    verification_targets: [
      {
        id: 'vt-hello-copy',
        kind: 'exact-copy',
        check: `stdout of \`python ${filename}\` equals "Hello, operator!"`,
        // The executable form (T223): the operator approves the exact command that
        // will judge the work, so verification needs no model.
        run: `test "$(python ${filename})" = "Hello, operator!"`,
        maps_to: ['step-hello'],
      },
    ],
    boundary_cases: [
      {
        id: 'bc-empty-name',
        description: 'When no operator name is configured, the greeting falls back to "Hello, operator!"',
        step_id: 'step-hello',
      },
    ],
  };
}

export interface ProposeResult {
  workloadIssue: number;
  andonIssue: number;
  planRef: string;
}

export async function proposeDemoPlan(
  gh: Octokit,
  repo: RepoRef,
  opts: { slug?: string; runId?: string; actor?: string; at?: string; base?: string; trackingIssue?: number; filename?: string } = {},
): Promise<ProposeResult> {
  const slug = opts.slug ?? 'demo';
  const runId = opts.runId ?? `demo-run-${slug}`;
  // Built before anything is written: a refused filename must not leave a
  // workload and an Andon break behind with no plan.
  const plan = demoPlan(runId, opts.filename);
  // Attribution is a success criterion, not decoration (live PB-003 finding G:
  // seeded events read `by:@operator`, a placeholder no audit can resolve).
  // Default to the AUTHENTICATED user, the same identity the real workflows
  // record via github.actor.
  let actor = opts.actor;
  if (!actor) {
    try {
      actor = (await gh.users.getAuthenticated()).data.login;
    } catch {
      // /user is user-to-server only — an installation token (e.g. the Actions
      // GITHUB_TOKEN) 401/403s here; the runner exports the triggering identity.
      actor = process.env.GITHUB_ACTOR;
    }
    if (!actor) {
      // NO placeholder fallback: an unattributable event is finding G itself.
      throw new Error(
        'cannot resolve an attributable operator identity: this token cannot call /user and GITHUB_ACTOR is unset — pass an explicit actor',
      );
    }
  }
  const at = opts.at ?? new Date().toISOString();

  // Introduce + activate the workload when not present (quickstart §4 note).
  // The activate re-reads by ISSUE NUMBER: GitHub's list endpoint is not
  // read-after-write consistent, so the just-created issue can be invisible to
  // a slug lookup (live PB-003 finding). A pre-existing proposed workload (e.g.
  // a prior run that failed here) is activated too — the seed is resumable.
  let workload = await getWorkload(gh, repo, slug);
  if (!workload) {
    workload = await introduceWorkload(gh, repo, { slug, title: `Demo workload (${slug})`, actor, at });
  }
  if (workload.state === 'proposed') {
    workload = await applyLifecycleTransition(gh, repo, {
      slug,
      action: 'activated',
      actor,
      at,
      issueNumber: workload.issueNumber,
    });
  }

  const branch = planBranch(slug, 1);
  plan.feature = slug;
  // Bind the step to its chunk when the caller has one — preflight B3 requires
  // the build's chunk to be a tracking issue of the frozen plan.
  if (opts.trackingIssue !== undefined) plan.steps[0]!.tracking_issue = opts.trackingIssue;

  // Find-or-create the Andon break, then land the branch through publishPlan —
  // the SAME deterministic writer the production flow uses. That inherits its
  // resumability (branch-exists, inherited plan.json sha — live PB-003 finding
  // C: approval merges put a plan.json on main, and a sha-less write 422s) and
  // avoids a second copy of the write logic. The fresh Andon's number is passed
  // as a hint: lists lag creates (finding B), only single GETs are consistent.
  const openBreaks = await gh.paginate(gh.issues.listForRepo, { ...repo, labels: 'andon:open', state: 'open', per_page: 100 });
  let andonIssue = openBreaks.find((issue) => parseAndonHeader(issue.body ?? '')?.planRef === branch)?.number;
  if (andonIssue === undefined) {
    andonIssue = await createAndonIssue(gh, repo, { slug, plan, planRef: branch });
  }
  plan.andon_issue = andonIssue;
  await publishPlan(gh, repo, plan, { base: opts.base, andonIssue, workloadIssue: workload.issueNumber });

  return { workloadIssue: workload.issueNumber, andonIssue, planRef: branch };
}

export const SEED_USAGE =
  'usage: propose-plan [--slug <kebab-case-slug>] [--filename <name.py>]  (defaults: demo, hello.py)';

/**
 * The seed's command line, or null when it should be refused with the usage
 * line. Both flags take `--flag value` and `--flag=value`. Anything else is
 * refused rather than ignored: both flags have defaults, so a misspelt one would
 * otherwise seed `demo` / `hello.py` silently.
 */
export function parseSeedArgs(argv: readonly string[]): { slug?: string; filename?: string } | null {
  const out: { slug?: string; filename?: string } = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    const key = (['slug', 'filename'] as const).find((k) => arg === `--${k}` || arg.startsWith(`--${k}=`));
    if (key === undefined || out[key] !== undefined) return null;
    const value = arg.includes('=') ? arg.slice(arg.indexOf('=') + 1) : argv[++i];
    if (!value) return null;
    if (key === 'slug' && !/^[a-z0-9][a-z0-9-]*$/.test(value)) return null;
    if (key === 'filename' && !DEMO_FILENAME_PATTERN.test(value)) return null;
    out[key] = value;
  }
  return out;
}

const isMain = process.argv[1]?.endsWith('propose-plan.ts');
if (isMain) {
  // A live target accumulates plan/<slug>/v* refs run over run (PB-001 used
  // `demo`, PB-002 `demo2`), and this seed always proposes v1 — so the operator
  // must be able to pick a fresh slug (PB-003 precondition).
  // Accept --slug <value> and --slug=<value>: this arg is optional with a
  // default, so an unrecognized spelling would otherwise fall through SILENTLY
  // to `demo` — wrong slug on a fresh target, confusing ref-exists 422 here.
  const args = parseSeedArgs(process.argv.slice(2));
  if (args === null) {
    console.error(SEED_USAGE);
    process.exit(2);
  }
  const gh = createClient();
  const repo = repoFromEnv();
  proposeDemoPlan(gh, repo, args)
    .then((r) => {
      console.log(`workload issue #${r.workloadIssue}`);
      console.log(`Andon break  #${r.andonIssue} (andon:open)`);
      console.log(`plan branch  ${r.planRef}`);
    })
    .catch((error) => {
      console.error(errorMessage(error));
      process.exit(1);
    });
}
