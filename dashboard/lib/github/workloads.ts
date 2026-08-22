import type { Octokit } from '@octokit/rest';
import type { RepoRef } from './client';
import { errorMessage, errorStatus, Refusal } from './errors';
import { mergeRecheck } from './read-after-write';
import {
  parseWorkloadHeader,
  serializeWorkloadHeader,
  serializeWorkloadEvent,
  type WorkloadAction,
  type WorkloadEvent,
} from './markers';
import { WORKLOAD_TRANSITIONS, workloadState, type WorkloadState } from './labels';
import { reopenPlan, tagExists, type ReopenResult, maxPlanVersion, planBranch } from './plans';
import { findOpenAndonByPlanRef } from './andon';
import { instructionProblems, listOpenCorrections, sendCorrection } from './corrections';

/**
 * Workload module (T136 tracer surface): intake, listing, state derivation,
 * the single-writer lifecycle transition the workload-lifecycle workflow
 * performs, and the in-progress edit router (T161, FR-036/FR-037/SC-013).
 */

export interface Workload {
  issueNumber: number;
  slug: string;
  title: string;
  state: WorkloadState | null; // null = contract violation (not exactly one workload:* label)
}

export const SLUG_RE = /^[a-z0-9][a-z0-9-]*$/;

/**
 * Every workload.
 *
 * `recheck` names the issues a caller just wrote, re-read through the
 * read-after-write-consistent single-issue GET and merged over the list — the
 * contract's list-lag rule (`contracts/dashboard-github-api.md`). The portfolio
 * and the archive view both render from here immediately after their own writes:
 * without the hint a just-introduced workload is missing from the page that was
 * supposed to show it, and a just-activated one still reads `proposed`. Both are
 * the shape of failure the operator reads as "the button did nothing".
 */
export async function listWorkloads(
  gh: Octokit,
  repo: RepoRef,
  opts: { recheck?: number[] } = {},
): Promise<Workload[]> {
  // Paginated: workload issues are never deleted (FR-042), so this list only
  // grows — a single page would silently drop older workloads (slug uniqueness,
  // lifecycle gate L0, portfolio) once the repo passes 100 issues+PRs.
  const data = await gh.paginate(gh.issues.listForRepo, { ...repo, state: 'all', per_page: 100 });
  const listed = data
    .filter((issue) => !issue.pull_request) // the issues API returns PRs too — never workloads
    .map((issue) => {
      const header = parseWorkloadHeader(issue.body ?? '');
      if (!header) return null;
      const labels = (issue.labels ?? []).map((l) => (typeof l === 'string' ? l : (l.name ?? '')));
      return {
        issueNumber: issue.number,
        slug: header.id,
        title: issue.title,
        state: workloadState(labels),
      };
    })
    .filter((w): w is Workload => w !== null);
  // `getWorkloadByIssue` already declines a PR number and an issue with no
  // workload header, which is what makes an untrusted URL hint safe here.
  // Never `'absent'`: this list is `state: 'all'` and workloads are never deleted
  // (FR-042), so nothing ever leaves it — only a non-workload number is declined.
  return mergeRecheck(
    listed,
    opts.recheck,
    async (n) => {
      const workload = await getWorkloadByIssue(gh, repo, n);
      return workload ? { item: workload } : null;
    },
    (w) => w.issueNumber,
  );
}

export async function getWorkload(gh: Octokit, repo: RepoRef, slug: string): Promise<Workload | null> {
  const all = await listWorkloads(gh, repo);
  return all.find((w) => w.slug === slug) ?? null;
}

/**
 * Read one workload by its issue number. The single-issue GET is read-after-write
 * consistent, while the LIST endpoint is not: a just-created issue can be missing
 * from `listForRepo` for a while (live-discovered in PB-003 — the seed introduced
 * a workload and the immediate activate couldn't find it). Callers that already
 * hold the issue number from a create MUST re-read through here, never via list.
 */
export async function getWorkloadByIssue(gh: Octokit, repo: RepoRef, issueNumber: number): Promise<Workload | null> {
  let issue;
  try {
    ({ data: issue } = await gh.issues.get({ ...repo, issue_number: issueNumber }));
  } catch (error: unknown) {
    // Same contract as getWorkload: absence is null, not a raw HTTP error.
    if (errorStatus(error) === 404) return null;
    throw error;
  }
  if (issue.pull_request) return null; // the issues API answers for PR numbers too — never workloads
  const header = parseWorkloadHeader(issue.body ?? '');
  if (!header) return null;
  const labels = (issue.labels ?? []).map((l) => (typeof l === 'string' ? l : (l.name ?? '')));
  return { issueNumber, slug: header.id, title: issue.title, state: workloadState(labels) };
}

/**
 * Operator intake (dashboard only, after readiness passes — FR-029/FR-031).
 * Title-only is valid; the slug is the identity everything else keys on.
 */
