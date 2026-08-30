import { z } from 'zod';

/**
 * EXECUTOR CONFIGURATION (T204/T219, FR-059/FR-065/FR-066) — *which* agent builds.
 *
 * Operator configuration, not a stored record. The system ships one conformant
 * executor and requires none: anything runnable by GitHub Agentic Workflows that
 * satisfies `contracts/build-executor.md` is a legitimate choice, and the gates and
 * the deterministic writer must not be able to tell the difference (SC-019).
 *
 * The shape exists so that provenance is recordable (FR-065 — a deliverable can be
 * correlated with the agent that produced it) and so that ONE prohibition is
 * enforceable at config load rather than trusted: the spawned tier's guardrailed
 * runner (FR-066).
 */

/**
 * The guardrailed-runner declaration the spawned tier must carry (FR-066).
 *
 * For the in-sandbox tier containment is STRUCTURAL — gh-aw compiles to
 * `.lock.yml`, pins every action to an immutable SHA, passes
 * actionlint/zizmor/poutine, and constrains egress by `allow-domains`. None of that
 * travels with an operator-supplied image, and the gates cannot inspect the inside
 * of one. So for the spawned tier the containment obligation moves to the operator,
 * and this is where they discharge it: allowlists for what may execute and what may
 * be touched, declared rather than assumed.
 *
 * Both lists must be NON-EMPTY. An empty allowlist is not "no restriction stated",
 * it is "everything permitted" — the absent-≠-success mistake in configuration
 * form, and the exact thing a declaration-shaped field invites if it accepts `[]`.
 */
export const GuardrailedRunner = z
  .object({
    binaries: z.array(z.string().min(1)).min(1),
    paths: z.array(z.string().min(1)).min(1),
  })
  .strict();

/**
 * The executor object. Since 2026-08-29 (GHI #163) there is NO per-executor merge
 * checkpoint field: merge authority is derived from the step (high-stakes), the paths
 * the deliverable touches, and the repository-wide `BUILD_REQUIRES_OPERATOR_MERGE`.
 * `.strict()` means a stale `requires_operator_merge:` line fails D4.
 */
export const ExecutorConfig = z
  .object({
    /** Recorded on every deliverable this executor produces (FR-065). */
    id: z.string().regex(/^[a-z0-9][a-z0-9-]*$/, 'executor id must be lowercase kebab-case'),
    /**
     * `in-sandbox` — a gh-aw-compiled workflow; containment is structural. The V1
     * default and the reference tier.
     * `spawned` — an operator-supplied image driving execution outside the gh-aw
     * container; containment is CONDITIONAL and the operator supplies it.
     */
    tier: z.enum(['in-sandbox', 'spawned']),
    /** gh-aw's compile-time engine selection. In-sandbox tier only. */
    engine: z.enum(['copilot', 'claude', 'gemini', 'codex']).optional(),
    /** Container image ref. Spawned tier only — gh-aw owns the image in-sandbox. */
    image: z.string().min(1).optional(),
    /** Must exist in gh-aw's pinned AI-credits catalog or the proxy rejects the run. */
    model: z.string().min(1).optional(),
    guardrailed_runner: GuardrailedRunner.optional(),
  })
  // Deleted 2026-08-29 (GHI #163, option 2): `requires_operator_merge` used to live
  // here as a per-executor FR-062 escalation. It was never read on the live path — the
  // merge checkpoint is the REPOSITORY'S (`BUILD_REQUIRES_OPERATOR_MERGE`), plus
  // escalation by what the change touches (a subject workflow or a `CHECKPOINT_PATHS`
  // entry; GHI #174 D6.7). A knob that looked like it did something and did nothing is
  // the worst kind of configuration. Because this object is `.strict()`, an executor
  // file still carrying the field is now REFUSED by D4 ("Unrecognized key") rather
  // than silently ignored — the operator learns the knob is gone at the gate, not by
  // wondering why it had no effect.
  .strict()
  .superRefine((cfg, ctx) => {
    // FR-066, enforced at load rather than documented and hoped for. An executor
    // that drives execution outside the compiled sandbox without declaring its
    // allowlists is not conformant, and the honest moment to say so is before it
    // runs — not after it has produced a patch nobody can reason about.
    if (cfg.tier === 'spawned' && !cfg.guardrailed_runner) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['guardrailed_runner'],
        message:
          'tier "spawned" requires a guardrailed_runner declaration with non-empty binaries and paths allowlists ' +
          '(FR-066). Execution outside the gh-aw container carries none of the compiled tier\'s structural ' +
          'containment — no SHA pinning, no scanner pass, no egress allowlist — and the gates cannot inspect an ' +
          'operator-supplied image. The obligation is real, not a formality.',
      });
    }
    if (cfg.tier === 'spawned' && !cfg.image) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['image'], message: 'tier "spawned" requires an image' });
    }
    if (cfg.tier === 'in-sandbox' && !cfg.engine) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['engine'],
        message:
          'tier "in-sandbox" requires an engine (copilot|claude|gemini|codex) — the constitution\'s standing ' +
          'multi-engine constraint is that this is selectable per workflow, so it must be stated',
      });
    }
  });

export type ExecutorConfig = z.infer<typeof ExecutorConfig>;

/** Merge authority as the gates resolve it (FR-062). Not a config value — a
 *  DERIVED verdict, because config is only ever one of its three inputs. */
export type MergeAuthority = 'pre-authorized' | 'operator-merge-required';
