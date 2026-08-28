import { createHash } from 'node:crypto';
import type { Octokit } from '@octokit/rest';
import type { RepoRef } from '../../../dashboard/lib/github/client';
import { resolveCurrent, slugFromPlanRef, tagExists, tagTargetSha, tryReadPlanAtRef } from '../../../dashboard/lib/github/plans';
import { getWorkload } from '../../../dashboard/lib/github/workloads';
import { getChunk, findIntentConfirmation } from '../../../dashboard/lib/github/chunks';
import { errorMessage, errorStatus } from '../../../dashboard/lib/github/errors';
import { CONTRADICTION_LABEL } from '../../../dashboard/lib/github/labels';
import { ConfirmationRecord, Ledger, Legacy } from '../../../schemas/confirmation';
import type { PlanStep } from '../../../schemas/plan';
import { asApiUnavailable, type GateResult } from './runner';

/**
 * Build-preflight checks (gate-checks-cli.md §2):
 *   B1  --plan-ref tag exists AND is the newest frozen plan/<slug>/v* tag —
 *       the derived official version (FR-007; CURRENT eliminated 2026-07-11)
 *   B2  plan at that tag re-validates against the schema (integrity)
 *   B3  chunk is chunk:ready with intent + testable outcome metric + acceptance (FR-017)
 *   B4  unattended runs require a WELL-FORMED intent-confirmed comment (FR-018)
 *   B5  every high-stakes step in the build carries a valid, authority-matching
 *       confirmation record, BOUND to this workload and to the step as approved
 *       (FR-024, SC-006; binding added 2026-08-17, GHI #95)
 *   B6  no flagged:wrong-assumption on the chunk — reconcile first (FR-022)
 *   B7  the workload carries workload:active (FR-033/038/039/041)
 *   B8  the run was DISPATCHED ON the frozen tag — GITHUB_REF names --plan-ref
 *       (FR-007; decided 2026-07-28, GHI #72 option A)
 *   B9  a VERIFY run's commit descends from the frozen tag (FR-063, added
 *       2026-08-24) — build runs skip it: they have no merged commit yet, and B8
 *       already governs what they were dispatched on
 */

export async function checkB1FrozenCurrent(
  gh: Octokit,
  repo: RepoRef,
  planRef: string,
  slug: string,
): Promise<GateResult> {
  if (!(await tagExists(gh, repo, planRef))) {
    return { id: 'B1', status: 'fail', requirement: 'FR-007', detail: `tag ${planRef} does not exist` };
  }
  const current = await resolveCurrent(gh, repo, slug);
  if (current !== planRef) {
    return { id: 'B1', status: 'fail', requirement: 'FR-007', detail: `official version is ${current ?? 'unset (nothing frozen)'}, not ${planRef}` };
  }
  return { id: 'B1', status: 'pass', requirement: 'FR-007' };
}

export async function checkB2PlanRevalidates(gh: Octokit, repo: RepoRef, planRef: string): Promise<GateResult> {
  const { plan, errors } = await tryReadPlanAtRef(gh, repo, planRef);
  return plan
    ? { id: 'B2', status: 'pass', requirement: 'integrity' }
    : { id: 'B2', status: 'fail', requirement: 'integrity', detail: errors.join('; ') };
}

/**
 * B8 — the build must be DISPATCHED ON the frozen tag, not merely handed it as an
 * input (FR-007; GHI #72 option A, decided 2026-07-28).
 *
 * Three guarantees rest on the dispatch ref, and every one of them was broken while
 * builds were dispatched on `main` with the tag passed only as an input:
 *   1. the agent's worktree IS the frozen commit — `actions/checkout` follows
 *      `github.ref`, so dispatching on the tag makes "build only from frozen"
 *      structural instead of aspirational. Dispatched on main, the agent verified
 *      its targets against unapproved code while the reporter stamped those
 *      conclusions onto the frozen commit.
 *   2. `vt-report` gets TRUSTED provenance — `workflow_run.head_sha` is the frozen
 *      commit, which is the only thing an agent-authored artifact can be bound
 *      against (the workflow_run payload cannot see dispatch inputs).
 *   3. `cancelWorkloadRuns` finds the run at all — it matches in-flight runs by
 *      `head_branch == plan/<slug>/v<N>` (runs.ts). Dispatched on main, head_branch
 *      is `main`, nothing matches, and cancel silently stops nothing (FR-038,
 *      SC-014).
 *
 * Read from the environment, not a CLI flag: GITHUB_REF is set by Actions itself on
 * every step, so it cannot be spoofed by the caller the way an argument could — and
 * being env-borne means this check needed no change to the compiled workflow.
 *
 * WHY THE `plan_ref` INPUT STAYS (GHI #66 proposed dropping it as redundant once
 * dispatch-on-tag was enforced — that reading was wrong): this check compares two
 * INDEPENDENT sources, the caller's declared intent (`--plan-ref`, from the dispatch
 * input) against what Actions actually did (`GITHUB_REF`). Deriving the plan ref from
 * `github.ref` would make the comparison tautological — B8 would assert the ref
 * equals itself and catch nothing. The input's redundancy is the whole point of it.
 *
 * Absent GITHUB_REF (a local run of the CLI) is NOT a failure: the check reports
 * pass with a detail saying it was unenforceable, because failing closed here would
 * make the preflight unrunnable outside Actions for no security gain — the guarantee
 * only means anything on a runner.
 */