export async function introduceWorkload(
  gh: Octokit,
  repo: RepoRef,
  input: { slug: string; title: string; actor: string; at: string },
): Promise<Workload> {
  if (!SLUG_RE.test(input.slug)) throw new Refusal(`invalid workload slug: ${input.slug}`);
  const existing = await getWorkload(gh, repo, input.slug);
  if (existing) throw new Refusal(`workload slug already exists: ${input.slug} (issue #${existing.issueNumber})`);

  const { data: issue } = await gh.issues.create({
    ...repo,
    title: input.title,
    body: serializeWorkloadHeader({ id: input.slug }),
    labels: ['workload:proposed'],
  });
  await gh.issues.createComment({
    ...repo,
    issue_number: issue.number,
    body: serializeWorkloadEvent({ action: 'introduced', by: input.actor, at: input.at }),
  });
  return { issueNumber: issue.number, slug: input.slug, title: input.title, state: 'proposed' };
}

/**
 * Post-gate lifecycle transition — performed ONLY by the workload-lifecycle
 * workflow after lifecycle-gate passes (transition authority matrix).
 * Flips the workload:* label atomically and appends the event comment.
 */
export async function applyLifecycleTransition(
  gh: Octokit,
  repo: RepoRef,
  input: {
    slug: string;
    action: Exclude<WorkloadAction, 'introduced' | 'edited'>;
    actor: string;
    at: string;
    reason?: string;
    revisit?: string;
    /** Pass when the caller just created the workload: the list endpoint is not
     *  read-after-write consistent, so a fresh issue must be re-read by number. */
    issueNumber?: number;
  },
): Promise<Workload> {
  const workload =
    input.issueNumber !== undefined
      ? await getWorkloadByIssue(gh, repo, input.issueNumber)
      : await getWorkload(gh, repo, input.slug);
  if (!workload || workload.slug !== input.slug) throw new Refusal(`workload not found: ${input.slug}`);
  const transition = WORKLOAD_TRANSITIONS[normalizeAction(input.action)];
  if (!transition) throw new Refusal(`unknown lifecycle action: ${input.action}`);

  if (!workload.state || !transition.from.includes(workload.state)) {
    throw new Refusal(`illegal transition ${workload.state} → ${transition.to} for ${input.slug}`);
  }

  await gh.issues.removeLabel({ ...repo, issue_number: workload.issueNumber, name: `workload:${workload.state}` });
  await gh.issues.addLabels({ ...repo, issue_number: workload.issueNumber, labels: [`workload:${transition.to}`] });
  await gh.issues.createComment({
    ...repo,
    issue_number: workload.issueNumber,
    body: serializeWorkloadEvent({
      action: input.action,
      by: input.actor,
      at: input.at,
      ...(input.reason !== undefined ? { reason: input.reason } : {}),
      ...(input.revisit !== undefined ? { revisit: input.revisit } : {}),
    }),
  });
  if (transition.to === 'archived') {
    await gh.issues.update({ ...repo, issue_number: workload.issueNumber, state: 'closed' });
    await gh.issues.lock({ ...repo, issue_number: workload.issueNumber });
  }
  return { ...workload, state: transition.to };
}

/** Map past-tense event actions to the transition table's imperative keys. */
function normalizeAction(action: string): string {
  const map: Record<string, string> = {
    activated: 'activate',
    completed: 'complete',
    canceled: 'cancel',
    deferred: 'defer',
    reactivated: 'reactivate',
    archived: 'archive',
  };
  return map[action] ?? action;
}

/* ------------------------------------------------------------------------- *
 * US11 — editing an in-progress workload (T161, FR-036/FR-037, SC-013)
 *
 * Editing is NOT a lifecycle transition: nothing below writes a `workload:*`
 * label, so `applyLifecycleTransition` remains the single writer of state. An
 * edit either patches the workload ISSUE (metadata) or opens a new plan version
 * for a fresh approval (scope) — and in every case appends one attributed,
 * timestamped `edited` event, because an edit that left no record is exactly the
 * "silent edit" SC-013 counts as zero.
 * ------------------------------------------------------------------------- */

export type WorkloadEditClass = 'metadata' | 'scope' | 'ambiguous';

