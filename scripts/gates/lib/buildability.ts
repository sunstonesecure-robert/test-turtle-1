import type { Octokit } from '@octokit/rest';
import type { RepoRef } from '../../../dashboard/lib/github/client';
import { apiMessage } from '../../../dashboard/lib/github/errors';
import { resolveCurrent, tryReadPlanAtRef } from '../../../dashboard/lib/github/plans';
import { checkB1FrozenCurrent, checkB2PlanRevalidates } from './checks-preflight';
import { readFileAtRef, type FileAtRef } from './repo-read';
import type { GateResult } from './runner';

/**
 * "Could this workload's OFFICIAL plan pass preflight TODAY?" (GHI #109)
 *
 * THE GAP THIS FILLS. Nothing anywhere reported that a workload's approved plan
 * can never be built. The operator found out by dispatching a build and reading a
 * failed Actions run; `/workloads`, the work-item cards and the readiness check all showed
 * the workload as fine. Two live workloads in the governed repo were in exactly
 * that state on 2026-08-17, and three more were working only because obsolete
 * files nobody meant to keep had never been cleaned up — a tidy-up commit would
 * have bricked them with no warning anywhere.
 *
 * The cause of the first instance was that removing the `plans/<slug>/CURRENT`
 * pointer (GHI #44) was a breaking change to something ALREADY-FROZEN plans
 * depend on: their gate code reads a file the project deliberately deleted, so
 * B1 fails forever. Running the gates from a current source (GHI #107) stops that
 * happening to plans frozen from now on. It does nothing for the plans already
 * bricked, and it cannot: `workflow_dispatch` on a tag runs the workflow FILE as
 * it exists at that tag, so a plan frozen before that fix keeps its old workflow
 * and its old, frozen-in gate code. Which is why detection is a separate thing
 * from the fix, and why a plan can be unbuildable for reasons neither one covers.
 *
 * WHAT IS CHECKED, AND WHY ONLY THIS. The STRUCTURAL half of preflight — the
 * gates that are a property of the plan and the repo rather than of a particular
 * dispatch:
 *
 *   B1/B2 (reused, never re-implemented) — the frozen tag resolves as the
 *     official version and its document still validates. These are the gates that
 *     fail for the whole plan rather than for one build of it.
 *
 *   the frozen workflow — whether the build workflow AT THE TAG runs its preflight
 *     from a current gate source. If it does not, this plan is policed by whatever
 *     the rules were on its approval date, and any dependency those rules had on a
 *     since-removed mechanism is a permanent failure with no way to fix it in place.
 *
 * Deliberately EXCLUDED: B3/B4/B6 need a chunk, B8 needs a dispatch ref, and B5 is
 * a state a flagged step is legitimately IN — "waiting on an authority" is the
 * gate working, not a broken plan. Reporting those here would turn an
 * action-required banner into noise the operator learns to ignore, which is how a
 * real one goes unnoticed.
 */

/** The build workflow as installed in the governed repo. Named once here rather
 *  than spelled at the read below, so the file this looks for and the file
 *  readiness I5 requires stay one string. */
export const BUILD_WORKFLOW_PATH = '.github/workflows/build-template.lock.yml';

/**
 * The agent's briefing, as installed. The compiled lock RUNTIME-IMPORTS this file
 * (`{{#runtime-import build-template.md}}`) out of the SAME checkout GitHub ran the
 * lock from — so on a dispatch against a tag, the prompt the build agent is handed is
 * the frozen one exactly as the workflow is. A prompt fix is as unreachable as a
 * workflow fix, which is why the drift comparison below covers both.
 */
export const BUILD_PROMPT_PATH = '.github/workflows/build-template.md';

