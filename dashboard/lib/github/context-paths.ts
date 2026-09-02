import { posix } from 'node:path';
import type { Octokit } from '@octokit/rest';
import type { RepoRef } from './client';
import { errorStatus } from './errors';

/**
 * Agent context selection (FR-053) — the rules for a designated context path,
 * in one place, dependency-free.
 *
 * Three surfaces designate context and every one of them must judge a path the
 * same way: the GitHub issue form (normalized by `scripts/intake-normalize.ts`
 * against a checkout), the dashboard's Introduce form (`### Context`, GHI #182)
 * and the answer composer (FR-056 references), the latter two against the
 * TARGET repository through the contents API. The shape rules and the size cap
 * live here; each surface supplies its own existence check and its own house
 * wording. This module imports nothing from the workload layer so that
 * `workloads.ts` can use it without a cycle through the intake script.
 */

export const CONTEXT_FOLDERS = ['runbooks', 'useful-context', 'inputs', 'specs'];

// Per-file ceiling for designated context items (PB-004: a 6.5 MB PDF designated
// as context hung a planning-agent run for ~6h — an oversized binary blob is a
// pathological token load). Configurable via CONTEXT_MAX_FILE_MB; a folder
// designation is checked file-by-file. Pre-extraction/RAG for large sources is
// the longer-term path (tracked separately) — this is the cheap intake guard.
const DEFAULT_CONTEXT_MAX_FILE_MB = 5;

/** Effective per-file context limit in bytes, from CONTEXT_MAX_FILE_MB (default 5), or the passed override. */
export function contextMaxFileBytes(override?: number): number {
  if (override !== undefined) return override;
  const mb = Number(process.env.CONTEXT_MAX_FILE_MB);
  return (Number.isFinite(mb) && mb > 0 ? mb : DEFAULT_CONTEXT_MAX_FILE_MB) * 1024 * 1024;
}

/**
 * FR-053 shape rules, filesystem-free: does the path fail to normalize to
 * inside a special context folder? Shared by intake (fs existence), the
 * Introduce form and the answer composer (API existence) so the surfaces
 * cannot drift.
 */
export function violatesSpecialFolderRules(line: string): boolean {
  // Repo paths are forward-slash canonical: backslash tricks and `..`
  // traversal are rejected outright, even when they would re-enter a
  // special folder after normalization.
  if (line.includes('\\') || line.includes('\0')) return true;
  if (line.split('/').includes('..')) return true;
  // Normalize BEFORE the prefix check (collapses `./` and `//`); absolute
  // paths, drive letters, and any first segment that isn't a special
  // folder are invalid.
  const normalized = posix.normalize(line);
  if (posix.isAbsolute(normalized) || /^[a-zA-Z]:/.test(normalized)) return true;
  return !CONTEXT_FOLDERS.includes(normalized.split('/')[0] ?? '');
}

/**
 * A designated path's problem, as a fact rather than a sentence. Two dashboard
 * surfaces render these with their own copy (the Introduce form under the
 * dashboard's house rules, the answer composer with its FR-056 wording) while
 * the judgment itself stays shared.
 */
export type ContextPathProblem =
  | { path: string; kind: 'shape' } // fails the special-folder shape rules (escape, absolute, outside the four folders)
  | { path: string; kind: 'missing' } // shape-valid, but not in the repository
  | { path: string; kind: 'oversized'; bytes: number; maxBytes: number }; // a file over the per-file cap

/**
 * Validate designated context paths against the TARGET repository: the shape
 * rules, existence through the contents API, and the per-file size cap. The
 * dashboard reviews a remote repo, so the local filesystem is not the checkout
 * the planning agent will read. Empty means every path is valid.
 *
 * A folder designation means everything under it, so the cap is applied to
 * every file it contains, walked through the API — each offending file is
 * reported as its own path, exactly as the checkout-side intake walk reports
 * it (`oversizedContextPaths`). This walk is not optional for the dashboard:
 * a dashboard-introduced workload already carries the marker, so the intake
 * normalizer returns `already_normalized` without looking at its context, and
 * this validator is the ONLY size check such a workload ever gets (PR #183
 * review). The walk is cheap where it matters — a directory listing already
 * carries each file's size, so the cost is one request per directory, never
 * one per file.
 */
export async function contextPathProblems(
  gh: Octokit,
  repo: RepoRef,
  paths: string[],
  opts: { maxFileBytes?: number } = {},
): Promise<ContextPathProblem[]> {
  const problems: ContextPathProblem[] = [];
  const maxBytes = contextMaxFileBytes(opts.maxFileBytes);
  for (const ref of paths) {
    if (violatesSpecialFolderRules(ref)) {
      problems.push({ path: ref, kind: 'shape' });
      continue;
    }
    // The form's "a folder means everything under it" idiom is written with a
    // trailing slash; the contents API addresses the directory without one.
    const path = posix.normalize(ref).replace(/(?<=.)\/+$/, '');
    try {
      const { data } = await gh.repos.getContent({ ...repo, path });
      if (Array.isArray(data)) {
        problems.push(...(await oversizedInDirectory(gh, repo, data, maxBytes)));
      } else if (data.type === 'file' && data.size > maxBytes) {
        problems.push({ path: ref, kind: 'oversized', bytes: data.size, maxBytes });
      }
      // Anything else a path can resolve to (symlink, submodule) is not a file
      // the agent reads; intake skips symlinks for the same reason.
    } catch (error: unknown) {
      if (errorStatus(error) === 404) {
        problems.push({ path: ref, kind: 'missing' });
      } else {
        throw error;
      }
    }
  }
  return problems;
}

/** One directory listing, as the contents API returns it. */
type DirectoryEntry = { type: string; path: string; size: number };

/**
 * Every file over the cap under a directory listing, recursively. Files are
 * judged from the listing itself (it carries `size`); only subdirectories cost
 * a further request. Symlinks and submodules are skipped, as in the intake walk.
 */
async function oversizedInDirectory(
  gh: Octokit,
  repo: RepoRef,
  entries: DirectoryEntry[],
  maxBytes: number,
): Promise<ContextPathProblem[]> {
  const problems: ContextPathProblem[] = [];
  for (const entry of entries) {
    if (entry.type === 'file') {
      if (entry.size > maxBytes) problems.push({ path: entry.path, kind: 'oversized', bytes: entry.size, maxBytes });
    } else if (entry.type === 'dir') {
      const { data } = await gh.repos.getContent({ ...repo, path: entry.path });
      if (Array.isArray(data)) problems.push(...(await oversizedInDirectory(gh, repo, data, maxBytes)));
    }
  }
  return problems;
}

/** `bytes` as an MB figure, the way intake reports sizes. */
export function megabytes(bytes: number, digits = 1): string {
  return (bytes / (1024 * 1024)).toFixed(digits);
}