/**
 * The edit taxonomy — a deterministic field → class register.
 *
 * Classification keys on the FIELD, never on the text of the new value. Two
 * readings force that:
 *   - Deterministic-First Execution (constitution): routing on a known
 *     condition is a pure function of its inputs and MUST NOT call a model. A
 *     judge asked "does this new title alter intent?" would route the same edit
 *     differently on two runs, and SC-013 ("0 silent edits") is only auditable
 *     if the route is reproducible from the record.
 *   - FR-036 puts "ownership of the *what*" with the operator. Where the field
 *     itself leaves the question open, the answer is the operator's explicit,
 *     recorded reclassification — not a guess made on their behalf.
 *
 * **metadata** — applies immediately, recorded (FR-037):
 *   - `title` — FR-037 names "title clarification" verbatim. The title NAMES the work; the
 *     frozen plan specifies it (data-model "Workload": the title "may be the only content
 *     at intake", so it cannot be what an approval was given against).
 *   - `backlog_order` — FR-037 names "backlog ordering" verbatim. Ordering is portfolio
 *     presentation: it changes nothing inside any plan, so it can invalidate no approval.
 *
 * **ambiguous** — re-plan by default, metadata-only on the operator's recorded override:
 *   - `description` — the archetypal case, named as such by FR-036 and US11 scenario 4
 *     ("a description change that may alter intent").
 *
 * **scope** — always the re-plan path (FR-036 → FR-008):
 *   - `scope`, `intent` — scope- and intent-affecting by name (FR-036); a step's intent is
 *     half of what the operator judged (FR-002).
 *   - `acceptance` — what the operator approved the step against (data-model "Plan Step").
 *   - `steps` — the frozen plan's ordered body of work: the object of the approval (FR-007).
 *   - `priority` — Commitment Scope is DERIVED from step priority (data-model), so re-tagging
 *     a MUST changes what was committed and what completion is measured against (FR-034).
 *   - `verification_targets` — the pass/fail checks MUST steps map to (FR-011/FR-012):
 *     moving a target moves the bar the operator set.
 *   - `context` — the `### Context` section designates the material a planning agent works
 *     FROM (FR-053), so changing it changes the premise the frozen plan was reasoned from.
 *     Deliberately NOT ambiguous: FR-037 does not name it metadata, and `ambiguous` is the
 *     class that unlocks the operator's override — which must not stand in front of a real
 *     change of premise.
 *
 * Anything absent from this register is `scope` — see `classifyWorkloadEdit`.
 *
 * FR-057 (mid-review intent changes) is the review-time counterpart for
 * `description`, and its acknowledgment gate G12 is deferred (GHI #28). This
 * router applies the FR-036 rule only: a description change lands on the issue
 * ONLY on the metadata route, i.e. with the operator's recorded
 * reclassification. On every other outcome the request is recorded verbatim in
 * the history instead, so nothing is lost while it goes through re-plan.
 */
export const WORKLOAD_EDIT_TAXONOMY: Readonly<Record<string, WorkloadEditClass>> = {
  title: 'metadata',
  backlog_order: 'metadata',
  description: 'ambiguous',
  scope: 'scope',
  intent: 'scope',
  acceptance: 'scope',
  steps: 'scope',
  priority: 'scope',
  verification_targets: 'scope',
  context: 'scope',
};

/**
 * An unrecognised field classifies as `scope` — the safe side (FR-036's
 * re-plan default), and deliberately NOT `ambiguous`: an unknown field is not a
 * KNOWN ambiguity, and `ambiguous` is the one class that unlocks the operator's
 * metadata-only override. Were the fallback `ambiguous`, any misspelled or
 * newly-invented field name would buy an immediate apply with no fresh
 * approval — the silent edit SC-013 counts as zero.
 *
 * `Object.hasOwn`, not a plain lookup: the field name arrives from an operator
 * form, and `TAXONOMY['constructor']` (or `'__proto__'`, `'toString'`) resolves
 * through Object.prototype to a truthy inherited value that `?? 'scope'` would
 * never catch — the fallback would be bypassed by exactly the unrecognised
 * input it exists for.
 */
export function classifyWorkloadEdit(field: string): WorkloadEditClass {
  return Object.hasOwn(WORKLOAD_EDIT_TAXONOMY, field) ? WORKLOAD_EDIT_TAXONOMY[field]! : 'scope';
}

export interface WorkloadEditRouting {
  classification: WorkloadEditClass;
  /** where the edit actually goes: an immediate issue patch, or a new plan version under review */
  route: 'metadata' | 're-plan';
  /** the FR-036 override was exercised: an ambiguous edit the operator reclassified metadata-only */
  reclassified: boolean;
}

/**
 * FR-036's routing rule, as a pure function so the UI can show the operator
 * where an edit will go BEFORE it is submitted, and so the rule itself is
 * testable without a repo:
 *   - metadata  → applies immediately (FR-037).
 *   - ambiguous → re-plan by DEFAULT; metadata-only only on the operator's
 *                 explicit reclassification, which is then recorded (FR-036).
 *   - scope     → re-plan, and the override is REFUSED. FR-036 grants the
 *                 reclassification for ambiguity; extending it to an edit the
 *                 taxonomy calls scope-affecting would make "0 silent edits"
 *                 (SC-013) opt-out, which is the one thing US11 exists to stop.
 */
