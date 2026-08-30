import type { Octokit } from '@octokit/rest';
import type { RepoRef } from './client';
import { errorStatus } from './errors';
import { CHECKPOINT_PATHS_VARIABLE, parseCheckpointPaths } from '../../../scripts/gates/lib/checkpoint-paths';

/**
 * The operator's checkpoint paths, read from where they actually set them (T272,
 * GHI #163 option 3).
 *
 * Mirrors `readOperatorMergeCheckpoint` in `builds.ts` deliberately — same three
 * outcomes, same order, same reasons:
 *
 *   env `CHECKPOINT_PATHS` set   → parsed as-is, no API call. The CLIs run inside
 *                                  Actions and the workflow already passes the
 *                                  variable through as an env var; an empty string
 *                                  there means "unset", which is the empty list.
 *   variable 404                 → `[]`. Only a VERIFIED 404 is absence (GHI #150).
 *   anything else                → `'unreadable'`, warned once per repository. A
 *                                  403 is what a token without the fine-grained
 *                                  **Variables** permission gets — the exact defect
 *                                  T263 fixed for the boolean checkpoint one function
 *                                  away, so this reader was born with the fix rather
 *                                  than acquiring it after a live stall.
 *
 * `'unreadable'` and not `[]` on error because `[]` here means "no path waits for
 * the operator", which is the permissive answer, and reporting it about a setting we
 * could not read is how a deliverable the operator meant to read lands unread.
 * Callers degrade to `unknown` — except where the answer does not depend on this
 * list (a high-stakes step, or a subject-workflow path, both knowable without it).
 */
export type CheckpointPathsConfig = string[] | 'unreadable';

const warned = new Set<string>();

export async function readCheckpointPaths(gh: Octokit, repo: RepoRef): Promise<CheckpointPathsConfig> {
  const fromEnv = process.env[CHECKPOINT_PATHS_VARIABLE];
  if (fromEnv !== undefined) return parseCheckpointPaths(fromEnv);
  try {
    const { data } = await gh.actions.getRepoVariable({ ...repo, name: CHECKPOINT_PATHS_VARIABLE });
    return parseCheckpointPaths(data.value);
  } catch (error: unknown) {
    if (errorStatus(error) === 404) return [];
    const key = `${repo.owner}/${repo.repo}`;
    if (!warned.has(key)) {
      warned.add(key);
      // Said once, and with the remedy — a bare status code sends the operator to the
      // network tab to work out which setting it was about.
      console.warn(
        `Could not read the ${CHECKPOINT_PATHS_VARIABLE} repository variable of ${key} ` +
          `(${errorStatus(error) ?? 'no status'}). Merge authority for paths it would list is reported as ` +
          '"unknown" rather than guessed. A 403 means the token lacks the fine-grained "Variables" read ' +
          `permission — grant it, or set ${CHECKPOINT_PATHS_VARIABLE} in the dashboard environment to state ` +
          'the list directly.',
      );
    }
    return 'unreadable';
  }
}
