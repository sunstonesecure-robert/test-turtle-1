import type { Octokit } from '@octokit/rest';
import type { RepoRef } from './client';
import { errorStatus, Refusal } from './errors';
import { readPlanAtRef, slugFromPlanRef } from './plans';
import type { PlanStep } from '../../../schemas/plan';
import {
  ConfirmationRecord,
  Decision,
  Ledger,
  type ConfirmationLedger,
  type Decision as DecisionEntry,
} from '../../../schemas/confirmation';
import { confirmationPath, stepDigest } from '../../../scripts/gates/lib/checks-preflight';

/**
 * Record a high-stakes confirmation from the review page and land it (GHI #194).
 *
 * WHAT WAS WRONG. The panel computed the two fields nobody can produce by hand —
 * the workload and the step's digest — printed them, and then sent the operator to
 * a skill file on GitHub to do the rest: type a name, a contact, a timestamp and a
 * rationale into JSON, and get that file onto the default branch past a ruleset
 * that refuses every non-admin push. On the first real workload that took a
 * session-assisted API commit and a hand-typed timestamp, and the operator's word
 * for the panel's link was "pointless". The gate was right; the route to it was
 * not one a person should have to walk.
 *
 * WHAT THIS DOES. It composes the ledger entry from what a human actually knows —
 * the decision, who answered, how to reach them, what they said — and supplies
 * everything else itself: the step id, the workload, the authority and the digest
 * from the plan under review, and `at` from the server clock. Then it validates
 * the WHOLE resulting ledger the way the gate will read it, refuses by name on
 * anything the gate would refuse, and only then writes: a branch off the default
 * branch, one commit, one pull request. Nothing is written before every check has
 * passed, so a refusal is always "nothing happened, and here is why".
 *
 * APPEND, NEVER REPLACE. The ledger on the default branch is the step's decision
 * log (schemas/confirmation.ts). If it exists it is read and the new entry is
 * appended; if it does not, it is created. This module never rewrites an earlier
 * entry, because each one names its own author and rewriting it would put words in
 * that person's mouth.
 *
 * WHY A PULL REQUEST AND NOT A COMMIT TO THE DEFAULT BRANCH. The default-branch
 * ruleset requires the plan and deliverable gates on every push and bypasses only
 * the repository-admin role — deliberately, so no machine credential holds a bypass
 * (CONFIGURATION_GUIDE.md §5c). The dashboard's credential is not an admin, so it
 * takes the route everyone else has: a pull request carrying only the record, which
 * both gates report `skipped` on, so the operator merges it with one click. Merging
 * is a push to the default branch, so `confirm-record` fires exactly as it does for
 * a direct commit and applies `confirmed:<authority>` — that label stays that
 * workflow's alone (issue-tracker-contract.md); this module writes the record file
 * and nothing else. Should the credential ever gain a bypass, landing directly is a
 * one-line change; the pull request is correct today and stays auditable.
 *
 * THE BRANCH AND FILE WRITERS FOLLOW evidence-store.ts AND approval.ts rather than
 * calling them: those are bound to their own branch (`evidence`, an orphan) and their
 * own title (`Approve plan …`), and generalizing either for one more caller would
 * change modules this change has no business in. The shapes are the same — ref
 * create-or-422, contents PUT with the blob sha when overwriting, one open pull
 * request per head, reused rather than surfacing GitHub's 422.
 */

/** Where a step's confirmation branch lives — one per (workload, step), so the
 *  pull request list says which step each row is about. */
export function confirmationBranch(workload: string, stepId: string): string {
  return `confirm/${workload}/${stepId}`;
}

/** The attribution as the form collects it. `role` is captured, never gated on
 *  (GHI #193 rider): the capacity in which the person answered. */
export interface ConfirmerInput {
  name: string;
  contact: string;
  role?: string | null;
}

/** The human half of an entry, typed into the form. Everything else is derived. */
export interface FormEntryInput {
  kind: 'form';
  decision: 'approved' | 'rejected' | 'overridden';
  by: ConfirmerInput;
  rationale: string;
}

/** A pre-written entry, for an operator who received the JSON from the authority
 *  or from a confirmation skill. Validated exactly like the form's — the only
 *  difference is that its `at`, when present, is kept, because it is the moment
 *  the authority actually answered rather than the moment it was pasted. */
