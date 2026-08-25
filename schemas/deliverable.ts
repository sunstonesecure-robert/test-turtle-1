import { z } from 'zod';

/**
 * The DELIVERABLE PATCH envelope (T204, FR-060) — the only channel by which a
 * build's work reaches the repository.
 *
 * Same shape as every other artifact seam in this system: an untrusted executor
 * with `contents: read` uploads it, a deterministic writer with the write scope
 * validates it and performs the write. `plan.json`→`plan-publish` and
 * `vt-results.json`→`vt-report` already work this way; this is the third.
 *
 * WHY A FILE SET AND NOT A UNIFIED DIFF. The contract calls this a "patch", and the
 * obvious reading is `git diff` output. It is not, deliberately, and the reason is
 * D2/D5:
 *
 *   1. **The gates need the path list to be a FACT, not a parse.** D2 asks whether
 *      every path stays inside the step's declared scope and D5 asks whether any
 *      path is reserved. Against a unified diff both questions route through a diff
 *      parser, and a parser bug is a scope bypass — `--- /dev/null` vs `a/`
 *      prefixes, renames, mode changes, quoted paths with embedded newlines. Here
 *      the paths ARE the data, so both gates are set arithmetic over explicit
 *      strings and the parser cannot be wrong about what is being written.
 *   2. **Applying a diff needs git and a credential.** `git apply` + `git push`
 *      would put the write back in a shell with a token, which is the capability
 *      the substrate split withholds. A file set is written through the git DATA
 *      API (blob → tree → commit → ref), so the writer never holds a git
 *      credential either.
 *   3. **It is idempotent and reviewable.** Re-delivering the same envelope
 *      produces the same tree, so a `workflow_run` re-delivery is a no-op rather
 *      than a conflicted re-apply.
 *
 * The cost is stated rather than hidden: an executor must emit whole files, not
 * hunks. For the deliverables this system builds — the operator's own software, a
 * bounded step at a time — that is the natural unit anyway, and it removes an
 * entire class of "the patch applied but not the way anyone expected".
 */

/**
 * One file the deliverable writes. `content` is the WHOLE file, because a hunk
 * cannot be validated against a scope without also being applied first.
 */
export const DeliverableFile = z
  .object({
    /** repo-relative, forward slashes. Traversal and absolute paths are refused by
     *  the gate (`isRepoRelative`), not normalized into safety. */
    path: z.string().min(1),
    content: z.string(),
    /** `utf-8` (default) or `base64` for binary deliverables — an image, a font, a
     *  compiled asset. Base64 is decoded by the writer, never executed by it. */
    encoding: z.enum(['utf-8', 'base64']).optional(),
  })
  .strict();

export const DeliverablePatch = z
  .object({
    /**
     * The frozen plan tag this build was dispatched on. Carried IN the artifact for
     * the same reason `vt-results.json` carries it: the `workflow_run` payload the
     * deterministic writer is triggered by cannot see the dispatch inputs, so there
     * is nowhere else for the frozen ref to come from. Treated as a CLAIM — D1
     * binds it against the triggering run's own `head_sha`, which the executor
     * cannot author.
     */
    plan_ref: z.string().min(1),
    /**
     * The one plan step this deliverable delivers. **Executor-authored, and
     * therefore not trusted on its own** (GHI #116): a lying executor could name a
     * step whose declared scope is wider than the one it was dispatched for. D1
     * closes that by deriving the step INDEPENDENTLY from the build's work item
     * (exactly one step's `tracking_issue` names it, which B3 already proved) and
     * refusing any disagreement. The field stays in the envelope because the
     * chunkless case has no independent derivation, and because a claim that can be
     * checked is more useful than an absence.
     */
    step_id: z.string().regex(/^step-[a-z0-9-]+$/),
    /** Which executor produced this — recorded on the PR for provenance (FR-065).
     *  Descriptive, never authoritative: it labels the work, it does not authorize it. */
    executor_id: z.string().min(1),
    /** The executor's tier/engine/model, as configured. Provenance only (FR-065). */
    executor: z
      .object({
        tier: z.enum(['in-sandbox', 'spawned']),
        engine: z.string().min(1).optional(),
        image: z.string().min(1).optional(),
        model: z.string().min(1).optional(),
      })
      .strict()
      .optional(),
    files: z.array(DeliverableFile),
    /** Paths this deliverable REMOVES. Held to exactly the same scope and reserved
     *  checks as `files` — deleting a file is a write, and a deliverable that could
     *  delete outside its scope would be strictly worse than one that could add. */
    deletions: z.array(z.string().min(1)).optional(),
    /** One line for the deliverable commit message and the PR title. */
    summary: z.string().min(1).optional(),
  })
  .strict();

export type DeliverablePatch = z.infer<typeof DeliverablePatch>;
export type DeliverableFile = z.infer<typeof DeliverableFile>;

/**
 * Every path the envelope writes or removes — the single list both D2 and D5 read.
 *
 * One function rather than two call sites assembling it, because the two gates
 * disagreeing about WHICH paths a patch touches would make one of them wrong about
 * a patch the other judged correctly.
 */
export function patchPaths(patch: DeliverablePatch): string[] {
  return [...patch.files.map((f) => f.path), ...(patch.deletions ?? [])];
}
