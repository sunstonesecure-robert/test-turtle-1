import { readFile } from 'node:fs/promises';
import type { Octokit } from '@octokit/rest';
import { createClient, type RepoRef } from '../../dashboard/lib/github/client';
import { cliMain, runGateCatalogue, UsageError, type GateReport } from './lib/runner';
import { PLAN_CATALOGUE } from './lib/catalogue';
import { checkG1Schema, checkG7NoOpenCorrections, checkG8AllJudged, checkG9VersionMonotonic, checkG10Acyclic, checkG11QuestionsAnswered } from './lib/checks-core';
import { checkG2ExactlyOnePriority, checkG3MustCoverage, checkG4SinglePassFail, checkG16SubjectBoundary } from './lib/checks-scope';
import { checkG5EvidenceTags } from './lib/checks-evidence';
import { checkG6HighStakesAuthority } from './lib/checks-highstakes';
import {
  checkG13WorkItemUniqueInPlan,
  checkG14WorkItemUnclaimedElsewhere,
  checkG15NoUnaddressedContradiction,
} from './lib/checks-binding';

/**
 * plan-gate (T035 + T057 + T093 + T107 + T240) — required status check on every approval PR.
 * Set: G1 schema, G2 exactly one priority, G3 MUST coverage, G4 single
 * pass/fail check, G5 evidence tags + stand-ins, G6 every high-stakes step names
 * its confirming authority, G7 no open corrections, G8 all boundary cases judged,
 * G9 version monotonic + tag absent, G10 acyclic deps, G11 every question answered,
 * G13 no two steps of this plan claim one work item, G14 no step claims a work item
 * another workload's official plan already claims (GHI #102), G15 no work item this
 * plan delivers carries contradicting evidence raised after the plan was written,
 * G16 no step's declared scope reaches the installed oversight machinery or the
 * governance record (FR-068 — the SUBJECT boundary, so the operator is never asked
 * to approve the system rewriting its own controls).
 *
 * G12 is NOT in the set and its number is not reused: the intent-drift gate is
 * deferred to GHI #28 with its detection mechanism unsettled, and two gates sharing
 * an id across the history is worse than a gap in the sequence.
 */

export async function planGate(gh: Octokit, repo: RepoRef, rawPlan: unknown, planLabel: string): Promise<GateReport> {
  const g1 = checkG1Schema(rawPlan);
  const plan = g1.plan;

  // G2/G5/G6 read the RAW document precisely so they can name the offending STEP
  // instead of a zod path — and EVERY input they refuse also fails G1, because the
  // schema already requires a priority, an evidence tag, and an authority on a
  // high-stakes step. Running G1 alone on the failure path made all three
  // unreachable exactly where they earn their keep: the operator got
  // "invalid_enum_value at steps.2.authority" and no step id. They take unparsed
  // input by design, so they are safe to run whatever G1 said.
  //
  // Everything else genuinely needs a parsed document. Those used to VANISH from a
  // schema-failure report, which is the shape GHI #108 is about: a nine-gate report
  // and a thirteen-gate report meant different things and looked the same. They are
  // now reported as not-applicable, with the reason, so the operator can see that
  // the missing coverage is a consequence of the schema failure rather than a gate
  // that was never there.
  const unparsed = (): string | null =>
    plan ? null : 'the plan does not parse as a plan document (G1), so there is nothing for this check to read';

  const report = await runGateCatalogue(planLabel, PLAN_CATALOGUE, [
    { id: 'G1', run: () => g1.result },
    { id: 'G2', run: () => checkG2ExactlyOnePriority(rawPlan) },
    { id: 'G3', skip: unparsed, run: () => checkG3MustCoverage(plan!) },
    { id: 'G4', skip: unparsed, run: () => checkG4SinglePassFail(plan!) },
    { id: 'G5', run: () => checkG5EvidenceTags(rawPlan) },
    { id: 'G6', run: () => checkG6HighStakesAuthority(rawPlan) },
    { id: 'G7', skip: unparsed, run: () => checkG7NoOpenCorrections(gh, repo, plan!.andon_issue) },
    { id: 'G8', skip: unparsed, run: () => checkG8AllJudged(gh, repo, plan!) },
    { id: 'G9', skip: unparsed, run: () => checkG9VersionMonotonic(gh, repo, plan!) },
    { id: 'G10', skip: unparsed, run: () => checkG10Acyclic(plan!) },
    { id: 'G11', skip: unparsed, run: () => checkG11QuestionsAnswered(gh, repo, plan!) },
    // G12 is deferred (GHI #28) — the number is skipped, never reused, so one id
    // never means two different gates across the history.
    { id: 'G13', skip: unparsed, run: () => checkG13WorkItemUniqueInPlan(plan!) },
    { id: 'G14', skip: unparsed, run: () => checkG14WorkItemUnclaimedElsewhere(gh, repo, plan!) },
    { id: 'G15', skip: unparsed, run: () => checkG15NoUnaddressedContradiction(gh, repo, plan!) },
    // G16 asks what the plan is ABOUT, which is a different question from every gate
    // above it and the one nothing asked until GHI #141 (FR-068). Pure: it reads the
    // declared scopes and the derived reserved set, no API call.
    { id: 'G16', skip: unparsed, run: () => checkG16SubjectBoundary(plan!) },
  ]);
  return { plan: planLabel, result: report.result, gates: report.gates };
}

