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
