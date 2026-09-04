import { z } from 'zod';

/**
 * Zod mirror of schemas/confirmation.schema.json (the contract copy is the source of truth).
 *
 * A LEDGER, NOT AN ANSWER (amended 2026-08-27, GHI #96). The record used to carry
 * seven flat fields describing one confirmation — who, when, what scope — and no
 * field at all for WHAT WAS DECIDED. B5 read "a valid record exists" as
 * authorization, so an operator who wrote down a clinician's refusal unblocked the
 * build that refusal existed to stop. The only way to express "no" was to write
 * nothing, which is byte-identical to nobody having been asked yet. The record now
 * holds an ordered list of decisions, each saying what was decided, about which
 * version of the step, by whom, and why.
 *
 * ONE FILE, NOT TWO (operator decision, 2026-08-27). Lifting a block could have been
 * a second file beside the confirmation; it is an appended entry instead. A second
 * file adds linkage to maintain for no gain, and the objection it was meant to answer
 * — that an operator would be editing a document attributed to a doctor — dissolves
 * once the file is understood as the STEP's decision log rather than the authority's
 * document. Every entry names its own author, so appending never rewrites.
 *
 * APPEND-ONLY IS A CONVENTION, NOT A GUARANTEE (operator decision, 2026-08-27). The
 * ledger lives on the protected default branch and git history is its audit trail. A
 * rewritten entry is VISIBLE in the commit log but the gate reads only the file at
 * HEAD and will not detect it. Accepted deliberately: tamper-evidence would mean the
 * gate diffing every build against previous versions, and that was judged not worth
 * its cost. Recorded here so the limit is a decision rather than an oversight.
 *
 * Rules mirrored from the JSON Schema:
 *  - step_id reuses plan.schema.json's step id pattern — the record is looked up BY the
 *    step id (confirmations/<workload>/<step-id>.json), so two patterns drifting apart would let a
 *    plan accept a step id that can carry no confirmation
 *  - authority is the V1 enum (customer|clinical|legal|security-regulatory), extensible in a future schema
 *    version (data-model.md); until it is, an unlisted authority names nobody qualified
 *  - `by` requires BOTH halves: a name nobody can reach cannot be corroborated
 *    after the build, a contact with no name attributes the decision to no one
 *  - `at` is an ISO 8601 INSTANT, zone included — decisions are expected AFTER the
 *    freeze (FR-024), so a zoneless "14:02" is not the moment the gate is about.
 *    `offset: true` because the JSON Schema says `format: date-time` (RFC 3339), which
 *    admits a numeric offset: zod 3's bare .datetime() takes only `Z`, so without it a
 *    record valid against the source of truth would be refused by the gate reading it.
 *  - the attribution and rationale fields must carry NON-WHITESPACE text. A bare
 *    minLength lets `{"name":" ","contact":" ","rationale":" "}` through, and that entry
 *    moves a high-stakes gate while attributing the decision to nobody and justifying
 *    it with nothing — the exact hollow record the gate exists to refuse.
 *  - `workload` + per-entry `step_digest` BIND each decision to the work it was given
 *    about (added 2026-08-17, GHI #95). Without them a record matched on step id alone,
 *    which is unique only WITHIN a plan and says nothing about which version of that
 *    step was described to the authority. Two reachable failures, both closed:
 *    workloads `alpha` and `beta` both declaring `step-billing-cycle` shared one
 *    repo-global file, so alpha's customer answer satisfied beta's build; and a v1
 *    answer satisfied a v2 build in which the same step id meant materially different
 *    work — precisely what US6 exists to prevent. The digest is over the step's own
 *    CONTENT rather than the plan version, so a re-freeze that left the step alone
 *    keeps its sign-off: binding to the version would expire every confirmation on
 *    every re-approval, which is safe but makes flagging a step expensive enough to
 *    discourage it (operator decision, 2026-08-17).
 *
 * THE DIGEST MOVED ONTO THE ENTRY (2026-08-27). It was a header field, so a step whose
 * wording changed invalidated the whole record and B5 reported "no confirmation
 * recorded" — false, and it sent the operator to ask a question that had already been
 * answered about the previous version. Per-entry, the ledger survives a revision: the
 * gate reads the newest entry matching the CURRENT step and can say which earlier
 * version was decided instead of pretending the file is empty.
 */

const stepId = z.string().regex(/^step-[a-z0-9-]+$/);
/** Same shape as SLUG_RE in workloads.ts — kebab-case, no leading hyphen. Re-spelled
 *  rather than imported because this file is the zod mirror of a JSON Schema whose
 *  `pattern` is the source of truth; the two are checked against each other in
 *  tests/contract/confirmation-record.test.ts. */
const workloadSlug = z.string().regex(/^[a-z0-9][a-z0-9-]*$/);
/** `sha256:` + 64 lowercase hex. Prefixed so the field is self-describing and a
 *  future algorithm change is a visible one rather than a silent reinterpretation. */
