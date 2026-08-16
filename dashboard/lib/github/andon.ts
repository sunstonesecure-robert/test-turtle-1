import type { Octokit } from '@octokit/rest';
import type { RepoRef } from './client';
import type { PlanDoc } from '../../../schemas/plan';
import { errorStatus } from './errors';
// Static import that closes an import cycle: corrections.ts statically imports
// getAndon from here, so andon.ts ↔ corrections.ts is circular. The cycle is
// safe because neither binding is touched at module-evaluation time — both are
// referenced only inside function bodies — so ESM's live bindings are populated
// well before the first call. (Not a dynamic import(); it need not be, and the
// getAndon side is static too — a lone dynamic edge would not break the cycle.)
import { withdrawOpenCorrections } from './corrections';
import {
  parseAndonHeader,
  parseCorrectionMarker,
  parseJudgmentItems,
  serializeAndonHeader,
  serializeJudgmentItem,
  checkJudgmentItem,
  type JudgmentItem,
} from './markers';

/**
 * Andon-break module (tracer surface of T037/T042/T043): create the labeled
 * Andon issue for a proposed plan, open it (open → under-review), judge items ✓.
 * Corrections (✗ path) arrive with the first expansion increment — not the tracer.
 */

export interface AndonBreak {
  issueNumber: number;
  runId: string;
  planRef: string;
  items: JudgmentItem[];
  labels: string[];
}

export function renderAndonBody(plan: PlanDoc, planRef: string): string {
  const items: JudgmentItem[] = [
    ...plan.boundary_cases.map((bc) => ({ id: bc.id, description: bc.description, judged: false })),
  ];
  return [
    serializeAndonHeader({ runId: plan.run_id, planRef }),
    '## Proposed plan',
    `Plan branch: \`${planRef}\` (plan.json)`,
    '',
    '## Judgments required',
    ...items.map(serializeJudgmentItem),
  ].join('\n');
}

/** Agent side (safe output create-issue in production): raise the Andon break. */
export async function createAndonIssue(
  gh: Octokit,
  repo: RepoRef,
  input: { slug: string; plan: PlanDoc; planRef: string },
): Promise<number> {
  const { data: issue } = await gh.issues.create({
    ...repo,
    title: `Andon break: validate plan ${input.planRef}`,
    body: renderAndonBody(input.plan, input.planRef),
    labels: ['andon:open'],
  });
  return issue.number;
}

export async function getAndon(gh: Octokit, repo: RepoRef, issueNumber: number): Promise<AndonBreak> {
  const { data: issue } = await gh.issues.get({ ...repo, issue_number: issueNumber });
  const header = parseAndonHeader(issue.body ?? '');
  if (!header) throw new Error(`issue #${issueNumber} has no andon:v1 header`);
  return {
    issueNumber,
    runId: header.runId,
    planRef: header.planRef,
    items: parseJudgmentItems(issue.body ?? ''),
    labels: (issue.labels ?? []).map((l) => (typeof l === 'string' ? l : (l.name ?? ''))),
  };
}

/**
 * Operator opens the break: andon:open → andon:under-review (FR-003).
 * Idempotent — already under review is a no-op (double submit, stale inbox);
 * a resolved break is refused rather than silently resurrected.
 * Crash-safe ordering (GHI #48, the withdrawProposal pattern): the target
 * label is ADDED before the live one is dropped, so a partial failure never
 * leaves the break with no andon:* label — a state no retry could recognize
 * as openable, wedging the review permanently.
 */
export async function openAndon(gh: Octokit, repo: RepoRef, issueNumber: number): Promise<void> {
  const { data: issue } = await gh.issues.get({ ...repo, issue_number: issueNumber });
  const labels = (issue.labels ?? []).map((l) => (typeof l === 'string' ? l : (l.name ?? '')));
  if (labels.includes('andon:under-review')) {
    // Not a bare return: a prior attempt may have added under-review and then
    // failed before dropping andon:open — finish that teardown to converge.
    if (labels.includes('andon:open')) {
      try {
        await gh.issues.removeLabel({ ...repo, issue_number: issueNumber, name: 'andon:open' });
      } catch (error: unknown) {
        // 404 only — the label already gone means someone else finished the
        // teardown. Anything else fails loudly: a swallowed 5xx would report
        // success while the stale label lingers, and a caller told "done"
        // never retries (PR #51 review).
        if (errorStatus(error) !== 404) throw error;
      }
    }
    return;
  }
  if (!labels.includes('andon:open')) {
    throw new Error(`Andon #${issueNumber} is not open for review (labels: ${labels.join(', ') || 'none'})`);
  }
  await gh.issues.addLabels({ ...repo, issue_number: issueNumber, labels: ['andon:under-review'] });
  try {
    await gh.issues.removeLabel({ ...repo, issue_number: issueNumber, name: 'andon:open' });
  } catch (error: unknown) {
    // TOCTOU: a concurrent open won the race and already removed the label —
    // the same no-op as the under-review check above.
    if (errorStatus(error) !== 404) throw error;
  }
}

