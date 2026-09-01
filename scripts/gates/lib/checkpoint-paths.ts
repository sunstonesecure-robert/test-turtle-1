import { isSubjectWorkflowPath } from '../../install-manifest';
import { matchesAny, normalizePath } from './globs';

/**
 * CHECKPOINT BY WHAT THE CHANGE TOUCHES (T272, GHI #163 option 3, GHI #174 D6.7).
 *
 * Merge authority (FR-062) used to be decided by two inputs: whether the STEP is
 * high-stakes, and whether the REPOSITORY has `BUILD_REQUIRES_OPERATOR_MERGE` set.
 * Neither looks at the diff. That left a gap GHI #163 named: the deliverable that
 * most needs a human to read it is identified by *what it changes*, not by which
 * plan step produced it — a rewritten IAM policy, an organization config, and above
 * all an agent-authored GitHub Actions workflow (GHI #174), which decides what runs
 * with which credentials the moment it lands.
 *
 * So this module answers a third question for D3 and its siblings: does the patch
 * touch a CHECKPOINT PATH? Two sources, both escalation-only:
 *
 *   1. the subject-workflow namespace (`.github/workflows/<workload-slug>_<name>.yml`,
 *      `subjectWorkflowRe` in the install manifest). Unconditional and
 *      unconfigurable — D6.7 in GHI #174: an agent-authored workflow never lands on
 *      the default branch without a human having read it, whatever
 *      `BUILD_REQUIRES_OPERATOR_MERGE` says.
 *   2. the operator's own list, the `CHECKPOINT_PATHS` Actions variable — scope-style
 *      globs, newline- or comma-separated. Additive: it can only ADD paths that wait
 *      for the operator; nothing here can pre-authorize a path a gate escalates.
 *
 * WHY THE SCOPE READING OF A BARE NAME. The operator writes these in the same grammar
 * a plan step's `scope` uses (`plan-propose.md` teaches it): `config/iam-config.yaml`
 * is that one file, `config/**` or `config/` is the directory. Reading a bare
 * `config/iam-config.yaml` as a directory would be harmless here (it would escalate
 * more, never less) but it would teach two meanings for one spelling, which is the
 * D2-vs-G16 disagreement `globs.ts` exists to prevent. One grammar, read the way its
 * author learned it.
 *
 * The result names each path AND why it is a checkpoint, because the Builds page, the
 * gate detail and the merger's refusal all quote it, and three callers phrasing one
 * decision three ways is the `refusalDetail` lesson (GHI #127).
 *
 * WHY THIS MODULE TAKES NO SLUG, WHEN EVERY OTHER READER OF THE NAMESPACE DOES (T279,
 * operator decision 2026-09-01). The namespace became per-workload —
 * `.github/workflows/<workload-slug>_<name>.yml` — and everywhere else the slug is
 * threaded through with ABSENT meaning "the namespace is empty", because there absent
 * has to fail CLOSED: an empty namespace reserves more, refuses more, escalates more.
 *
 * HERE THE SAME DEFAULT WOULD FAIL OPEN, and that is the whole reason for the
 * asymmetry. A `false` from the namespace test in this module means "not a checkpoint"
 * — LESS escalation, not more. A caller that forgot to thread the slug would silently
 * stop making an agent-authored deploy workflow wait for its human, which is exactly
 * the unconditional promise D6.7 exists to make. And it would typecheck.
 *
 * So the question this module asks is deliberately slug-INDEPENDENT: is this path in
 * ANY workload's namespace? Threading a slug could only ever SHRINK that set, and
 * there is nothing to gain by shrinking it — a file carrying another workload's prefix
 * is refused outright by D5 and never reaches a merge, so treating it as a checkpoint
 * costs nothing and mis-treating it as ordinary would cost the promise. The rule stays
 * escalation-only in the one direction that matters: every file shaped like an
 * agent-authored deploy workflow waits for the operator, whoever's prefix it carries.
 */

