import { existsSync } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import type { Octokit } from '@octokit/rest';
import { createClient, type RepoRef } from '../dashboard/lib/github/client';
import { errorMessage, errorStatus } from '../dashboard/lib/github/errors';
import { CONFIRMED_LABELS } from '../dashboard/lib/github/labels';
import { resolveCurrent, tryReadPlanAtRef } from '../dashboard/lib/github/plans';
import { listWorkloads } from '../dashboard/lib/github/workloads';
import type { ConfirmationRecord } from '../schemas/confirmation';
import type { PlanStep } from '../schemas/plan';
import { CONFIRMATION_DIR, confirmationVerdict, parseConfirmation } from './gates/lib/checks-preflight';

/**
 * confirm-record — validates every committed high-stakes confirmation and applies
 * `confirmed:<authority>` to the tracking issue of the step each record names
 * (issue-tracker-contract.md authority matrix, FR-023/FR-024). Invoked by the
 * confirm-record workflow when a `confirmations/<workload>/<step-id>.json` lands on
 * the default branch.
 *
 * The label is a BOARD SIGNAL, never the gate: B5 reads the FILE, so a label can
 * neither unblock a build nor be forged into one. That is exactly why it must never
 * run ahead of a valid record — a `confirmed:` label with nothing behind it would
 * tell the operator an authority answered a question it never saw. Validity is
 * `parseConfirmation`, B5's own, imported rather than restated: two definitions
 * would let a record earn the label and still block the build it was recorded for.
 *
 * Outcomes are split three ways, because only one of them is the record's own fault:
 *   rejected  — unparseable or off-schema, a `step_id` or `workload` that disagrees
 *     with the path, an authority the step does not route to, a `step_digest` that
 *     confirms a superseded version of the step, or a record still sitting at the
 *     pre-GHI-#95 unscoped path. Nothing but an edit fixes these, and every one of
 *     them would make `confirmed:<authority>` say something untrue, so the run fails.
 *   unlabeled — no official plan names the step yet, or the step carries no
 *     `tracking_issue`. Those are states of the PLAN, not defects in the record: the
 *     identical file becomes labelable later without changing a byte, so failing
 *     every push until then would be a false alarm on a workflow that runs on main
 *     (the B8 precedent — a check must not fail for a condition that is not its
 *     business).
 *   labeled   — the label is on the step's tracking issue.
 *
 * Scans the whole directory rather than the push's diff: idempotent, identical under
 * workflow_dispatch, no dependence on event shape, and a re-applied label is a no-op.
 * With rejection scoped to the record itself, an old valid record stays valid however
 * much the plans around it churn.
 */

/** Where the records live — taken from the constant B5 reads, so the validator and
 *  the gate can never end up looking in two different places. One directory per
 *  workload beneath it (GHI #95). */
export const RECORD_DIR = CONFIRMATION_DIR;

/**
 * Every record in the tree, as `{ workload, stepId, file }`. Two levels deep and no
 * deeper: the path IS the binding (`confirmations/<workload>/<step-id>.json`), so a
 * file at any other depth is not a record this validator can attribute to anything.
 *
 * A `.json` sitting at the ROOT is the pre-#95 unscoped shape, and it is surfaced
 * rather than skipped: silence would leave an operator believing a sign-off they
 * genuinely obtained is in force, when B5 no longer reads that path at all.
 */
interface FoundRecord {
  workload: string;
  stepId: string;
  /** display path, relative to the record dir — this is what the run log prints */
  file: string;
  absolute: string;
}

async function findRecords(dir: string): Promise<{ records: FoundRecord[]; unscoped: string[] }> {
  // A directory that does not exist yet is the ordinary state of a repo before its
  // first high-stakes step, not an error.
  if (!existsSync(dir)) return { records: [], unscoped: [] };
  const entries = (await readdir(dir, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name));
  const unscoped = entries.filter((e) => e.isFile() && e.name.endsWith('.json')).map((e) => e.name);
  const records: FoundRecord[] = [];
  for (const entry of entries.filter((e) => e.isDirectory())) {
    const workload = entry.name;
    const files = (await readdir(join(dir, workload))).filter((f) => f.endsWith('.json')).sort();
    for (const file of files) {
      records.push({
        workload,
        stepId: basename(file, '.json'),
        file: `${workload}/${file}`,
        absolute: join(dir, workload, file),
      });
    }
  }
  // Sorted so one commit's log reads the same every time (report determinism).
  return { records, unscoped };
}