/**
 * The two files a build ACTUALLY RUNS FROM at the dispatch ref, and the whole of what
 * machinery drift is measured over (ADR-0008, GHI #265).
 *
 * Deliberately not "everything `init` installs". The toolchain — `schemas/`,
 * `scripts/`, `dashboard/lib/`, `executors/` and the six toolchain files — is NOT
 * frozen with the plan in any way that matters: the gates are checked out from the
 * default branch before the tag is (GHI #107), and GHI #274 staged
 * `materialize-vendor.ts` out to `$RUNNER_TEMP` on the same argument. Comparing those
 * would make every live plan unbuildable within a day of an ordinary commit to `main`,
 * for a difference no build ever reads.
 */
export const FROZEN_MACHINERY_PATHS = [BUILD_WORKFLOW_PATH, BUILD_PROMPT_PATH] as const;

/**
 * The marker that a lock runs its gates from a current checkout: the preflight
 * invocation carries `--gates-ref`. Chosen over parsing the YAML because it is
 * the ARGUMENT the fix introduced — a lock that passes it necessarily resolved a
 * gates ref, and a lock that does not, necessarily runs whatever gate code its own
 * checkout holds. A structural YAML walk would be more code for a weaker claim.
 */
const CURRENT_GATES_MARKER = '--gates-ref';

export interface BuildabilityVerdict {
  slug: string;
  /** the official version, or null when this workload has approved none */
  planRef: string | null;
  /** false only when something makes the plan unbuildable — never for "nothing frozen yet" */
  buildable: boolean;
  /** operator-facing, one per cause, each actionable on its own; empty when buildable */
  reasons: string[];
  /**
   * The review that approved this version — WHERE the recovery happens.
   *
   * A verdict without a destination is only half a report: the operator is told
   * their approved plan cannot be built and left to find the place to fix it. The
   * exit is a re-open, and a re-open is offered on the review that approved the
   * current version, so that review is the answer to "where do I go?" (the
   * runbook's step 1). Null when the plan could not be read to find it.
   */
  andonIssue: number | null;
  /** the structural gate results behind the verdict, in preflight order */
  gates: GateResult[];
  /**
   * Whether what a build runs from AT THE TAG is still what is installed today.
   *
   * A VALUE, not the absence of a sentence (ADR-0007). "Compared, identical" and
   * "could not look" produce the same silence on every surface, and if silence were
   * their only expression no test could tell them apart — which is exactly how
   * `unmetPrerequisites` shipped a warning that went quiet on the case it existed
   * for. `unknown` carries why. Never `drifted` without a matching entry in `reasons`.
   */
  machineryDrift: MachineryDrift;
}

/**
 * The answer to "is the machinery at this tag still the installed machinery?", with
 * "we could not find out" as its own value rather than as a shrug.
 *
 * `drifted` beats `unknown` beats `same`: a difference we actually observed is not
 * suppressed because a second read failed.
 */
export type MachineryDrift =
  /** compared, and the frozen copies are byte-identical to the installed ones */
  | { kind: 'same' }
  | { kind: 'drifted'; branch: string; paths: string[] }
  /** we tried to compare and could not — a fault, a throttle, a file too large */
  | { kind: 'unknown'; why: string }
  /**
   * NOTHING WAS COMPARED, and that is a third answer rather than a flavour of the
   * first two. A workload with no frozen plan has nothing to compare; a tag that
   * already carries its own refusal is deliberately not compared, because one cause
   * gets one remedy. Recording either as `same` would say "we looked and they match"
   * about a look nobody took — the conflation ADR-0007 names, one level in from where
   * `unknown` fixes it.
   */
  | { kind: 'not-compared'; why: string };

/** The installed side, read ONCE per scan — see `readInstalledMachinery`. */
export type InstalledMachinery =
  | { kind: 'read'; branch: string; files: ReadonlyMap<string, FileAtRef> }
  | { kind: 'unreadable'; why: string };

/**
 * Whether a build dispatched on this frozen tag would be policed by CURRENT rules.
 *
 * Three outcomes, and the middle one is the whole point: a tag whose workflow runs
 * the preflight out of its own checkout is not merely at risk — every gate added
 * since it was frozen is already absent from every build of it, silently.
 */