export function checkB8DispatchedOnFrozenRef(planRef: string, githubRef: string | undefined): GateResult {
  if (githubRef === undefined || githubRef.trim().length === 0) {
    return {
      id: 'B8',
      status: 'pass',
      requirement: 'FR-007',
      detail: 'GITHUB_REF is unset — not an Actions run, so the dispatch ref is unenforceable here',
    };
  }
  // Accept the full ref or the short form: Actions sets refs/tags/<tag> for a tag
  // dispatch, and comparing both ways keeps this honest whichever GitHub sends.
  const ref = githubRef.trim();
  if (ref === `refs/tags/${planRef}` || ref === planRef) {
    return { id: 'B8', status: 'pass', requirement: 'FR-007' };
  }
  // The consequence, said the same way in both branches below — it is WHY the
  // refusal exists, and an operator who reads only the first clause still gets it.
  const because =
    `Dispatching elsewhere means the agent checks out that ref instead of the approved commit ` +
    `(FR-007), the results cannot be bound to this build, and a cancel of the workload would not ` +
    `find this run (FR-038)`;
  // The SAME-NAME case gets its own sentence (live: run 32658276993). A plan branch
  // and its frozen tag are both `plan/<slug>/v<N>`, so GitHub's ref picker offers
  // two entries with one label and lists branches first — the obvious pick is the
  // wrong one. Saying "dispatched on refs/heads/plan/demo7/v1, not the frozen tag
  // plan/demo7/v1" to someone in that position names the same string twice and
  // reads as a contradiction, which is how a correct refusal wasted two dispatches.
  if (ref === `refs/heads/${planRef}`) {
    return {
      id: 'B8',
      status: 'fail',
      requirement: 'FR-007',
      detail:
        `dispatched on the BRANCH ${planRef}, not the frozen TAG of the same name — the plan branch ` +
        `and the frozen tag are both called ${planRef}, so the name alone is ambiguous. ` +
        `IN THE UI: re-run and switch to the Tags tab in the "Use workflow from" dropdown, because it ` +
        `lists branches first. ON THE CLI: pass the ref FULLY QUALIFIED — ` +
        `\`gh workflow run build-template.lock.yml --ref refs/tags/${planRef}\` — because ` +
        `\`--ref ${planRef}\` resolves the ambiguous name to the BRANCH silently, with nothing to ` +
        `tell you a choice was made. ${because}`,
    };
  }
  return {
    id: 'B8',
    status: 'fail',
    requirement: 'FR-007',
    detail:
      `dispatched on ${ref}, not the frozen tag ${planRef} — re-run selecting the TAG. IN THE UI: ` +
      `open the Tags tab in the ref picker, because a plan BRANCH of the same name also exists and ` +
      `the picker offers it first. ON THE CLI: \`--ref refs/tags/${planRef}\`, fully qualified — a ` +
      `bare \`--ref ${planRef}\` resolves to the branch silently. ${because}`,
  };
}

/** B3 — the chunk carries a full, testable requirement (FR-017): label chunk:ready
 *  AND every body section (Intent / outcome metric / Acceptance) non-empty. Both are
 *  checked — a hand-applied label without the fields is exactly what this gate exists
 *  to catch. The chunk must also be BOUND to the frozen plan (a step's
 *  tracking_issue): without the binding, a ready+confirmed chunk from an unrelated
 *  workload would satisfy B3/B4, and naming an unflagged bystander chunk would
 *  bypass B6's contradiction block on the real work item (PR #74 bot finding). */
