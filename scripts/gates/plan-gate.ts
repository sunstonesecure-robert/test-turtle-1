import { readFile } from 'node:fs/promises';
import type { Octokit } from '@octokit/rest';
import { createClient, type RepoRef } from '../../dashboard/lib/github/client';
import { cliMain, runGates, UsageError, type GateReport } from './lib/runner';
import { checkG1Schema, checkG7NoOpenCorrections, checkG8AllJudged, checkG9VersionMonotonic, checkG10Acyclic, checkG11QuestionsAnswered } from './lib/checks-core';

/**
 * plan-gate (T035) — required status check on every approval PR.
 * Tracer set: G1 schema, G7 no open corrections, G8 all boundary cases judged,
 * G9 version monotonic + tag absent, G10 acyclic deps, G11 every question
 * answered. G2–G6 are wired in by US2/US5/US6.
 */

export async function planGate(gh: Octokit, repo: RepoRef, rawPlan: unknown, planLabel: string): Promise<GateReport> {
  const g1 = checkG1Schema(rawPlan);
  if (!g1.plan) {
    return { plan: planLabel, result: 'fail', gates: [g1.result] };
  }
  const plan = g1.plan;
  const report = await runGates(planLabel, [
    () => g1.result,
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
