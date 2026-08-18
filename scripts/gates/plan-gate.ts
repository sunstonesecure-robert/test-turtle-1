import { readFile } from 'node:fs/promises';
import type { Octokit } from '@octokit/rest';
import { createClient, type RepoRef } from '../../dashboard/lib/github/client';
import { cliMain, runGateCatalogue, UsageError, type GateReport } from './lib/runner';
import { checkG1Schema, checkG7NoOpenCorrections, checkG8AllJudged, checkG9VersionMonotonic, checkG10Acyclic, checkG11QuestionsAnswered } from './lib/checks-core';
import { checkG2ExactlyOnePriority, checkG3MustCoverage, checkG4SinglePassFail } from './lib/checks-scope';
import { checkG5EvidenceTags } from './lib/checks-evidence';
import { checkG6HighStakesAuthority } from './lib/checks-highstakes';
import { checkG13WorkItemUniqueInPlan, checkG14WorkItemUnclaimedElsewhere } from './lib/checks-binding';

/**
 * plan-gate (T035 + T057 + T093 + T107) — required status check on every approval PR.
 * Set: G1 schema, G2 exactly one priority, G3 MUST coverage, G4 single
 * pass/fail check, G5 evidence tags + stand-ins, G6 every high-stakes step names
 * its confirming authority, G7 no open corrections, G8 all boundary cases judged,
 * G9 version monotonic + tag absent, G10 acyclic deps, G11 every question answered,
 * G13 no two steps of this plan claim one work item, G14 no step claims a work item
 * another workload's official plan already claims (GHI #102).
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

  const report = await runGateCatalogue(planLabel, [
    { id: 'G1', requirement: 'integrity', run: () => g1.result },
    { id: 'G2', requirement: 'FR-009', run: () => checkG2ExactlyOnePriority(rawPlan) },
    { id: 'G3', requirement: 'FR-012', skip: unparsed, run: () => checkG3MustCoverage(plan!) },
    { id: 'G4', requirement: 'FR-011', skip: unparsed, run: () => checkG4SinglePassFail(plan!) },
    { id: 'G5', requirement: 'FR-019', run: () => checkG5EvidenceTags(rawPlan) },
    { id: 'G6', requirement: 'FR-023', run: () => checkG6HighStakesAuthority(rawPlan) },
    { id: 'G7', requirement: 'FR-005', skip: unparsed, run: () => checkG7NoOpenCorrections(gh, repo, plan!.andon_issue) },
    { id: 'G8', requirement: 'FR-002', skip: unparsed, run: () => checkG8AllJudged(gh, repo, plan!) },
    { id: 'G9', requirement: 'FR-027', skip: unparsed, run: () => checkG9VersionMonotonic(gh, repo, plan!) },
    { id: 'G10', requirement: 'data integrity', skip: unparsed, run: () => checkG10Acyclic(plan!) },
    { id: 'G11', requirement: 'FR-056', skip: unparsed, run: () => checkG11QuestionsAnswered(gh, repo, plan!) },
    // G12 is deferred (GHI #28) — the number is skipped, never reused, so one id
    // never means two different gates across the history.
    { id: 'G13', requirement: 'FR-017', skip: unparsed, run: () => checkG13WorkItemUniqueInPlan(plan!) },
    { id: 'G14', requirement: 'FR-046', skip: unparsed, run: () => checkG14WorkItemUnclaimedElsewhere(gh, repo, plan!) },
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
