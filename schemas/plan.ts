import { z } from 'zod';

/**
 * Zod mirror of schemas/plan.schema.json (the contract copy is the source of truth).
 * Conditional rules mirrored here:
 *  - stand_in is required (non-empty) when evidence_tag === "assumption"
 *  - authority is required (customer|clinical|legal|security-regulatory) when high_stakes === true
 */

const stepId = z.string().regex(/^step-[a-z0-9-]+$/);

export const PlanStep = z
  .object({
    id: stepId,
    title: z.string().min(1),
    intent: z.string().min(1),
    acceptance: z.string().min(1),
    priority: z.enum(['MUST', 'SHOULD', 'COULD']),
    evidence_tag: z.enum(['verified', 'assumption']),
    stand_in: z.string().nullable().optional(),
    high_stakes: z.boolean(),
    authority: z.enum(['customer', 'clinical', 'legal', 'security-regulatory']).nullable().optional(),
    depends_on: z.array(stepId),
    /**
     * The path globs this step's deliverable may touch (T223, FR-061 / FR-068).
     *
     * OPTIONAL, and it has to be: `PlanStep` is `.strict()` and every plan frozen
     * before 2026-08-24 was written without it, so a required field would make each
     * of them permanently unbuildable (constitution: Frozen-Artifact Compatibility).
     * D2 therefore reports `not-applicable` — naming the absent field — for a step
     * that declares none, rather than passing silently: a scope-less plan cannot
     * make the containment promise, and a gate that says so is not the same as a
     * gate that agrees.
     *
     * IT IS AN INCLUSION ALLOWLIST, and that is exactly its limit (FR-068). It
     * answers "did the patch stay inside what the plan declared?" — which a plan
     * aimed at the wrong subject answers perfectly. So it can never be the thing
     * that keeps a build out of the oversight machinery: G16 refuses a plan whose
     * scope reaches there, and D5 refuses such a patch whatever this field says.
     */
    scope: z.array(z.string().min(1)).optional(),
    /**
     * The path globs this step must READ in order to write its deliverable — the read
     * side of `scope` (GHI #274, FR-071).
     *
     * `scope` declares what a step's deliverable may WRITE, and it is enforced twice:
     * G16 at approval, D2 at delivery. Nothing declared what a step must READ. What it
     * must read lived only as English in `acceptance` — which is exactly where
     * `vendor/lza` was on the run that cost a build: the step's acceptance required
     * every config key to be confirmed against a checked-out release source, nothing in
     * the environment provided one, the agent correctly emitted `missing_data`, and a
     * 9m41s run delivered nothing (2026-09-17, work item #113).
     *
     * OPTIONAL, on `scope`'s own argument above: every plan frozen before this field
     * existed lacks it, and a required field would make each of them unbuildable.
     *
     * IT IS NOT AN ALLOWLIST AND NOTHING IS REFUSED FOR VIOLATING IT. A build step must
     * read the repository it is editing — `step-config` reads `config/global-config.yaml`
     * in order to modify it — so "may read only what it declared" would make every step
     * in every plan illegal. What the field buys is a question that can be asked BEFORE
     * the spend: does anything actually provide this? A declared read has exactly three
     * legitimate providers — it exists at the approval ref, a step this one comes after
     * writes it, or a root `<name>.lock` fetches it into `vendor/<name>` — and plan-gate
     * G20 names a read with none of the three as an ADVISORY finding, never a refusal.
     *
     * Globs, the same grammar as `scope`, read through the same matcher.
     */
    reads: z.array(z.string().min(1)).optional(),
    /**
     * The WORK ITEM issue this step delivers — one field, one meaning
     * (clarified 2026-08-17, GHI #101). It is simultaneously the FR-025 mirror for
     * linkability and the FR-017 build binding, because in this system the issue
     * that represents a step's work IS its work item; the alternative, a second
     * `chunk_issue` field, was rejected because all three existing readers already
     * assume that meaning (B3's build binding, confirm-record's `confirmed:*`
     * label, the portfolio's conflict attribution).
     *
     * At most one step per issue: B3 asks whether ANY step tracks the named chunk,
     * so two would make "which step is this build for?" unanswerable.
     */
    tracking_issue: z.number().int().min(1).nullable().optional(),
  })
  .strict()
  .superRefine((step, ctx) => {
    if (step.evidence_tag === 'assumption' && (!step.stand_in || step.stand_in.length === 0)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['stand_in'],
        message: 'stand_in is required when evidence_tag is "assumption" (FR-020)',
      });
    }
    if (step.high_stakes && !step.authority) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['authority'],
        message: 'authority is required when high_stakes is true (FR-023)',
      });
    }
  });

export const VerificationTarget = z
  .object({
    id: z.string().regex(/^vt-[a-z0-9-]+$/),
    kind: z.enum(['expected-output', 'exact-copy', 'boundary-behavior']),
    /** The prose assertion the OPERATOR judged (FR-011). Required always — a
     *  command with no stated intent is not a commitment anyone approved. */
    check: z.string().min(1),
    /**
     * The EXECUTABLE form of `check` (T223, FR-063) — one shell command, run from
     * the repo root of the merged deliverable commit, exit status is the verdict.
     *
     * Present, verification is DETERMINISTIC: no model interprets the target, the
     * result is reproducible, and the operator approved the exact command that will
     * judge the work (constitution: Deterministic-First Execution). Absent, `check`
     * stays prose and a conformant executor in verify mode interprets it — the
     * pluggable path, which costs a model call and cannot be replayed.
     *
     * Optional for the same Frozen-Artifact reason as `scope`: every target frozen
     * before 2026-08-24 has only the prose form.
     */
    run: z.string().min(1).optional(),
    maps_to: z.array(stepId).min(1),
  })
  .strict();

export const BoundaryCase = z
  .object({
    id: z.string().regex(/^bc-[a-z0-9-]+$/),
    description: z.string().min(1),
    step_id: stepId.optional(),
  })
  .strict();

export const PlanDoc = z
  .object({
    feature: z.string().regex(/^[0-9]{3}-[a-z0-9-]+$|^[a-z0-9-]+$/),
    version: z.number().int().min(1),
    supersedes: z.number().int().min(1).nullable().optional(),
    run_id: z.string().min(1),
    andon_issue: z.number().int().min(1),
    steps: z.array(PlanStep).min(1),
    verification_targets: z.array(VerificationTarget),
    boundary_cases: z.array(BoundaryCase),
  })
  .strict();

export type PlanDoc = z.infer<typeof PlanDoc>;
export type PlanStep = z.infer<typeof PlanStep>;
export type VerificationTarget = z.infer<typeof VerificationTarget>;
export type BoundaryCase = z.infer<typeof BoundaryCase>;
