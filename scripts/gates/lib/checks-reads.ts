import { posix } from 'node:path';
import {
  contextCovers,
  CONTEXT_FOLDERS,
  type DeclaredContext,
} from '../../../dashboard/lib/github/context-paths';
import type { PlanDoc } from '../../../schemas/plan';
import { globCovers, isRepoRelative, matchesAny, normalizePath } from './globs';
import type { GateResult } from './runner';

/**
 * G20 and G21 — the READ side of a plan step (FR-071; GHI #274).
 *
 * A step declares what its deliverable may WRITE (`scope`, enforced by G16 at approval
 * and D2 at delivery) and, until now, nothing about what it must READ. What it must
 * read lived only as English in `acceptance` — which is exactly where `vendor/lza` was
 * on the run that cost a build (2026-09-17, run 35236838549, work item #113: the agent
 * behaved correctly, found nothing, emitted `missing_data`, and B1 through B8 all
 * passed, because not one of them asks whether the thing an acceptance points at will
 * be there).
 *
 * THE ASYMMETRY THIS CLOSES. The harness already knows how to ask "does this path
 * exist?". It asks it in exactly one place — of the lines the OPERATOR types into a
 * workload's `### Context` (FR-053, `scripts/intake-normalize.ts`) — and asks it of
 * nothing the agent writes. These two gates ask it of what the agent writes.
 *
 * TWO IDS BECAUSE TWO REMEDIES. G20's remedy belongs to the plan: provide the source,
 * or take the read out of the step. G21's belongs to the operator: designate the path
 * on the workload, or stop referring to it. Folding them would make one amber row mean
 * two different fixes, which is the rule G17 and G18 were split on.
 *
 * BOTH ADVISORY, NEVER A REFUSAL. A plan may legitimately name a path a later step
 * delivers, and the operator is the one who knows (ADR-0007: the harness names a risk
 * before the click, it does not withhold the button). The obvious stronger rule — *an
 * agent may only reference paths the operator declared* — cannot work, for three
 * reasons: `### Context` cannot even express the subject's own source tree; Context
 * feeds the PLANNING agent and the build agent never sees it; and a build step must
 * read the repository it is editing.
 *
 * TWO HALVES, AND ONLY ONE OF THEM IS PURE — the split `checks-approval.ts` makes for
 * G17 and G19, for the same reason: the review page runs these very functions on every
 * render (`gate-preview.ts`) and cannot call GitHub. What differs here, and is the
 * whole of this module's care: for G19 the pure half still finds real defects alone,
 * whereas NEITHER of these can answer its central question without the repository. So
 * neither ever returns a bare `pass` on the pure path. A check that could not ask
 * reports `not-applicable` and names the question that went unasked. An advisory silent
 * about the half it could not run is a lie by omission — and "an absent check reading
 * as a passing one" is the class this whole issue is about.
 *
 * THIS MODULE IS REACHABLE FROM `dashboard/app` (page → gate-preview → here), so it
 * imports no `node:fs`, no Octokit client and nothing carrying `import.meta.url`. The
 * repository half lives in `reads-providers.ts` and is imported only by `plan-gate.ts`
 * — it reaches `scripts/materialize-vendor.ts`, whose entry guard uses
 * `import.meta.url`, and `tests/unit/dashboard-bundle-boundary.test.ts` fails the day
 * a page can reach it.
 */

/**
 * What a caller learned from the repository, or why it learned nothing.
 *
 * `{ read: false }` is NOT an empty problem list. One means "asked, and found nothing
 * wrong"; the other means "did not ask". Collapsing them is the characteristic failure
 * of a surface-don't-enforce design and this codebase has shipped it once already.
 */
export type RepositoryAnswer =
  | {
      read: true;
      problems: readonly string[];
      /**
       * `<stepId>\0<glob>` for each declared read the tree ALREADY HOLDS at the approval
       * ref. Only the repository half can know this, and the ordering clause below needs
       * it: a read that is already there does not wait on the step that will later edit
       * it, so reporting an ordering risk about it is a true sentence about the wrong
       * thing (Codex on PR #277). Absent on the preview, where nothing was looked up.
       */
      presentAtRef?: readonly string[];
    }
  | { read: false; why: string };

