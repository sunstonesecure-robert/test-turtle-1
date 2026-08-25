import type { Octokit } from '@octokit/rest';
import { createClient, type RepoRef } from '../../dashboard/lib/github/client';
import { cliMain, runGateCatalogue, UsageError, type GateReport, type GateSetRef } from './lib/runner';
import { PREFLIGHT_CATALOGUE } from './lib/catalogue';
import {
  checkB1FrozenCurrent,
  checkB2PlanRevalidates,
  checkB3ChunkReady,
  checkB4IntentConfirmed,
  checkB5ConfirmationRecorded,
  checkB6NotFlagged,
  checkB7WorkloadActive,
  checkB8DispatchedOnFrozenRef,
  checkB9VerifyCommitDescends,
  stepsForChunk,
} from './lib/checks-preflight';
import { slugFromPlanRef } from '../../dashboard/lib/github/plans';

/**
 * build-preflight (T040 + T140 + T107) — step 1 of every dispatched build workflow.
 * A non-zero exit fails the run before any agent step executes.
 * Set: B1, B2, B5, B7, B8 always; B3/B6 when the build names a chunk, B4 when it is
 * also unattended; B9 only on a VERIFY run, which carries --verify-commit (FR-063).
 *
 * The plan-ref → slug parse lives in plans.ts beside `planBranch` that builds it: this
 * gate and the portfolio view must agree on which workload a ref names.
 *
 * THE WORKTREE AND THE RULES ARE SEPARABLE, AND ONLY ONE OF THEM IS HISTORICAL
 * (GHI #107). Nothing here reads the checkout: every gate resolves the plan through
 * the API at `--plan-ref` (`tryReadPlanAtRef`), so the preflight needs no frozen
 * worktree to do its job. The build workflow therefore runs this file from a CURRENT
 * gates checkout and only then checks out the frozen tag for the agent — freezing the
 * plan document is FR-007, but freezing the policy that enforces it means governance
 * is pinned to the rules of the approval date and gets weaker with age. Live evidence:
 * run 32074383640 built `plan/demo6/v1` (frozen 2026-07-10) under a three-gate
 * preflight; B3, B4, B5, B6 and B8 did not exist in that copy, so the US6 high-stakes
 * block and the B8 provenance binding were both inert and nothing said so.
 *
 * `gatesRef`/`gatesSha` are what the workflow saw when it checked the gate code out.
 * They are DESCRIPTIVE — no gate reads them — but they go in the report, because
 * "the current gates ran" is only trustworthy if the report can name which ones.
 */

export async function buildPreflight(
  gh: Octokit,
  repo: RepoRef,
  input: {
    planRef: string;
    workload: string;
    chunk?: number;
    unattended?: boolean;
    githubRef?: string;
    /** the step ids this build covers (`--step`, repeatable). Omitted is NOT "the
     *  whole plan" any more: when the build names a chunk, the covered step is
     *  derived from it (GHI #87). Omitted AND chunkless is the whole plan. */
    steps?: string[];
    /** the ref + commit this gate code was checked out at (GHI #107) */
    gateSet?: GateSetRef;
    /** VERIFY RUNS ONLY: the merged deliverable commit this run is about to judge.
     *  Present makes B9 apply; absent is a build run, which B8 governs instead
     *  (FR-063, added 2026-08-24). */
    verifyCommit?: string;
  },
): Promise<GateReport> {
  // B3/B6 run only when the build names a chunk; B4 only for unattended runs on
  // that chunk. A chunkless build (the US1 tracer's whole-plan demo build) is
  // legal and skips them — an UNATTENDED build without a chunk is not: there is
  // no chunk whose confirmed intent could authorize it (FR-018).
  if (input.unattended && input.chunk === undefined) {
    throw new UsageError('an unattended build requires --chunk — intent confirmation (B4) attaches to a chunk (FR-018)');
  }
  // WHICH high-stakes steps this build waits for (GHI #87, operator decision
  // 2026-08-17: only the step the named work item delivers). An explicit `--step`
  // still wins — the demo script and the review panel both scope B5 deliberately —
  // but a dispatched build no longer has to carry one: the chunk it names already
  // says which step it is doing, and `stepsForChunk` reads it from the plan.
  //
  // It returns null for anything ambiguous (no chunk, unreadable plan, a chunk no
  // step claims or two steps claim), and null means the WHOLE plan. So the narrowing
  // only ever happens on a binding B3 is about to accept; every uncertain reading
  // keeps the old, wider gate.
  const steps =
    input.steps && input.steps.length > 0
      ? input.steps
      : ((await stepsForChunk(gh, repo, input.planRef, input.chunk)) ?? undefined);
  // THE CATALOGUE, not a pre-filtered list (GHI #108). Every gate the contract
  // declares appears in the report, and a gate that does not apply says so WITH
  // ITS REASON rather than vanishing — because a report missing five gates used to
  // be shaped exactly like a report of a build where those five did not apply, and
  // like one where they all passed. `skip` is what makes a deliberate omission
  // legible; anything the catalogue declares and the code cannot run is `absent`,
  // and `absent` fails the report.
  const noChunk = () => (input.chunk === undefined ? 'no --chunk: this build names no work item' : null);
  const report = await runGateCatalogue(input.planRef, PREFLIGHT_CATALOGUE, [
    { id: 'B1', run: () => checkB1FrozenCurrent(gh, repo, input.planRef, input.workload) },
    { id: 'B2', run: () => checkB2PlanRevalidates(gh, repo, input.planRef) },
    { id: 'B3', skip: noChunk, run: () => checkB3ChunkReady(gh, repo, input.chunk!, input.planRef) },
    {
      id: 'B4',
      // Two distinct reasons, reported apart: an attended run does not need the
      // confirmation at all, whereas a chunkless one could not carry it.
      skip: () =>
        input.chunk === undefined
          ? 'no --chunk: intent confirmation attaches to a work item'
          : !input.unattended
            ? 'attended run: someone is watching, so no recorded intent confirmation is required'
            : null,
      run: () => checkB4IntentConfirmed(gh, repo, input.chunk!),
    },
    // B5 runs on every build, chunked or not: a high-stakes step is gated by the
    // plan that flagged it, not by whether this build happens to name a chunk.
    { id: 'B5', run: () => checkB5ConfirmationRecorded(gh, repo, input.planRef, steps) },
    { id: 'B6', skip: noChunk, run: () => checkB6NotFlagged(gh, repo, input.chunk!) },
    { id: 'B7', run: () => checkB7WorkloadActive(gh, repo, input.workload) },
    // B8 is pure and reads no API, so it runs last and costs nothing — but its
    // failure is the most structural of the set: the run is building the wrong
    // worktree entirely (GHI #72 option A).
    { id: 'B8', run: () => checkB8DispatchedOnFrozenRef(input.planRef, input.githubRef) },
    // B9 applies to VERIFY runs, which judge a merged commit. A build run has none
    // yet — and saying so by name is the point: a report that simply omitted B9 on
    // builds would be shaped like a report where it passed (GHI #108).
    {
      id: 'B9',
      skip: () =>
        input.verifyCommit === undefined
          ? 'no --verify-commit: this is a build run, not a verify run — B8 governs the ref it was dispatched on'
          : null,
      run: () => checkB9VerifyCommitDescends(gh, repo, input.planRef, input.verifyCommit!),
    },
  ]);
  return {
    plan: input.planRef,
    // Before the verdict, deliberately: a reader of this JSON has to know which
    // rule set produced the gate list before they can read an absence as a pass.
    ...(input.gateSet ? { gate_set: input.gateSet } : {}),
    result: report.result,
    gates: report.gates,
  };
}