export interface ConfirmOutcome {
  /** file name within the records directory; for a `cleared` orphan whose step no
   *  official plan declares any more, the issue it was removed from instead */
  file: string;
  status: 'labeled' | 'unlabeled' | 'rejected' | 'cleared';
  /** human-readable, and for a rejection it IS the reason — this is what the run log shows */
  detail: string;
}

/** A step id resolved against the OFFICIAL (frozen) plans — B5's universe, since a
 *  confirmation exists to unblock a build and a build only ever runs from a frozen tag. */
interface LocatedStep {
  planRef: string;
  step: PlanStep;
}

/**
 * `<workload>/<step-id>` → the official step it names.
 *
 * ONE entry, not a list, since GHI #95 scoped the record path by workload. It used
 * to be a list keyed on step id alone, because `confirmations/<step-id>.json` was a
 * repo-global path while step ids are unique only WITHIN a plan — two workloads both
 * naming `step-billing-cycle` shared one file, and this validator REFUSED to label
 * the ambiguity while B5 went on accepting the record. That disagreement is gone:
 * the path now carries the workload, so the key is unambiguous by construction and
 * there is no ambiguity left to report.
 */
interface OfficialIndex {
  byStep: Map<string, LocatedStep>;
  /** tracking issue → the official steps naming it, for the orphan-label sweep */
  byIssue: Map<number, LocatedStep[]>;
  /** official plans we could NOT read. A partial view must never drive a deletion, so
   *  their presence disables the sweep rather than silently narrowing it. */
  unreadable: string[];
}

/** The index key — spelled once so the writer and every reader agree. */
const stepKey = (workload: string, stepId: string): string => `${workload}/${stepId}`;

async function indexOfficialSteps(gh: Octokit, repo: RepoRef): Promise<OfficialIndex> {
  const byStep = new Map<string, LocatedStep>();
  const byIssue = new Map<number, LocatedStep[]>();
  const unreadable: string[] = [];
  const workloads = (await listWorkloads(gh, repo)).sort((a, b) => a.slug.localeCompare(b.slug));
  for (const workload of workloads) {
    const planRef = await resolveCurrent(gh, repo, workload.slug);
    if (planRef === null) continue; // nothing frozen yet — this workload owns no official steps
    // An unreadable plan contributes nothing rather than throwing: an off-schema plan
    // is the plan gate's business, and it must not take every OTHER record down with it.
    const { plan } = await tryReadPlanAtRef(gh, repo, planRef);
    if (!plan) {
      unreadable.push(planRef);
      continue;
    }
    for (const step of plan.steps) {
      byStep.set(stepKey(workload.slug, step.id), { planRef, step });
      if (typeof step.tracking_issue === 'number') {
        byIssue.set(step.tracking_issue, [...(byIssue.get(step.tracking_issue) ?? []), { planRef, step }]);
      }
    }
  }
  return { byStep, byIssue, unreadable };
}

/**
 * Remove every `confirmed:<authority>` whose record no longer earns it — absent, edited
 * into invalidity, deleted, left at the pre-#95 unscoped path, pointed at a step whose
 * authority changed, or confirming a version of the step a later approval rewrote
 * (GHI #95). B5 goes on blocking such a build correctly, so this is not about the
 * gate: it is about the board not testifying to a sign-off that no longer exists, which is
 * the one thing this workflow owns and the only lie it could tell.
 *
 * `earned` is authoritative because the caller rescans the WHOLE directory every run
 * rather than a push diff — a deletion leaves no outcome to react to, so the sweep has to
 * be driven by what should be there, not by what changed.
 *
 * Refuses to act on a partial view: if any official plan could not be read, its steps are
 * missing from the index and their perfectly good labels would look orphaned. Better to
 * report a skipped sweep than to strip real confirmations because one plan is off-schema.
 */