/** Operator judges one item ✓ (task-list PATCH). Questions are refused: a
 *  q- item's ✓ comes ONLY through a recorded answer:v1 (recordAnswer) — the
 *  dashboard hides the plain ✓ for questions, and this guard stops a replayed
 *  form POST from checking one without an answer (it would pass the UI's
 *  allJudged and open an approval PR that plan-gate G11 then fails). */
export async function judgeItem(gh: Octokit, repo: RepoRef, issueNumber: number, itemId: string): Promise<void> {
  if (itemId.startsWith('q-')) {
    throw new Error(`question item ${itemId} is answered, not judged ✓ — record an answer instead (FR-055)`);
  }
  const { data: issue } = await gh.issues.get({ ...repo, issue_number: issueNumber });
  const updated = checkJudgmentItem(issue.body ?? '', itemId);
  if (updated === null) throw new Error(`judgment item ${itemId} not found on Andon #${issueNumber}`);
  await gh.issues.update({ ...repo, issue_number: issueNumber, body: updated });
}

/** The LIVE Andon break (open or under-review — both are in-flight reviews;
 *  a review the operator has picked up must still be findable) whose header
 *  references this plan ref; null when none. The labels param is AND-semantic,
 *  so the two states need two queries. */
export async function findOpenAndonByPlanRef(gh: Octokit, repo: RepoRef, planRef: string): Promise<number | null> {
  for (const label of ['andon:open', 'andon:under-review']) {
    const breaks = await gh.paginate(gh.issues.listForRepo, { ...repo, labels: label, state: 'open', per_page: 100 });
    const match = breaks.find((issue) => parseAndonHeader(issue.body ?? '')?.planRef === planRef);
    if (match) return match.number;
  }
  return null;
}

/** Every LIVE break (open or under-review) belonging to a workload — matched
 *  by the slug-anchored plan ref in the andon:v1 header (plan/<slug>/v<N>),
 *  the key that keeps parallel workloads independent (FR-044): one workload's
 *  cancel can never close another workload's break. Ascending issue order. */
export async function findLiveAndonsBySlug(gh: Octokit, repo: RepoRef, slug: string): Promise<number[]> {
  const versionRe = new RegExp(`^plan/${slug}/v\\d+$`);
  // The two live-label LISTs are independent reads — queried concurrently
  // (labels is AND-semantic, so they can't be one call); the Set dedupes and
  // the sort keeps the result deterministic.
  const pages = await Promise.all(
    ['andon:open', 'andon:under-review'].map((label) =>
      gh.paginate(gh.issues.listForRepo, { ...repo, labels: label, state: 'open', per_page: 100 }),
    ),
  );
  const found = new Set<number>();
  for (const issue of pages.flat()) {
    const header = parseAndonHeader(issue.body ?? '');
    if (header && versionRe.test(header.planRef)) found.add(issue.number);
  }
  return [...found].sort((a, b) => a - b);
}

/**
 * Withdraw a plan proposal (T198, FR-057/FR-058): the operator ends the review
 * WITHOUT approving. A live break (andon:open or andon:under-review) becomes
 * andon:superseded and is closed — the record is retained, never deleted
 * (FR-042) — and every open correction linked to it cascades to withdrawn with
 * the cause recorded, so no correction:open outlives its break. The WORKLOAD is
 * untouched: withdrawal supersedes the proposal, not the work item — the agent
 * may propose a fresh, higher version (abandoned versions are never reused,
 * FR-058). Idempotent on an already-superseded break (double submit). A
 * resolved (approved) break is refused: genuine change to a frozen plan is an
 * open re-open, not a withdrawal (FR-008). The G12 intent-drift gate that also
 * consumes this state is deferred (GHI #28) — nothing here gates on it.
 */
