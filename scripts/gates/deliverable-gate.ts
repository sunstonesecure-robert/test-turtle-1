import type { Octokit } from '@octokit/rest';
import { createClient, type RepoRef } from '../../dashboard/lib/github/client';
import { cliMain, printReport, refusalDetail, runGateCatalogue, UsageError, type GateReport } from './lib/runner';
import { DELIVERABLE_CATALOGUE } from './lib/catalogue';
import {
  checkD1Provenance,
  checkD2ScopeContainment,
  checkD3MergeAuthority,
  checkD4ExecutorProvenance,
  checkD5SubjectBoundary,
  resolveDeliveringStep,
  type DeliverablePr,
} from './lib/checks-deliverable';

/**
 * deliverable-gate (T208 + T239) — required status check on every
 * `build/<slug>/<step-id>` pull request.
 *
 * This is the gate that decides whether an agent's actual work may land, and the
 * only gate in the system that reads a patch. Like every other family it reports
 * EVERY declared gate on every run — a gate that does not apply says so by name, so
 * a report can never be read as "everything was checked" when it was not (GHI #108).
 *
 * REGISTRATION IS HALF THE GATE. A `deliverable-gate` that runs on a build PR
 * without being REGISTERED AS A REQUIRED CHECK reports its verdict and blocks
 * nothing — D2 and D5 become advisory, silently, with a green-looking PR. So the
 * CLI, the workflow, and `setup-repo.ts`'s ruleset registration are one change, and
 * readiness item I7 asserts the registration independently.
 *
 * AND THE `pull_request` TRIGGER IS NOT ENOUGH — found live, 2026-08-25. A
 * deliverable pull request is opened by `build-publish` using `GITHUB_TOKEN`, and
 * GitHub deliberately does not fire workflow events for actions taken with that
 * token (it exists to stop runaway recursion). So on the one pull request this gate
 * exists for, the `pull_request` event NEVER ARRIVES: PR #54 sat with
 * `build:awaiting-merge`, no checks at all, and a required check that could never be
 * satisfied. Permanently unmergeable, and green-looking.
 *
 * The fix is a SWEEP, not a cleverer event payload. `deliverable-gate.yml` also runs
 * on `build-publish`'s completion and asks a different question — "which open
 * deliverable pull requests have no verdict?" — then writes the `deliverable-gate`
 * check run onto each head commit itself. Deliberately broader than the event that
 * prompted it, and self-healing for the same reason: a gate whose run was lost, or
 * whose PR predates the gate, is picked up on the next sweep rather than waiting for
 * an event that already happened.
 */

/** The check-run name IS the required-check context. One constant, because the
 *  ruleset registration (`REQUIRED_CHECK_CONTEXTS`) and this must be the same
 *  string or the gate reports a verdict nothing is waiting for. */
export const DELIVERABLE_CHECK_NAME = 'deliverable-gate';

export async function deliverableGate(gh: Octokit, repo: RepoRef, prNumber: number): Promise<GateReport> {
  const { data: pr } = await gh.pulls.get({ ...repo, pull_number: prNumber });
  // Every path the diff touches — added, modified, removed, renamed. `previous_filename`
  // is included deliberately: a rename WRITES both sides, so a patch that renames a
  // reserved file out of the way has touched it, and a gate that only saw the
  // destination would let exactly that through.
  const files = await gh.paginate(gh.pulls.listFiles, { ...repo, pull_number: prNumber, per_page: 100 });
  const paths = [...new Set(files.flatMap((f) => [f.filename, ...(f.previous_filename ? [f.previous_filename] : [])]))];

  const subject: DeliverablePr = {
    number: pr.number,
    headRef: pr.head.ref,
    headSha: pr.head.sha,
    body: pr.body ?? '',
    labels: pr.labels.map((l) => (typeof l === 'string' ? l : (l.name ?? ''))),
    paths,
  };

  // D1 runs first and its marker feeds the rest: the step every later gate judges
  // comes from the plan the marker names. Reading the plan once here, rather than in
  // each check, is what stops four gates disagreeing about which step this is.
  const d1 = await checkD1Provenance(gh, repo, subject);
  const { step } = await resolveDeliveringStep(gh, repo, d1.marker);
  // The per-workflow merge checkpoint (FR-062). Escalation-only: this can only ever
  // ADD a checkpoint — nothing read here can remove one a gate demands, which is why
  // the high-stakes branch inside resolveMergeAuthority does not consult it.
  const requiresOperatorMerge = /^(1|true|yes)$/i.test(process.env.BUILD_REQUIRES_OPERATOR_MERGE ?? '');

  const noMarker = (): string | null =>
    d1.marker ? null : 'no deliverable:v1 marker on the pull request (D1), so there is nothing to judge this against';
  const noStep = (): string | null =>
    !d1.marker
      ? 'no deliverable:v1 marker on the pull request (D1)'
      : step
        ? null
        : `the marker names step ${d1.marker.stepId}, which ${d1.marker.planRef} does not define (D1)`;

  const report = await runGateCatalogue(`#${prNumber} ${pr.head.ref}`, DELIVERABLE_CATALOGUE, [
    { id: 'D1', run: () => ({ id: d1.id, status: d1.status, requirement: d1.requirement, ...(d1.detail ? { detail: d1.detail } : {}) }) },
    { id: 'D2', skip: noStep, run: () => checkD2ScopeContainment(subject, step) },
    { id: 'D3', skip: noStep, run: () => checkD3MergeAuthority(step, { requiresOperatorMerge }) },
    { id: 'D4', skip: noMarker, run: () => checkD4ExecutorProvenance(d1.marker) },
    // NO `skip`, deliberately, and this is the difference that matters. D2/D3/D4 all
    // need the plan to have resolved; D5 needs nothing but the paths. A patch whose
    // marker is missing, whose plan is unreadable, or whose step is a lie is exactly
    // the patch most worth asking the subject question about — so D5 always runs.
    { id: 'D5', run: () => checkD5SubjectBoundary(subject) },
  ]);
  return { subject: report.subject, result: report.result, gates: report.gates };
}