export async function checkB3ChunkReady(
  gh: Octokit,
  repo: RepoRef,
  chunkIssue: number,
  planRef: string,
): Promise<GateResult> {
  const chunk = await getChunk(gh, repo, chunkIssue);
  if (!chunk) {
    return { id: 'B3', status: 'fail', requirement: 'FR-017', detail: `issue #${chunkIssue} is not a chunk (no chunk:* label)` };
  }
  if (chunk.state !== 'ready') {
    return { id: 'B3', status: 'fail', requirement: 'FR-017', detail: `chunk #${chunkIssue} is chunk:${chunk.state} — promote it with the full requirement before handing it to an agent` };
  }
  const missing = (['intent', 'outcomeMetric', 'acceptance'] as const).filter((f) => chunk[f] === null);
  if (missing.length > 0) {
    return { id: 'B3', status: 'fail', requirement: 'FR-017', detail: `chunk #${chunkIssue} is labeled ready but missing section(s): ${missing.join(', ')}` };
  }
  const { plan } = await tryReadPlanAtRef(gh, repo, planRef);
  const claiming = plan?.steps.filter((s) => s.tracking_issue === chunkIssue) ?? [];
  if (claiming.length === 0) {
    return {
      id: 'B3',
      status: 'fail',
      requirement: 'FR-017',
      detail: `chunk #${chunkIssue} is not a tracking issue of any step in ${planRef} — the build's chunk must be the plan's chunk, or the gates on it gate nothing`,
    };
  }
  // EXACTLY one, not merely one-or-more (GHI #102). An existence check is satisfied
  // the moment any step claims the chunk, however many others also do — and this is
  // the gate that has to answer "which step is this build for?", which two claimants
  // make unanswerable. Plan-gate G13 refuses such a plan at approval, so reaching
  // here means a plan frozen BEFORE that gate existed; failing closed is right, and
  // the message names the exit rather than leaving the operator at a dead end.
  if (claiming.length > 1) {
    return {
      id: 'B3',
      status: 'fail',
      requirement: 'FR-017',
      detail: `chunk #${chunkIssue} is claimed by ${claiming.map((s) => s.id).join(' and ')} in ${planRef} — one work item delivers one step, so this build cannot say which step it is for. Re-open the plan and give each step its own work item`,
    };
  }
  // Name the claimant on the way through. B3 is the gate that answers "which step
  // is this build for?" — it computes exactly that above and used to discard it on
  // success, leaving a bare green where the one fact the operator came for was
  // already in hand (PR #118 bot review). Same reason B5 explains its own pass.
  return {
    id: 'B3',
    status: 'pass',
    requirement: 'FR-017',
    detail: `chunk #${chunkIssue} is delivered by ${claiming[0]!.id} in ${planRef}`,
  };
}

/**
 * The steps a chunk-aimed build is BUILDING — the plan steps that deliver the work
 * item it names (GHI #87, operator decision 2026-08-17).
 *
 * `build-template` forwarded `--chunk` and `--unattended` but never `--step`, so a
 * dispatched build gated on EVERY high-stakes step in the plan. Safe, and it made
 * flagging expensive in exactly the way that teaches an operator to flag less: on a
 * plan with two flagged steps, confirming one unblocked no build at all — a build
 * of a chunk touching neither flagged step still waited for both authorities.
 *
 * Derived rather than added as a dispatch input, because the chunk is ALREADY the
 * unit of work B3/B4/B6 gate on and the plan already records which step delivers it.
 * A second input would let a caller name a step set the chunk does not correspond
 * to, which is a way of disarming B5 by hand.
 *
 * `null` — meaning "gate the whole plan" — for every case that is not an unambiguous
 * single step: no chunk named, an unreadable plan, a chunk no step claims, or a
 * chunk two steps claim. Never narrow on an uncertain reading: B3 refuses all of
 * those anyway, and the one thing this must not do is quietly shrink the set of
 * authorities a build waits for on the strength of a binding the gate is about to
 * reject.
 */
export async function stepsForChunk(
  gh: Octokit,
  repo: RepoRef,
  planRef: string,
  chunkIssue: number | undefined,
): Promise<string[] | null> {
  if (chunkIssue === undefined) return null;
  const { plan } = await tryReadPlanAtRef(gh, repo, planRef);
  const claiming = plan?.steps.filter((s) => s.tracking_issue === chunkIssue) ?? [];
  return claiming.length === 1 ? [claiming[0]!.id] : null;
}

/** B4 — unattended runs need the operator's confirmation on record (FR-018): the
 *  intent:confirmed label AND a well-formed intent-confirmed comment naming this
 *  chunk. The comment is the confirmation — it carries identity + timestamp; the
 *  label alone is just a light. */
export async function checkB4IntentConfirmed(gh: Octokit, repo: RepoRef, chunkIssue: number): Promise<GateResult> {
  const chunk = await getChunk(gh, repo, chunkIssue);
  if (!chunk) {
    return { id: 'B4', status: 'fail', requirement: 'FR-018', detail: `issue #${chunkIssue} is not a chunk (no chunk:* label)` };
  }
  if (!chunk.intentConfirmed) {
    return { id: 'B4', status: 'fail', requirement: 'FR-018', detail: `chunk #${chunkIssue} lacks intent:confirmed — an unattended run cannot begin until the operator confirms intent alignment` };
  }
  const confirmation = await findIntentConfirmation(gh, repo, chunkIssue);
  if (!confirmation) {
    return { id: 'B4', status: 'fail', requirement: 'FR-018', detail: `chunk #${chunkIssue} carries intent:confirmed but no well-formed confirmation comment (by:@login at:ISO8601) — the label without the record does not authorize an unattended run` };
  }
  return { id: 'B4', status: 'pass', requirement: 'FR-018' };
}

