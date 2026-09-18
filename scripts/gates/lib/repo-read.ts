import type { Octokit } from '@octokit/rest';
import type { RepoRef } from '../../../dashboard/lib/github/client';
import { apiMessage, errorStatus } from '../../../dashboard/lib/github/errors';

/**
 * ONE FILE AT ONE REF, asked three ways (GHI #265, GHI #274).
 *
 * The same six-line `repos.getContent` + base64 decode + 404-means-absent body was
 * copied privately into `buildability.ts`, `checks-preflight.ts` and (inline) the
 * deliverable gate. Two gates now need a FOURTH copy, which is the point at which a
 * duplicated reader becomes three readers that answer differently. It lives here
 * instead, and the two callers that had their own were changed to import it.
 *
 * THREE READERS, BECAUSE THE QUESTION IS NOT ALWAYS "GIVE ME THE TEXT".
 *
 *   readTextAtRef   the historical one, unchanged in behaviour: the text, or `null`.
 *                   `null` folds together "absent", "a directory" and "not decodable",
 *                   which is fine for every caller that only wants to grep a lock file
 *                   and treats any other answer as a fault.
 *
 *   readFileAtRef   the same read, four-valued. `absent` is a VERIFIED 404 and is a
 *                   fact; `unreadable` is everything else and is NOT — a 5xx, a
 *                   throttle, a directory, a file too large for the contents API. A
 *                   caller that folds those together tells the operator a file is
 *                   missing when it is probably right there.
 *
 *   pathKindAtRef   what is AT the path, because "is there a directory here?" has no
 *                   answer in the other two. The contents API answers a directory with
 *                   an ARRAY, which both readers above turn into a null/unreadable —
 *                   so a gate asking whether `vendor/lza` will be there would report
 *                   the live case missing. `null` is the unknown, never `absent`.
 *
 * THE >1 MB HOLE IS CLOSED HERE RATHER THAN BY LUCK. Over about a megabyte GitHub
 * returns the entry with `encoding: 'none'` and an EMPTY `content`. Decoding that
 * yields `''`, and two empty strings compare equal — so a drift check would report "no
 * difference" on exactly the files it could not read. That is `unreadable`, and it says
 * how big the file was.
 */

/** What is at a path, when the answer might not be a fact. */
export type FileAtRef =
  | { kind: 'text'; text: string }
  /** a VERIFIED 404 — the path is not there, and that is a fact */
  | { kind: 'absent' }
  /** we could not find out: a fault, a directory, or a file too large to return */
  | { kind: 'unreadable'; why: string };

/** `file` / `directory` / `absent` are facts; `null` means we could not find out. */
export type PathKind = 'file' | 'directory' | 'absent';

/**
 * One file at one ref as text, or null when absent.
 *
 * KEEPS ITS ORIGINAL CONTRACT, deliberately: a non-404 error THROWS. Its callers use it
 * to decide refusals that already exist (`frozenWorkflowReason`, the preflight's lock
 * reads), and quietly downgrading a fault to "absent" there would be a regression
 * wearing the clothes of a robustness fix. A caller that wants the softer answer asks
 * `readFileAtRef` instead.
 */
export async function readTextAtRef(gh: Octokit, repo: RepoRef, path: string, ref: string): Promise<string | null> {
  try {
    const { data } = await gh.repos.getContent({ ...repo, path, ref });
    if (Array.isArray(data) || !('content' in data)) return null;
    return Buffer.from(data.content, 'base64').toString('utf8');
  } catch (error: unknown) {
    if (errorStatus(error) === 404) return null;
    throw error;
  }
}

/** The same read, with "could not find out" as its own answer. Never throws. */
export async function readFileAtRef(gh: Octokit, repo: RepoRef, path: string, ref: string): Promise<FileAtRef> {
  try {
    const { data } = await gh.repos.getContent({ ...repo, path, ref });
    if (Array.isArray(data)) return { kind: 'unreadable', why: `${path} is a directory at ${ref}, not a file` };
    if (!('content' in data)) return { kind: 'unreadable', why: `${path} at ${ref} returned no content` };
    // Over ~1 MB the contents API returns the entry with an empty `content` and an
    // encoding that is not base64. Decoding it gives '' — which compares equal to any
    // other file it also could not read.
    if (data.content === '' && data.encoding !== 'base64') {
      return { kind: 'unreadable', why: `${path} is too large for the contents API to return (${data.size} bytes)` };
    }
    return { kind: 'text', text: Buffer.from(data.content, 'base64').toString('utf8') };
  } catch (error: unknown) {
    if (errorStatus(error) === 404) return { kind: 'absent' };
    return { kind: 'unreadable', why: apiMessage(error) };
  }
}

/**
 * What is at this path, at this ref — and `null` when we could not find out.
 *
 * `path === ''` is the repository root and is a directory without asking.
 */
export async function pathKindAtRef(
  gh: Octokit,
  repo: RepoRef,
  path: string,
  ref: string,
): Promise<PathKind | null> {
  if (path === '') return 'directory';
  try {
    const { data } = await gh.repos.getContent({ ...repo, path, ref });
    if (Array.isArray(data)) return 'directory';
    // A SUBMODULE OR A SYMLINK COUNTS AS PRESENT, and that is a decision rather than an
    // accident of `!Array.isArray`. The question every caller asks is "will this be in
    // the tree?", and a submodule entry is: `actions/checkout` materializes it when the
    // workflow asks for submodules and leaves an empty directory when it does not —
    // either way the path is declared by the repository rather than missing from it, and
    // reporting it absent would accuse a plan of naming something its own tree names.
    // A non-array answer is a file, a symlink or a submodule. All three count as
    // PRESENT: the question every caller asks is "will this be in the tree?", and a
    // submodule entry is declared by the repository rather than missing from it.
    return 'file';
  } catch (error: unknown) {
    if (errorStatus(error) === 404) return 'absent';
    return null;
  }
}