/**
 * Gate every open deliverable pull request and record the verdict as a check run.
 *
 * Returns the reports so the caller can exit non-zero on a red one — but a red gate
 * here is NOT a failed sweep: the check run is the product, and it has been written.
 */
export async function sweepDeliverablePrs(
  gh: Octokit,
  repo: RepoRef,
  opts: { write?: boolean } = {},
): Promise<{ prNumber: number; report: GateReport }[]> {
  const open = await gh.paginate(gh.pulls.list, { ...repo, state: 'open', per_page: 100 });
  const out: { prNumber: number; report: GateReport }[] = [];
  for (const pr of open) {
    if (!pr.head.ref.startsWith('build/')) continue;
    // The marker, not the branch name, is what makes this a deliverable: only the
    // deterministic writer emits one, and it holds a write scope no executor has.
    if (!/<!--\s*deliverable:v1\s/.test(pr.body ?? '')) continue;
    const report = await deliverableGate(gh, repo, pr.number);
    if (opts.write !== false) {
      await gh.checks.create({
        ...repo,
        name: DELIVERABLE_CHECK_NAME,
        head_sha: pr.head.sha,
        status: 'completed',
        conclusion: report.result === 'pass' ? 'success' : 'failure',
        output: {
          title: report.result === 'pass' ? 'D1–D5 green' : `refused: ${refusalDetail(report.gates)}`.slice(0, 120),
          // The gate's OWN sentences, never a paraphrase — the same rule every other
          // refusal surface in this system follows (GHI #127).
          summary: report.gates
            .map((g) => `- **${g.id}** (${g.requirement}) — \`${g.status}\`${g.detail ? `: ${g.detail}` : ''}`)
            .join('\n'),
        },
      });
    }
    out.push({ prNumber: pr.number, report });
  }
  return out;
}

const isMain = process.argv[1]?.endsWith('deliverable-gate.ts');
if (isMain && process.argv.includes('--sweep')) {
  // The sweep is its own entry point rather than a mode of `cliMain`, because its
  // exit code means something different: `cliMain` exits 1 on a red gate, which is
  // right for the required check and wrong here — a red verdict that was
  // successfully RECORDED is a successful sweep. Failing the run would only hide
  // the check run it just wrote.
  const argv = process.argv.slice(2);
  const repoArg = argv[argv.indexOf('--repo') + 1] ?? '';
  const [owner, repoName] = repoArg.split('/');
  if (!owner || !repoName) {
    console.error('usage: deliverable-gate --sweep --repo <owner/repo>');
    process.exit(2);
  }
  void sweepDeliverablePrs(createClient(), { owner, repo: repoName })
    .then((results) => {
      if (results.length === 0) {
        console.log('no open deliverable pull requests — nothing to gate');
        return;
      }
      for (const { prNumber, report } of results) {
        console.log(`\n=== PR #${prNumber} ===`);
        printReport(report, false);
      }
    })
    .catch((error: unknown) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exit(1);
    });
} else if (isMain) {
  void cliMain(async (args) => {
    const prArg = args.get('pr');
    const repoArg = args.get('repo');
    if (!prArg || !repoArg) throw new UsageError('deliverable-gate (--pr <number> | --sweep) --repo <owner/repo> [--json]');
    const prNumber = Number(prArg);
    if (!Number.isInteger(prNumber) || prNumber <= 0) throw new UsageError(`invalid --pr: ${prArg}`);
    const [owner, repo] = repoArg.split('/');
    if (!owner || !repo) throw new UsageError(`invalid --repo: ${repoArg}`);
    return deliverableGate(createClient(), { owner, repo }, prNumber);
  });
}