/**
 * Where one step's confirmation record lives — SCOPED BY WORKLOAD (GHI #95).
 *
 * It used to be the repo-global `confirmations/<step-id>.json`, but step ids are
 * unique only WITHIN a plan: workloads `alpha` and `beta` both declaring
 * `step-billing-cycle` shared one file, so alpha's customer answer satisfied
 * beta's build. The system already half-knew this — `confirmRecords` REFUSED to
 * label an ambiguous step id while B5 went on accepting the record, so one
 * component declined to signal what another accepted as authorization.
 */
export function confirmationPath(workload: string, stepId: string): string {
  return `${CONFIRMATION_DIR}/${workload}/${stepId}.json`;
}

/** Root of the record tree. Named once so the gate, the validator and the
 *  workflow's path filter cannot end up looking in different places. */
export const CONFIRMATION_DIR = 'confirmations';

/** The pre-#95 unscoped path. A READ-ONLY diagnostic: a record found here is
 *  refused (it carries no binding and never did), but saying "no confirmation
 *  recorded" while one sits at the old path would send the operator to chase an
 *  authority who already answered. */
export function legacyConfirmationPath(stepId: string): string {
  return `${CONFIRMATION_DIR}/${stepId}.json`;
}

/**
 * The fingerprint a confirmation is bound to: what the step says it will do, how
 * anyone would know it worked, and who had to approve it (GHI #95).
 *
 * WHY CONTENT AND NOT THE PLAN VERSION. Binding to `plan_ref` would be simpler and
 * equally safe, but it expires every confirmation on a workload the moment ANY
 * version is re-approved — including steps nobody touched — so the operator
 * re-asks a customer about work that did not change, and flagging a step becomes
 * expensive enough to discourage. Hashing the step means a re-freeze that left the
 * step alone keeps its sign-off, and one that rewrote it does not (operator
 * decision, 2026-08-17).
 *
 * The FIELD SET is the answer to "would the authority want to be asked again?":
 *   id          — the step being confirmed, so a record cannot be renamed onto another
 *   intent      — the business `what`, which is what was described to them
 *   acceptance  — the testable outcome, which is what they were promised
 *   authority   — who was asked; a re-route is a different question, not the same one
 * `priority`, `title`, `depends_on` and `tracking_issue` are deliberately OUT: none
 * of them changes what the authority said yes to, and including them would expire
 * good sign-offs on bookkeeping edits.
 *
 * Serialization is canonical by construction — a fixed key order written out
 * literally, not `JSON.stringify(step)` over a whole object whose key order is an
 * accident of how the document was authored. `??` normalizes an absent optional and
 * an explicit null to the same value, so a plan rewritten by a different writer does
 * not invalidate its own confirmations.
 */
export function stepDigest(step: Pick<PlanStep, 'id' | 'intent' | 'acceptance'> & { authority?: string | null }): string {
  const canonical = JSON.stringify([
    ['id', step.id],
    ['intent', step.intent],
    ['acceptance', step.acceptance],
    ['authority', step.authority ?? null],
  ]);
  return `sha256:${createHash('sha256').update(canonical, 'utf8').digest('hex')}`;
}

/** One file at one ref, or null when absent. Local rather than reusing plans.ts's
 *  private reader: that one resolves the PLAN document (canonical path, guarded
 *  legacy fallback), and a confirmation has exactly one path with no history. */
async function readTextAtRef(gh: Octokit, repo: RepoRef, path: string, ref: string): Promise<string | null> {
  try {
    const { data } = await gh.repos.getContent({ ...repo, path, ref });
    if (Array.isArray(data) || !('content' in data)) return null;
    return Buffer.from(data.content, 'base64').toString('utf8');
  } catch (error: unknown) {
    if (errorStatus(error) === 404) return null;
    throw error;
  }
}

/**
 * Valid record, or the reason it is not one. Exported so the confirm-record
 * workflow's validator (scripts/confirm-record.ts) admits EXACTLY the records B5
 * accepts: a second definition of "valid" would let a record earn the
 * confirmed:<authority> label and still block the build it was recorded for.
 *
 * `at` is WHERE the record was found — the workload directory and the filename —
 * and the record's own fields must agree with both. Everything checkable from the
 * FILE ALONE is checked here; whether it matches the STEP is `confirmationMismatch`
 * below, because one caller (`confirmRecords`) reads records before it knows which
 * official plan, if any, declares them.
 */
