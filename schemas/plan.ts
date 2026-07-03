import { z } from 'zod';

/**
 * Zod mirror of schemas/plan.schema.json (the contract copy is the source of truth).
 * Conditional rules mirrored here:
 *  - stand_in is required (non-empty) when evidence_tag === "assumption"
 *  - authority is required (customer|clinical|legal) when high_stakes === true
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
    authority: z.enum(['customer', 'clinical', 'legal']).nullable().optional(),
    depends_on: z.array(stepId),
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
    check: z.string().min(1),
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
