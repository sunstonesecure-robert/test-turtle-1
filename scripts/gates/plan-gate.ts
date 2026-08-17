import { readFile } from 'node:fs/promises';
import type { Octokit } from '@octokit/rest';
import { createClient, type RepoRef } from '../../dashboard/lib/github/client';
import { cliMain, runGates, UsageError, type GateReport } from './lib/runner';
import { checkG1Schema, checkG7NoOpenCorrections, checkG8AllJudged, checkG9VersionMonotonic, checkG10Acyclic, checkG11QuestionsAnswered } from './lib/checks-core';
import { checkG2ExactlyOnePriority, checkG3MustCoverage, checkG4SinglePassFail } from './lib/checks-scope';
import { checkG5EvidenceTags } from './lib/checks-evidence';
import { checkG6HighStakesAuthority } from './lib/checks-highstakes';

/**
 * plan-gate (T035 + T057 + T093 + T107) — required status check on every approval PR.
 * Set: G1 schema, G2 exactly one priority, G3 MUST coverage, G4 single
 * pass/fail check, G5 evidence tags + stand-ins, G6 every high-stakes step names
 * its confirming authority, G7 no open corrections, G8 all boundary cases judged,
 * G9 version monotonic + tag absent, G10 acyclic deps, G11 every question answered.
 */

export async function planGate(gh: Octokit, repo: RepoRef, rawPlan: unknown, planLabel: string): Promise<GateReport> {
  const g1 = checkG1Schema(rawPlan);
  if (!g1.plan) {
    // G2/G5/G6 read the RAW document precisely so they can name the offending STEP
    // instead of a zod path — and EVERY input they refuse also fails G1, because the
    // schema already requires a priority, an evidence tag, and an authority on a
    // high-stakes step. Returning G1 alone therefore made all three unreachable
    // exactly where they earn their keep: the operator got "invalid_enum_value at
    // steps.2.authority" and no step id. They take unparsed input by design, so they
    // are safe to run on the failure path; G3/G4/G7–G11 genuinely need a parsed doc
    // and stay behind the guard. Order still follows gate-checks-cli.md §1.
    return {
      plan: planLabel,
      result: 'fail',
      gates: [
        g1.result,
        checkG2ExactlyOnePriority(rawPlan),
        checkG5EvidenceTags(rawPlan),
        checkG6HighStakesAuthority(rawPlan),
      ],
    };
  }
  const plan = g1.plan;
  const report = await runGates(planLabel, [
    () => g1.result,
    () => checkG2ExactlyOnePriority(rawPlan),
    () => checkG3MustCoverage(plan),
    () => checkG4SinglePassFail(plan),
    () => checkG5EvidenceTags(rawPlan),
    () => checkG6HighStakesAuthority(rawPlan),
    () => checkG7NoOpenCorrections(gh, repo, plan.andon_issue),
    () => checkG8AllJudged(gh, repo, plan),
    () => checkG9VersionMonotonic(gh, repo, plan),
    () => checkG10Acyclic(plan),
    () => checkG11QuestionsAnswered(gh, repo, plan),
  ]);
  return { plan: planLabel, result: report.result, gates: report.gates };
}

const isMain = process.argv[1]?.endsWith('plan-gate.ts');
if (isMain) {
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
