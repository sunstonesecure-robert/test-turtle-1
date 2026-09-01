import type { Octokit } from '@octokit/rest';
import type { RepoRef } from '../../../dashboard/lib/github/client';
import { readPlanAtRef, slugFromPlanRef, tagTargetSha } from '../../../dashboard/lib/github/plans';
import { parseDeliverableMarker, type DeliverableMarker } from '../../../dashboard/lib/github/markers';
import { errorMessage, errorStatus } from '../../../dashboard/lib/github/errors';
import type { PlanDoc, PlanStep } from '../../../schemas/plan';
import { ExecutorConfig } from '../../../schemas/executor';
import { pathsOutside, isRepoRelative, normalizePath } from './globs';
// The FR-062 rule lives in the shared seam, not here: THREE callers read it — D3
// below, the `build-merge` writer, and the dashboard's deliverable list — and the
// `deriveCompletionStatus` precedent puts a derivation with that profile in
// `dashboard/lib/github/`, which gates import from rather than the other way round.
import { resolveMergeAuthority, type MergeAuthorityInputs } from '../../../dashboard/lib/github/builds';
import { reservedPathsTouched, reservedRefusalDetail, type ReservedPathOptions } from './reserved-paths';
import { ApiUnavailableError, type GateResult } from './runner';

/**
 * Deliverable-gate checks (gate-checks-cli.md §2b) — the required status check on
 * every `build/<slug>/<step-id>` pull request. This is the gate that decides whether
 * an agent's actual work may land, and the only gate in the system that reads a patch.
 *
 *   D1  the PR corresponds to a VALIDATED deliverable patch from a build run on the
 *       frozen tag: the marker's plan_ref/step/run are recorded, the run really was
 *       this build, and the head is a DESCENDANT of the frozen tag's commit (FR-060,
 *       FR-007 as amended — a deliverable descends from the frozen plan, never
 *       alters it)
 *   D2  every path falls inside the DECLARED SCOPE of the one step it delivers;
 *       a straying path fails and is named (FR-061)
 *   D3  merge authority is satisfied — pre-authorized by the approved plan, or the
 *       operator's own merge where configuration demands a checkpoint or the step
 *       carries a recorded external confirmation. Escalation-only (FR-062, FR-024)
 *   D4  executor provenance is recorded on the PR (FR-065)
 *   D5  no path is inside the RESERVED SET — the installed oversight machinery and
 *       the governance record. Read from the patch ALONE; D5 never consults the
 *       declared scope (FR-068)
 *
 * WHY D5 SITS NEXT TO D2 AND IGNORES IT. D2 is an inclusion allowlist: it asks "did
 * the patch stay inside what the plan declared?", which a plan aimed at the wrong
 * subject answers perfectly. The property D5 holds is different in kind — "the system
 * did not rewrite its own controls" — and it cannot be expressed over a scope the
 * plan itself authors. If a step's scope could satisfy D5, a proposal would simply
 * declare `.github/workflows/**` and the boundary would be gone. Live evidence that
 * this is not theoretical: the first agent build here to clear every gate built a
 * change to the installed dashboard, and D1–D4 as specified would all have been
 * green (run 32658500322, GHI #141).
 */

/** What the gate reads off a deliverable pull request. Assembled once by the CLI so
 *  five checks cannot disagree about which PR they are judging. */
export interface DeliverablePr {
  number: number;
  headRef: string;
  headSha: string;
  body: string;
  labels: string[];
  /** every path the PR's diff touches — added, modified, removed, renamed */
  paths: string[];
  /** who opened it. The deterministic writer runs as an Actions identity, so a
   *  human author is proof this pull request did NOT come from `build-publish`
   *  (Codex on PR #145) — the cheapest half of D1's forgery check. */
  authorLogin: string;
  /** whether the author is an Actions/App identity rather than a person */
  authorIsBot: boolean;
}