const isMain = process.argv[1]?.endsWith('build-preflight.ts');
if (isMain) {
  void cliMain(async (args, flags, repeated) => {
    const planRef = args.get('plan-ref');
    const repoArg = args.get('repo');
    if (!planRef || !repoArg) {
      throw new UsageError('build-preflight --plan-ref <tag> --workload <slug> --repo <owner/repo> [--chunk <issue#>] [--unattended] [--step <step-id>]... [--verify-commit <sha>] [--gates-ref <ref> --gates-sha <sha>] [--json]');
    }
    // Repeatable: one --step per step this build covers. Passing none is not a
    // selection — B5 then gates every high-stakes step in the plan (FR-024).
    const steps = repeated.get('step') ?? [];
    const chunkArg = args.get('chunk');
    const chunk = chunkArg !== undefined ? Number(chunkArg) : undefined;
    if (chunkArg !== undefined && !Number.isInteger(chunk)) {
      throw new UsageError(`invalid --chunk: ${chunkArg} (expected an issue number)`);
    }
    const workload = args.get('workload') ?? slugFromPlanRef(planRef);
    if (!workload) throw new UsageError(`cannot derive workload slug from ${planRef}; pass --workload`);
    const [owner, repo] = repoArg.split('/');
    if (!owner || !repo) throw new UsageError(`invalid --repo: ${repoArg}`);
    // GITHUB_REF comes from the Actions environment, never from an argument: a
    // caller-supplied ref would let the very dispatch B8 refuses assert its own
    // correctness.
    const githubRef = process.env.GITHUB_REF;
    // Arguments, not environment, and the opposite of B8's reasoning on purpose:
    // this is a LABEL on the report, not a check, and only the workflow that did
    // the checkout knows what it checked out. Both halves or neither — a ref with
    // no sha names a moving target, and a sha with no ref names nothing a human
    // can look up (GHI #107).
    const gatesRef = args.get('gates-ref');
    const gatesSha = args.get('gates-sha');
    if ((gatesRef === undefined) !== (gatesSha === undefined)) {
      throw new UsageError('--gates-ref and --gates-sha go together — a ref without its resolved commit is not an auditable gate-set identity');
    }
    return buildPreflight(createClient(), { owner, repo }, {
      planRef,
      workload,
      ...(chunk !== undefined ? { chunk } : {}),
      ...(steps.length > 0 ? { steps } : {}),
      ...(flags.has('unattended') ? { unattended: true } : {}),
      ...(githubRef !== undefined ? { githubRef } : {}),
      ...(gatesRef !== undefined && gatesSha !== undefined ? { gateSet: { ref: gatesRef, sha: gatesSha } } : {}),
      ...(args.get('verify-commit') !== undefined ? { verifyCommit: args.get('verify-commit')! } : {}),
    });
  });
}