const stepDigest = z.string().regex(/^sha256:[0-9a-f]{64}$/);

/** Mirrors the JSON Schema's `"pattern": "\\S"` — at least one non-whitespace character. */
const attributed = (field: string) =>
  z
    .string()
    .min(1)
    .regex(/\S/, `${field} must contain non-whitespace text — a blank attributes the decision to no one`);

export const Attribution = z
  .object({
    name: attributed('by.name'),
    contact: attributed('by.contact'),
  })
  .strict();

/** The three things a decision can be. `overridden` is the operator's act, not the
 *  authority's: it lifts a recorded refusal, and the gate reports it loudly rather
 *  than passing in silence. */
export const DecisionKind = z.enum(['approved', 'rejected', 'overridden']);

export const Decision = z
  .object({
    decision: DecisionKind,
    step_digest: stepDigest,
    by: Attribution,
    at: z.string().datetime({ offset: true }),
    rationale: attributed('rationale'),
  })
  .strict();

/** The ledger shape — what every writer emits from 2026-08-27 on.
 *  Exported so the contract test can make PATH-PRECISE assertions against one
 *  branch: a union reports its failures under `invalid_union`, which would let a
 *  record rejected for the wrong reason pass a test that only checked it failed. */
export const Ledger = z
  .object({
    step_id: stepId,
    workload: workloadSlug,
    authority: z.enum(['customer', 'clinical', 'legal', 'security-regulatory']),
    decisions: z.array(Decision).min(1),
  })
  .strict()
  .superRefine((doc, ctx) => {
    // Chronology is part of the record's meaning: "the latest decision wins" is only
    // a rule if the order is trustworthy. Non-decreasing rather than strictly
    // increasing, because two decisions genuinely can share a timestamp at second
    // resolution and refusing that would reject an honest record.
    for (let i = 1; i < doc.decisions.length; i += 1) {
      const prev = Date.parse(doc.decisions[i - 1]!.at);
      const here = Date.parse(doc.decisions[i]!.at);
      if (here < prev) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['decisions', i, 'at'],
          message:
            `is earlier than the decision before it (${doc.decisions[i - 1]!.at}) — the ledger is chronological, ` +
            'oldest first, because the gate reads the LATEST decision and out-of-order entries would change which one that is',
        });
      }
    }
    // An override lifts a refusal. With nothing to lift it is a mis-recorded
    // approval wearing a heavier word — and it would read, to anyone auditing, as
    // though an authority had refused when none ever did.
    doc.decisions.forEach((entry, i) => {
      if (entry.decision !== 'overridden') return;
      const liftsSomething = doc.decisions
        .slice(0, i)
        .some((earlier) => earlier.decision === 'rejected' && earlier.step_digest === entry.step_digest);
      if (!liftsSomething) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['decisions', i, 'decision'],
          message:
            'is an override with no earlier `rejected` decision about this same version of the step to lift — ' +
            'record the authority\'s refusal first, or record this as `approved` if that is what it is',
        });
      }
    });
  });

/**
 * The pre-ledger shape. Accepted and normalized, never emitted.
 *
 * Reading an absent decision as `approved` is not a compatibility guess: refusal was
 * unrepresentable when these records were written, so an approval is the only thing
 * such a record could have meant. Constitution *Frozen-Artifact Compatibility*, route
 * (a) — a shim, with the reason it is sound recorded beside it.
 *
 * Exported for the same reason as `Ledger`: path-precise assertions in the contract test.
 */
export const Legacy = z
  .object({
    step_id: stepId,
    workload: workloadSlug,
    step_digest: stepDigest,
    authority: z.enum(['customer', 'clinical', 'legal', 'security-regulatory']),
    confirmer: z
      .object({ name: attributed('confirmer.name'), contact: attributed('confirmer.contact') })
      .strict(),
    confirmed_at: z.string().datetime({ offset: true }),
    scope: attributed('scope'),
  })
  .strict();

/**
 * Both shapes in, one shape out. Everything downstream — B5, the confirm-record
 * validator, the review panel — sees a ledger and never has to ask which era a
 * record came from.
 */
export const ConfirmationRecord = z.union([Ledger, Legacy]).transform((doc): ConfirmationLedger => {
  if ('decisions' in doc) return doc;
  return {
    step_id: doc.step_id,
    workload: doc.workload,
    authority: doc.authority,
    decisions: [
      {
        decision: 'approved' as const,
        step_digest: doc.step_digest,
        by: doc.confirmer,
        at: doc.confirmed_at,
        rationale: doc.scope,
      },
    ],
  };
});

export type Decision = z.infer<typeof Decision>;
export type Attribution = z.infer<typeof Attribution>;
export type ConfirmationLedger = {
  step_id: string;
  workload: string;
  authority: 'customer' | 'clinical' | 'legal' | 'security-regulatory';
  decisions: Decision[];
};
export type ConfirmationRecord = ConfirmationLedger;
