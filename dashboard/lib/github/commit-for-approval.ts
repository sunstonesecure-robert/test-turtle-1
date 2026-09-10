import type { Octokit } from '@octokit/rest';
import type { PlanDoc, PlanStep } from '../../../schemas/plan';
import type { RepoRef } from './client';
import { getAndon } from './andon';
import { openApprovalPr } from './approval';
import {
  createChunksFromSteps,
  deriveWorkItemFromStep,
  findDerivedChunk,
  getChunk,
  listOpenDerived,
  previewDerivedChunkReconciliation,
  type Chunk,
  type CreatedChunk,
  type ReconciliationPreview,
} from './chunks';
import { errorStatus, Refusal } from './errors';
import { reconcileHighStakesRouting } from './high-stakes';
import { commitPlanUpdate, parsePlanRef, tryReadPlanAtRef } from './plans';
import { inexecutableMustTargets } from '../../../scripts/gates/lib/checks-approval';

/**
 * Commit for approval — the one click that turns a judged plan into work items, links
 * and an approval pull request (ADR-0002; GHI #197; decisions D2, D4, D8).
 *
 * WHY ONE ACTION. Before 2026-09-08 the review page had a Link button per step that
 * wrote onto the plan branch at once, and the Approve button opened the pull request;
 * work items were typed by hand on a separate page. Live on `lza-phase0` (2026-09-05)
 * the plan froze with three promised steps tracking nothing, three ready items nobody
 * tracked, and no page said what to do next. The decision was to make the binding a
 * consequence of committing the plan: every row on the Work items section states what
 * the step will track — an inherited item, one created from the step, or one of this
 * workload's own unbound items — and the commit creates the pending items, writes every
 * `tracking_issue` in ONE plan commit, then opens the pull request. A refusal names the
 * step and writes nothing.
 *
 * WHY THIS MODULE HAS NO REACT AND NO NEXT. `app/actions.ts` is a `'use server'` module
 * and cannot be driven from a vitest suite; the property that matters most here —
 * nothing written before every row is valid, and a resubmit creating nothing new — has
 * to be provable against the GitHub mock. So the form parsing and the orchestration
 * live here, and the server action is a thin caller.
 */

/** What one plan step will track once the commit lands — the operator's row choice. */
export type WorkItemChoice =
  /** the step already tracks an item (inherited from the prior version, D8) */
  | { stepId: string; mode: 'inherited'; issueNumber: number }
  /** create the item from the step at commit; `outcomeMetric` is the operator's text
   *  for a step no verification target names ('' otherwise — the plan supplies it) */
  | { stepId: string; mode: 'create'; outcomeMetric: string }
  /** bind one of this workload's own unbound items */
  | { stepId: string; mode: 'link'; issueNumber: number }
  /** an optional (SHOULD/COULD) step the operator did not opt in — tracks nothing */
  | { stepId: string; mode: 'none' };

/**
 * The form field names, derived from the step id so the review page and the parser
 * cannot drift. `mode` carries `create`, `none` or `link:<issue>`; `optIn` is the
 * SHOULD/COULD checkbox (its ABSENCE means "no work item", the browser's contract for an
 * unchecked box); `metric` is the operator-typed outcome metric.
 */
export const workItemField = {
  mode: (stepId: string) => `wi-mode-${stepId}`,
  optIn: (stepId: string) => `wi-optin-${stepId}`,
  metric: (stepId: string) => `wi-metric-${stepId}`,
} as const;

/**
 * One choice per step, in plan order, from the submitted form.
 *
 * A step with an inherited binding is `inherited` unless the form carries a mode for
 * it — the page offers a mode only when the inherited number does not resolve to a work
 * item, so an operator can repair it; a hand-crafted POST can also rebind, and every
 * rebinding is re-verified against live state in `commitForApproval`, never trusted from
 * here. A step with NO form field falls back to the default the page rendered: a MUST
 * step is created from the step (D4 — it must track something), an optional step tracks
 * nothing. Only a malformed mode value is a refusal here; everything about GitHub state
 * is the commit's business.
 */