/** Identities the deterministic writer can legitimately run as. `github-actions[bot]`
 *  is what `GITHUB_TOKEN` writes as; an App installation token writes as
 *  `<app-slug>[bot]`, which the `Bot` type covers (GHI #149 would move us there). */
function isWriterIdentity(pr: Pick<DeliverablePr, 'authorLogin' | 'authorIsBot'>): boolean {
  return pr.authorIsBot || pr.authorLogin.endsWith('[bot]');
}

/**
 * D1 — provenance.
 *
 * Three separable claims, and the order matters because each later one needs the
 * earlier to have held:
 *   (a) the PR carries a `deliverable:v1` marker at all. Only `build-publish` writes
 *       one, and it holds the write scope the executor does not, so the marker's
 *       presence is what distinguishes a deliverable PR from any branch a human
 *       happened to name `build/…`.
 *   (b) the marker's `plan_ref` parses as a frozen plan ref and its tag resolves.
 *   (c) the head commit DESCENDS from that tag's commit — FR-007 as amended. A
 *       deliverable is a descendant of the frozen plan, never an alteration of it,
 *       so `compareCommits(tag…head)` must report `ahead` (or `identical`, which is
 *       an empty deliverable and fails D2 anyway rather than here).
 *
 * The descendancy check is the one that cannot be faked from inside the executor:
 * it is a property of the git graph the deterministic writer built.
 *
 * AND THE MARKER ALONE IS NOT PROVENANCE (Codex on PR #145, 2026-08-25). The first
 * version of this gate read the marker, resolved the plan and checked ancestry — all
 * of which a repository contributor can satisfy by hand. Open `build/<slug>/<step>`
 * off the frozen tag, paste a syntactically valid `deliverable:v1` marker naming a
 * real plan and a real in-scope step, touch only non-reserved paths in that scope, and
 * D1–D6 all pass — after which the `build-merge` sweep auto-merges it as
 * pre-authorized. That is a route onto the default branch that bypasses the approval
 * path entirely, using our own merger as the vehicle, and it also lets a marker edit
 * misattribute the executor or point at a step with weaker gates.
 *
 * So D1 now demands two things the marker cannot assert about itself:
 *   1. **the pull request was opened by the writer's identity**, not a person — the
 *      deterministic writer runs as an Actions identity and a human author is
 *      immediate proof this did not come from `build-publish`; and
 *   2. **`runId` names a real, successful run of the build workflow in THIS
 *      repository whose own head is the frozen tag's commit** — checked against the
 *      Actions API, which the marker's author does not control.
 *
 * Neither is individually sufficient (a contributor cannot forge (1) without
 * compromising Actions; (2) alone could cite a genuine past build), which is why both
 * are required.
 */