/**
 * How to actually LAND a confirmation record — one definition, shared by the gate's
 * refusal and the review page, so the two can never tell an operator different things
 * (GHI #92).
 *
 * The fact itself is not new: PB-012's preconditions have stated it since the playbook
 * was written. What was missing is that it lived in a preconditions block in one file,
 * and the operator who needs it is looking at a blocked build in the dashboard or a
 * refusal in a run log. Knowledge nothing points at is knowledge nobody has.
 *
 * WHY THERE IS A SECOND ROUTE AT ALL. The default-branch ruleset requires the
 * plan-gate and deliverable-gate checks on EVERY push, not merely on pull-request
 * merges, and bypasses only the repository-admin role (`setup-repo.ts`, actor_id 5).
 * That is deliberate: no machine credential holds a bypass on any repo type. The
 * consequence is that the person who obtained a customer's or a clinician's answer may
 * have no way to commit it directly — and the gate would then block a build for want of
 * a record the operator was holding in their hand.
 *
 * The pull request works because both gates report `skipped` — never a failure — on a
 * pull request that carries neither a plan document nor a deliverable, and a skip
 * satisfies a required check. That is the same property that keeps ordinary
 * development pull requests from being blocked by gates that do not apply to them.
 */
export function howToLandTheRecord(path: string, branch: string): string {
  return (
    `record their answer at ${path}. Committing straight to ${branch} needs the repository-admin role — the ${branch} ` +
    'ruleset requires the plan-gate and deliverable-gate checks on every push and bypasses only that role. Without it, ' +
    'open a pull request from a branch instead: a pull request carrying neither a plan nor a deliverable is reported ' +
    'skipped by both gates, which satisfies the required checks, so you can merge it yourself'
  );
}

/**
 * Why this record did not parse, in words an operator can act on.
 *
 * A UNION'S OWN ERROR SAYS NOTHING. `ConfirmationRecord` is `Ledger | Legacy`, and
 * zod collapses a failed union into a single `invalid_union` issue at the root whose
 * message is "Invalid input" — so a record with a blank contact, or a missing
 * confirmer, or a decision spelled `denied`, all reported identically and none of
 * them usefully. That is the same failure shape as a gate that refuses without
 * saying why (T250): correct, and useless at the moment someone needs it.
 *
 * So the branch the document was plainly TRYING to be is re-validated on its own and
 * ITS issues are reported. A document carrying `scope`/`confirmer`/`confirmed_at` and
 * no `decisions` is a legacy record and is judged as one; everything else is judged
 * as a ledger, which is what every writer emits.
 */
function confirmationParseReason(doc: unknown): string {
  const isRecord = typeof doc === 'object' && doc !== null && !Array.isArray(doc);
  const has = (key: string): boolean => isRecord && key in (doc as Record<string, unknown>);
  const looksLegacy = !has('decisions') && ['scope', 'confirmer', 'confirmed_at'].some(has);
  const result = looksLegacy ? Legacy.safeParse(doc) : Ledger.safeParse(doc);
  if (result.success) {
    // Unreachable in practice: the union failed, so neither branch accepts it. Kept
    // because "the union said no and the branch said yes" is a contradiction worth
    // naming rather than reporting as an empty string.
    return 'it matches neither the decision-ledger shape nor the pre-2026-08-27 flat one';
  }
  const detail = result.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
  return looksLegacy ? `${detail} (read as a pre-2026-08-27 flat record)` : detail;
}

export function parseConfirmation(
  raw: string,
  at: { workload: string; stepId: string },
): { record: ConfirmationRecord } | { reason: string } {
  let doc: unknown;
  try {
    doc = JSON.parse(raw);
  } catch (error: unknown) {
    return { reason: `unparseable JSON (${errorMessage(error)})` };
  }
  const parsed = ConfirmationRecord.safeParse(doc);
  if (!parsed.success) {
    return { reason: confirmationParseReason(doc) };
  }
  // A record whose step_id disagrees with its filename was copied from another
  // step: the authority answered a different question, so it attributes nothing
  // to the step being built.
  if (parsed.data.step_id !== at.stepId) {
    return { reason: `its step_id is "${parsed.data.step_id}", not "${at.stepId}" — a record copied from another step confirms nothing` };
  }
  // Same argument one level up (GHI #95): step ids are unique only within a plan,
  // so a record moved between workload directories would otherwise authorize work
  // its authority never saw.
  if (parsed.data.workload !== at.workload) {
    return {
      reason: `its workload is "${parsed.data.workload}", not "${at.workload}" — a record filed under another workload confirms nothing here`,
    };
  }
  return { record: parsed.data };
}