/** The check-run name IS the required-check context. */
export const PLAN_CHECK_NAME = 'plan-gate';

/**
 * Record `plan-gate` as NOT APPLICABLE on every open pull request that carries no
 * plan document (T240 follow-on, found live 2026-08-25).
 *
 * WHY THIS EXISTS, because it looks like a workaround and is not quite one.
 *
 * `plan-gate` is a required status check on the default branch, and its
 * `pull_request` job skips itself on any head that is not `plan/**` — which
 * produces a `skipped` check run, which satisfies the rule. That has worked since
 * 2026-07-02 and still does, for pull requests a HUMAN opens.
 *
 * A DELIVERABLE pull request is opened by `build-publish` using `GITHUB_TOKEN`, and
 * GitHub deliberately emits no workflow events for actions taken with that token. So
 * `plan-gate.yml` never runs at all — not even to skip — and the head commit carries
 * no `plan-gate` check run of any kind. The required check is then unsatisfiable and
 * the deliverable is permanently unmergeable. Live: PR #54's merge was refused with
 * *"Required status check plan-gate is expected"* while `deliverable-gate` sat green
 * beside it.
 *
 * THE ALTERNATIVE WAS WORSE. `deliverable-gate`'s sweep could have written the
 * `plan-gate` context while it was there — one fewer moving part. It is refused on
 * purpose: a required check that can be satisfied by a DIFFERENT gate is not a
 * required check any more, and the next person to read a green `plan-gate` would have
 * no way to know which code produced it. Each gate writes its own context, or the
 * contexts mean nothing.
 *
 * `skipped`, not `success`: this pull request was not gated, and saying it passed
 * would be the absent-≠-success lie in the one place it would be hardest to notice
 * (GHI #108). The summary says which pull request it was and why the gate does not
 * apply.
 */
export async function sweepNonPlanPrs(gh: Octokit, repo: RepoRef): Promise<{ prNumber: number; wrote: boolean }[]> {
  const open = await gh.paginate(gh.pulls.list, { ...repo, state: 'open', per_page: 100 });
  const out: { prNumber: number; wrote: boolean }[] = [];
  for (const pr of open) {
    // An approval PR gates for real, through the pull_request job. Never touch one.
    if (pr.head.ref.startsWith('plan/')) continue;
    const { data: existing } = await gh.checks.listForRef({ ...repo, ref: pr.head.sha, check_name: PLAN_CHECK_NAME, per_page: 1 });
    if (existing.total_count > 0) {
      out.push({ prNumber: pr.number, wrote: false });
      continue;
    }
    await gh.checks.create({
      ...repo,
      name: PLAN_CHECK_NAME,
      head_sha: pr.head.sha,
      status: 'completed',
      conclusion: 'skipped',
      output: {
        title: 'not an approval pull request — no plan document to gate',
        summary:
          `Pull request #${pr.number} has head \`${pr.head.ref}\`, which is not a \`plan/<slug>/v<N>\` approval ` +
          'branch, so it carries no plan document and there is nothing for G1-G16 to read.\n\n' +
          'Recorded as `skipped` rather than `success` deliberately: this pull request was not gated, and a green ' +
          '`plan-gate` here would claim it was. Whatever governs this pull request is its own required check — for a ' +
          '`build/**` deliverable that is `deliverable-gate` (D1–D5).',
      },
    });
    out.push({ prNumber: pr.number, wrote: true });
  }
  return out;
}

const isMain = process.argv[1]?.endsWith('plan-gate.ts');
if (isMain && process.argv.includes('--sweep-non-plan')) {
  const argv = process.argv.slice(2);
  const repoArg = argv[argv.indexOf('--repo') + 1] ?? '';
  const [owner, repoName] = repoArg.split('/');
  if (!owner || !repoName) {
    console.error('usage: plan-gate --sweep-non-plan --repo <owner/repo>');
    process.exit(2);
  }
  void sweepNonPlanPrs(createClient(), { owner, repo: repoName })
    .then((results) => {
      const wrote = results.filter((r) => r.wrote);
      console.log(
        wrote.length === 0
          ? `no non-plan pull request needed a plan-gate verdict (${results.length} checked)`
          : `recorded plan-gate=skipped on PR(s) ${wrote.map((r) => `#${r.prNumber}`).join(', ')}`,
      );
    })
    .catch((error: unknown) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exit(1);
    });
} else if (isMain) {
  void cliMain(async (args) => {
    const planPath = args.get('plan');
    const repoArg = args.get('repo');
    if (!planPath || !repoArg) throw new UsageError('plan-gate --plan <path/to/plan.json> --repo <owner/repo> [--json]');
    const [owner, repo] = repoArg.split('/');
    if (!owner || !repo) throw new UsageError(`invalid --repo: ${repoArg}`);
    const raw = JSON.parse(await readFile(planPath, 'utf8'));
    return planGate(createClient(), { owner, repo }, raw, planPath);
  });
}