export async function checkD1Provenance(
  gh: Octokit,
  repo: RepoRef,
  pr: DeliverablePr,
): Promise<GateResult & { marker?: DeliverableMarker }> {
  // BEFORE the marker is read at all: who opened this? A person cannot be
  // `build-publish`, and saying so costs one field of the pull request we already have.
  if (!isWriterIdentity(pr)) {
    return {
      id: 'D1',
      status: 'fail',
      requirement: 'FR-060',
      detail:
        `pull request #${pr.number} was opened by @${pr.authorLogin}, not by the deterministic writer. A deliverable ` +
        'pull request is created by `build-publish` from a validated artifact — one opened by a person is a hand-made ' +
        'branch wearing a deliverable marker, and merging it would land work no approved plan authorized through a ' +
        'path no gate watched. Dispatch a build on the frozen tag instead.',
    };
  }
  const marker = parseDeliverableMarker(pr.body);
  if (!marker) {
    return {
      id: 'D1',
      status: 'fail',
      requirement: 'FR-060',
      detail:
        `pull request #${pr.number} carries no deliverable:v1 marker. Only the deterministic writer ` +
        '(build-publish) emits one, so a build/** branch without it was not produced by a validated ' +
        'deliverable patch — nothing here can be bound to a build run, a plan, or a step',
    };
  }
  const slug = slugFromPlanRef(marker.planRef);
  if (slug === null) {
    return {
      id: 'D1',
      status: 'fail',
      requirement: 'FR-007',
      detail: `the marker names plan_ref "${marker.planRef}", which is not a frozen plan ref (plan/<slug>/v<N>)`,
      marker,
    };
  }
  const tagSha = await tagTargetSha(gh, repo, marker.planRef).catch((error: unknown) => {
    throw new ApiUnavailableError(errorMessage(error));
  });
  if (tagSha === null) {
    return {
      id: 'D1',
      status: 'fail',
      requirement: 'FR-007',
      detail: `the marker names ${marker.planRef}, but no such frozen tag exists — a deliverable must descend from an approved plan`,
      marker,
    };
  }
  let status: string;
  try {
    const { data } = await gh.repos.compareCommits({ ...repo, base: tagSha, head: pr.headSha });
    status = data.status;
  } catch (error: unknown) {
    if (errorStatus(error) === 404) {
      return {
        id: 'D1',
        status: 'fail',
        requirement: 'FR-007',
        detail: `the head commit ${pr.headSha.slice(0, 8)} and the frozen tag ${marker.planRef} share no history at all`,
        marker,
      };
    }
    throw new ApiUnavailableError(errorMessage(error));
  }
  if (status !== 'ahead' && status !== 'identical') {
    return {
      id: 'D1',
      status: 'fail',
      requirement: 'FR-007',
      detail:
        `the head commit ${pr.headSha.slice(0, 8)} is "${status}" relative to ${marker.planRef}, not a descendant of it. ` +
        'A deliverable is produced FROM the frozen plan and lands on its own branch — it never alters the frozen ' +
        'commit, and it never comes from somewhere else (FR-007)',
      marker,
    };
  }

  // THE BUILD RUN THE MARKER CITES, verified against the Actions API. The marker is
  // text in a pull request body; this is the trusted half.
  const runCheck = await verifyBuildRun(gh, repo, marker, tagSha);
  if (runCheck !== null) {
    return { id: 'D1', status: 'fail', requirement: 'FR-060', detail: runCheck, marker };
  }
  return {
    id: 'D1',
    status: 'pass',
    requirement: 'FR-060',
    detail: `opened by @${pr.authorLogin} from build run ${marker.runId}; head descends from ${marker.planRef}`,
    marker,
  };
}

/**
 * Does the build run the marker cites actually exist, succeed, and belong to this
 * deliverable? Returns the refusal detail, or `null` when the run checks out.
 *
 * What is verified, and why each part:
 *  - **the run exists in THIS repository** — a run id from anywhere else proves nothing;
 *  - **it succeeded** — a failed or cancelled build produced no validated artifact;
 *  - **its own head_sha is the frozen tag's commit** — builds are dispatched ON the
 *    frozen tag (preflight B8), so this is the same binding `vt-report` relies on, and
 *    it is what stops a marker citing a genuine build of a DIFFERENT plan.
 *
 * A read failure is refused, not waved through: this is the check that makes the
 * marker trustworthy, and "the API was slow" is not evidence of provenance.
 */
