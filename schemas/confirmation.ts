import { z } from 'zod';

/**
 * Zod mirror of schemas/confirmation.schema.json (the contract copy is the source of truth).
 * Rules mirrored here:
 *  - step_id reuses plan.schema.json's step id pattern — the record is looked up BY the
 *    step id (confirmations/<workload>/<step-id>.json), so two patterns drifting apart would let a
 *    plan accept a step id that can carry no confirmation
 *  - authority is the V1 enum (customer|clinical|legal), extensible in a future schema
 *    version (data-model.md); until it is, an unlisted authority names nobody qualified
 *  - confirmer requires BOTH halves: a name nobody can reach cannot be corroborated
 *    after the build, a contact with no name attributes the sign-off to no one
 *  - confirmed_at is an ISO 8601 INSTANT, zone included — the record is expected AFTER
 *    the freeze (FR-024), so a zoneless "14:02" is not the moment the gate is about.
 *    `offset: true` because the JSON Schema says `format: date-time` (RFC 3339), which
 *    admits a numeric offset: zod 3's bare .datetime() takes only `Z`, so without it a
 *    record valid against the source of truth would be refused by the gate reading it.
 *  - the three attribution fields must carry NON-WHITESPACE text. A bare minLength lets
 *    `{"name":" ","contact":" ","scope":" "}` through, and that record unblocks a
 *    high-stakes build while attributing the sign-off to nobody and scoping it to
 *    nothing — the exact hollow record the gate exists to refuse.
 *  - `workload` + `step_digest` BIND the record to the work it was given about
 *    (added 2026-08-17, GHI #95). Without them the record matched on step id alone,
 *    which is unique only WITHIN a plan and says nothing about which version of that
 *    step was described to the authority. Two reachable failures, both closed here:
 *    workloads `alpha` and `beta` both declaring `step-billing-cycle` shared one
 *    repo-global file, so alpha's customer answer satisfied beta's build; and a v1
 *    answer satisfied a v2 build in which the same step id meant materially different
 *    work — precisely what US6 exists to prevent. The digest is over the step's own
 *    CONTENT rather than the plan version, so a re-freeze that left the step alone
 *    keeps its sign-off: binding to the version would expire every confirmation on
 *    every re-approval, which is safe but makes flagging a step expensive enough to
 *    discourage it (operator decision, 2026-08-17).
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
    .regex(/\S/, `${field} must contain non-whitespace text — a blank attributes the confirmation to no one`);

export const Confirmer = z
  .object({
    name: attributed('confirmer.name'),
    contact: attributed('confirmer.contact'),
  })
  .strict();

export const ConfirmationRecord = z
  .object({
    step_id: stepId,
    workload: workloadSlug,
    step_digest: stepDigest,
    authority: z.enum(['customer', 'clinical', 'legal']),
    confirmer: Confirmer,
    confirmed_at: z.string().datetime({ offset: true }),
    scope: attributed('scope'),
  })
  .strict();

export type ConfirmationRecord = z.infer<typeof ConfirmationRecord>;
export type Confirmer = z.infer<typeof Confirmer>;