/**
 * What does this ledger say about THIS step — and is it enough to build?
 *
 * One definition, used by B5 and by the confirm-record validator, so the gate and
 * the board can never disagree about what a record authorizes.
 *
 * THE READ RULE (GHI #96, 2026-08-27): the NEWEST decision whose `step_digest`
 * matches the step being built wins. `approved` and `overridden` authorize;
 * `rejected` blocks; no matching entry means nobody has been asked about THIS
 * version yet. Earlier versions' decisions stay in the file as history and
 * authorize nothing — which is the point of keeping them.
 *
 * WHY A PASS CAN CARRY A NOTE. An override is an operator overruling a recorded
 * refusal. It is a legitimate act and it must not be silent: a build that proceeded
 * because a human set aside a clinician's "no" should say so in the same report the
 * operator reads, not only in the file. `note` is that sentence.
 *
 * ORDER IS THE MESSAGE. Authority is compared first even though it is also inside
 * the digest: a re-route from customer to legal changes the fingerprint too, and
 * "the step changed since this was signed" would send the operator to re-ask the
 * customer when what they actually need is to ask counsel. The specific cause
 * wins; the digest is the catch-all behind it (the same reason B5 reports its
 * causes apart rather than as one message).
 */
export function confirmationVerdict(
  record: ConfirmationRecord,
  step: PlanStep,
): { ok: true; note: string | null } | { ok: false; kind: 'refused' | 'mismatch'; reason: string } {
  // authority is non-null on any high_stakes step that survived the schema
  // (plan.ts's superRefine, FR-023), so the route is always something to match.
  if (record.authority !== step.authority) {
    return {
      ok: false,
      kind: 'mismatch',
      reason: `recorded against the ${record.authority} authority, but the step routes to ${step.authority} — an answer from another authority leaves the risk this step named unreviewed`,
    };
  }
  const digest = stepDigest(step);
  const forThisVersion = record.decisions.filter((entry) => entry.step_digest === digest);
  const latest = forThisVersion[forThisVersion.length - 1];

  if (!latest) {
    // NOT "no confirmation recorded" — that wording was the old failure and it is
    // false here: somebody WAS asked, about a version that has since changed. Saying
    // which one, and when, is the difference between the operator re-asking a
    // question with the new text in hand and re-asking one already answered.
    const history = record.decisions[record.decisions.length - 1];
    return {
      ok: false,
      kind: 'mismatch',
      reason: history
        ? `its decisions are all about a different version of ${step.id} — the step's intent or acceptance has changed ` +
          `since the last one (${history.decision} on ${history.at}; the ledger's newest entry carries ${history.step_digest}, ` +
          `this step hashes to ${digest}). Take the changed step back to the ${record.authority} authority and append a fresh ` +
          `decision; an answer given about different work is exactly what this gate exists to refuse (GHI #95)`
        : `records no decision at all about ${step.id}`,
    };
  }

  if (latest.decision === 'rejected') {
    // The refusal in the authority's own words. Deliberately NOT "route it to the
    // authority and commit the answer": they answered, and the answer was no. The
    // remedy that fits is to change the work or to lift the block on the record —
    // sending the operator back to re-ask would be a correct refusal with a remedy
    // that does not fit the road they arrived by (the T250 lesson).
    return {
      ok: false,
      kind: 'refused',
      reason:
        `the ${record.authority} authority REFUSED this version of ${step.id} on ${latest.at} — ${latest.by.name} ` +
        `(${latest.by.contact}): "${latest.rationale}". A refusal blocks the build. Either change the step and take the ` +
        `new version back to them, or, if the objection is answered elsewhere, append an \`overridden\` decision saying ` +
        `why — an override is recorded and reported, never silent (FR-024)`,
    };
  }

  if (latest.decision === 'overridden') {
    const refusal = forThisVersion.filter((entry) => entry.decision === 'rejected').pop();
    return {
      ok: true,
      note:
        'building over a recorded refusal — ' +
        (refusal
          ? `${refusal.by.name} (${refusal.by.contact}) for the ${record.authority} authority refused on ${refusal.at}: ` +
            `"${refusal.rationale}"`
          : `the ${record.authority} authority refused earlier`) +
        `; ${latest.by.name} (${latest.by.contact}) lifted the block on ${latest.at}: "${latest.rationale}"`,
    };
  }

  return { ok: true, note: null };
}