export function readWorkItemChoices(plan: PlanDoc, formData: FormData): WorkItemChoice[] {
  return plan.steps.map((step): WorkItemChoice => {
    const rawMode = formData.get(workItemField.mode(step.id));
    const optedIn = step.priority === 'MUST' || formData.has(workItemField.optIn(step.id));
    if (rawMode === null) {
      if (typeof step.tracking_issue === 'number') return { stepId: step.id, mode: 'inherited', issueNumber: step.tracking_issue };
      return optedIn
        ? { stepId: step.id, mode: 'create', outcomeMetric: String(formData.get(workItemField.metric(step.id)) ?? '').trim() }
        : { stepId: step.id, mode: 'none' };
    }
    if (!optedIn) return { stepId: step.id, mode: 'none' };
    const mode = String(rawMode);
    if (mode === 'create') {
      return { stepId: step.id, mode: 'create', outcomeMetric: String(formData.get(workItemField.metric(step.id)) ?? '').trim() };
    }
    if (mode === 'none') return { stepId: step.id, mode: 'none' };
    const link = /^link:(\d+)$/.exec(mode);
    if (link && Number(link[1]) > 0) return { stepId: step.id, mode: 'link', issueNumber: Number(link[1]) };
    throw new Refusal(
      `"${mode}" is not a choice for step ${step.id} — pick "create from this step" or one of the unbound work items, then commit again`,
    );
  });
}

/** The steps the preview may count as tracked (G17, D6 amendment): everything but `none`. */
export function boundStepIds(choices: WorkItemChoice[]): string[] {
  return choices.filter((c) => c.mode !== 'none').map((c) => c.stepId);
}

export interface CommitForApprovalInput {
  andonIssue: number;
  choices: WorkItemChoice[];
  actor: string;
  at: string;
}

export interface CommitForApprovalResult {
  planRef: string;
  pr: { number: number; url: string };
  /** items this commit CREATED (a reused derived item is not listed here) */
  created: CreatedChunk[];
  /** every binding the commit wrote onto the plan that was not there before */
  linked: { stepId: string; issueNumber: number }[];
  /** existing items the FREEZE will rewrite from a changed step (D8; GHI #212) — read
   *  here, written by `freezeApprovedPlan` once the version is official. An item that
   *  already says what its step says is not listed */
  willReconcile: ReconciliationPreview[];
}

/** 404-only tolerance, the review page's rule: a number naming no issue is `null`;
 *  an unreadable issue is a fault, because unreadable is not absent (GHI #150). */
async function chunkOrNull(gh: Octokit, repo: RepoRef, issueNumber: number): Promise<Chunk | null> {
  try {
    return await getChunk(gh, repo, issueNumber);
  } catch (error: unknown) {
    if (errorStatus(error) === 404) return null;
    throw error;
  }
}

function stepLabel(step: PlanStep): string {
  return `step "${step.id}" (${step.title})`;
}

/**
 * The governed action, in order: validate every row → create the pending items →
 * write every link in one plan commit → open the approval pull request.
 *
 * REFUSED BEFORE ANY WRITE when: the review is not live; a MUST step would track
 * nothing; an inherited or linked number is not a ready work item of this workload
 * (an inherited number whose marker names ANOTHER workload included — the
 * reconciliation pass would otherwise rewrite that workload's item);
 * two rows would resolve to one item (B3's one-step-per-item rule, G13) — a `create`
 * row counts by the item ALREADY derived for its step, when there is one, so a repair
 * that re-creates step A while another row links A's existing item is caught here and
 * not by the pull request's gate two clicks later; two open items are derived for one
 * step (`findDerivedChunk` names both); a MUST-mapped target has no run command (G18
 * would refuse the pull request, so no item is minted for a plan that cannot be
 * approved); or a created step has no outcome metric — that last one is
 * `createChunksFromSteps`'s own refusal, raised before it writes.
 *
 * WILL RECONCILE (D8 as amended 2026-09-08, E4; timing per GHI #212): every EXISTING
 * item the commit binds — inherited, linked, or found already derived for a `create`
 * row — is compared to what its step now derives, and the ones that no longer match
 * are REPORTED, not rewritten. The rewrite (in place, an event naming the version, the
 * stale `intent:confirmed` cleared) is the freeze's: until the approval merges, the
 * previous version is still official and its items must keep saying what it said.
 * Inheritance is not staleness — and a review is not an approval.
 *
 * IDEMPOTENT ON RESUBMIT. `createChunksFromSteps` finds the item already derived for a
 * step by its marker and reuses it; a matching item is not rewritten; a plan whose
 * links are already what the rows say is not rewritten; `openApprovalPr` returns the
 * open pull request rather than a second; and the routing labels are reconciled on
 * every pass, not only the one that wrote the plan, so a retry after a crash between
 * the plan commit and the label pass still lands them. So a double click, or a retry
 * after a partial failure, converges on the same three records.
 */