async function verifyBuildRun(
  gh: Octokit,
  repo: RepoRef,
  marker: DeliverableMarker,
  tagSha: string,
): Promise<string | null> {
  const runId = Number(marker.runId);
  if (!Number.isInteger(runId) || runId <= 0) {
    return `the marker's build run id "${marker.runId}" is not a run id`;
  }
  let run;
  try {
    ({ data: run } = await gh.actions.getWorkflowRun({ ...repo, run_id: runId }));
  } catch (error: unknown) {
    if (errorStatus(error) === 404) {
      return (
        `the marker cites build run ${runId}, which does not exist in this repository — a deliverable pull request ` +
        'is opened by `build-publish` from a real build, so a run id naming nothing is a hand-written marker'
      );
    }
    throw new ApiUnavailableError(errorMessage(error));
  }
  if (run.conclusion !== 'success') {
    return `build run ${runId} concluded "${run.conclusion ?? run.status}", not success — no validated deliverable came from it`;
  }
  if (run.head_sha !== tagSha) {
    return (
      `build run ${runId} ran on commit ${run.head_sha.slice(0, 8)}, but ${marker.planRef} is ` +
      `${tagSha.slice(0, 8)} — the cited build did not build this plan (FR-007, preflight B8)`
    );
  }
  return null;
}

/**
 * The scope question as a pure function (T206), so it is testable without a PR and
 * so the gate and any preview ask it identically.
 *
 * Returns the STRAYING paths, not a boolean: every refusal in this system names the
 * offending paths, and a caller that recomputes them phrases it differently from the
 * gate that decided (the GHI #127 lesson).
 */
export function patchPathsWithinStepScope(paths: readonly string[], scope: readonly string[]): string[] {
  return pathsOutside(paths, scope);
}

/**
 * D2 — scope containment (FR-061).
 *
 * NOT-APPLICABLE, NAMING THE ABSENT FIELD, for a step that declares no scope. Every
 * plan frozen before 2026-08-24 is in that position and must stay buildable
 * (constitution: Frozen-Artifact Compatibility), but "the plan made no containment
 * promise" is a different fact from "the patch stayed inside it" and the report says
 * which one it is. That is only safe because **D5 is unconditional**: the subject
 * boundary does not depend on this field, so a scope-less plan is still governed.
 */
export function checkD2ScopeContainment(pr: DeliverablePr, step: PlanStep | null): GateResult {
  if (!step) {
    return {
      id: 'D2',
      status: 'fail',
      requirement: 'FR-061',
      detail: 'the delivering step could not be resolved (see D1), so there is no declared scope to validate against',
    };
  }
  const scope = step.scope ?? [];
  if (scope.length === 0) {
    return {
      id: 'D2',
      status: 'not-applicable',
      requirement: 'FR-061',
      detail:
        `step ${step.id} declares no \`scope\` — the plan was frozen before the field existed, so it makes no ` +
        'containment promise for this gate to check. The patch is still bound by D5 (the reserved paths), which ' +
        'does not read this field. Re-open the plan (FR-008) to add a scope if containment matters here',
    };
  }
  const traversal = pr.paths.filter((p) => !isRepoRelative(p));
  if (traversal.length > 0) {
    return {
      id: 'D2',
      status: 'fail',
      requirement: 'FR-061',
      detail: `patch names path(s) that are not repo-relative: ${traversal.join(', ')} — refused, never normalized into safety`,
    };
  }
  const straying = patchPathsWithinStepScope(pr.paths, scope);
  if (straying.length > 0) {
    return {
      id: 'D2',
      status: 'fail',
      requirement: 'FR-061',
      detail:
        `${straying.length} path(s) fall outside step ${step.id}'s declared scope [${scope.join(', ')}]: ` +
        `${straying.join(', ')}. Work outside the step is work no authority was asked about — the pull request is ` +
        'refused rather than silently trimmed',
    };
  }
  return { id: 'D2', status: 'pass', requirement: 'FR-061', detail: `${pr.paths.length} path(s) inside [${scope.join(', ')}]` };
}