function frozenWorkflowReason(planRef: string, lock: string | null): string | null {
  if (lock === null) {
    return (
      `the build workflow is missing from ${planRef} — a build dispatched on this tag has nothing to run, ` +
      `so this plan cannot be built at all. Re-approve it as a new version (re-open, approve, freeze) to cut a ` +
      `tag that carries the workflow.`
    );
  }
  if (!lock.includes(CURRENT_GATES_MARKER)) {
    return (
      `${planRef} was frozen before builds ran their checks from current code, so a build of it is policed by ` +
      `the rules of its approval date — every check added since is silently absent, and any that depended on ` +
      `something the project has removed fails permanently. Re-approve it as a new version (re-open, approve, ` +
      `freeze) to pick up the current checks.`
    );
  }
  return null;
}

/**
 * The installed copies, read ONCE for a whole scan.
 *
 * Hoisted out of the per-workload function on purpose. `scanBuildability` is a
 * `Promise.all`, and the ETag cache (`client.ts`) is written only AFTER a response
 * returns and has no in-flight dedupe — so N workloads issue N identical
 * default-branch GETs before any of them can populate the key. One read per scan
 * instead of one per workload. FR-046's per-workload independence is untouched: this
 * read touches no workload's refs or documents.
 */
export async function readInstalledMachinery(gh: Octokit, repo: RepoRef): Promise<InstalledMachinery> {
  let branch: string;
  try {
    const { data } = await gh.repos.get({ ...repo });
    branch = data.default_branch;
  } catch (error: unknown) {
    return { kind: 'unreadable', why: apiMessage(error) };
  }
  const files = new Map<string, FileAtRef>();
  for (const path of FROZEN_MACHINERY_PATHS) {
    files.set(path, await readFileAtRef(gh, repo, path, branch));
  }
  return { kind: 'read', branch, files };
}

/**
 * Is what a build runs from at this tag still what is installed today? (GHI #265,
 * ADR-0008.)
 *
 * WHAT COUNTS AS DRIFT IS NARROW ON PURPOSE. A pair is compared only when BOTH sides
 * came back as text. Three absences are each not drift, and each for its own reason:
 *
 *   absent at the tag        a tag predating the file — the lock's own absence is
 *                            already `frozenWorkflowReason`'s refusal, and a missing
 *                            prompt means the frozen lock never imported one.
 *   absent on the branch     a RETIREMENT (`RETIRED_TEMPLATES`), not a fix that failed
 *                            to arrive. Readiness owns a missing installed workflow.
 *   unreadable either side   not a fact. It makes the answer `unknown`.
 *
 * `installed` is injectable so a scan can share one read, and self-fetching so the
 * dispatch click can ask with nothing in hand — the same shape the preflight gates
 * `dispatchBuild` reuses have.
 */
export async function checkMachineryCurrentAtTag(
  gh: Octokit,
  repo: RepoRef,
  planRef: string,
  installed?: InstalledMachinery,
): Promise<MachineryDrift> {
  const current = installed ?? (await readInstalledMachinery(gh, repo));
  if (current.kind === 'unreadable') {
    return { kind: 'unknown', why: `the installed copy could not be read (${current.why})` };
  }
  const drifted: string[] = [];
  let degraded: string | null = null;
  for (const path of FROZEN_MACHINERY_PATHS) {
    const here = current.files.get(path) ?? { kind: 'unreadable' as const, why: 'it was never read' };
    if (here.kind === 'unreadable') {
      degraded ??= `${path} on ${current.branch} could not be read (${here.why})`;
      continue;
    }
    const there = await readFileAtRef(gh, repo, path, planRef);
    if (there.kind === 'unreadable') {
      degraded ??= `${path} at ${planRef} could not be read (${there.why})`;
      continue;
    }
    // A verified absence on either side is not a difference — see the docblock.
    if (here.kind === 'absent' || there.kind === 'absent') continue;
    if (here.text !== there.text) drifted.push(path);
  }
  // A difference we SAW outranks a comparison we could not make.
  if (drifted.length > 0) return { kind: 'drifted', branch: current.branch, paths: drifted };
  if (degraded !== null) return { kind: 'unknown', why: degraded };
  return { kind: 'same' };
}

