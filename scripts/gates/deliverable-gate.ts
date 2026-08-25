import type { Octokit } from '@octokit/rest';
import { createClient, type RepoRef } from '../../dashboard/lib/github/client';
import { cliMain, runGateCatalogue, UsageError, type GateReport } from './lib/runner';
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
 */
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

const isMain = process.argv[1]?.endsWith('deliverable-gate.ts');
if (isMain) {
  void cliMain(async (args) => {
    const prArg = args.get('pr');
    const repoArg = args.get('repo');
    if (!prArg || !repoArg) throw new UsageError('deliverable-gate --pr <number> --repo <owner/repo> [--json]');
    const prNumber = Number(prArg);
    if (!Number.isInteger(prNumber) || prNumber <= 0) throw new UsageError(`invalid --pr: ${prArg}`);
    const [owner, repo] = repoArg.split('/');
    if (!owner || !repo) throw new UsageError(`invalid --repo: ${repoArg}`);
    return deliverableGate(createClient(), { owner, repo }, prNumber);
  });
}