export function routeWorkloadEdit(input: { field: string; reclassifyAsMetadataOnly?: boolean }): WorkloadEditRouting {
  const classification = classifyWorkloadEdit(input.field);
  const override = input.reclassifyAsMetadataOnly === true;
  if (classification === 'scope' && override) {
    throw new Refusal(
      `refusing the metadata-only override for "${input.field}": FR-036 grants the operator's reclassification only where the classification is AMBIGUOUS, and "${input.field}" is scope- or intent-affecting. Re-submit without the override and the change routes through re-plan — a new plan version enters review and takes effect on a fresh approval (FR-008).`,
    );
  }
  // An override on an already-metadata field changes nothing and is recorded as
  // no override: there was no ambiguity to reclassify, so the history must not
  // claim the operator overrode anything.
  if (classification === 'metadata') return { classification, route: 'metadata', reclassified: false };
  if (classification === 'ambiguous' && override) return { classification, route: 'metadata', reclassified: true };
  return { classification, route: 're-plan', reclassified: false };
}

/**
 * States that admit an edit. US11 is scoped to an *in-progress* workload, and
 * that is `proposed` or `active`:
 *   - `proposed`: elaboration is expected before activation (FR-016/FR-031) —
 *     nothing is frozen yet, so a scope edit's re-plan route reports "nothing to
 *     re-open" and the request is still recorded (see `applyWorkloadEdit`).
 *   - `active`: the in-progress case US11 is written about.
 * Everything else is refused BY NAME below.
 */
export const EDITABLE_WORKLOAD_STATES: readonly WorkloadState[] = ['proposed', 'active'];

/** Why each non-editable state is refused, and the way through — the refusal has
 *  to be actionable from the message alone, without opening the spec. */
const EDIT_REFUSAL_BY_STATE: Readonly<Record<string, string>> = {
  // Uniform refusal, not "metadata yes / scope no": a deferred workload accepts
  // no agent activity (FR-039), so the re-plan route would raise an Andon break
  // that no agent revision may answer — a review with no path out. Admitting
  // only the metadata half would also make admissibility depend on the FR-036
  // override, so the same submitted edit would be accepted or refused according
  // to a box the operator ticks after the fact.
  deferred:
    'a deferred workload accepts no agent activity until it is reactivated (FR-039) — reactivate it first and the edit routes normally, with history intact (FR-040)',
  completed:
    'a completed workload\'s record is closed and stays reviewable exactly as approved (FR-035) — introduce a new workload for the change (FR-031); records are never rewritten (FR-042)',
  canceled:
    'a canceled workload\'s record is closed (FR-038) — introduce a new workload for the change (FR-031); records are never rewritten (FR-042)',
  // The issue is closed AND locked, so GitHub itself 403s the PATCH — the named
  // refusal is the actionable half of a read-only guarantee that is already
  // structural (FR-041).
  archived:
    'archived workloads are read-only (FR-041) — the record stays searchable and reviewable (FR-043) and is never rewritten (FR-042); introduce a new workload for the change (FR-031)',
};

export interface WorkloadEditRequest {
  slug: string;
  /** the field being edited — the taxonomy key (WORKLOAD_EDIT_TAXONOMY) */
  field: string;
  /** the operator's own statement of the change; recorded verbatim in the `edited`
   *  event on EVERY route, so a scope edit's request is never lost while its
   *  re-plan runs (SC-013) */
  summary: string;
  /** new issue title — required for, and only used by, field `title` */
  title?: string;
  /** new body prose — required for, and only used by, field `description` */
  description?: string;
  /** the operator's explicit FR-036 reclassification of an AMBIGUOUS edit as metadata-only */
  reclassifyAsMetadataOnly?: boolean;
  /** set when the request names a plan version directly — always refused (see below) */
  targetPlanRef?: string;
  actor: string;
  at: string;
  /** Pass when the caller already holds the issue number (e.g. a clarification
   *  right after intake): the list endpoint is not read-after-write consistent,
   *  so a fresh issue must be re-read by number (PB-003, getWorkloadByIssue). */
  issueNumber?: number;
}

export interface WorkloadEditResult {
  /** the workload after the edit — its lifecycle state is UNCHANGED by construction */
  workload: Workload;
  classification: WorkloadEditClass;
  route: 'metadata' | 're-plan';
  reclassified: boolean;
  /** what was actually written to the issue; empty when the field has no
   *  workload-issue writer (see `backlog_order` below) */
  patched: { title?: string; description?: string };
  /** the new plan version opened for review, or null on the two no-op outcomes */
  reopened: ReopenResult | null;
  /** the break-level correction blocking approval until the scope request is addressed
   *  (GHI #73 A1); null on the metadata route and when there was no break to attach to */
  correctionIssue: number | null;
  /** which re-plan outcome occurred; null on the metadata route */
  replan: 'reopened' | 'already-open' | 'nothing-to-reopen' | null;
  /** the `edited` event appended to the workload's history */
  event: WorkloadEvent;
}

