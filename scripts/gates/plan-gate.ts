import { readFile } from 'node:fs/promises';
import type { Octokit } from '@octokit/rest';
import { createClient, type RepoRef } from '../../dashboard/lib/github/client';
import { cliMain, runGates, UsageError, type GateReport } from './lib/runner';
import { checkG1Schema, checkG7NoOpenCorrections, checkG8AllJudged, checkG9VersionMonotonic, checkG10Acyclic, checkG11QuestionsAnswered } from './lib/checks-core';
import { checkG2ExactlyOnePriority, checkG3MustCoverage, checkG4SinglePassFail } from './lib/checks-scope';
import { checkG5EvidenceTags } from './lib/checks-evidence';

/**
 * plan-gate (T035 + T057 + T093) — required status check on every approval PR.
 * Set: G1 schema, G2 exactly one priority, G3 MUST coverage, G4 single
 * pass/fail check, G5 evidence tags + stand-ins, G7 no open corrections,
 * G8 all boundary cases judged, G9 version monotonic + tag absent, G10
 * acyclic deps, G11 every question answered. G6 arrives with US6.
 */

export async function planGate(gh: Octokit, repo: RepoRef, rawPlan: unknown, planLabel: string): Promise<GateReport> {
  const g1 = checkG1Schema(rawPlan);
  if (!g1.plan) {
    return { plan: planLabel, result: 'fail', gates: [g1.result] };
  }
  const plan = g1.plan;
  const report = await runGates(planLabel, [
    () => g1.result,
    () => checkG2ExactlyOnePriority(rawPlan),
    () => checkG3MustCoverage(plan),
    () => checkG4SinglePassFail(plan),
    () => checkG5EvidenceTags(rawPlan),
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