/** Why the review page's own render cannot answer G20's central question. */
export const PREVIEW_NO_REPOSITORY =
  'This screen does not read the repository, so it has only checked what the plan says about itself. ' +
  'The approval check also asks, of every path a step says it reads, whether the tree will hold it and ' +
  'whether a lock file will fetch it.';

/** Why the review page's own render cannot answer G21's central question. */
export const PREVIEW_NO_WORKLOAD =
  'This screen does not read the workload issue, so it cannot tell which context the operator designated. ' +
  'The approval check does, and its answer arrives on the approval pull request.';

const G20_TAIL =
  'this does not block approval: a plan may name a path the operator knows will be there, and the operator ' +
  'is the one who knows. Send it back as a correction, or approve it as it stands — it is cheaper to fix ' +
  'here than after the freeze, where the only remedy is a re-open.';

const G21_TAIL =
  "this does not block approval. Add the path to the workload's Context, or take the reference out of the " +
  'plan; an agent that was never handed a source is working from memory.';

/* ------------------------------------------------------------------ *
 * The prose extractor — increment 1's hard half
 * ------------------------------------------------------------------ */

/**
 * Path-shaped tokens in a sentence a planning agent wrote.
 *
 * DELIBERATELY NARROW, AND CALIBRATED TO AN ADVISORY. A false positive here costs one
 * amber line on a review page beside an enabled button; a false NEGATIVE costs a build.
 * So the grammar leans toward reading, but it still refuses everything it cannot be
 * confident is a path:
 *
 *   • A token must contain a `/` and a segment after it. `specs` alone is the English
 *     word; `the specs/ folder` is prose about a folder, not a designation, and a
 *     trailing-slash-only token is dropped.
 *   • Sentence punctuation is stripped from the end — `.`, `,`, `;`, `:`, `)`, `]`,
 *     `"`, `'` — because a path at the end of a sentence carries the sentence's period.
 *     A `:12` line reference is stripped too; that is how this house cites a file.
 *   • A backtick span contributes its whitespace-separated words, because an acceptance
 *     quotes both bare paths and whole commands in backticks.
 *   • A URL, an absolute path, a drive letter, a `..` escape and a glob are all
 *     refused. A glob is a class of files and a Context line is a concrete path, so a
 *     glob could never be matched against a designation anyway.
 *
 * Only tokens whose first segment is one of the four special context folders survive
 * the caller's filter — that is what makes this decidable against a list that exists.
 */