export async function commitForApproval(gh: Octokit, repo: RepoRef, input: CommitForApprovalInput): Promise<CommitForApprovalResult> {
  const andon = await getAndon(gh, repo, input.andonIssue);
  if (!andon.labels.includes('andon:open') && !andon.labels.includes('andon:under-review')) {
    throw new Refusal(
      `Review #${input.andonIssue} is closed (${andon.labels.join(', ') || 'no state'}) — committing for approval writes onto the plan, and this review is over. An approved plan changes through Re-open; a withdrawn one through a fresh proposal`,
    );
  }
  const planRef = andon.planRef;
  const parsedRef = parsePlanRef(planRef);
  if (!parsedRef) throw new Error(`review #${input.andonIssue} names "${planRef}", which is not a plan ref`);
  const { plan, errors } = await tryReadPlanAtRef(gh, repo, planRef);
  if (!plan) {
    throw new Refusal(
      `the plan file on ${planRef} does not match its required shape (${errors.join('; ')}) — nothing can be committed until the agent's revision makes it valid`,
    );
  }
  const stepsById = new Map(plan.steps.map((s) => [s.id, s]));

  // ---- validate every row, writing nothing ----
  const problems: string[] = [];
  const claimedBy = new Map<number, string>();
  const claim = (issueNumber: number, step: PlanStep): void => {
    const other = claimedBy.get(issueNumber);
    if (other) problems.push(`#${issueNumber} is named by both ${other} and ${step.id} — one work item delivers one step; pick a different item for one of them`);
    else claimedBy.set(issueNumber, step.id);
  };
  const seen = new Set<string>();
  // This workload's open derived items, listed ONCE for every `create` row below.
  const derived = await listOpenDerived(gh, repo, parsedRef.slug);
  // The item each existing-item row binds — what the reconciliation pass reads.
  const existing: Array<{ step: PlanStep; issueNumber: number }> = [];
  for (const choice of input.choices) {
    const step = stepsById.get(choice.stepId);
    if (!step) {
      problems.push(`step "${choice.stepId}" is not in ${planRef}`);
      continue;
    }
    seen.add(step.id);
    if (choice.mode === 'none') {
      if (step.priority === 'MUST') {
        problems.push(`${stepLabel(step)} is promised (MUST) but would track no work item — create one from the step or link an unbound item`);
      }
      continue;
    }
    if (choice.mode === 'create') {
      // Derivation completeness is createChunksFromSteps's refusal. What IS judged
      // here is the item the create will REUSE: `createChunksFromSteps` finds one
      // already derived for the step and binds it, so it takes part in the
      // one-item-one-step check like any other row (or the refusal would come from
      // the pull request's gate, after everything was written).
      try {
        const reused = await findDerivedChunk(gh, repo, planRef, step.id, { hint: step.tracking_issue ?? null, derived });
        if (reused) {
          claim(reused.issueNumber, step);
          existing.push({ step, issueNumber: reused.issueNumber });
        }
      } catch (error: unknown) {
        if (error instanceof Refusal) problems.push(error.message);
        else throw error;
      }
      continue;
    }
    const item = await chunkOrNull(gh, repo, choice.issueNumber);
    const role = choice.mode === 'inherited' ? 'inherits' : 'would link';
    if (item === null) {
      problems.push(`${stepLabel(step)} ${role} #${choice.issueNumber}, which is not a work item (it carries no work-item label) — create one from the step or link an unbound item`);
      continue;
    }
    if (item.state !== 'ready') {
      problems.push(`${stepLabel(step)} ${role} #${choice.issueNumber}, which still carries the retired title-only label — write its requirement (Workloads page, unbound work items) or create one from the step`);
      continue;
    }
    const ownerSlug = item.derivedFrom ? parsePlanRef(item.derivedFrom.planRef)?.slug : undefined;
    if (choice.mode === 'link' && ownerSlug !== parsedRef.slug) {
      // The select offers this workload's own items only; a POST naming any other is
      // refused here rather than judged by G14 on the pull request two clicks later.
      problems.push(`${stepLabel(step)} would link #${choice.issueNumber}, which is not one of this workload's own work items — link only an item derived for ${parsedRef.slug}, or create one from the step`);
      continue;
    }
    if (choice.mode === 'inherited' && item.derivedFrom && ownerSlug !== parsedRef.slug) {
      // An inherited number is the plan's own word, but the plan branch is writable by
      // the agent and by hand, and the reconciliation pass below REWRITES every bound
      // derived item to this step. Accepting a number derived for another workload
      // would rewrite that workload's item in this one's name (PR #204 review, P1). A
      // marker-less inherited item is still allowed: it is a legacy hand-typed issue
      // nothing claims, and the reconciliation leaves it exactly as it is.
      problems.push(
        `${stepLabel(step)} inherits #${choice.issueNumber}, which was derived for workload ${ownerSlug ?? 'unknown'}, not ${parsedRef.slug} — a step tracks only its own workload's items. Re-open the plan and bind the step to one of ${parsedRef.slug}'s items: create one from the step, or link an unbound item derived for it`,
      );
      continue;
    }
    claim(choice.issueNumber, step);
    existing.push({ step, issueNumber: choice.issueNumber });
  }
  for (const step of plan.steps) {
    if (!seen.has(step.id)) problems.push(`${stepLabel(step)} has no row — reload the review and commit again`);
  }
  if (problems.length > 0) {
    throw new Refusal(`nothing was committed — ${problems.join('; ')}`);
  }
  // A promised step's check with no command freezes as a target the build never runs;
  // the pull request's gate refuses it, so no work item is minted for it here.
  const inexecutable = inexecutableMustTargets(plan);
  if (inexecutable.length > 0) {
    throw new Refusal(
      `nothing was committed — ${inexecutable
        .map(({ vtId, mustStepIds }) => `check ${vtId} (for promised step ${mustStepIds.join(', ')}) has no run command`)
        .join('; ')}. Add the command that proves each check under Set scope & targets, or lower the step's priority, then commit again`,
    );
  }

  // ---- create the pending items (refuses, naming each step, before its first write) ----
  const toCreate = input.choices.filter((c): c is Extract<WorkItemChoice, { mode: 'create' }> => c.mode === 'create');
  const createdOrReused = await createChunksFromSteps(gh, repo, {
    planRef,
    plan,
    steps: toCreate.map((c) => ({ stepId: c.stepId, outcomeMetric: c.outcomeMetric })),
    actor: input.actor,
    at: input.at,
  });

  // ---- what the FREEZE will do to the existing items (D8; GHI #212) — read, not written ----
  // Every item the commit binds that it did not just create: the validation pass
  // collected the inherited, linked and to-be-reused ones. A freshly created item
  // already carries its step's text. Nothing is rewritten here: the version under
  // review is not official until its approval merges, and the item it inherits still
  // belongs to the version that IS — `freezeApprovedPlan` performs the rewrite.
  const willReconcile: ReconciliationPreview[] = [];
  for (const { step, issueNumber } of existing) {
    const preview = await previewDerivedChunkReconciliation(gh, repo, { issueNumber, plan, step });
    if (preview.requirementChanges || preview.titleChanges) willReconcile.push(preview);
  }

  // ---- one plan commit carrying every link ----
  const wanted = new Map<string, number | null>();
  for (const choice of input.choices) {
    if (choice.mode === 'none') wanted.set(choice.stepId, null);
    else if (choice.mode === 'create') wanted.set(choice.stepId, createdOrReused.find((c) => c.stepId === choice.stepId)!.issueNumber);
    else wanted.set(choice.stepId, choice.issueNumber);
  }
  const linked: { stepId: string; issueNumber: number }[] = [];
  const touched: (number | null)[] = [];
  // Every number the plan names before or after — the routing pass below reads them
  // all, so a retry that finds the links already written still lands the labels.
  const routed: (number | null)[] = [];
  for (const step of plan.steps) {
    const before = step.tracking_issue ?? null;
    const after = wanted.get(step.id) ?? null;
    routed.push(before, after);
    if (before === after) continue;
    touched.push(before, after);
    if (after !== null) linked.push({ stepId: step.id, issueNumber: after });
  }
  let bound = plan;
  if (touched.length > 0) {
    bound = await commitPlanUpdate(gh, repo, {
      planRef,
      message: () =>
        `plan: bind work items at commit for approval (${linked.map((l) => `${l.stepId} → #${l.issueNumber}`).join(', ') || 'unbind optional steps'}) by @${input.actor} at ${input.at} (FR-017)`,
      mutate: (current) => ({
        ...current,
        steps: current.steps.map((s) => (wanted.has(s.id) ? { ...s, tracking_issue: wanted.get(s.id) ?? null } : s)),
      }),
    });
  }
  // The routing label follows the binding (PR #111 review): an item newly bound to a
  // flagged step must carry `high-stakes:<authority>`, and one released must not.
  // Run on EVERY pass, not only the one that wrote the plan: a retry after a crash
  // between the plan commit and this line finds `touched` empty, and a label pass
  // gated on it would never run — leaving a flagged step's new item unrouted while
  // the banner says the commit converged. Idempotent (add if missing, remove if
  // present), so the clean-retry cost is a read per bound item.
  await reconcileHighStakesRouting(gh, repo, bound, routed);

  const pr = await openApprovalPr(gh, repo, { slug: parsedRef.slug, version: parsedRef.version });
  return { planRef, pr, created: createdOrReused.filter((c) => c.created), linked, willReconcile };
}

/** The outcome metric the plan supplies for a step, or '' — the row shows a field then. */
export function planSuppliedMetric(plan: PlanDoc, step: PlanStep): string {
  return deriveWorkItemFromStep(plan, step).outcomeMetric;
}