export interface PastedEntryInput {
  kind: 'paste';
  text: string;
}

/**
 * The review-state guard the panel's record action applies before composing anything
 * (PR #204 review). A confirmation is recorded on a LIVE review (the answer arrived
 * early) or a RESOLVED one (the ordinary case: frozen plan, refused build, answer
 * afterwards) — never on a WITHDRAWN one. A withdrawn proposal's plan version will
 * never be built, so an answer recorded against it authorizes nothing and, worse,
 * lands a ledger the next proposal's step may not match. JSX-free so the rule is
 * pinned by a test; the `'use server'` action calls it and can add nothing to it.
 */
export function assertReviewAcceptsConfirmation(andonIssue: number, labels: readonly string[]): void {
  if (labels.includes('andon:superseded')) {
    throw new Refusal(
      `Review #${andonIssue} was withdrawn, so no answer is recorded against its proposal — that plan version will never be built. ` +
        'Propose again; the new proposal\'s review is where the authority\'s answer is recorded, against the step as it then reads',
    );
  }
}

export interface RecordConfirmationInput {
  /** the plan the review is about — the frozen tag, or the live branch */
  planRef: string;
  stepId: string;
  entry: FormEntryInput | PastedEntryInput;
  /** who pressed the button — the commit is attributed to them, the entry to the confirmer */
  actor: string;
  /** the server clock; injectable so a test can pin the ledger's chronology */
  now?: Date;
}

export interface RecordConfirmationResult {
  path: string;
  /** the default branch the record is headed for */
  branch: string;
  /** the branch the record was committed on */
  head: string;
  decision: DecisionEntry['decision'];
  /** false when an existing ledger was appended to */
  created: boolean;
  pr: { number: number; url: string };
}

// ---------------------------------------------------------------------------
// The rule the skills teach, made checkable
// ---------------------------------------------------------------------------

/**
 * Words by which an approval usually smuggles a condition into its rationale.
 *
 * WHY THE RECORDER CHECKS THIS AT ALL. The gate reads the decision alone: a
 * condition written into an `approved` entry binds nothing, and the build proceeds
 * as though the authority had said an unconditional yes. All four confirmation
 * skills therefore carry the same rule — a condition the frozen step does not meet
 * is recorded as `rejected` with the condition as the rationale, carried into the
 * step by re-plan, and re-confirmed against the new digest. The skill can only
 * teach the rule; the form is where it is actually broken, so the form enforces it.
 *
 * A HEURISTIC, NAMED AS ONE. Text cannot be read for intent, so the list is short
 * and made of the conjunctions that introduce a condition rather than every word
 * that might. A false positive costs one re-phrase (the refusal quotes the phrase
 * it tripped on and says what to do); a false negative costs a build that ran on a
 * yes the authority never quite gave. The list is exported so the test pins it and
 * a future extension is a visible one.
 */
export const CONDITION_MARKERS: readonly string[] = [
  // The "yes, …" forms first: they contain the shorter markers below, and the
  // refusal quotes the phrase it tripped on — "yes, but" is what the operator typed.
  'yes, but',
  'yes but',
  'yes, if',
  'yes if',
  'but only',
  'only if',
  'only when',
  'only once',
  'only after',
  'provided that',
  'provided the',
  'on condition',
  'on the condition',
  'as long as',
  'so long as',
  'subject to',
  'unless',
  'conditional on',
  'contingent on',
  'with the condition',
  'with the proviso',
];

/** The first condition marker the rationale carries, or null. Matched on word
 *  boundaries so `unless` does not fire on `unlessened` — unlikely, but a refusal
 *  that quotes a phrase the operator cannot find in their own text is worse than
 *  none. */