export function pathTokens(text: string): string[] {
  // Brackets and parentheses are SEPARATORS, not trim characters: a markdown link is
  // `[label](path)`, so the path is glued to the label by `](` and stripping only the
  // ends of a whitespace-delimited word leaves `label](path`.
  const words = text.split(/[\s`()[\]]+/).filter((w) => w.length > 0);
  const out: string[] = [];
  for (const word of words) {
    // Markdown wrapping and sentence punctuation, from both ends.
    let t = word.replace(/^[<"'*_]+/, '').replace(/[>"',;:.*_]+$/, '');
    // `path:12` and `path:12-20` — a line citation, not part of the path.
    t = t.replace(/:\d+(-\d+)?$/, '');
    if (t.length === 0) continue;
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(t)) continue; // a URL
    if (/[*?[\]{}]/.test(t)) continue; // a glob names a class, a designation names a path
    if (!t.includes('/')) continue; // a bare word is English
    if (t.endsWith('/')) continue; // "the specs/ folder" is prose about a folder
    if (!isRepoRelative(t)) continue; // absolute, drive-lettered, or escaping
    out.push(normalizePath(t));
  }
  return [...new Set(out)];
}

/** Where in the plan a path was named — operator-readable, never an internal id. */
export interface ClaimedPath {
  /** e.g. "step-config's acceptance" or "the boundary case bc-config-keys-from-source" */
  where: string;
  path: string;
  /**
   * Every step whose scope could make this path an OUTPUT rather than a claimed input.
   * A verification target maps to a LIST of steps, and taking only the first reported a
   * path the second step writes as undeclared context (Codex on PR #277).
   */
  stepIds: string[];
}

/** Every SPECIAL-FOLDER path this plan's prose names, with where it was named. */
export function claimedContextPaths(plan: PlanDoc): ClaimedPath[] {
  const found: ClaimedPath[] = [];
  const add = (where: string, stepIds: string[], text: string): void => {
    for (const path of pathTokens(text)) {
      if (!CONTEXT_FOLDERS.includes(posix.normalize(path).split('/')[0] ?? '')) continue;
      found.push({ where, path, stepIds });
    }
  };
  for (const step of plan.steps) {
    add(`${step.id}'s title`, [step.id], step.title);
    add(`${step.id}'s intent`, [step.id], step.intent);
    add(`${step.id}'s acceptance`, [step.id], step.acceptance);
  }
  for (const bc of plan.boundary_cases) add(`the boundary case ${bc.id}`, bc.step_id === undefined ? [] : [bc.step_id], bc.description);
  // Same shape, same scan: a state transition is prose the operator judges, and prose
  // that names `specs/…` is claiming context whether it sits in a boundary case or a
  // transition (Codex on PR #290 — the field was new and this reader was not told).
  for (const st of plan.state_transitions ?? [])
    add(`the state transition ${st.id}`, st.step_id === undefined ? [] : [st.step_id], st.description);
  // EVERY mapped step, not the first: a target checking the second step's own output
  // was reported as claiming context nobody gave it.
  for (const vt of plan.verification_targets) add(`${vt.id}'s check`, [...vt.maps_to], vt.check);
  // One path claimed in three places is one finding, reported at the first place it
  // was named — three lines for one remedy is how a report becomes noise.
  const seen = new Set<string>();
  return found.filter((c) => (seen.has(c.path) ? false : (seen.add(c.path), true)));
}

/* ------------------------------------------------------------------ *
 * G20's pure half
 * ------------------------------------------------------------------ */

/** A declared read that is not a path inside this repository at all. */
export function malformedReads(plan: PlanDoc): { stepId: string; glob: string }[] {
  return plan.steps.flatMap((step) =>
    (step.reads ?? [])
      .filter((glob) => !isRepoRelative(glob.replace(/[*?]/g, 'x')))
      .map((glob) => ({ stepId: step.id, glob })),
  );
}

/** Every step id this step transitively declares it comes after. */
function prerequisiteClosure(plan: PlanDoc, stepId: string): Set<string> {
  const byId = new Map(plan.steps.map((s) => [s.id, s]));
  const seen = new Set<string>();
  // G10 refuses a cyclic plan, but it runs independently of this one and a document
  // it is about to refuse must not hang the report first.
  const queue = [...(byId.get(stepId)?.depends_on ?? [])];
  while (queue.length > 0) {
    const next = queue.shift()!;
    if (seen.has(next)) continue;
    seen.add(next);
    queue.push(...(byId.get(next)?.depends_on ?? []));
  }
  return seen;
}

/** The step whose `scope` covers this read, or null. */
function planProviderOf(plan: PlanDoc, readerId: string, glob: string): string | null {
  for (const step of plan.steps) {
    if (step.id === readerId) continue;
    if ((step.scope ?? []).some((s) => globCovers(s, glob))) return step.id;
  }
  return null;
}

/**
 * A declared read that no OTHER step in this plan writes — the candidates the
 * repository half then has to answer for. Malformed reads are excluded: a path that is
 * not a path has its own clause and asking the tree about it would be nonsense.
 */
export function readsWithoutPlanProvider(plan: PlanDoc): { stepId: string; glob: string }[] {
  const malformed = new Set(malformedReads(plan).map((m) => `${m.stepId} ${m.glob}`));
  return plan.steps.flatMap((step) =>
    (step.reads ?? [])
      .filter((glob) => !malformed.has(`${step.id} ${glob}`))
      .filter((glob) => planProviderOf(plan, step.id, glob) === null)
      .map((glob) => ({ stepId: step.id, glob })),
  );
}

/**
 * A declared read some other step writes, where the reader does NOT say it comes after
 * the writer. This is the issue's story 2, and it is the case `depends_on` alone
 * cannot catch: the PROSE declares the order and the field does not.
 */
export function unorderedReadProviders(plan: PlanDoc): { stepId: string; glob: string; providerId: string }[] {
  return plan.steps.flatMap((step) => {
    const after = prerequisiteClosure(plan, step.id);
    return (step.reads ?? []).flatMap((glob) => {
      const providerId = planProviderOf(plan, step.id, glob);
      if (providerId === null || after.has(providerId)) return [];
      return [{ stepId: step.id, glob, providerId }];
    });
  });
}

/**
 * G20 — every path a step declares it READS has something that will provide it
 * (FR-071).
 *
 * `repository` carries the half only `plan-gate` can run. On the review page it is
 * `{ read: false }`, and a clean pure half then reports `not-applicable` with the
 * reason rather than a tick it did not earn.
 */
export function checkG20ReadsProvided(plan: PlanDoc, repository: RepositoryAnswer): GateResult {
  const declared = plan.steps.reduce((n, s) => n + (s.reads ?? []).length, 0);
  // A read the tree ALREADY HOLDS does not wait on anybody. The repository half reports
  // which ones those are; the preview cannot know, and shows the ordering clause with
  // its own "this screen does not read the repository" beside it.
  const present = new Set(repository.read ? (repository.presentAtRef ?? []) : []);
  const pure = [
    ...malformedReads(plan).map(
      ({ stepId, glob }) => `${stepId} declares a read that is not a path inside this repository: \`${glob}\``,
    ),
    ...unorderedReadProviders(plan)
      .filter(({ stepId, glob }) => !present.has(`${stepId}\u0000${glob}`))
      .map(
        ({ stepId, glob, providerId }) =>
          `${stepId} says it reads \`${glob}\`, which ${providerId} writes — but ${stepId} does not say it comes ` +
          `after ${providerId}, so a build may be dispatched for it first`,
      ),
  ];
  const problems = repository.read ? [...pure, ...repository.problems] : pure;
  if (problems.length === 0) {
    if (!repository.read) {
      return { id: 'G20', status: 'not-applicable', requirement: 'FR-071', detail: repository.why };
    }
    // AN ABSENT CHECK MUST NOT READ AS A PASSING ONE. A plan where no step declares a
    // read is not a plan whose reads were checked — it is a plan that said nothing for
    // this gate to check, and the operator is entitled to know which of the two they
    // are looking at. (The repair is recorded reads, which fire after the spend.)
    return declared === 0
      ? {
          id: 'G20',
          status: 'pass',
          requirement: 'FR-071',
          detail: 'no step declares what it reads, so there was nothing here to check',
        }
      : { id: 'G20', status: 'pass', requirement: 'FR-071' };
  }
  return {
    id: 'G20',
    status: 'advisory',
    requirement: 'FR-071',
    detail: repository.read
      ? `${problems.join('; ')} — ${G20_TAIL}`
      : `${problems.join('; ')} — ${G20_TAIL} ${repository.why}`,
  };
}

/* ------------------------------------------------------------------ *
 * G21's pure half
 * ------------------------------------------------------------------ */

/** Naming your own output is not claiming context. */
function writtenByOwnStep(plan: PlanDoc, claim: ClaimedPath): boolean {
  return claim.stepIds.some((id) => {
    const step = plan.steps.find((s) => s.id === id);
    return step !== undefined && matchesAny(claim.path, step.scope ?? [], false);
  });
}

/**
 * G21 — a special-folder path the plan's prose names that the workload never
 * designated as context (FR-071).
 *
 * `declared` is the workload's `### Context`, or the reason it is unknown. A workload
 * that designates NOTHING is authoritative, not unknown: FR-053 makes index-files-only
 * a real mode, so a plan quoting `specs/lza-01/spec.md` under it is still claiming
 * something it was never handed.
 */
export function checkG21ContextClaimed(plan: PlanDoc, declared: DeclaredContext): GateResult {
  if (!declared.known) {
    return { id: 'G21', status: 'not-applicable', requirement: 'FR-071', detail: declared.why };
  }
  const undeclared = claimedContextPaths(plan).filter(
    (c) => !contextCovers(declared.paths, c.path) && !writtenByOwnStep(plan, c),
  );
  if (undeclared.length === 0) return { id: 'G21', status: 'pass', requirement: 'FR-071' };
  return {
    id: 'G21',
    status: 'advisory',
    requirement: 'FR-071',
    detail:
      `${undeclared
        .map((c) => `${c.where} names \`${c.path}\`, which this workload does not designate as context`)
        .join('; ')} — ${G21_TAIL}`,
  };
}