/**
 * THE ONE ENTRY POINT BOTH SURFACES USE: the operator-facing reason machinery drift
 * gives for this tag, or null when there is none to give.
 *
 * It carries the SKIP as well as the comparison. `dispatchBuild` asking
 * `checkMachineryCurrentAtTag` directly was a real way for the two to disagree: on a
 * tag whose lock predates `--gates-ref` AND whose prompt drifted, the card printed the
 * frozen-gates sentence (because it skips the comparison) while the click printed the
 * drift sentence. Both withhold the build, so nothing broke — but the comment beside
 * the click claimed they could not disagree, and they could.
 */
export async function machineryDriftReason(
  gh: Octokit,
  repo: RepoRef,
  planRef: string,
  installed?: InstalledMachinery,
): Promise<{ drift: MachineryDrift; reason: string | null; workflowReason: string | null }> {
  // FOUR-VALUED, not the throwing reader. `absent` is a verified 404 and is a fact — it
  // is `frozenWorkflowReason`'s "the build workflow is missing from this tag" refusal,
  // and that refusal is correct. `unreadable` is NOT a fact: a 5xx or a throttle on this
  // one read used to fault the whole workloads page, and now that the same read feeds a
  // REFUSAL at the dispatch click it would also close the only retry route the product
  // has. A read that could not be made says nothing and refuses nothing (ADR-0007).
  const lock = await readFileAtRef(gh, repo, BUILD_WORKFLOW_PATH, planRef);
  if (lock.kind === 'unreadable') {
    return {
      drift: { kind: 'unknown', why: `${BUILD_WORKFLOW_PATH} at ${planRef} could not be read (${lock.why})` },
      reason: null,
      workflowReason: null,
    };
  }
  const workflowReason = frozenWorkflowReason(planRef, lock.kind === 'text' ? lock.text : null);
  if (workflowReason !== null) {
    return {
      drift: {
        kind: 'not-compared',
        why: 'the build workflow at this tag already has its own reason and its own re-open, so a second comparison would buy a read and add nothing',
      },
      reason: null,
      workflowReason,
    };
  }
  const drift = await checkMachineryCurrentAtTag(gh, repo, planRef, installed);
  return {
    drift,
    reason: drift.kind === 'drifted' ? machineryDriftSentence(planRef, drift) : null,
    workflowReason: null,
  };
}

/** What each drifted path IS, in words an operator reads. */
const MACHINERY_LABEL: Readonly<Record<string, string>> = {
  [BUILD_WORKFLOW_PATH]: 'the build workflow',
  [BUILD_PROMPT_PATH]: 'the instructions the build agent is given',
};

/**
 * The ONE wording the banner, the review and the dispatch refusal all use — so the
 * page that withholds the button and the click that refuses cannot say different
 * things about the same fact. Ends with a period, because `dispatchBuild` splices
 * ` No run was started.` after it (the `awaitingConfirmationSentence` pattern).
 */
export function machineryDriftSentence(
  planRef: string,
  drift: Extract<MachineryDrift, { kind: 'drifted' }>,
): string {
  const what = drift.paths.map((p) => MACHINERY_LABEL[p] ?? p).join(' and ');
  const verb = drift.paths.length === 1 ? 'differs' : 'differ';
  return (
    `${planRef} was frozen with an older copy of what a build runs: ${what} at this tag ${verb} from the copy ` +
    `installed on ${drift.branch} today (${drift.paths.join(', ')}). A build dispatched on this tag runs the ` +
    `frozen copy, and installing the framework again updates ${drift.branch} without reaching a tag. Re-approve ` +
    `it as a new version (re-open, approve, freeze) to cut a tag that carries the current copy.`
  );
}

/**
 * The verdict for ONE workload. Never throws for an ordinary state: a workload
 * with nothing frozen is `buildable: true` with a null ref, because "has not
 * approved a plan yet" is not a broken plan and surfacing it as action-required
 * would flag every new workload the day it is created.
 */