async function clearOrphanedLabels(
  gh: Octokit,
  repo: RepoRef,
  index: OfficialIndex,
  earned: Map<number, Set<string>>,
): Promise<ConfirmOutcome[]> {
  if (index.unreadable.length > 0) {
    return [
      {
        file: '(sweep)',
        status: 'unlabeled',
        detail:
          `stale-label sweep SKIPPED — could not read the official plan at ${index.unreadable.join(', ')}, ` +
          `and a partial view of official steps would strip labels that are genuinely earned`,
      },
    ];
  }
  const outcomes: ConfirmOutcome[] = [];
  for (const label of CONFIRMED_LABELS) {
    // state: 'all' — a closed tracking issue keeps its labels, and a stale claim on a
    // closed issue is still a claim.
    const issues = await gh.paginate(gh.issues.listForRepo, { ...repo, labels: label, state: 'all', per_page: 100 });
    for (const issue of issues.sort((a, b) => a.number - b.number)) {
      if (earned.get(issue.number)?.has(label)) continue;
      try {
        await gh.issues.removeLabel({ ...repo, issue_number: issue.number, name: label });
      } catch (error: unknown) {
        // 404-only tolerance: someone else removed it between the list and the delete,
        // which is the outcome we wanted anyway (GHI #52 convention).
        if (errorStatus(error) !== 404) throw error;
      }
      const step = index.byIssue.get(issue.number)?.[0]?.step;
      outcomes.push({
        file: step ? `${step.id}.json` : `#${issue.number}`,
        status: 'cleared',
        detail: `${label} removed from #${issue.number} — no valid confirmation record backs it any more`,
      });
    }
  }
  return outcomes;
}

/** Validate every record under `dir` and label what can be labeled. Outcomes come back
 *  in file order (sorted) — the log for one commit must read the same every time. */