/**
 * B5 — the build stays blocked until an attributable external confirmation exists
 * for every high-stakes step it builds (FR-024, SC-006).
 *
 * WHERE IT READS IS THE CHECK. The plan comes from `planRef`, the frozen tag; the
 * confirmation comes from the repository's DEFAULT BRANCH HEAD. FR-024 blocks the
 * build "even on an approved plan", which means the confirmation is recorded AFTER
 * the freeze — so the frozen tag cannot contain it by construction, and a B5 that
 * read `confirmations/<workload>/<step-id>.json` at planRef would be unpassable: every
 * high-stakes build would block forever and the only way out would be to stop
 * flagging steps. Approval freezes the plan; the confirmation unblocks the build;
 * the two act on different objects and the gate reads each where it lives.
 *
 * Step set: the steps this build NAMES (`--step`, repeatable) when it names any,
 * otherwise every high_stakes step in the plan. A named step the plan does not
 * contain FAILS — a typo must not silently skip the gate on the step it names —
 * and an empty list is not a selection, so a caller forwarding zero --step
 * arguments falls back to the whole plan rather than disarming the check.
 *
 * The three causes are reported apart because they are three different operator
 * actions: chase the authority, fix the record you have, or get the RIGHT
 * authority. One message for all three would send the operator to the wrong place
 * twice out of three times. Ordering is PLAN order, never discovery order
 * (gate-checks-cli.md "Shared conventions").
 *
 * WHAT THE RECORD IS BOUND TO (GHI #95, amended 2026-08-17). The lookup used to be
 * `confirmations/<step-id>.json` matched on step id and authority alone, which let
 * one answer authorize work it was never about, two ways:
 *   1. across WORKLOADS — step ids are unique only within a plan, so `alpha` and
 *      `beta` both declaring `step-billing-cycle` shared one file; the path is now
 *      scoped by workload;
 *   2. across VERSIONS, the worse one — v1 flags a step, the authority answers, the
 *      operator re-opens and approves a v2 in which that step id means materially
 *      different work, and the v1-era answer satisfied B5 on the v2 build. The
 *      record now carries a digest of the step's own content, recomputed here from
 *      the FROZEN plan, so a re-freeze that rewrote the step invalidates its
 *      sign-off and a re-freeze that left it alone does not.
 * The workload comes from `planRef` and not from a parameter: the ref is what the
 * build was dispatched with and what B1/B8 already police, so the gate cannot be
 * pointed at another workload's records by a caller.
 */
export async function checkB5ConfirmationRecorded(
  gh: Octokit,
  repo: RepoRef,
  planRef: string,
  stepIds?: string[],
): Promise<GateResult> {
  // The same read B2 makes: one way to resolve plan.json, so the gate that blocks
  // and the gate that validates can never disagree about which document is frozen.
  const { plan, errors } = await tryReadPlanAtRef(gh, repo, planRef);
  if (!plan) {
    return { id: 'B5', status: 'fail', requirement: 'FR-024', detail: `cannot read the plan at ${planRef}: ${errors.join('; ')}` };
  }

  const named = stepIds !== undefined && stepIds.length > 0 ? stepIds : null;
  const unknown = named ? [...new Set(named.filter((id) => !plan.steps.some((s) => s.id === id)))] : [];
  const inScope = plan.steps.filter((s) => s.high_stakes && (named === null || named.includes(s.id)));

  if (unknown.length === 0 && inScope.length === 0) {
    // Explained, not silent: a green on a gate this consequential reads like a
    // gate that never ran.
    return {
      id: 'B5',
      status: 'pass',
      requirement: 'FR-024',
      detail: 'no high-stakes step in this build — nothing to confirm',
    };
  }

  const blocked = unknown.map((id) => `${id}: named by this build but absent from the plan at ${planRef}`);
  // A PASS is not always a quiet one. An override lets the build proceed over a
  // recorded refusal, and that has to reach the same report the operator reads —
  // a gate that passed silently here would make "an authority agreed" and "a human
  // overruled an authority" look identical (FR-024, GHI #96).
  const notes: string[] = [];
  if (inScope.length > 0) {
    // Derived from the dispatched ref, never a parameter: B1/B8 already police
    // which plan this build is for, so scoping the records to that same ref means
    // a caller cannot point the gate at another workload's answers (GHI #95).
    const workload = slugFromPlanRef(planRef);
    if (workload === null) {
      return {
        id: 'B5',
        status: 'fail',
        requirement: 'FR-024',
        detail: `cannot tell which workload ${planRef} belongs to, so no confirmation record can be attributed to it — a build ref must be plan/<slug>/v<N>`,
      };
    }
    const { data: repoInfo } = await gh.repos.get({ ...repo });
    const branch = repoInfo.default_branch;
    for (const step of inScope) {
      const path = confirmationPath(workload, step.id);
      const raw = await readTextAtRef(gh, repo, path, branch);
      if (raw === null) {
        // Before reporting "nobody answered", check the pre-#95 unscoped path.
        // A record sitting there IS an answer somebody gave; sending the operator
        // back to the authority would waste a real person's time on a file move.
        const legacy = await readTextAtRef(gh, repo, legacyConfirmationPath(step.id), branch);
        blocked.push(
          legacy === null
            ? `${step.id}: no confirmation recorded — ${path} does not exist on ${branch}; route it to the ${step.authority} authority, then ${howToLandTheRecord(path, branch)}`
            : `${step.id}: a confirmation exists at the old unscoped ${legacyConfirmationPath(step.id)}, which no longer binds to any workload or step version (GHI #95) — re-record it at ${path} with its workload and step_digest fields; the review page's high-stakes panel prints the record to commit`,
        );
        continue;
      }
      const parsed = parseConfirmation(raw, { workload, stepId: step.id });
      if ('reason' in parsed) {
        blocked.push(`${step.id}: ${path} is not a valid confirmation record — ${parsed.reason}`);
        continue;
      }
      const verdict = confirmationVerdict(parsed.record, step);
      if (!verdict.ok) blocked.push(`${step.id}: ${verdict.reason}`);
      else if (verdict.note !== null) notes.push(`${step.id}: ${verdict.note}`);
    }
  }

  if (blocked.length > 0) {
    return { id: 'B5', status: 'fail', requirement: 'FR-024', detail: blocked.join('; ') };
  }
  return notes.length > 0
    ? { id: 'B5', status: 'pass', requirement: 'FR-024', detail: notes.join('; ') }
    : { id: 'B5', status: 'pass', requirement: 'FR-024' };
}