/**
 * Apply an edit to an in-progress workload (FR-036/FR-037, SC-013).
 *
 * Route by route:
 *   - **metadata** → issue PATCH + an attributed `edited` event. PATCH first,
 *     comment second: the PATCH is idempotent (the same title twice is a no-op),
 *     so a crash between them retries cleanly, whereas commenting first would
 *     record a change that may never have landed.
 *   - **ambiguous, no reclassification** → the scope route (the FR-036 default).
 *   - **ambiguous, reclassified metadata-only** → applies immediately, and the
 *     OVERRIDE itself rides in the event's `reason` — the history says who
 *     decided this needed no re-plan and that they decided it, not just what
 *     changed (FR-036: "that override MUST itself be recorded").
 *   - **scope** → `reopenPlan` (the FR-008 path): version N+1 enters review,
 *     version N stays the official version until a fresh approval freezes the
 *     new one. Re-open BEFORE the event, mirroring lifecycle.ts's reactivate:
 *     a crash in between leaves an open review that a retry recognizes as
 *     "already re-opened" and records, whereas recording first would leave a
 *     permanent event claiming a route that failed (events are append-only —
 *     FR-042 — so a wrong one can never be taken back).
 *
 * A direct write to the frozen plan is impossible here structurally, not merely
 * untested: this function's only writers are `issues.update` and
 * `issues.createComment` on the WORKLOAD issue, plus `reopenPlan`, which cuts a
 * new branch from the frozen tag and never writes the tag. `targetPlanRef`
 * exists so a caller that ASKS for one anyway (a UI deep-link carrying the
 * current plan ref, a replayed form POST) gets an actionable refusal instead of
 * a silently ignored field.
 */