export async function confirmRecords(gh: Octokit, repo: RepoRef, dir: string = RECORD_DIR): Promise<ConfirmOutcome[]> {
  const { records, unscoped } = await findRecords(dir);

  // Parsed before a single API call: a record's validity is intrinsic to the file, so
  // a directory of malformed ones is rejected without asking GitHub anything.
  const outcomes: ConfirmOutcome[] = [];
  // Surfaced, never silently skipped: a file at the pre-#95 root path is an answer a
  // real authority gave, and B5 no longer reads it. Rejected rather than "unlabeled"
  // because only an edit fixes it — and because an operator who obtained a sign-off
  // needs to hear that it is not in force.
  for (const file of unscoped) {
    outcomes.push({
      file,
      status: 'rejected',
      detail:
        `sits at the pre-GHI-#95 unscoped path — records now live at ` +
        `${CONFIRMATION_DIR}/<workload>/${file} and carry \`workload\` and \`step_digest\`, which bind the ` +
        `sign-off to one workload and one version of the step. Move it and add those fields; the review ` +
        `page's high-stakes panel prints the record to commit`,
    });
  }
  const valid: { file: string; workload: string; stepId: string; record: ConfirmationRecord }[] = [];
  for (const found of records) {
    // The PATH is the lookup key (B5 reads confirmations/<workload>/<step-id>.json),
    // so it — not the record's own fields — decides what is being confirmed; the
    // fields must then agree with it.
    const parsed = parseConfirmation(await readFile(found.absolute, 'utf8'), {
      workload: found.workload,
      stepId: found.stepId,
    });
    if ('reason' in parsed) {
      outcomes.push({ file: found.file, status: 'rejected', detail: `not a valid confirmation record — ${parsed.reason}` });
      continue;
    }
    valid.push({ file: found.file, workload: found.workload, stepId: found.stepId, record: parsed.record });
  }
  // No early return on an empty `valid` set: the sweep below still has to run. A deleted
  // or newly-corrupted record produces nothing to react to, and that is exactly the case
  // where a label is left standing for a confirmation that no longer exists.
  const index = await indexOfficialSteps(gh, repo);
  const earned = new Map<number, Set<string>>();

  for (const { file, workload, stepId, record } of valid) {
    const { authority } = record;
    const located = index.byStep.get(stepKey(workload, stepId));
    if (located === undefined) {
      outcomes.push({
        file,
        status: 'unlabeled',
        detail: `valid ${authority} confirmation; no official plan for workload ${workload} names ${stepId} yet — nothing to label`,
      });
      continue;
    }
    const { planRef, step } = located;
    // The gate's own read rule, imported not restated (GHI #95, #96): a ledger whose
    // latest decision about the CURRENT step is not an authorization must not light a
    // label saying the authority signed off on what is frozen today.
    const verdict = confirmationVerdict(record, step);
    if (!verdict.ok) {
      // A REFUSAL IS NOT A BROKEN RECORD. The file is valid and the authority
      // answered; the answer was no. Reporting it as `rejected` alongside malformed
      // JSON would tell the operator to go fix the file, when the file is the one
      // thing here that is right. It earns no label, and the sweep below strips any
      // confirmed:* label a previous approval had left standing.
      outcomes.push({
        file,
        status: verdict.kind === 'refused' ? 'unlabeled' : 'rejected',
        detail:
          verdict.kind === 'refused'
            ? `${verdict.reason} — no confirmed:${authority} label is earned while the latest decision stands (${planRef})`
            : `${verdict.reason} — until then the label would credit an answer to a question that authority was never asked (${planRef})`,
      });
      continue;
    }
    if (step.tracking_issue === null || step.tracking_issue === undefined) {
      outcomes.push({ file, status: 'unlabeled', detail: `valid ${authority} confirmation for ${stepId} (${planRef}); the step names no tracking issue — nothing to label` });
      continue;
    }

    const label = `confirmed:${authority}`;
    // The string comes from the taxonomy, not from here: the schema's authority enum
    // and the label family are two spellings of one contract, and a drift between them
    // would mint an off-taxonomy label no dashboard view ever reads (labels.ts precedent).
    if (!(CONFIRMED_LABELS as readonly string[]).includes(label)) {
      throw new Error(`authority "${authority}" has no label in the confirmed:* family — schema and taxonomy have drifted`);
    }
    await gh.issues.addLabels({ ...repo, issue_number: step.tracking_issue, labels: [label] });
    earned.set(step.tracking_issue, new Set([...(earned.get(step.tracking_issue) ?? []), label]));
    outcomes.push({ file, status: 'labeled', detail: `${label} applied to #${step.tracking_issue} (${stepId}, ${planRef})` });
  }

  // Add first, sweep second: a step whose authority changed picks up its new label before
  // the old one goes, so the board is never momentarily blank on a confirmation that holds.
  outcomes.push(...(await clearOrphanedLabels(gh, repo, index, earned)));
  return outcomes;
}

const isMain = process.argv[1]?.endsWith('confirm-record.ts');
if (isMain) {
  const argv = process.argv.slice(2);
  const get = (name: string): string | undefined => {
    const i = argv.indexOf(`--${name}`);
    const v = i >= 0 ? argv[i + 1] : undefined;
    return v && v.length > 0 ? v : undefined;
  };
  const repoArg = get('repo');
  const [owner, repoName] = (repoArg ?? '').split('/');
  if (!owner || !repoName) {
    console.error('usage: confirm-record --repo <owner/repo> [--dir <confirmations>]');
    process.exit(2);
  }
  const dir = get('dir') ?? RECORD_DIR;
  confirmRecords(createClient(), { owner, repo: repoName }, dir)
    .then((outcomes) => {
      if (outcomes.length === 0) {
        console.log(`no confirmation records under ${dir}/ and no stale confirmed:* labels — nothing to do`);
        return;
      }
      const glyph = (status: ConfirmOutcome['status']): string =>
        status === 'rejected' ? '✗' : status === 'cleared' ? '↺' : '✓';
      for (const o of outcomes) console.log(`${glyph(o.status)} ${o.file}: ${o.detail}`);
      // Exit 1 on any rejection, AFTER the valid records were labeled: one bad file
      // must not withhold a signal another authority genuinely earned.
      const rejected = outcomes.filter((o) => o.status === 'rejected').length;
      if (rejected > 0) {
        console.error(`${rejected} confirmation record(s) rejected and left unlabeled — fix the record, never the label`);
        process.exit(1);
      }
    })
    .catch((error) => {
      console.error(errorMessage(error));
      process.exit(1);
    });
}
