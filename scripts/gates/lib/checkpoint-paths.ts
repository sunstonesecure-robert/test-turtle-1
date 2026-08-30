import { isSubjectWorkflowPath } from '../../install-manifest';
import { matchesAny } from './globs';

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
 *   1. the subject-workflow namespace (`.github/workflows/subject_<name>.yml`,
 *      `SUBJECT_WORKFLOW_RE` in the install manifest). Unconditional and
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
 */

/** The Actions repository variable the operator lists their checkpoint paths in. The
 *  workflows pass it through as an env var of the same name (`CONFIGURATION_GUIDE.md` §3). */
export const CHECKPOINT_PATHS_VARIABLE = 'CHECKPOINT_PATHS';

/** Why a namespace path is a checkpoint — one sentence, reused verbatim by every caller.
 *  Second person, like the operator-glob reason below: this sentence reaches the Builds
 *  page and the pull-request body, where the reader IS the operator (T274 aligned it with
 *  the wording the contract and CONFIGURATION_GUIDE quote). */
export const SUBJECT_WORKFLOW_CHECKPOINT_WHY = 'an operator deploy workflow always waits for your own merge';

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
    if (isSubjectWorkflowPath(path)) {
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