/**
 * D5 — the subject boundary (FR-068). **Reads the patch alone.**
 *
 * Note what is NOT a parameter: the step, and therefore the declared scope. That is
 * the check, not an omission. A boundary a plan can widen is not a boundary, and D2
 * above already asks the question a scope can answer.
 *
 * `opts.slug` IS a parameter, and it is the one thing runtime supplies: WHICH WORKLOAD
 * this patch belongs to, which is the prefix of the one namespace carved out of
 * `.github/**` for it (`.github/workflows/<slug>_<name>.yml`, FR-069 as amended by
 * T279). The caller takes it from the plan ref D1 resolved — the authoritative source
 * wherever one exists — and ABSENT IS THE STRICT ANSWER: no slug means no namespace,
 * so every `.github/**` path is reserved, exactly as before the carve-out existed. A
 * gate that forgot to thread it refuses a legitimate build, visibly; it never admits a
 * workflow file nobody authorized. Note this is still not a widening knob: another
 * workload's prefix is as reserved here as `plan-gate.yml` is.
 */
export function checkD5SubjectBoundary(pr: DeliverablePr, opts: ReservedPathOptions = {}): GateResult {
  const traversal = pr.paths.filter((p) => !isRepoRelative(p));
  if (traversal.length > 0) {
    return {
      id: 'D5',
      status: 'fail',
      requirement: 'FR-068',
      detail: `patch names path(s) that escape the repository: ${traversal.join(', ')} — refused outright`,
    };
  }
  const offending = reservedPathsTouched(pr.paths.map(normalizePath), opts);
  if (offending.length > 0) {
    // The slug reaches the REFUSAL too, not just the decision: a refusal under
    // `.github/workflows/` names the way out, and the name it offers has to be one this
    // workload can actually use (`demo7_<name>.yml`, never a generic prefix or another
    // workload's) — GHI #127, T279.
    return {
      id: 'D5',
      status: 'fail',
      requirement: 'FR-068',
      detail: reservedRefusalDetail(offending, 'the patch', opts.slug ?? null),
    };
  }
  return {
    id: 'D5',
    status: 'pass',
    requirement: 'FR-068',
    detail: `${pr.paths.length} path(s), none inside the installed machinery or the governance record`,
  };
}

/** D3 — merge authority is satisfied. Reports which authority applies and why; it
 *  fails only when the authority cannot be resolved at all. Whether the operator has
 *  yet PERFORMED an operator-required merge is the merge event's business, not the
 *  gate's: blocking here would make a PR that is correctly waiting for a human look
 *  broken. */
// `opts` is the SAME input set the dashboard listing and the merger hand the shared
// rule — the repository checkpoint and the checkpoint paths the patch touches
// (T274). One type, so a new escalating input cannot reach one reader and not the
// others.
export function checkD3MergeAuthority(step: PlanStep | null, opts: MergeAuthorityInputs = {}): GateResult {
  if (!step) {
    return {
      id: 'D3',
      status: 'fail',
      requirement: 'FR-062',
      detail: 'the delivering step could not be resolved (see D1), so merge authority cannot be determined — refusing rather than defaulting to pre-authorized',
    };
  }
  const { authority, reason } = resolveMergeAuthority(step, opts);
  return { id: 'D3', status: 'pass', requirement: 'FR-062', detail: `${authority}: ${reason}` };
}

/**
 * Parse `executors/<id>.yml` through the schema that carries the FR-066 refinement.
 *
 * A DELIBERATELY TINY YAML READER, and the reason is the same one `globs.ts` gives for
 * not taking `minimatch`: this module is vendored into every governed repo, so a
 * dependency here is a dependency there. The executor config is a flat block of
 * scalars plus two string lists (`guardrailed_runner.binaries` / `.paths`), which is
 * three constructs wide — and anything this reader cannot express is refused rather
 * than guessed at, so an exotic file fails the gate instead of passing it by accident.
 */
