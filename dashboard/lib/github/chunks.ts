import { createHash } from 'node:crypto';
import type { Octokit } from '@octokit/rest';
import type { PlanDoc, PlanStep } from '../../../schemas/plan';
import type { RepoRef } from './client';
import { errorStatus, Refusal } from './errors';
import {
  parseDerivationMarker,
  parseIntentConfirmed,
  serializeDerivationMarker,
  serializeIntentConfirmed,
  type DerivationMarker,
} from './markers';
import { parsePlanRef, tryReadPlanAtRef, workItemsOf } from './plans';
import { mergeRecheck } from './read-after-write';

export { parseDerivationMarker, serializeDerivationMarker, type DerivationMarker } from './markers';

/**
 * Chunks module (T082, FR-016–FR-018): work items.
 *
 * A chunk is an Issue carrying the `chunk:ready` label and its FULL requirement:
 * Intent + empirically testable outcome metric + Acceptance (FR-017). There is
 * no lesser state. `chunk:title-only` was RETIRED on 2026-09-07 (operator
 * decision, FR-016 amended): a one-line idea is a WORKLOAD (FR-031), and a work
 * item exists only once it says what "done" means — otherwise it is a label with
 * nothing behind it, exactly what B3 exists to refuse. The retired label is still
 * READ, as state 'title-only', so a repository carrying one from before the rule
 * shows it as unfinished (the Workloads page offers the requirement form) rather
 * than silently dropping it; nothing writes it any more.
 *
 * Since ADR-0002 (2026-09-08) the NORMAL way a work item comes into being is
 * derivation from an approved plan step, at Commit for approval — see
 * `deriveWorkItemFromStep` / `createChunksFromSteps` at the end of this module.
 * The hand-typed form is the exception, kept for a legacy title-only issue.
 *
 * `intent:confirmed` (label + structured comment, FR-018) additionally permits
 * UNATTENDED runs — preflight B4 requires the well-formed comment, not just the
 * label, because only the comment carries identity + timestamp.
 */

export interface Chunk {
  issueNumber: number;
  title: string;
  /** 'ready' is the only state a chunk can be CREATED in; 'title-only' is read for
   *  legacy issues carrying the retired label and is never written */
  state: 'ready' | 'title-only';
  /** the `intent:confirmed` LABEL — the light. Kept for every caller that only
   *  needs to know whether unattended runs are permitted. */
  intentConfirmed: boolean;
  /**
   * WHO confirmed and WHEN (GHI #120) — the well-formed confirmation comment, or
   * null. This is the record B4 actually reads, so it can disagree with the label:
   * a label with no comment behind it is not a confirmation, and the review page
   * should render that gap rather than paper over it.
   */
  intentConfirmation: { by: string; at: string } | null;
  /** the plan step this item was derived from (ADR-0002), or null for a hand-typed item */
  derivedFrom: { planRef: string; stepId: string } | null;
  intent: string | null;
  outcomeMetric: string | null;
  acceptance: string | null;
  assignee: string | null;
}

// Body sections mirror the chunk issue form (templates/ISSUE_TEMPLATE/chunk.yml):
// GitHub issue forms render each field as `### <label>` followed by the value.
const SECTIONS = {
  intent: '### Intent',
  outcomeMetric: '### Empirically testable outcome metric',
  acceptance: '### Acceptance',
} as const;

/**
 * The content digest the derivation marker records (D8 as amended): the three
 * requirement fields as written, joined by `|`. What matters is that the same
 * requirement always hashes the same and a changed one never does — the digest is
 * compared, never decoded.
 */
export function requirementDigest(fields: { intent: string; outcomeMetric: string; acceptance: string }): string {
  return createHash('sha256').update([fields.intent, fields.outcomeMetric, fields.acceptance].join('|'), 'utf8').digest('hex');
}

/**
 * The issue body. `derivedFrom` prepends the derivation marker and a visible
 * provenance line ABOVE the first heading — it has to be above, not below:
 * `parseChunkBody` reads each section up to the next `###`, so anything after the
 * Acceptance heading would be read back as part of the acceptance text. The marker's
 * digest is always computed from the fields being written, so it can never record a
 * requirement other than the one on the body.
 */
export function renderChunkBody(
  fields: { intent: string; outcomeMetric: string; acceptance: string },
  derivedFrom?: { planRef: string; stepId: string; actor: string; at: string },
): string {
  const provenance = derivedFrom
    ? [
        serializeDerivationMarker({ planRef: derivedFrom.planRef, stepId: derivedFrom.stepId, digest: requirementDigest(fields) }),
        `_Derived from step \`${derivedFrom.stepId}\` of \`${derivedFrom.planRef}\` by @${derivedFrom.actor} at ${derivedFrom.at}._`,
        '',
      ]
    : [];
  return [
    ...provenance,
    SECTIONS.intent,
    '',
    fields.intent,
    '',
    SECTIONS.outcomeMetric,
    '',
    fields.outcomeMetric,
    '',
    SECTIONS.acceptance,
    '',
    fields.acceptance,
  ].join('\n');
}