/** The Actions repository variable the operator lists their checkpoint paths in. The
 *  workflows pass it through as an env var of the same name (`CONFIGURATION_GUIDE.md` §3). */
export const CHECKPOINT_PATHS_VARIABLE = 'CHECKPOINT_PATHS';

/** Why a namespace path is a checkpoint — one sentence, reused verbatim by every caller.
 *  Second person, like the operator-glob reason below: this sentence reaches the Builds
 *  page and the pull-request body, where the reader IS the operator (T274 aligned it with
 *  the wording the contract and CONFIGURATION_GUIDE quote). */
export const SUBJECT_WORKFLOW_CHECKPOINT_WHY = 'an operator deploy workflow always waits for your own merge';

/**
 * Is this path inside ANY workload's subject-workflow namespace? (T279)
 *
 * Not a second spelling of the naming rule — it ASKS the manifest's own predicate, and
 * only supplies the missing argument: the prefix the path itself claims, everything
 * before the first `_` of its basename. `isSubjectWorkflowPath` then validates that
 * prefix as a slug and matches the whole path, so every part of the rule is still
 * decided in one place. `Demo7_x.yml` (invalid slug), `demo7_x.lock.yml` (a dot in the
 * name — a compiled agentic lock is machinery) and `sub/demo7_x.yml` (nested) all
 * answer false here exactly as they do there.
 */
function isAnyWorkloadSubjectWorkflow(path: string): boolean {
  const claimedSlug = /^\.github\/workflows\/([^/_]+)_/.exec(normalizePath(path))?.[1];
  return claimedSlug !== undefined && isSubjectWorkflowPath(path, claimedSlug);
}

export interface CheckpointPath {
  /** the touched path, as the caller named it */
  path: string;
  /** plain language: why this path waits for the operator (no gate ids — this reaches the Builds page) */
  why: string;
}

/**
 * The `CHECKPOINT_PATHS` value → the operator's globs.
 *
 * Newline- OR comma-separated, because an Actions variable is edited in a one-line
 * text box in the GitHub UI (commas) and set from a YAML block in the docs
 * (newlines), and refusing either spelling would be a refusal about formatting.
 * Trimmed, empties dropped, duplicates collapsed. `undefined` (unset) is the empty
 * list — the documented default is "no operator-listed checkpoint paths".
 */
export function parseCheckpointPaths(value: string | undefined): string[] {
  if (value === undefined) return [];
  const out: string[] = [];
  for (const raw of value.split(/[\n,]/)) {
    const g = raw.trim();
    if (g.length === 0 || out.includes(g)) continue;
    out.push(g);
  }
  return out;
}

/**
 * Which of these paths are checkpoint paths, and why.
 *
 * One entry per offending path. The namespace reason wins when both apply, because
 * it is the unconditional one — an operator who also listed `.github/workflows/**`
 * has not made a subject workflow wait for a different reason.
 */
export function checkpointPathsTouched(paths: readonly string[], operatorGlobs: readonly string[] = []): CheckpointPath[] {
  const out: CheckpointPath[] = [];
  const seen = new Set<string>();
  for (const path of paths) {
    if (seen.has(path)) continue;
    seen.add(path);
    // ANY workload's namespace, not this one's — see the module docblock (T279): here
    // a `false` would mean LESS escalation, so the question must not depend on a slug
    // a caller might not have threaded.
    if (isAnyWorkloadSubjectWorkflow(path)) {
      out.push({ path, why: SUBJECT_WORKFLOW_CHECKPOINT_WHY });
      continue;
    }
    // The SCOPE reading (bareIsDirectory = false): see the module docblock.
    const matched = operatorGlobs.filter((g) => matchesAny(path, [g], false));
    if (matched.length === 0) continue;
    out.push({
      path,
      why:
        `you listed ${matched.map((g) => `\`${g}\``).join(' and ')} as a checkpoint path ` +
        `(the ${CHECKPOINT_PATHS_VARIABLE} repository variable), so this change waits for your own merge`,
    });
  }
  return out;
}