export async function applyWorkloadEdit(
  gh: Octokit,
  repo: RepoRef,
  input: WorkloadEditRequest,
): Promise<WorkloadEditResult> {
  const summary = input.summary.trim();
  if (summary.length === 0) {
    throw new Refusal(
      `refusing to edit workload "${input.slug}": state what is changing — the request is recorded in the workload's history (FR-037), and an unstated one records nothing (SC-013)`,
    );
  }
  // Pure precondition first: an illegal override is refused before a single
  // read, so a caller that cannot be served never touches the system of record.
  const routing = routeWorkloadEdit(input);

  // On the re-plan route the summary becomes the INSTRUCTION of a break-level
  // correction (GHI #73 A1), so it must satisfy the one-instruction contract
  // (FR-004) — checked HERE, before any read or write. Validating it after
  // reopenPlan would leave a fresh plan version under review carrying no request
  // and no event: the exact silent edit this route exists to prevent. Not applied
  // on the metadata route, where the summary is only ever a history note.
  if (routing.route === 're-plan') {
    const problems = instructionProblems(summary);
    if (problems.length > 0) {
      throw new Refusal(
        `refusing to route this scope edit: its summary becomes the instruction the agent must address ` +
          `on the re-opened plan, so it must be exactly one actionable instruction (FR-004) — ${problems.join('; ')}`,
      );
    }
  }

  const workload =
    input.issueNumber !== undefined
      ? await getWorkloadByIssue(gh, repo, input.issueNumber)
      : await getWorkload(gh, repo, input.slug);
  if (!workload || workload.slug !== input.slug) throw new Refusal(`workload not found: ${input.slug}`);

  if (workload.state === null) {
    throw new Refusal(
      `refusing to edit workload "${input.slug}": its lifecycle state is unreadable — a workload issue must carry exactly one workload:* label (SC-011). Repair the labels on issue #${workload.issueNumber} first.`,
    );
  }
  if (!EDITABLE_WORKLOAD_STATES.includes(workload.state)) {
    throw new Refusal(
      `refusing to edit workload "${input.slug}": it is ${workload.state}, and an edit is an in-progress operation (US11) admitted only while ${EDITABLE_WORKLOAD_STATES.join(' or ')} — ${EDIT_REFUSAL_BY_STATE[workload.state] ?? 'no edit path exists from this state'}`,
    );
  }

  if (input.targetPlanRef !== undefined) {
    const frozen = await tagExists(gh, repo, input.targetPlanRef);
    throw new Refusal(
      frozen
        ? `refusing to modify ${input.targetPlanRef} directly: a frozen plan version is immutable (FR-007) — the plan/<slug>/v<N> tag IS the official version. Scope- or intent-affecting change goes through the open re-plan path (FR-036/FR-008): re-submit it as a scope edit of this workload and version N+1 enters review while N stays official until a fresh approval.`
        : `refusing to modify ${input.targetPlanRef} directly: a workload edit never writes a plan ref. That version is still under review — change it through its Andon break (a correction, then the agent's revision) or the scope-commitment editor on the review page (FR-009/FR-011).`,
    );
  }

  const patched: { title?: string; description?: string } = {};
  let reopened: ReopenResult | null = null;
  let replan: WorkloadEditResult['replan'] = null;
  /** The break-level correction that blocks approval of the re-opened plan (GHI #73 A1). */
  let correctionIssue: number | null = null;
  let reason: string;

  if (routing.route === 'metadata') {
    if (input.field === 'title') {
      if (input.title === undefined || input.title.trim().length === 0) {
        throw new Refusal(`refusing to edit workload "${input.slug}": field "title" needs the new title (a workload always has one — FR-031)`);
      }
      // Title-only PATCH: the body is not sent at all, so the workload:v1 header
      // cannot be disturbed by this path.
      await gh.issues.update({ ...repo, issue_number: workload.issueNumber, title: input.title });
      patched.title = input.title;
    } else if (input.field === 'description') {
      if (input.description === undefined) {
        throw new Refusal(`refusing to edit workload "${input.slug}": field "description" needs the new description text`);
      }
      const body = await rewriteWorkloadDescription(gh, repo, workload.issueNumber, input.description);
      await gh.issues.update({ ...repo, issue_number: workload.issueNumber, body });
      patched.description = input.description;
    }
    // else: a metadata field with no workload-issue writer. `backlog_order` is
    // the one such row — FR-037 permits the edit, and ordering lives on the
    // chunk issues (US4's backlog writer, not yet built), so what this seam owes
    // it is the RECORD (FR-037: "MUST be recorded in the workload's history").
    // Inventing storage for it here would put a second, undeclared source of
    // truth in front of the writer that will own it.
    reason = metadataEditReason(input.field, summary, routing.reclassified, input.actor);
  } else {
    try {
      reopened = await reopenPlan(gh, repo, { slug: input.slug, actor: input.actor, at: input.at });
      replan = 'reopened';
    } catch (error: unknown) {
      // The same two outcomes lifecycle.ts tolerates on reactivate, read for an
      // edit:
      //   "already re-opened" — a version is already under review, and one
      //     review at a time is the rule (reopenPlan). The edit's requirement is
      //     met by that open review, so the request is recorded and pointed at
      //     it as a correction rather than forking a second version.
      //   "nothing to re-open" — no frozen plan exists yet (a proposed workload,
      //     or one whose first proposal is still under review). There is no
      //     approval to supersede, so recording the request IS the whole
      //     obligation: it lands in the plan the agent has yet to propose.
      // Anything else is a real failure and propagates — a swallowed error here
      // would report a routed edit that never routed.
      const message = errorMessage(error);
      if (message.startsWith('already re-opened')) replan = 'already-open';
      else if (message.startsWith('nothing to re-open')) replan = 'nothing-to-reopen';
      else throw error;
    }
    // THE FORCING FUNCTION (GHI #73 option A1, decided 2026-07-28).
    //
    // Re-opening alone does not carry the change: v(N+1) is a byte-identical clone
    // of the frozen version, so without this the operator could judge it, approve
    // it, and freeze a plan that ignores the very edit the UI said was "routed" —
    // a silent edit, which SC-013 counts at zero.
    //
    // A break-level correction is what blocks that: G7 refuses the go-ahead while
    // any correction:open is linked to the break, and it never reads an item id, so
    // this needs no gate change. Two ways out, both already implemented — the
    // revision addresses it and the operator re-judges, or the operator withdraws it
    // with a recorded cause (without that second path a changed mind would strand
    // the review).
    //
    // Ordering: AFTER reopenPlan (there is no break to attach to before it) and
    // BEFORE the edited event, for the same reason re-open precedes the event — a
    // crash between them leaves a blocking request on an open review, which a retry
    // converges on, rather than a permanent event claiming a route that never
    // blocked anything (events are append-only, FR-042).
    // The target review: the one just re-opened, or the live break of the NEWEST
    // plan version. Resolved for 'nothing-to-reopen' too — there is no FROZEN plan
    // then, but a FIRST version can perfectly well be under review (reopenPlan
    // throws "nothing to re-open" whenever resolveCurrent is null, which is exactly
    // that state), and that live review must carry the request or v1 gets approved
    // without it. Only when no live break exists at all is record-only right.
    //
    // Keyed on the newest version's PLAN REF, never "the first live break for this
    // slug": a workload can carry more than one live break (an earlier version's
    // review left open beside the current one), and picking the first would attach
    // the request to a stale review that no longer gates anything — found by the
    // regression test for this very path (PR #71 review).
    const newestVersion = await maxPlanVersion(gh, repo, input.slug);
    const target =
      reopened?.andonIssue ??
      (newestVersion > 0 ? ((await findOpenAndonByPlanRef(gh, repo, planBranch(input.slug, newestVersion))) ?? undefined) : undefined);
    if (target !== undefined) {
      try {
        correctionIssue = await sendCorrection(gh, repo, { andonIssue: target, instruction: summary });
      } catch (error: unknown) {
        const message = errorMessage(error);
        if (!message.includes('already has an open break-level correction')) throw error;

        // The review already carries an open request. Two very different cases hide
        // behind one error, and treating them alike loses a request (PR #71 review):
        //
        //   SAME instruction  → an idempotent RETRY (a double submit, a crash
        //     between the correction and the event). The obligation is already met by
        //     the existing request, so converge on it.
        //   DIFFERENT instruction → a SECOND, distinct request. Converging would
        //     leave it enforceable nowhere: the first correction carries only the
        //     first summary, so once that one is addressed or withdrawn G7 passes and
        //     the plan can be approved without the second change — while its own
        //     event claimed it went in as a blocking correction. Refused instead,
        //     naming the outstanding request, because at most one break-level
        //     correction may be open per break and silently dropping the newer ask is
        //     the silent edit SC-013 counts at zero.
        //
        // Safe to refuse here: this error is only reachable when the break already
        // existed, i.e. reopenPlan threw before writing anything, so nothing is
        // half-applied.
        const existing = (await listOpenCorrections(gh, repo, target)).find((c) => c.itemId === null);
        if (existing?.instruction.trim() === summary) {
          correctionIssue = existing.issueNumber;
        } else {
          throw new Refusal(
            `refusing this scope edit: Andon #${target} already carries an outstanding request ` +
              `(correction #${existing?.issueNumber ?? 'unknown'}: "${existing?.instruction ?? ''}") and only one may be ` +
              `open at a time, so this different request could not be made enforceable — address or withdraw that one ` +
              `first, then re-submit. Nothing was recorded for this edit (FR-036/SC-013).`,
          );
        }
      }
    }

    // The new value the operator typed is NOT applied on this route — it takes
    // effect through the new version's fresh approval — so it rides in the
    // record. Without that, the text would exist only in the browser tab that
    // submitted it, which is a lost request and therefore a silent edit (SC-013).
    reason = scopeEditReason(input.field, summary, routing.classification, replan, reopened, input.description ?? input.title, correctionIssue);
  }

  const event: WorkloadEvent = { action: 'edited', by: input.actor, at: input.at, reason };
  await gh.issues.createComment({
    ...repo,
    issue_number: workload.issueNumber,
    body: serializeWorkloadEvent(event),
  });

  // The lifecycle state is returned unchanged on purpose: an edit is not a
  // transition, and `applyLifecycleTransition` stays the only writer of
  // `workload:*` labels (transition authority matrix).
  return {
    workload: { ...workload, title: patched.title ?? workload.title },
    classification: routing.classification,
    route: routing.route,
    reclassified: routing.reclassified,
    patched,
    reopened,
    correctionIssue,
    replan,
    event,
  };
}