export async function withdrawProposal(
  gh: Octokit,
  repo: RepoRef,
  issueNumber: number,
  input: { by: string; at: string; cause: string },
): Promise<void> {
  const cause = input.cause.trim();
  if (cause.length === 0) {
    throw new Error('withdrawal refused: a cause must be recorded (issue-tracker-contract.md §Andon Break)');
  }
  const andon = await getAndon(gh, repo, issueNumber); // throws if the issue is not an Andon break
  if (andon.labels.includes('andon:superseded')) {
    // Idempotent — already withdrawn (double submit). Not a bare return: a prior
    // attempt may have set the terminal label and then failed before dropping
    // the live labels or closing, so finish that teardown to converge. No second
    // cascade or comment — those already ran on the attempt that superseded it.
    await dropLiveLabelsAndClose(gh, repo, issueNumber);
    return;
  }
  if (andon.labels.includes('andon:resolved')) {
    throw new Error(
      `Andon #${issueNumber} is resolved (approved) — a frozen plan changes only through an open re-open, not withdrawal (FR-008)`,
    );
  }
  if (!andon.labels.includes('andon:open') && !andon.labels.includes('andon:under-review')) {
    throw new Error(`Andon #${issueNumber} is not a live break (labels: ${andon.labels.join(', ') || 'none'}) — nothing to withdraw`);
  }

  // Cascade first: no correction:open may outlive its break (data-model "Correction").
  await withdrawOpenCorrections(gh, repo, issueNumber, {
    by: input.by,
    at: input.at,
    cause: `Andon #${issueNumber} proposal withdrawn: ${cause}`,
  });

  // Attributed, human-visible audit line on the break's timeline (marker-less —
  // nothing parses or gates on it; the G12 gate is deferred to GHI #28).
  await gh.issues.createComment({
    ...repo,
    issue_number: issueNumber,
    // Blockquote continuation so a multi-line cause renders fully on GitHub.
    body: `**Proposal withdrawn** (superseded) by @${input.by} at ${input.at}\n> ${cause.replace(/\n/g, '\n> ')}`,
  });

  // Add the terminal label BEFORE dropping the live ones: if the teardown fails
  // partway, the break is never left with no andon:* label — a state a retry
  // could not recognize as withdrawable, orphaning the issue. Once superseded is
  // present, the idempotent branch above recovers any partial failure here. Then
  // drop the live labels and close (retained, not locked — the break stays a
  // searchable record; closure is never deletion, FR-042).
  await gh.issues.addLabels({ ...repo, issue_number: issueNumber, labels: ['andon:superseded'] });
  await dropLiveLabelsAndClose(gh, repo, issueNumber);
}

/** Teardown tail shared by every terminal closure — withdrawProposal here,
 *  freezeApprovedPlan in plans.ts — and their crash-recovery retries: drop the
 *  live andon:* labels and close the issue. Callers add their terminal label
 *  FIRST (GHI #48 ordering), so a partial failure never leaves the break
 *  label-less. removeLabel 404s are swallowed — at most one live label is
 *  normally present, so the other's absence is the EXPECTED case — but any
 *  other failure propagates: the terminal label is already on, so the
 *  caller's retry re-enters here and converges, whereas a swallowed 5xx
 *  would report success with a stale live label stranded (PR #51 review).
 *  Closing an already-closed issue is a no-op. */
export async function dropLiveLabelsAndClose(gh: Octokit, repo: RepoRef, issueNumber: number): Promise<void> {
  for (const stale of ['andon:open', 'andon:under-review']) {
    try {
      await gh.issues.removeLabel({ ...repo, issue_number: issueNumber, name: stale });
    } catch (error: unknown) {
      if (errorStatus(error) !== 404) throw error;
    }
  }
  await gh.issues.update({ ...repo, issue_number: issueNumber, state: 'closed' });
}

/** Open corrections linked to this Andon (G7 input) — matched via the machine-readable
 *  correction:v1 marker, not substring (andon:12 must not match andon:123). */
export async function openCorrectionCount(gh: Octokit, repo: RepoRef, andonIssue: number): Promise<number> {
  // Paginated: undercounting past page one would let plan-gate G7 pass with corrections open.
  const data = await gh.paginate(gh.issues.listForRepo, { ...repo, labels: 'correction:open', state: 'open', per_page: 100 });
  return data.filter((issue) => parseCorrectionMarker(issue.body ?? '')?.andonIssue === andonIssue).length;
}