/** B6 — a chunk flagged wrong-assumption builds on contradicted ground; the flag
 *  must be reconciled (US5) before any build (FR-022). */
/**
 * B9 — the commit a VERIFY run is about must descend from the frozen plan tag
 * (FR-063, T210).
 *
 * B8 asks the same family of question about a BUILD: did this run start from the
 * approved plan? B9 asks it about a VERIFICATION: is the code you just judged
 * downstream of the plan that was approved? They are different runs at different
 * moments and neither substitutes for the other — which is why B9 is its own gate
 * rather than a widened B8.
 *
 * `identical` PASSES, and that is the compatibility shim in gate form (constitution:
 * Frozen-Artifact Compatibility, route (a)). A build frozen before US18 verified the
 * frozen tree itself and produced no deliverable, so its verify commit IS the tag's
 * commit. Refusing that would make every previously frozen plan permanently
 * unverifiable — the GHI #44/#109 mistake exactly. The shim is narrow: `ahead` and
 * `identical` only. `behind` and `diverged` are refused, because a result about a
 * commit the plan does not lead to is a result about something else entirely.
 */
export async function checkB9VerifyCommitDescends(
  gh: Octokit,
  repo: RepoRef,
  planRef: string,
  commitSha: string,
): Promise<GateResult> {
  const tagSha = await tagTargetSha(gh, repo, planRef);
  if (tagSha === null) {
    return { id: 'B9', status: 'fail', requirement: 'FR-063', detail: `${planRef} has no target commit — nothing to descend from` };
  }
  if (tagSha === commitSha) {
    return {
      id: 'B9',
      status: 'pass',
      requirement: 'FR-063',
      detail:
        `the verified commit IS the frozen commit (${tagSha.slice(0, 8)}) — the legacy binding, accepted for plans ` +
        'frozen before verification was rebound to the deliverable commit (compatibility shim)',
    };
  }
  let status: string;
  try {
    const { data } = await gh.repos.compareCommits({ ...repo, base: tagSha, head: commitSha });
    status = data.status;
  } catch (error: unknown) {
    if (errorStatus(error) === 404) {
      return {
        id: 'B9',
        status: 'fail',
        requirement: 'FR-063',
        detail: `commit ${commitSha.slice(0, 8)} and ${planRef} (${tagSha.slice(0, 8)}) share no history`,
      };
    }
    return asApiUnavailable(error);
  }
  if (status === 'ahead' || status === 'identical') {
    return { id: 'B9', status: 'pass', requirement: 'FR-063', detail: `${commitSha.slice(0, 8)} descends from ${planRef}` };
  }
  return {
    id: 'B9',
    status: 'fail',
    requirement: 'FR-063',
    detail:
      `commit ${commitSha.slice(0, 8)} is "${status}" relative to ${planRef} (${tagSha.slice(0, 8)}), not a descendant. ` +
      'A verification result may only describe code the approved plan led to (FR-063)',
  };
}

export async function checkB6NotFlagged(gh: Octokit, repo: RepoRef, chunkIssue: number): Promise<GateResult> {
  const { data: issue } = await gh.issues.get({ ...repo, issue_number: chunkIssue });
  const labels = (issue.labels ?? []).map((l) => (typeof l === 'string' ? l : (l.name ?? '')));
  return labels.includes(CONTRADICTION_LABEL)
    ? { id: 'B6', status: 'fail', requirement: 'FR-022', detail: `chunk #${chunkIssue} carries flagged:wrong-assumption — reconcile the contradicting evidence before building` }
    : { id: 'B6', status: 'pass', requirement: 'FR-022' };
}

export async function checkB7WorkloadActive(gh: Octokit, repo: RepoRef, slug: string): Promise<GateResult> {
  const workload = await getWorkload(gh, repo, slug);
  if (!workload) {
    return { id: 'B7', status: 'fail', requirement: 'FR-033', detail: `workload not found: ${slug}` };
  }
  return workload.state === 'active'
    ? { id: 'B7', status: 'pass', requirement: 'FR-033' }
    : { id: 'B7', status: 'fail', requirement: 'FR-033', detail: `workload ${slug} is workload:${workload.state}, not active` };
}