/** ATX heading line — the shape of every structured section in a workload body. */
const HEADING_LINE_RE = /^[ \t]*#{1,6}\s/;

/**
 * The new issue body for a description edit, with two things preserved verbatim:
 *
 * 1. **The `workload:v1` header, byte for byte.** It is the identity
 *    `listWorkloads`, the lifecycle gate's L0 and the portfolio all key on, so a
 *    rewrite that dropped or reshaped it would orphan the workload from every
 *    other surface — and FR-042 retains records, it does not resurrect
 *    identities. The header is carried across as the ORIGINAL text, never
 *    re-serialized from the parsed slug: the marker grammar admits interior
 *    whitespace (`markers.ts` WORKLOAD_RE), the GitHub-UI hand-edit path is
 *    first-class here (FR-025), and a parse→serialize round-trip would silently
 *    canonicalize a hand-written header. Located with the exported parser
 *    line by line rather than a second copy of the marker regex — two parsers
 *    for one grammar is how two surfaces come to disagree about identity.
 * 2. **Every structured section**, i.e. everything from the first heading line
 *    on. `### Context` designates the material a planning agent works FROM
 *    (FR-053) and the issue-form intake body is entirely headed sections
 *    (`intake-normalize.ts`); dropping them on a "metadata-only" edit would
 *    change what the next agent reads — a scope effect smuggled through the
 *    metadata route.
 *
 * The description is therefore the prose BETWEEN the header and the first
 * section, which is exactly what it is at intake.
 */
/** A line that is EXACTLY the workload:v1 marker, modulo surrounding whitespace —
 *  the only shape rewriteWorkloadDescription can preserve byte-exact while replacing
 *  the prose around it. */
const HEADER_ONLY_LINE_RE = /^<!--\s*workload:v1\s+id:[a-z0-9][a-z0-9-]*\s*-->$/;