export function parseExecutorConfig(
  raw: string,
): { ok: true; config: ExecutorConfig } | { ok: false; problems: string[] } {
  const scalars: Record<string, unknown> = {};
  const runner: { binaries: string[]; paths: string[] } = { binaries: [], paths: [] };
  let section: 'root' | 'executor' | 'runner' | null = null;
  let list: 'binaries' | 'paths' | null = null;

  const unquote = (v: string): string => v.replace(/^['"]|['"]$/g, '').trim();
  for (const line of raw.split('\n')) {
    const noComment = line.replace(/\s+#.*$/, '').replace(/^\s*#.*$/, '');
    if (noComment.trim().length === 0) continue;
    const indent = noComment.length - noComment.trimStart().length;
    const text = noComment.trim();

    if (text === 'executor:') { section = 'executor'; list = null; continue; }
    if (/^guardrailed_runner:$/.test(text)) { section = 'runner'; list = null; continue; }
    const item = /^-\s*(.+)$/.exec(text);
    if (item && list) { runner[list].push(unquote(item[1]!)); continue; }
    const kv = /^([a-z_]+):\s*(.*)$/.exec(text);
    if (!kv) return { ok: false, problems: [`cannot parse line: ${text.slice(0, 60)}`] };
    const [, key, value] = kv;
    if (section === 'runner' && (key === 'binaries' || key === 'paths')) {
      list = key as 'binaries' | 'paths';
      // Inline flow form: `binaries: [a, b]`
      const flow = /^\[(.*)\]$/.exec(value!.trim());
      if (flow) {
        runner[list] = flow[1]!.split(',').map(unquote).filter((v) => v.length > 0);
        list = null;
      }
      continue;
    }
    list = null;
    // `guardrailed_runner` nested under `executor:` keeps the same two keys; the
    // indent tells us we have left the runner block.
    if (section === 'runner' && indent <= 2) section = 'executor';
    if (value!.trim().length === 0) continue;
    const v = unquote(value!);
    scalars[key!] = v === 'true' ? true : v === 'false' ? false : v;
  }

  const candidate: Record<string, unknown> = { ...scalars };
  if (runner.binaries.length > 0 || runner.paths.length > 0) {
    candidate.guardrailed_runner = runner;
  }
  const parsed = ExecutorConfig.safeParse(candidate);
  return parsed.success
    ? { ok: true, config: parsed.data }
    : { ok: false, problems: parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`) };
}

/**
 * D4 — executor provenance recorded (FR-065) **and the named executor's configuration
 * actually validated (FR-066)**.
 *
 * THE SECOND HALF WAS A CLAIM, NOT A CHECK (Codex on PR #145, 2026-08-25). FR-066 says
 * an executor driving execution outside the compiled sandbox must wrap it in a
 * guardrailed runner with binary and path allowlists, and `schemas/executor.ts`
 * enforces exactly that — in a `superRefine` that **nothing ever called**.
 * `ExecutorConfig` was imported nowhere outside its own module, so on the live path a
 * `spawned` deliverable needed only to name an image, and the task note claiming
 * "enforced at config load" described a load that did not happen.
 *
 * So D4 now performs the load. The configuration is read from `executors/<id>.yml`
 * **at the frozen tag** — the same commit the operator approved — and parsed through
 * the very schema that carries the FR-066 refinement. Two properties make that
 * trustworthy: `executors/` is inside the RESERVED path set, so no deliverable can
 * edit its own configuration into compliance (D5); and reading it at the frozen tag
 * means the config judged is the config as approved, not as edited since.
 *
 * A MISSING configuration file is not a failure. The reference executor is a compiled
 * workflow rather than a file in `executors/`, and an operator may legitimately run
 * one without a declared config — so absence reports not-applicable, naming what it
 * looked for. What is refused is a configuration that EXISTS and is invalid, and a
 * `spawned` tier with no guardrailed runner, which is the case FR-066 is about.
 */
export async function checkD4ExecutorProvenance(
  marker: DeliverableMarker | undefined,
  loadConfig?: (executorId: string) => Promise<string | null>,
): Promise<GateResult> {
  if (!marker) {
    return { id: 'D4', status: 'fail', requirement: 'FR-065', detail: 'no deliverable:v1 marker (see D1), so no provenance is recorded' };
  }
  const missing: string[] = [];
  if (!marker.executorId) missing.push('executor id');
  if (!marker.tier) missing.push('tier');
  if (marker.tier === 'in-sandbox' && !marker.engine) missing.push('engine (in-sandbox tier)');
  if (marker.tier === 'spawned' && !marker.image) missing.push('image (spawned tier)');
  if (missing.length > 0) {
    return {
      id: 'D4',
      status: 'fail',
      requirement: 'FR-065',
      detail: `executor provenance incomplete — missing ${missing.join(', ')}. A landed deliverable must be correlatable with the agent that produced it`,
    };
  }
  const parts = [
    `executor ${marker.executorId}`,
    `tier ${marker.tier}`,
    marker.engine ? `engine ${marker.engine}` : '',
    marker.image ? `image ${marker.image}` : '',
    marker.model ? `model ${marker.model}` : '',
  ].filter(Boolean);

  // FR-066, actually loaded.
  const raw = loadConfig ? await loadConfig(marker.executorId) : null;
  if (raw === null) {
    // The spawned tier has no excuse for being unconfigured: its containment IS the
    // declaration, so an unfindable config means the obligation is undischarged.
    if (marker.tier === 'spawned') {
      return {
        id: 'D4',
        status: 'fail',
        requirement: 'FR-066',
        detail:
          `${parts.join(', ')} — but no configuration was found at executors/${marker.executorId}.yml in the frozen ` +
          'plan\'s tree. The spawned tier carries none of the compiled tier\'s structural containment, so its ' +
          'guardrailed runner (binary and path allowlists) is the whole of its containment and must be declared ' +
          'where the gate can read it (FR-066)',
      };
    }
    return {
      id: 'D4',
      status: 'pass',
      requirement: 'FR-065',
      detail: `${parts.join(', ')} — no executors/${marker.executorId}.yml declared (in-sandbox containment is structural)`,
    };
  }
  const parsed = parseExecutorConfig(raw);
  if (!parsed.ok) {
    return {
      id: 'D4',
      status: 'fail',
      requirement: 'FR-066',
      detail: `executors/${marker.executorId}.yml does not satisfy the executor contract: ${parsed.problems.join('; ')}`,
    };
  }
  if (parsed.config.tier !== marker.tier) {
    // A marker claiming in-sandbox while its configuration declares spawned would
    // slip past the tier-specific obligation above.
    return {
      id: 'D4',
      status: 'fail',
      requirement: 'FR-065',
      detail:
        `the deliverable reports tier "${marker.tier}" but executors/${marker.executorId}.yml declares ` +
        `"${parsed.config.tier}" — provenance must describe the executor that actually ran`,
    };
  }
  return {
    id: 'D4',
    status: 'pass',
    requirement: 'FR-065',
    detail: `${parts.join(', ')}; executors/${marker.executorId}.yml validated against the executor contract (FR-066)`,
  };
}

/**
 * The step this deliverable delivers, resolved from the PLAN rather than believed
 * from the marker where possible.
 *
 * The marker's `step_id` originates in the executor's own envelope (GHI #116 — the
 * step id is executor-authored with no trusted binding). Here it is checked against
 * the plan: the id must name a step that exists. That is as far as this can go
 * without the work item, which the deliverable PR does not carry; `build-publish`
 * performs the stronger derivation at write time, when the build run's `--chunk`
 * input is still reachable.
 */
export async function resolveDeliveringStep(
  gh: Octokit,
  repo: RepoRef,
  marker: DeliverableMarker | undefined,
): Promise<{ plan: PlanDoc | null; step: PlanStep | null }> {
  if (!marker) return { plan: null, step: null };
  try {
    const plan = await readPlanAtRef(gh, repo, marker.planRef);
    return { plan, step: plan.steps.find((s) => s.id === marker.stepId) ?? null };
  } catch {
    return { plan: null, step: null };
  }
}