export async function checkOfficialPlanBuildable(
  gh: Octokit,
  repo: RepoRef,
  slug: string,
  installed?: InstalledMachinery,
): Promise<BuildabilityVerdict> {
  const planRef = await resolveCurrent(gh, repo, slug);
  if (planRef === null) {
    // Nothing frozen, so nothing CAN have drifted. `same` rather than `unknown`: this
    // is an answer, not a failed read.
    return {
      slug,
      planRef: null,
      buildable: true,
      reasons: [],
      andonIssue: null,
      gates: [],
      machineryDrift: { kind: 'not-compared', why: 'this workload has no frozen plan, so there is no tag to compare' },
    };
  }

  // The gate functions themselves, not a second opinion (gate-checks-cli.md
  // "Shared conventions"): what this scan calls unbuildable has to be what the
  // preflight actually refuses, in its own words.
  const gates = [
    await checkB1FrozenCurrent(gh, repo, planRef, slug),
    await checkB2PlanRevalidates(gh, repo, planRef),
  ];
  // Read from the FROZEN document, so the review named is the one that approved
  // the version being complained about. An unreadable plan yields null rather than
  // a guess — that is one of the causes below, and pointing somewhere wrong would
  // be worse than pointing nowhere.
  const { plan } = await tryReadPlanAtRef(gh, repo, planRef);
  const reasons = gates
    .filter((g) => g.status === 'fail')
    .map((g) =>
      g.id === 'B1'
        ? `the approved plan ${planRef} is no longer resolvable as this workload's official version (${g.detail}) — a build of it is refused before any work happens`
        : `the approved plan ${planRef} no longer reads as a valid plan (${g.detail}) — a build of it is refused before any work happens`,
    );

  // THE BUILD WORKFLOW AT THE TAG, AND MACHINERY DRIFT (GHI #265, ADR-0008) — one read,
  // one decision, shared with the dispatch click so the surface that withholds the
  // button and the click that refuses cannot reach two different sentences about one
  // tag. The drift comparison is skipped entirely when the workflow reason already
  // fired. One cause gets one remedy: a tag with no build workflow, or one
  // predating the current checks, already has its sentence and its re-open, and a
  // second sentence for the same click would buy a read and say nothing new. The skip
  // is RECORDED as `not-compared`, never as `same` — see `MachineryDrift`.
  //
  // `machineryDriftReason` below is the same decision, shared with `dispatchBuild`, so
  // the surface that withholds the button and the click that refuses cannot reach two
  // different sentences about one tag.
  const machinery = await machineryDriftReason(gh, repo, planRef, installed);
  if (machinery.workflowReason !== null) reasons.push(machinery.workflowReason);
  if (machinery.reason !== null) reasons.push(machinery.reason);

  return {
    slug,
    planRef,
    buildable: reasons.length === 0,
    reasons,
    andonIssue: plan?.andon_issue ?? null,
    gates,
    machineryDrift: machinery.drift,
  };
}

/**
 * Every named workload's verdict, concurrently — one workload's reads touch only its
 * own refs and document, so nothing here couples two workloads (FR-046).
 *
 * The INSTALLED side of the drift comparison is read once, before the fan-out, and
 * shared. It is the same two files for every workload, and `Promise.all` issues every
 * request before the ETag cache can answer any of them, so leaving the read inside the
 * per-workload function costs one full request per workload for one identical answer.
 * Sharing it couples no two workloads: it is a read of the default branch, not of
 * anything either of them owns.
 */
export async function scanBuildability(gh: Octokit, repo: RepoRef, slugs: string[]): Promise<BuildabilityVerdict[]> {
  // An empty scan buys no reads. Otherwise `/workloads` with no active workload would
  // pay for a comparison against nothing.
  if (slugs.length === 0) return [];
  const installed = await readInstalledMachinery(gh, repo);
  return Promise.all(slugs.map((slug) => checkOfficialPlanBuildable(gh, repo, slug, installed)));
}