async function rewriteWorkloadDescription(
  gh: Octokit,
  repo: RepoRef,
  issueNumber: number,
  description: string,
): Promise<string> {
  const heading = description.split('\n').find((line) => HEADING_LINE_RE.test(line));
  if (heading !== undefined) {
    throw new Refusal(
      `refusing this description edit: it contains a markdown heading line ("${heading.trim()}"). A workload body's headings are structured contract sections — \`### Context\` designates the agent's input material (FR-053) — so a heading inside the description could not be told apart from one of those on the next read. Re-submit the description as prose.`,
    );
  }
  const { data: issue } = await gh.issues.get({ ...repo, issue_number: issueNumber });
  const lines = (issue.body ?? '').split('\n');
  // The line must be the header and NOTHING ELSE. parseWorkloadHeader matches the
  // marker ANYWHERE in a string, so `findIndex(parseWorkloadHeader)` alone accepts
  // `old description <!-- workload:v1 id:demo --> trailing` as the header line — and
  // since `head` keeps that whole line verbatim, the old description would survive
  // beside the new one and the edit would silently not replace anything (PR #71
  // review). Trimming to the marker is what makes the refusal below mean what its
  // message says.
  const headerIndex = lines.findIndex((line) => {
    if (parseWorkloadHeader(line) === null) return false;
    return HEADER_ONLY_LINE_RE.test(line.trim());
  });
  if (headerIndex === -1) {
    // Reachable for a header split across lines OR sharing its line with other
    // text (both writers emit it alone). Refused rather than repaired: this seam
    // must not be the thing that decides what a workload's identity line looks
    // like, and repairing it would mean guessing which side is the description.
    throw new Refusal(
      `refusing to rewrite the body of issue #${issueNumber}: its workload:v1 header is not on a line of its own, so the rewrite could not preserve it byte-exact — and a body that loses the header orphans the workload from listWorkloads, the lifecycle gate and the portfolio. Put the header on its own line first.`,
    );
  }
  const sectionIndex = lines.findIndex((line, i) => i > headerIndex && HEADING_LINE_RE.test(line));
  const head = lines.slice(0, headerIndex + 1); // header line and anything above it, verbatim
  const tail = sectionIndex === -1 ? [] : lines.slice(sectionIndex); // structured sections, verbatim
  return [...head, '', description, ...(tail.length > 0 ? ['', ...tail] : [])].join('\n');
}

/** The `edited` event's reason for the metadata route. When the operator
 *  reclassified an ambiguous edit, the reason carries the OVERRIDE — who
 *  decided this needed no re-plan, and that a decision was made at all — since
 *  FR-036 requires the override itself to be recorded, not merely its effect. */
function metadataEditReason(field: string, summary: string, reclassified: boolean, actor: string): string {
  const head = `metadata-only edit of "${field}" (FR-037): ${summary}`;
  return reclassified
    ? `${head}; classification was AMBIGUOUS and defaults to the re-plan path (FR-036) — @${actor} explicitly reclassified it as metadata-only, so it applied immediately with no new plan version and no fresh approval; this override is itself recorded here`
    : `${head}; applied immediately — no re-plan required`;
}

/** The `edited` event's reason for the re-plan route: what was asked for, why it
 *  went to re-plan, and what the re-open actually did — so the request survives
 *  in the history even when the re-open was a no-op (SC-013). */
function scopeEditReason(
  field: string,
  summary: string,
  classification: WorkloadEditClass,
  replan: WorkloadEditResult['replan'],
  reopened: ReopenResult | null,
  /** the new value the operator submitted, which this route does NOT apply */
  proposed?: string,
  /** the break-level correction now blocking approval of the re-opened plan (GHI #73 A1) */
  correctionIssue?: number | null,
): string {
  const head =
    classification === 'ambiguous'
      ? `edit of "${field}" with an AMBIGUOUS classification, defaulted to the re-plan path (FR-036): ${summary}`
      : `scope- or intent-affecting edit of "${field}" (FR-036): ${summary}`;
  const proposedClause =
    proposed !== undefined && proposed.trim().length > 0
      ? `; the operator's proposed new value, for the revision to carry: ${proposed}`
      : '';
  const outcome =
    replan === 'reopened' && reopened
      ? `re-opened as ${reopened.planRef} for review at Andon #${reopened.andonIssue} (FR-008) — the previous version stays the official one until a fresh approval freezes this one`
      : replan === 'already-open'
        ? 'a plan version is ALREADY under review for this workload, and one review runs at a time — this change went into that open review as a correction on its Andon break rather than forking a second version (FR-004/FR-008)'
        : correctionIssue !== undefined && correctionIssue !== null
          ? 'no frozen plan exists for this workload yet, so there was nothing to re-open — but its FIRST version is under review, and the request went onto that review rather than waiting for a version that is already in flight (FR-008)'
          : 'no frozen plan exists for this workload yet and no review is running, so there is nothing to re-open and nothing to block — the request is recorded here and belongs in the plan the agent has yet to propose';
  // The blocking half, named in the record: without it the history would say an
  // edit was "routed" while nothing stopped the unchanged clone being approved.
  const blocking =
    correctionIssue !== undefined && correctionIssue !== null
      ? `; correction #${correctionIssue} is open on that review and BLOCKS its approval until the request is addressed or withdrawn (G7/SC-013)`
      : replan === 'nothing-to-reopen'
        ? '; no review exists yet to block, so this record is the whole obligation'
        : '';
  return `${head}${proposedClause}; routed to the open re-plan path, never applied to the frozen plan (FR-007): ${outcome}${blocking}`;
}