export function conditionIn(rationale: string): string | null {
  const text = rationale.toLowerCase();
  for (const marker of CONDITION_MARKERS) {
    const re = new RegExp(`(^|[^a-z])${marker.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([^a-z]|$)`);
    if (re.test(text)) return marker;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

/** The ledger on the default branch, with the blob sha a write over it needs —
 *  or null when a verified 404 says there is none. Anything else is a fault: an
 *  unreadable record is not an absent one (GHI #150), and appending to a file we
 *  could not read would replace whatever is there. */
async function readLedgerFile(
  gh: Octokit,
  repo: RepoRef,
  path: string,
  branch: string,
): Promise<{ raw: string; sha: string } | null> {
  try {
    const { data } = await gh.repos.getContent({ ...repo, path, ref: branch });
    if (Array.isArray(data) || !('content' in data)) return null;
    return { raw: Buffer.from(data.content, 'base64').toString('utf8'), sha: data.sha };
  } catch (error: unknown) {
    if (errorStatus(error) === 404) return null;
    throw error;
  }
}

/** The newest decision about THIS version of the step, or null when nobody has
 *  been asked about it yet. The same read rule as `confirmationVerdict`. */
export function standingDecision(ledger: ConfirmationLedger | null, digest: string): DecisionEntry | null {
  if (!ledger) return null;
  const forThisVersion = ledger.decisions.filter((d) => d.step_digest === digest);
  return forThisVersion[forThisVersion.length - 1] ?? null;
}

/** True when the newest decision about this version of the step is a refusal —
 *  the only state in which `overridden` is an honest thing to record. */
export function refusalStands(ledger: ConfirmationLedger | null, digest: string): boolean {
  return standingDecision(ledger, digest)?.decision === 'rejected';
}

// ---------------------------------------------------------------------------
// Composition + validation
// ---------------------------------------------------------------------------

function zodIssues(issues: { path: (string | number)[]; message: string }[]): string {
  return issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
}

/** The pasted text as ONE entry — either a bare decision object, or a whole ledger
 *  carrying exactly one decision (the shape the panel's own template prints). A
 *  ledger header that disagrees with the step is refused here, by field, before the
 *  entry is judged. */
function entryFromPaste(
  text: string,
  expected: { stepId: string; workload: string; authority: string },
): { entry: Record<string, unknown> } {
  let doc: unknown;
  try {
    doc = JSON.parse(text);
  } catch (error: unknown) {
    throw new Refusal(
      `the pasted entry is not JSON (${error instanceof Error ? error.message : String(error)}) — paste one ledger entry, ` +
        'or use the form above and let the page write it',
    );
  }
  if (typeof doc !== 'object' || doc === null || Array.isArray(doc)) {
    throw new Refusal('the pasted entry must be a JSON object — one decision, or a ledger carrying one decision');
  }
  const record = doc as Record<string, unknown>;
  if (!('decisions' in record)) return { entry: record };

  const header = [
    ['step_id', expected.stepId],
    ['workload', expected.workload],
    ['authority', expected.authority],
  ] as const;
  for (const [field, want] of header) {
    if (field in record && record[field] !== want) {
      throw new Refusal(
        `the pasted ledger's ${field} is "${String(record[field])}", but this step's is "${want}" — an entry about ` +
          `another ${field === 'authority' ? 'authority' : field === 'workload' ? 'workload' : 'step'} confirms nothing here. ` +
          'Paste the entry the authority gave about THIS step, or use the form',
      );
    }
  }
  const decisions = record.decisions;
  if (!Array.isArray(decisions) || decisions.length !== 1) {
    throw new Refusal(
      `the pasted ledger carries ${Array.isArray(decisions) ? decisions.length : 'no'} decisions — paste exactly one: ` +
        'the record on the default branch is appended to, never replaced, so earlier decisions are already there',
    );
  }
  const only = decisions[0];
  if (typeof only !== 'object' || only === null || Array.isArray(only)) {
    throw new Refusal('the pasted ledger\'s one decision is not an object');
  }
  return { entry: only as Record<string, unknown> };
}

/**
 * Everything checked, nothing written: the entry as it will be appended, plus
 * what it is being appended to. Exported so the test can prove the refusals
 * without a GitHub mock for the write half, and so the panel could preview.
 */
export async function composeConfirmationEntry(
  gh: Octokit,
  repo: RepoRef,
  input: RecordConfirmationInput,
): Promise<{
  step: PlanStep;
  workload: string;
  authority: NonNullable<PlanStep['authority']>;
  digest: string;
  path: string;
  branch: string;
  existing: { ledger: ConfirmationLedger; sha: string } | null;
  ledger: ConfirmationLedger;
  entry: DecisionEntry;
}> {
  const workload = slugFromPlanRef(input.planRef);
  if (workload === null) {
    throw new Refusal(`"${input.planRef}" is not a plan ref, so no workload can own this confirmation — a plan ref is plan/<slug>/v<N>`);
  }
  // The plan the review is about, read fresh: the digest is computed from the step
  // as it stands at this ref, never taken from the form, so a stale page cannot
  // bind an answer to a version of the step that has since changed.
  const plan = await readPlanAtRef(gh, repo, input.planRef);
  const step = plan.steps.find((s) => s.id === input.stepId);
  if (!step) throw new Refusal(`step ${input.stepId} is not in ${input.planRef} — nothing to confirm`);
  if (!step.high_stakes || !step.authority) {
    throw new Refusal(
      `${input.stepId} is not flagged high-stakes in ${input.planRef}, so there is no authority to record an answer from — flag it first, while the review is live`,
    );
  }
  const authority = step.authority;
  const digest = stepDigest(step);
  const path = confirmationPath(workload, step.id);

  const { data: repoInfo } = await gh.repos.get({ ...repo });
  const branch = repoInfo.default_branch;

  // What is already on record. A file that exists but does not parse as a ledger is
  // refused, not appended to: appending means rewriting the file with the new entry
  // in it, and rewriting a record we could not read would replace whatever a person
  // meant by it.
  const file = await readLedgerFile(gh, repo, path, branch);
  let existing: { ledger: ConfirmationLedger; sha: string } | null = null;
  if (file) {
    let doc: unknown;
    try {
      doc = JSON.parse(file.raw);
    } catch {
      throw new Refusal(
        `${path} on ${branch} is not valid JSON, so nothing can be appended to it — fix the file by hand (a pull request from a branch), then record the answer here`,
      );
    }
    const parsed = ConfirmationRecord.safeParse(doc);
    if (!parsed.success) {
      throw new Refusal(
        `${path} on ${branch} is not a valid confirmation record (${zodIssues(parsed.error.issues)}), so nothing can be appended to it — fix the file by hand, then record the answer here`,
      );
    }
    // The three fields that make a ledger THIS step's: workload, step id, authority.
    // The path is derived from the first two, so a mismatch means a ledger was put at
    // this path by hand for something else — and the gate (B5, confirm-record) keeps
    // refusing it while an append here would grow it and open a pull request for it
    // (PR #204 review). Nothing is appended to a ledger that is not this step's.
    if (parsed.data.workload !== workload) {
      throw new Refusal(
        `${path} on ${branch} names workload "${parsed.data.workload}", but this review is about ${workload} — ` +
          'a ledger for another workload cannot be appended to, and the build gate would refuse it either way; ' +
          `move the old ledger aside by hand, then record the answer here`,
      );
    }
    if (parsed.data.step_id !== step.id) {
      throw new Refusal(
        `${path} on ${branch} names step "${parsed.data.step_id}", but this answer is about ${step.id} — ` +
          'a ledger for another step cannot be appended to, and the build gate would refuse it either way; ' +
          `move the old ledger aside by hand, then record the answer here`,
      );
    }
    if (parsed.data.authority !== authority) {
      throw new Refusal(
        `${path} on ${branch} was recorded against the ${parsed.data.authority} authority, but ${step.id} routes to ${authority} — ` +
          'the step was re-routed after that ledger was written. An answer from another authority cannot be appended to; ' +
          `move the old ledger aside by hand, then record ${authority}'s answer here`,
      );
    }
    existing = { ledger: parsed.data, sha: file.sha };
  }

  // The entry, from whichever route it arrived by. `at` is the server clock in UTC
  // for the form — the one field the live run showed a person will otherwise type
  // by hand — and the pasted value when a pasted entry carries one.
  const now = (input.now ?? new Date()).toISOString();
  let candidate: Record<string, unknown>;
  if (input.entry.kind === 'form') {
    const by: Record<string, unknown> = { name: input.entry.by.name.trim(), contact: input.entry.by.contact.trim() };
    const role = input.entry.by.role?.trim();
    if (role) by.role = role;
    candidate = {
      decision: input.entry.decision,
      step_digest: digest,
      by,
      at: now,
      rationale: input.entry.rationale.trim(),
    };
  } else {
    const { entry } = entryFromPaste(input.entry.text, { stepId: step.id, workload, authority });
    candidate = { ...entry };
    if (candidate.at === undefined) candidate.at = now;
    if (candidate.step_digest === undefined) candidate.step_digest = digest;
  }

  const entryParsed = Decision.safeParse(candidate);
  if (!entryParsed.success) {
    throw new Refusal(
      `the entry is incomplete or malformed (${zodIssues(entryParsed.error.issues)}) — the person who answered has to be named and reachable, and what they said has to be written down`,
    );
  }
  const entry = entryParsed.data;

  // THE BINDING, checked before anything else about the decision (GHI #95): an entry
  // about another version of the step authorizes nothing about this one, and the
  // refusal names which version the page is about so the operator can tell a stale
  // paste from a re-worded step.
  if (entry.step_digest !== digest) {
    throw new Refusal(
      `the entry's step_digest (${entry.step_digest}) is not ${step.id} as it stands in ${input.planRef} (${digest}) — ` +
        'it describes a different version of the step. If the authority answered about the step as it reads now, use the form ' +
        'and the page fills the digest in; if they answered about an earlier wording, the step has changed since and they need to be asked again',
    );
  }

  // The skills' rule (all four confirmation guides, step 3): an approval with a
  // condition the frozen step does not meet is a refusal wearing a lighter word.
  if (entry.decision === 'approved') {
    const marker = conditionIn(entry.rationale);
    if (marker !== null) {
      throw new Refusal(
        `the rationale reads as an approval with a condition attached ("${marker}"). The build gate reads the decision alone, so a ` +
          'condition written into an approved entry binds nothing. If the step as approved already meets the condition, say so ' +
          'without the "' +
          marker +
          '" and record approved; if it does not, record rejected with the condition as the rationale, carry the condition into ' +
          'the step through a new plan version, and ask again about the new wording',
      );
    }
  }

  // An override lifts a refusal. Checked here, in the operator's terms, before the
  // schema's own rule reports the same thing as a path and a message.
  if (entry.decision === 'overridden' && !refusalStands(existing?.ledger ?? null, digest)) {
    const standing = standingDecision(existing?.ledger ?? null, digest);
    throw new Refusal(
      `nothing to override: ${
        standing
          ? `the newest decision about this version of ${step.id} is "${standing.decision}", not a refusal`
          : `no decision about this version of ${step.id} is on record on ${branch}`
      }. Record the authority's refusal first — an override is only ever of a refusal that stands on record — or record approved if that is what they said`,
    );
  }

  const ledger: ConfirmationLedger = existing
    ? { ...existing.ledger, decisions: [...existing.ledger.decisions, entry] }
    : { step_id: step.id, workload, authority, decisions: [entry] };

  // The whole ledger, as the gate will read it: chronology, the override rule, the
  // header. This is the same parse B5 and confirm-record make, so a ledger this
  // writes is one they accept.
  const whole = Ledger.safeParse(ledger);
  if (!whole.success) {
    throw new Refusal(
      `the ledger would not be valid with this entry appended (${zodIssues(whole.error.issues)}) — nothing was written`,
    );
  }

  return { step, workload, authority, digest, path, branch, existing, ledger: whole.data, entry };
}

// ---------------------------------------------------------------------------
// Landing
// ---------------------------------------------------------------------------

/** The pull request that carries a step's not-yet-merged record, when one is open. */
export async function findOpenConfirmationPr(
  gh: Octokit,
  repo: RepoRef,
  input: { workload: string; stepId: string; base: string },
): Promise<{ number: number; url: string } | null> {
  const head = confirmationBranch(input.workload, input.stepId);
  const { data } = await gh.pulls.list({ ...repo, state: 'open', head: `${repo.owner}:${head}`, base: input.base });
  return data[0] ? { number: data[0].number, url: data[0].html_url } : null;
}

/** The pull request title, from the decision — the row in the pull request list
 *  has to say what was decided, because that is what the merge is about to make true. */
export function confirmationPrTitle(input: {
  decision: DecisionEntry['decision'];
  authority: string;
  stepId: string;
  workload: string;
}): string {
  const what =
    input.decision === 'approved'
      ? `${input.authority} approved`
      : input.decision === 'rejected'
        ? `${input.authority} refused`
        : `override of the ${input.authority} refusal on`;
  return `Confirmation: ${what} ${input.stepId} (${input.workload})`;
}

/**
 * Compose, validate, and land — a branch from the default branch, one commit, one
 * pull request. Every refusal happens inside `composeConfirmationEntry`, BEFORE
 * the first write, and the writes themselves fail only as faults.
 */
export async function recordConfirmation(
  gh: Octokit,
  repo: RepoRef,
  input: RecordConfirmationInput,
): Promise<RecordConfirmationResult> {
  const composed = await composeConfirmationEntry(gh, repo, input);
  const { workload, step, path, branch, existing, ledger, entry } = composed;
  const head = confirmationBranch(workload, step.id);

  // ONE PULL REQUEST AT A TIME PER STEP. A second entry while the first is unmerged
  // would have to be appended to a ledger the default branch does not carry yet, and
  // the operator would be judging two decisions in one merge. The remedy is the
  // merge they already owe.
  const open = await findOpenConfirmationPr(gh, repo, { workload, stepId: step.id, base: branch });
  if (open) {
    throw new Refusal(
      `a confirmation for ${step.id} is already waiting to be merged — pull request #${open.number} (${open.url}). Merge it (or close it) first; ` +
        'the next entry is appended to what that merge puts on record',
    );
  }

  // The branch, from the default branch's HEAD so the ledger the commit rewrites is
  // the one just read. A branch left behind by an earlier, merged confirmation is
  // moved forward rather than reused where it stands: committing onto a stale
  // branch would carry the file's history from before the last merge.
  const { data: base } = await gh.git.getRef({ ...repo, ref: `heads/${branch}` });
  const baseSha = base.object.sha;
  // Probe first, as ensureEvidenceBranch does, rather than create-and-catch-422: the
  // client logs every non-2xx except 304/404, and a stale branch is routine here.
  let branchExists = true;
  try {
    await gh.git.getRef({ ...repo, ref: `heads/${head}` });
  } catch (error: unknown) {
    if (errorStatus(error) !== 404) throw error;
    branchExists = false;
  }
  if (branchExists) {
    await gh.git.updateRef({ ...repo, ref: `heads/${head}`, sha: baseSha, force: true });
  } else {
    try {
      await gh.git.createRef({ ...repo, ref: `refs/heads/${head}`, sha: baseSha });
    } catch (error: unknown) {
      // A concurrent recorder got there between the probe and the create.
      if (errorStatus(error) !== 422) throw error;
      await gh.git.updateRef({ ...repo, ref: `heads/${head}`, sha: baseSha, force: true });
    }
  }

  await gh.repos.createOrUpdateFileContents({
    ...repo,
    path,
    message:
      `confirmation: ${entry.decision} for ${step.id} (${workload}) by ${entry.by.name}, recorded by @${input.actor} at ${entry.at}`,
    content: Buffer.from(`${JSON.stringify(ledger, null, 2)}\n`).toString('base64'),
    branch: head,
    ...(existing ? { sha: existing.sha } : {}),
  });

  const { data: pr } = await gh.pulls.create({
    ...repo,
    title: confirmationPrTitle({ decision: entry.decision, authority: ledger.authority, stepId: step.id, workload }),
    head,
    base: branch,
    // Operator-visible: what merging does, in the operator's terms, and why the
    // required checks will not stand in the way.
    body:
      `Puts the ${ledger.authority} authority's answer about \`${step.id}\` on record at \`${path}\`.\n\n` +
      `- **Decision:** ${entry.decision}\n` +
      `- **By:** ${entry.by.name} (${entry.by.contact}${entry.by.role ? `, ${entry.by.role}` : ''})\n` +
      `- **At:** ${entry.at}\n` +
      `- **Rationale:** ${entry.rationale}\n\n` +
      `${existing ? `Appends to the ${existing.ledger.decisions.length} earlier decision(s) already on \`${branch}\`.` : 'Starts the ledger for this step.'} ` +
      'Merging is what puts it on record: this pull request carries neither a plan nor a deliverable, so both required checks report ' +
      `skipped and you can merge it yourself. On merge, the confirmation workflow labels the step's tracking issue.\n\n` +
      `Recorded from the review page by @${input.actor}.`,
  });

  return {
    path,
    branch,
    head,
    decision: entry.decision,
    created: existing === null,
    pr: { number: pr.number, url: pr.html_url },
  };
}