/** Section text between one `###` heading and the next; null when absent or blank. */
export function parseChunkBody(body: string): { intent: string | null; outcomeMetric: string | null; acceptance: string | null } {
  const section = (heading: string): string | null => {
    const start = body.indexOf(heading);
    if (start === -1) return null;
    const rest = body.slice(start + heading.length);
    const next = rest.search(/\n### /);
    const text = (next === -1 ? rest : rest.slice(0, next)).trim();
    return text.length > 0 ? text : null;
  };
  return {
    intent: section(SECTIONS.intent),
    outcomeMetric: section(SECTIONS.outcomeMetric),
    acceptance: section(SECTIONS.acceptance),
  };
}

type IssueLike = {
  number: number;
  title: string;
  body?: string | null;
  labels?: (string | { name?: string })[];
  assignee?: { login: string } | null;
  pull_request?: unknown;
};

function labelNames(issue: IssueLike): string[] {
  return (issue.labels ?? []).map((l) => (typeof l === 'string' ? l : (l.name ?? '')));
}

/**
 * The chunk as its ISSUE alone says it — everything but the confirmation record,
 * which lives in the comments and needs a second read. `readChunk` is the full
 * shape; this is kept pure so `createChunk` can return without re-reading the
 * issue it just wrote (a new issue has no comments to read).
 */
function toChunk(issue: IssueLike, intentConfirmation: { by: string; at: string } | null): Chunk | null {
  const labels = labelNames(issue);
  const state = labels.includes('chunk:ready') ? 'ready' : labels.includes('chunk:title-only') ? 'title-only' : null;
  if (state === null) return null;
  const body = issue.body ?? '';
  const fields = parseChunkBody(body);
  const marker = parseDerivationMarker(body);
  return {
    issueNumber: issue.number,
    title: issue.title,
    state,
    intentConfirmed: labels.includes('intent:confirmed'),
    intentConfirmation,
    derivedFrom: marker ? { planRef: marker.planRef, stepId: marker.stepId } : null,
    intent: fields.intent,
    outcomeMetric: fields.outcomeMetric,
    acceptance: fields.acceptance,
    assignee: issue.assignee?.login ?? null,
  };
}

/**
 * The chunk WITH its confirmation record. The comments are read only when the
 * label says there is something to find: a list of N unconfirmed items costs
 * N label checks, not N comment listings. A label without a well-formed comment
 * yields `intentConfirmed: true, intentConfirmation: null` — the honest reading
 * of a state B4 will refuse.
 */
async function readChunk(gh: Octokit, repo: RepoRef, issue: IssueLike): Promise<Chunk | null> {
  const bare = toChunk(issue, null);
  if (bare === null) return null;
  if (!bare.intentConfirmed) return bare;
  return { ...bare, intentConfirmation: await findIntentConfirmation(gh, repo, issue.number) };
}

/**
 * Every open work item.
 *
 * `recheck` names chunks the caller KNOWS the current state of because it just
 * wrote them, and whose state therefore comes from the single-issue GET instead
 * of the LIST. GitHub's LIST endpoints are not read-after-write consistent
 * (PB-003 finding B — the same lag `listCorrections` already guards), so the
 * render immediately after `createChunk` can miss the chunk it just created and
 * draw the page exactly as it looked before the click. The operator adds a
 * work item, the issue is created correctly, and nothing appears until
 * they refresh the browser — a write that succeeds but renders as a no-op is
 * indistinguishable from a broken button.
 *
 * Unknown, foreign, or non-chunk numbers are ignored rather than trusted: the
 * hint reaches this seam from a URL parameter, so it must not be a way to pull
 * an arbitrary issue into the work-item list (FR-046) or to crash the page.
 */
export async function listChunks(gh: Octokit, repo: RepoRef, opts: { recheck?: number[] } = {}): Promise<Chunk[]> {
  // Two exact-label queries instead of one unfiltered scan: chunk:* labels are
  // mutually exclusive (FR-025), so the union is complete and disjoint. The retired
  // `chunk:title-only` is still LISTED so a legacy item is finished, not lost.
  const [titleOnly, ready] = await Promise.all([
    gh.paginate(gh.issues.listForRepo, { ...repo, labels: 'chunk:title-only', state: 'open', per_page: 100 }),
    gh.paginate(gh.issues.listForRepo, { ...repo, labels: 'chunk:ready', state: 'open', per_page: 100 }),
  ]);
  const chunks = (
    await Promise.all(
      [...titleOnly, ...ready].filter((issue) => !issue.pull_request).map((issue) => readChunk(gh, repo, issue)),
    )
  ).filter((c): c is Chunk => c !== null);

  // The list is OPEN issues by contract (both queries filter `state: 'open'`,
  // and work-items.tsx depends on that being what `listChunks` means), so a closed
  // chunk is declined here rather than merged. `?just=` survives in the browser
  // URL, so without this a chunk closed after the redirect would keep its card on
  // the page indefinitely, re-read by number and re-appended on every later render
  // (PR #118 bot review). Absent is what the unhinted list already says.
  const merged = await mergeRecheck(
    chunks,
    opts.recheck,
    async (issueNumber) => {
      const { chunk, closed } = await readChunkIssue(gh, repo, issueNumber);
      if (chunk === null) return null; // a PR, or no chunk:* label — not ours to judge
      // `'absent'`, not `null`: this read is authoritative, so a closed chunk is
      // REMOVED from a lagging list rather than merely not appended to it (#122).
      return closed ? 'absent' : { item: chunk };
    },
    (c) => c.issueNumber,
  );
  return merged.sort((a, b) => a.issueNumber - b.issueNumber);
}

/**
 * One issue read, reporting BOTH the chunk and whether the issue is closed.
 *
 * The two callers want different things and both are right: `getChunk` must keep
 * ignoring issue state, because B3 and the Andon work-items panel deliberately
 * resolve a closed-but-ready chunk (work-items.tsx's `resolveAsGateWould`), while
 * the open list is open-only and must not readmit a closed one through `recheck`.
 */
async function readChunkIssue(
  gh: Octokit,
  repo: RepoRef,
  issueNumber: number,
): Promise<{ chunk: Chunk | null; closed: boolean }> {
  const { data: issue } = await gh.issues.get({ ...repo, issue_number: issueNumber });
  if (issue.pull_request) return { chunk: null, closed: false };
  return { chunk: await readChunk(gh, repo, issue), closed: issue.state === 'closed' };
}

/** The chunk as the BUILD GATE resolves it — by label alone, open or closed. */
export async function getChunk(gh: Octokit, repo: RepoRef, issueNumber: number): Promise<Chunk | null> {
  return (await readChunkIssue(gh, repo, issueNumber)).chunk;
}

/** The three requirement fields, and the refusal that names the empty ones. */
export interface ChunkRequirement {
  intent: string;
  outcomeMetric: string;
  acceptance: string;
}
function missingRequirementFields(input: ChunkRequirement): string[] {
  return (['intent', 'outcomeMetric', 'acceptance'] as const).filter((f) => input[f].trim().length === 0);
}

/**
 * A work item is created COMPLETE: title plus the full requirement, labelled
 * `chunk:ready` from the first write (FR-016 as amended 2026-09-07, FR-017). An
 * empty field is a refusal, not a default — the empirically testable outcome
 * metric is what makes the requirement testable, and a title alone is an idea,
 * which is what a workload is for.
 *
 * `derivedFrom` records the plan step this item mirrors (ADR-0002); the one
 * caller that passes it is `createChunksFromSteps`, which has already checked
 * the step exists. Optional so the hand-typed path is unchanged.
 */
export async function createChunk(
  gh: Octokit,
  repo: RepoRef,
  input: { title: string; derivedFrom?: { planRef: string; stepId: string; actor: string; at: string } } & ChunkRequirement,
): Promise<Chunk> {
  const missing = missingRequirementFields(input);
  if (input.title.trim().length === 0) missing.unshift('title');
  if (missing.length > 0) {
    throw new Refusal(
      `a work item is created complete — empty field(s): ${missing.join(', ')}. A title alone is an idea, and an idea is a workload (Introduce one); a work item says what "done" means: intent, an empirically testable outcome metric, and acceptance.`,
    );
  }
  const { data: issue } = await gh.issues.create({
    ...repo,
    title: input.title,
    body: renderChunkBody(
      { intent: input.intent, outcomeMetric: input.outcomeMetric, acceptance: input.acceptance },
      input.derivedFrom,
    ),
    labels: ['chunk:ready'],
  });
  return toChunk(issue, null)!;
}

/**
 * Write (or rewrite) the requirement of an existing chunk — ALL THREE fields
 * non-empty (FR-017). Two callers: editing a ready chunk's requirement, and
 * finishing a legacy `chunk:title-only` issue, which this is the only route out
 * of (the retired label is removed and `chunk:ready` applied).
 *
 * A derived item keeps its provenance across a rewrite: the marker is re-emitted
 * from what the issue already carries — with the digest of the text now written, so
 * the marker never claims a requirement the body does not carry — and editing the
 * requirement can never silently orphan the item from its step (and let a
 * resubmitted Commit mint a twin).
 */
export async function promoteChunk(
  gh: Octokit,
  repo: RepoRef,
  input: { issueNumber: number; intent: string; outcomeMetric: string; acceptance: string },
): Promise<Chunk> {
  const missing = missingRequirementFields(input);
  if (missing.length > 0) {
    throw new Refusal(`requirement refused — empty field(s): ${missing.join(', ')} (FR-017 needs the full requirement)`);
  }
  const { data: before } = await gh.issues.get({ ...repo, issue_number: input.issueNumber });
  const marker = parseDerivationMarker(before.body ?? '');
  const fields = { intent: input.intent, outcomeMetric: input.outcomeMetric, acceptance: input.acceptance };
  // The provenance line's actor/at are not re-read from prose; only the marker is
  // machine-read, so the rewrite keeps the marker and drops the original line's
  // wording rather than inventing an actor for it.
  const body = marker
    ? [serializeDerivationMarker({ ...marker, digest: requirementDigest(fields) }), '', renderChunkBody(fields)].join('\n')
    : renderChunkBody(fields);
  await gh.issues.update({ ...repo, issue_number: input.issueNumber, body });
  // Writing the requirement REVOKES any prior intent confirmation: the operator
  // confirmed the OLD text, and B4 would otherwise accept the stale record to
  // authorize an unattended run on requirements nobody confirmed (FR-018;
  // PR #74 bot finding). The confirmation comment stays — append-only audit —
  // but without the label, B4 blocks until a fresh confirmation.
  await removeLabelIfPresent(gh, repo, input.issueNumber, 'intent:confirmed');
  await removeLabelIfPresent(gh, repo, input.issueNumber, 'chunk:title-only');
  await gh.issues.addLabels({ ...repo, issue_number: input.issueNumber, labels: ['chunk:ready'] });
  const chunk = await getChunk(gh, repo, input.issueNumber);
  if (!chunk) throw new Error(`issue #${input.issueNumber} is not a chunk after promotion`);
  return chunk;
}

// `demoteChunk` (ready → title-only) was removed with the state on 2026-09-07: a work
// item that no longer describes its work is closed or rewritten, never un-specified.

/** 404-only tolerance: an absent label is the expected no-op; any other failure
 *  (auth, transport, server) must abort, or the chunk ends up carrying two
 *  mutually exclusive chunk:* labels (same convention as GHI #52). */
async function removeLabelIfPresent(gh: Octokit, repo: RepoRef, issueNumber: number, name: string): Promise<void> {
  try {
    await gh.issues.removeLabel({ ...repo, issue_number: issueNumber, name });
  } catch (error: unknown) {
    if (errorStatus(error) !== 404) throw error;
  }
}

/**
 * Operator confirms the chunk's intent is aligned (FR-018): a structured,
 * attributable comment PLUS the intent:confirmed label. Comment first — if the
 * label write then fails, the durable record exists and a re-run converges;
 * the reverse order could leave a label with no record behind it.
 */
export async function confirmIntent(
  gh: Octokit,
  repo: RepoRef,
  input: { issueNumber: number; actor: string; at: string },
): Promise<void> {
  await gh.issues.createComment({
    ...repo,
    issue_number: input.issueNumber,
    body: serializeIntentConfirmed({ by: input.actor, at: input.at, chunk: input.issueNumber }),
  });
  await gh.issues.addLabels({ ...repo, issue_number: input.issueNumber, labels: ['intent:confirmed'] });
}

/** The well-formed confirmation comment for this chunk, or null (B4's input). */
export async function findIntentConfirmation(
  gh: Octokit,
  repo: RepoRef,
  issueNumber: number,
): Promise<{ by: string; at: string } | null> {
  const comments = await gh.paginate(gh.issues.listComments, { ...repo, issue_number: issueNumber, per_page: 100 });
  for (const comment of comments) {
    const parsed = parseIntentConfirmed(comment.body ?? '');
    if (parsed && parsed.chunk === issueNumber) return { by: parsed.by, at: parsed.at };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Derivation from a plan step (ADR-0002; GHI #197; decisions D2, D4, D8)
//
// A work item is the tracker mirror of a plan step. The operator is its only
// writer, at Commit for approval: the pending items are created from the steps,
// the `tracking_issue` links are written onto the plan branch, and the approval
// PR is opened — one click, or a refusal naming the step and writing nothing.
// ---------------------------------------------------------------------------

/** The four fields a work item is created with, as far as the plan can supply them. */
export interface DerivedWorkItem {
  title: string;
  intent: string;
  /** '' when no verification target names the step — the caller MUST ask the operator */
  outcomeMetric: string;
  acceptance: string;
}

/**
 * The work item a plan step describes — PURE.
 *
 * title, intent and acceptance are the step's own. The empirically testable
 * outcome metric is the step's VERIFICATION TARGETS: every target whose
 * `maps_to` names the step, one per line as `<id>: <check>`, with the executable
 * `run` command when the target carries one (those are the very commands the
 * build will be judged by — data-model "Verification Target Result").
 *
 * Same selection as `commitmentScope`'s coverage in checks-scope.ts (a target
 * covers a step iff its `maps_to` names it), so the metric the operator reads
 * here is exactly what G3/G18 will hold the step to. Applied to every step
 * rather than MUST only: a MUST step always has at least one target (G3 refuses
 * the plan otherwise), so the MUST items always derive complete; a SHOULD or
 * COULD step the operator opts in may have none, and then the metric is EMPTY —
 * a signal, not a default. Nothing here invents a metric, because a metric
 * nobody wrote is a requirement nobody can test, and the review page shows the
 * example text and asks for one.
 */
export function deriveWorkItemFromStep(plan: PlanDoc, step: PlanStep): DerivedWorkItem {
  const lines = plan.verification_targets
    .filter((vt) => vt.maps_to.includes(step.id))
    .map((vt) => `${vt.id}: ${vt.check}${vt.run ? ` — run: \`${vt.run}\`` : ''}`);
  return {
    title: step.title,
    intent: step.intent,
    outcomeMetric: lines.join('\n'),
    acceptance: step.acceptance,
  };
}

/** The workload slug a caller handed us as either `plan/<slug>/v<N>` or the bare slug. */
function slugOf(planRefOrSlug: string): string {
  const parsed = parsePlanRef(planRefOrSlug);
  if (parsed) return parsed.slug;
  if (/^[a-z0-9][a-z0-9-]*$/.test(planRefOrSlug)) return planRefOrSlug;
  // A fault, not a refusal: every caller derives this from a plan ref the SYSTEM
  // produced (the Andon header, the review's own route), so a shape that is
  // neither is a broken record, and no operator input can repair it.
  throw new Error(`"${planRefOrSlug}" is neither a plan ref (plan/<slug>/v<N>) nor a workload slug`);
}

/** Every OPEN work item of this workload that carries a derivation marker — the list
 *  `findDerivedChunk` reads, exported so a caller validating many rows lists once. */
export async function listOpenDerived(gh: Octokit, repo: RepoRef, slug: string): Promise<Chunk[]> {
  const ready = await gh.paginate(gh.issues.listForRepo, { ...repo, labels: 'chunk:ready', state: 'open', per_page: 100 });
  const chunks = await Promise.all(ready.filter((issue) => !issue.pull_request).map((issue) => readChunk(gh, repo, issue)));
  return chunks.filter(
    (c): c is Chunk => c !== null && c.derivedFrom !== null && parsePlanRef(c.derivedFrom.planRef)?.slug === slug,
  );
}

/**
 * The work item already derived for (workload, step), or null — the idempotency
 * read behind `createChunksFromSteps`.
 *
 * KEYED ON THE SLUG, NOT THE VERSION. A re-open cuts v2 from v1's steps (and D8
 * makes the agent inherit v1's `tracking_issue` values), so v2's Commit must find
 * v1's item for the same step rather than mint a second one. One derived item per
 * (slug, step) across every version of the plan is the invariant; B3's
 * exactly-one-step rule then holds by construction.
 *
 * `hint` is the step's inherited `tracking_issue` when it has one, read by single
 * GET first: the LIST is not read-after-write consistent (PB-003 finding B), so a
 * Commit resubmitted seconds after the first would otherwise miss the item it
 * just created. A hint that does not resolve to a derived item for THIS step is
 * ignored, never trusted — the marker is the key, the hint only a shortcut.
 *
 * TWO open derived items for one (slug, step) is a REFUSAL naming both, not a
 * silent pick of the first. The invariant can be broken from outside the hint path
 * — a Commit that died after its first create and was resubmitted before the LIST
 * caught up, or two tabs submitting at once — and picking one would bind a step to
 * a twin while the other sat open, unbound, looking like work to do. The operator's
 * remedy is one click on GitHub, so the sentence names it.
 *
 * `derived` lets a caller that has already listed this workload's open derived items
 * hand them in, so validating N rows costs one list rather than N.
 */
export async function findDerivedChunk(
  gh: Octokit,
  repo: RepoRef,
  planRefOrSlug: string,
  stepId: string,
  opts: { hint?: number | null; derived?: Chunk[] } = {},
): Promise<Chunk | null> {
  const slug = slugOf(planRefOrSlug);
  const matches = (c: Chunk | null): c is Chunk =>
    c !== null && c.derivedFrom !== null && c.derivedFrom.stepId === stepId && parsePlanRef(c.derivedFrom.planRef)?.slug === slug;
  let hinted: Chunk | null = null;
  if (typeof opts.hint === 'number' && opts.hint > 0) {
    try {
      const { chunk, closed } = await readChunkIssue(gh, repo, opts.hint);
      if (!closed && matches(chunk)) hinted = chunk;
    } catch (error: unknown) {
      // Only a verified 404 means "no such issue" (GHI #150). Anything else is a
      // read we could not make, and pretending it said "absent" is how a twin
      // gets minted — so it stays a fault.
      if (errorStatus(error) !== 404) throw error;
    }
  }
  const derived = opts.derived ?? (await listOpenDerived(gh, repo, slug));
  const found = derived.filter(matches);
  if (hinted && !found.some((c) => c.issueNumber === hinted!.issueNumber)) found.unshift(hinted);
  if (found.length > 1) {
    const numbers = found.map((c) => `#${c.issueNumber}`).join(' and ');
    throw new Refusal(
      `${numbers} were both derived for step ${stepId} of ${slug} — one work item mirrors one step, so this step cannot be bound until one of them is closed. Close the one nothing tracks on GitHub (a resubmitted commit or a second tab minted the twin), then commit again`,
    );
  }
  return found[0] ?? null;
}

export interface CreateChunksFromStepsInput {
  /** the plan version being committed — recorded on each marker */
  planRef: string;
  plan: PlanDoc;
  /** the steps to create items for; `outcomeMetric` is the operator's text for a
   *  step no verification target names (ignored when the plan supplies one) */
  steps: Array<{ stepId: string; outcomeMetric?: string }>;
  actor: string;
  at: string;
}

export interface CreatedChunk {
  stepId: string;
  issueNumber: number;
  /** false when an existing derived item was reused */
  created: boolean;
}

/**
 * Create the work items for the requested steps — or refuse before writing anything.
 *
 * ALL-OR-NOTHING BY CONSTRUCTION: every step is derived and checked first, and a
 * step whose item cannot be completed (no target names it and the operator typed
 * no metric; a step id the plan does not carry) is a `Refusal` naming the step,
 * thrown before the first issue exists. Then each step is written in input
 * order, reusing the item already derived for it (`created: false`) when there
 * is one. Should a later create fail after an earlier one succeeded, the
 * derivation markers make the retry converge ONCE THE LIST HAS CAUGHT UP: the
 * earlier items are found by marker and reused, not duplicated. What this does
 * not cover is a resubmit within GitHub's list lag before any link was written —
 * no `tracking_issue` exists yet to hint the single GET, so the LIST is the only
 * read, and it can miss an item created seconds ago. `findDerivedChunk` makes the
 * resulting twin a refusal naming both numbers on the next commit rather than a
 * silent pick, and the operator closes one; nothing here compensates a partial
 * write, because there is nothing to undo — an item is only ever created complete.
 *
 * The operator's metric is used ONLY where the plan has none. Where a target
 * exists, the metric is the target, because the target is what the build will be
 * judged by (G18, D6), and a hand-typed variant of it would be a second statement
 * of one commitment.
 */
export async function createChunksFromSteps(gh: Octokit, repo: RepoRef, input: CreateChunksFromStepsInput): Promise<CreatedChunk[]> {
  if (!parsePlanRef(input.planRef)) throw new Error(`"${input.planRef}" is not a plan ref (plan/<slug>/v<N>)`);
  const stepsById = new Map(input.plan.steps.map((s) => [s.id, s]));

  // Validate every step before writing any.
  const prepared: Array<{ step: PlanStep; fields: DerivedWorkItem }> = [];
  const problems: string[] = [];
  for (const requested of input.steps) {
    const step = stepsById.get(requested.stepId);
    if (!step) {
      problems.push(`step "${requested.stepId}" is not in ${input.planRef}`);
      continue;
    }
    const derived = deriveWorkItemFromStep(input.plan, step);
    const override = requested.outcomeMetric?.trim() ?? '';
    const fields: DerivedWorkItem = {
      ...derived,
      outcomeMetric: derived.outcomeMetric.length > 0 ? derived.outcomeMetric : override,
    };
    const missing = (['title', 'intent', 'outcomeMetric', 'acceptance'] as const).filter((f) => fields[f].trim().length === 0);
    if (missing.length > 0) {
      const detail = missing.includes('outcomeMetric')
        ? 'no verification target names this step, so its empirically testable outcome metric must be entered'
        : `empty field(s): ${missing.join(', ')}`;
      problems.push(`step "${step.id}" (${step.title}): ${detail}`);
      continue;
    }
    prepared.push({ step, fields });
  }
  if (problems.length > 0) {
    throw new Refusal(
      `no work item was created — ${problems.length === 1 ? 'one step' : `${problems.length} steps`} cannot be derived complete: ${problems.join('; ')}. Every work item says what "done" means before the plan is committed for approval.`,
    );
  }

  const results: CreatedChunk[] = [];
  for (const { step, fields } of prepared) {
    const existing = await findDerivedChunk(gh, repo, input.planRef, step.id, { hint: step.tracking_issue ?? null });
    if (existing) {
      results.push({ stepId: step.id, issueNumber: existing.issueNumber, created: false });
      continue;
    }
    const chunk = await createChunk(gh, repo, {
      ...fields,
      derivedFrom: { planRef: input.planRef, stepId: step.id, actor: input.actor, at: input.at },
    });
    results.push({ stepId: step.id, issueNumber: chunk.issueNumber, created: true });
  }
  return results;
}

/** What `reconcileDerivedChunk` did to one item. */
export interface ReconciledChunk {
  issueNumber: number;
  stepId: string;
  /** true when the requirement was rewritten from the step */
  rewritten: boolean;
  /** true when an `intent:confirmed` given to the old text was cleared */
  confirmationCleared: boolean;
}

/**
 * Bring an existing derived work item into line with the step it is being bound to
 * (decision D8 as amended 2026-09-08; ADR-0002 §4; experiment E4).
 *
 * WHY. The planning agent inherits `tracking_issue` across a re-open, and
 * `findDerivedChunk` reuses the item by (slug, step) — so a revised step keeps its
 * v1 item. Left alone, that item would carry v1's requirement and v1's
 * `intent:confirmed`, and preflight B4 would authorize an UNATTENDED build on text
 * nobody confirmed: B3 checks presence and claim, not content, so the only place
 * this can be caught is here, at Commit, where the step and the item are both in
 * hand. The same rule that protects a hand-edited requirement (`promoteChunk`
 * revokes the label) is applied to the plan-driven change.
 *
 * WHAT COUNTS AS CHANGED. The item's current sections against what the step now
 * derives — except the outcome metric where the plan supplies none, which stays the
 * operator's (an opted-in SHOULD step keeps the metric typed for it). A marker whose
 * digest disagrees with the derived text is also a change, whichever side moved.
 * Nothing is compared to the marker's step id: a linked item derived for a renamed
 * step is rewritten to the step it now mirrors, and its marker follows.
 *
 * WHAT IS WRITTEN, IN ORDER: the event comment naming the version (record first,
 * FR-042) → the body, with the marker re-emitted for THIS version and the new digest
 * → the stale `intent:confirmed` label removed. The confirmation comment stays, as
 * every append-only record does; without the label B4 blocks until the operator
 * confirms the new text, and the row offers Confirm intent again. Idempotent: an item
 * that already says what the step says is left untouched, so a resubmit converges.
 */
export async function reconcileDerivedChunk(
  gh: Octokit,
  repo: RepoRef,
  input: { issueNumber: number; planRef: string; plan: PlanDoc; step: PlanStep; actor: string; at: string },
): Promise<ReconciledChunk> {
  if (!parsePlanRef(input.planRef)) throw new Error(`"${input.planRef}" is not a plan ref (plan/<slug>/v<N>)`);
  const { data: issue } = await gh.issues.get({ ...repo, issue_number: input.issueNumber });
  const body = issue.body ?? '';
  const marker = parseDerivationMarker(body);
  // Not derived, not ours to rewrite: a hand-typed legacy item bound by a link keeps
  // the operator's words. (The review never offers such an item; a hand-crafted POST
  // is refused upstream.)
  if (!marker) return { issueNumber: input.issueNumber, stepId: input.step.id, rewritten: false, confirmationCleared: false };
  const current = parseChunkBody(body);
  const derived = deriveWorkItemFromStep(input.plan, input.step);
  const expected = {
    intent: derived.intent,
    outcomeMetric: derived.outcomeMetric.length > 0 ? derived.outcomeMetric : (current.outcomeMetric ?? ''),
    acceptance: derived.acceptance,
  };
  const digest = requirementDigest(expected);
  const unchanged =
    current.intent === expected.intent &&
    current.outcomeMetric === expected.outcomeMetric &&
    current.acceptance === expected.acceptance &&
    (marker.digest === null || marker.digest === digest);
  if (unchanged) return { issueNumber: input.issueNumber, stepId: input.step.id, rewritten: false, confirmationCleared: false };

  const labels = labelNames(issue as IssueLike);
  const confirmationCleared = labels.includes('intent:confirmed');
  await gh.issues.createComment({
    ...repo,
    issue_number: input.issueNumber,
    body:
      `**Requirement rewritten from step \`${input.step.id}\` of \`${input.planRef}\`** by @${input.actor} at ${input.at} — ` +
      `the step changed since this work item was derived, so the item now says what the plan says.` +
      (confirmationCleared
        ? ' The intent confirmation on record was given to the previous text and no longer authorizes an unattended build: confirm intent again on the row.'
        : ''),
  });
  await gh.issues.update({
    ...repo,
    issue_number: input.issueNumber,
    title: derived.title,
    body: [
      serializeDerivationMarker({ planRef: input.planRef, stepId: input.step.id, digest }),
      `_Derived from step \`${input.step.id}\` of \`${input.planRef}\` by @${input.actor} at ${input.at}._`,
      '',
      renderChunkBody(expected),
    ].join('\n'),
  });
  if (confirmationCleared) await removeLabelIfPresent(gh, repo, input.issueNumber, 'intent:confirmed');
  return { issueNumber: input.issueNumber, stepId: input.step.id, rewritten: true, confirmationCleared };
}

/** One work item `closeDerivedChunks` closed, and the step it was for. */
export interface ClosedDerivedChunk {
  issueNumber: number;
  planRef: string;
  stepId: string;
}

/**
 * Close every OPEN derived work item of this workload that NO FROZEN VERSION
 * tracks — the withdrawal path (EXPERIMENTS.md E3, GHI #197): items created at
 * Commit for approval and then withdrawn are closed, not orphaned.
 *
 * "Tracked by a frozen version" is the line, not "created for the withdrawn
 * version": a re-opened v2 inherits v1's steps and items (D8), and withdrawing
 * v2 must not close the items v1 — still the official plan — delivers through.
 * So the set of work items every `plan/<slug>/v*` TAG names is read first, and
 * only a derived item outside that set is closed.
 *
 * A frozen version whose document cannot be read is a FAULT: not knowing what
 * it tracks means not knowing what is safe to close, and unreadable is not
 * absent (GHI #150). Closing is a comment naming the withdrawal (record first,
 * FR-042), then the state change — retained, never deleted.
 */
export async function closeDerivedChunks(
  gh: Octokit,
  repo: RepoRef,
  input: { slug: string; reason: string; actor: string; at: string },
): Promise<ClosedDerivedChunk[]> {
  const reason = input.reason.trim();
  if (reason.length === 0) throw new Refusal('closing work items refused: a reason must be recorded');
  const slug = slugOf(input.slug);

  // Same slug-anchored tag scan as resolveCurrent, over EVERY frozen version rather
  // than the newest: an older version's items can still be the ones being built.
  const tracked = new Set<number>();
  const versionRe = new RegExp(`^refs/tags/(plan/${slug}/v\\d+)$`);
  let tags: string[] = [];
  try {
    const { data } = await gh.git.listMatchingRefs({ ...repo, ref: `tags/plan/${slug}/` });
    tags = data.map((ref) => versionRe.exec(ref.ref)?.[1]).filter((ref): ref is string => ref !== undefined);
  } catch (error: unknown) {
    if (errorStatus(error) !== 404) throw error;
  }
  for (const tagRef of tags) {
    const { plan, errors } = await tryReadPlanAtRef(gh, repo, tagRef);
    if (!plan) throw new Error(`frozen plan ${tagRef} is unreadable (${errors.join('; ')}) — cannot tell which work items it tracks`);
    for (const issueNumber of workItemsOf(plan)) tracked.add(issueNumber);
  }

  const closed: ClosedDerivedChunk[] = [];
  for (const chunk of await listOpenDerived(gh, repo, slug)) {
    if (tracked.has(chunk.issueNumber)) continue;
    const derivedFrom = chunk.derivedFrom!;
    await gh.issues.createComment({
      ...repo,
      issue_number: chunk.issueNumber,
      // Blockquote continuation so a multi-line reason renders fully on GitHub.
      body:
        `**Work item closed**: the proposal it was derived from (\`${derivedFrom.planRef}\`, step \`${derivedFrom.stepId}\`) ` +
        `was withdrawn by @${input.actor} at ${input.at}, and no approved plan tracks this item.\n> ${reason.replace(/\n/g, '\n> ')}`,
    });
    await gh.issues.update({ ...repo, issue_number: chunk.issueNumber, state: 'closed' });
    closed.push({ issueNumber: chunk.issueNumber, planRef: derivedFrom.planRef, stepId: derivedFrom.stepId });
  }
  return closed.sort((a, b) => a.issueNumber - b.issueNumber);
}
