import { existsSync, lstatSync, readdirSync } from 'node:fs';
import { join, posix } from 'node:path';
import type { Octokit } from '@octokit/rest';
import { createClient, type RepoRef } from '../dashboard/lib/github/client';
import {
  parseWorkloadHeader,
  serializeWorkloadHeader,
  serializeWorkloadEvent,
} from '../dashboard/lib/github/markers';
import { getWorkload, SLUG_RE } from '../dashboard/lib/github/workloads';
import { errorMessage } from '../dashboard/lib/github/errors';

/**
 * Intake normalizer — makes GitHub-UI intake (the "Workload intake" issue
 * template) satisfy the issue-tracker contract. Issue forms render fields as
 * markdown, not the machine-readable `workload:v1` marker every reader keys
 * on, so template-created workloads were invisible to the dashboard and gates.
 * Run by the workload-intake workflow on issues opened/labeled with
 * `workload:proposed`: extracts the slug from the form section, validates it,
 * prepends the marker, and appends the `introduced` event comment — the same
 * end state as dashboard intake. A refusal comments the reason and removes
 * the label (re-add it after fixing to retry).
 *
 * Readiness (FR-029) is not re-checked here: this workflow only exists in a
 * repo where init installed it (readiness I5), so intake-before-init is
 * structurally impossible on this path; the Actions token also cannot read
 * rulesets. Dashboard intake keeps its explicit readiness refusal.
 *
 * Agent context selection (FR-053): an optional `### Context` section lists
 * one repo path per line the planning agent must read; every path must
 * normalize to inside a special context folder (`runbooks/`, `useful-context/`,
 * `inputs/` — no `../` escapes, absolute paths, or backslash tricks) and exist
 * in the repository checkout. Any violation is a refusal naming every bad
 * path. No section, or an empty one, is valid (index-files-only mode).
 */

export type IntakeResult =
  | { outcome: 'normalized'; slug: string }
  | { outcome: 'already_normalized'; slug: string }
  | { outcome: 'refused'; reason: string };

const SLUG_SECTION_RE = /###\s*Workload slug\s*\n+\s*([^\n]+)/;
const CONTEXT_SECTION_RE = /###\s*Context\s*\n([\s\S]*?)(?=\n###\s|$)/;
const CONTEXT_FOLDERS = ['runbooks', 'useful-context', 'inputs'];

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

/** Context lines from the `### Context` section, trimmed, minus blanks and the issue-form placeholder. */
function contextLines(body: string): string[] {
  const section = CONTEXT_SECTION_RE.exec(body)?.[1] ?? '';
  return section
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line && line !== '_No response_');
}

/**
 * Designated context files exceeding the per-file limit (PB-004 hang guard).
 * Only meaningful for paths already known valid + existing (run after
 * invalidContextPaths clears). A folder designation is walked recursively and
 * each offending file is reported as its own `folder/sub/file` path.
 *
 * Walk safety (untrusted input — context paths are operator-supplied): lstat
 * does NOT follow symlinks, and symlinks are skipped outright. That kills two
 * failure modes at once — a symlink cycle (e.g. `dir/loop -> dir`) can't drive
 * infinite recursion / stack overflow, and a symlink can't escape the walk to
 * a huge or out-of-tree target. readdir is wrapped so an unreadable directory
 * (permissions / a delete race) fails soft, not by crashing the intake job.
 */
export function oversizedContextPaths(body: string, rootDir: string, maxBytes = contextMaxFileBytes()): { path: string; bytes: number }[] {
  const offenders: { path: string; bytes: number }[] = [];
  const check = (relPath: string): void => {
    const abs = join(rootDir, relPath);
    let stat;
    try {
      stat = lstatSync(abs);
    } catch {
      return; // existence is invalidContextPaths' job; a race here is not a size failure
    }
    if (stat.isSymbolicLink()) return; // context must be real committed files, never symlinks
    if (stat.isDirectory()) {
      let entries: string[];
      try {
        entries = readdirSync(abs);
      } catch {
        return; // unreadable directory (perms / delete race) → not a size failure; fail soft
      }
      for (const entry of entries) check(posix.join(relPath, entry));
    } else if (stat.size > maxBytes) {
      offenders.push({ path: relPath, bytes: stat.size });
    }
  };
  for (const line of contextLines(body)) check(posix.normalize(line));
  return offenders;
}

/** FR-053: paths from the `### Context` section that don't normalize to inside a special folder or don't exist. */
export function invalidContextPaths(body: string, rootDir: string): string[] {
  return contextLines(body).filter((line) => {
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
    if (!CONTEXT_FOLDERS.includes(normalized.split('/')[0] ?? '')) return true;
    return !existsSync(join(rootDir, normalized));
  });
}

export async function normalizeIntake(
  gh: Octokit,
  repo: RepoRef,
  issueNumber: number,
  opts: { rootDir?: string; maxContextFileBytes?: number } = {},
): Promise<IntakeResult> {
  const { data: issue } = await gh.issues.get({ ...repo, issue_number: issueNumber });
  const body = issue.body ?? '';

  const existing = parseWorkloadHeader(body);
  if (existing) return { outcome: 'already_normalized', slug: existing.id };

  const refuse = async (reason: string): Promise<IntakeResult> => {
    await gh.issues.createComment({
      ...repo,
      issue_number: issueNumber,
      body: `**Workload intake refused** — ${reason}\n\nFix the form values in the issue body, then re-add the \`workload:proposed\` label to retry.`,
    });
    await gh.issues.removeLabel({ ...repo, issue_number: issueNumber, name: 'workload:proposed' }).catch(() => {});
    return { outcome: 'refused', reason };
  };

  const slug = SLUG_SECTION_RE.exec(body)?.[1]?.trim() ?? '';
  if (!SLUG_RE.test(slug)) {
    return refuse(
      slug
        ? `\`${slug}\` is not a valid workload slug (kebab-case: lowercase letters, digits, hyphens)`
        : 'no workload slug found in the issue form',
    );
  }

  const dup = await getWorkload(gh, repo, slug);
  if (dup && dup.issueNumber !== issueNumber) {
    return refuse(`workload slug \`${slug}\` already exists (issue #${dup.issueNumber}, FR-031)`);
  }

  const rootDir = opts.rootDir ?? process.cwd();
  const badPaths = invalidContextPaths(body, rootDir);
  if (badPaths.length > 0) {
    return refuse(
      `context path(s) invalid: ${badPaths.map((p) => `\`${p}\``).join(', ')} — every \`### Context\` line must be a repo-relative path inside \`runbooks/\`, \`useful-context/\`, or \`inputs/\` that exists in the repository (FR-053)`,
    );
  }

  // Size guard (PB-004): only reachable once every path is valid + existing.
  const maxBytes = contextMaxFileBytes(opts.maxContextFileBytes);
  const oversized = oversizedContextPaths(body, rootDir, maxBytes);
  if (oversized.length > 0) {
    const limitMb = (maxBytes / (1024 * 1024)).toFixed(0);
    return refuse(
      `context file(s) too large (limit ${limitMb} MB, set CONTEXT_MAX_FILE_MB to change): ${oversized
        .map((o) => `\`${o.path}\` (${(o.bytes / (1024 * 1024)).toFixed(1)} MB)`)
        .join(', ')} — large sources must be pre-extracted to text before use as agent context (FR-053)`,
    );
  }

  await gh.issues.update({ ...repo, issue_number: issueNumber, body: `${serializeWorkloadHeader({ id: slug })}\n${body}` });
  await gh.issues.createComment({
    ...repo,
    issue_number: issueNumber,
    body: serializeWorkloadEvent({ action: 'introduced', by: issue.user?.login ?? 'unknown', at: new Date().toISOString() }),
  });
  return { outcome: 'normalized', slug };
}

const isMain = process.argv[1]?.endsWith('intake-normalize.ts');
if (isMain) {
  const argv = process.argv.slice(2);
  const get = (name: string): string | undefined => {
    const i = argv.indexOf(`--${name}`);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const issueArg = get('issue');
  const repoArg = get('repo');
  const [owner, repoName] = (repoArg ?? '').split('/');
  if (!issueArg || !owner || !repoName) {
    console.error('usage: intake-normalize --issue <number> --repo <owner/repo>');
    process.exit(2);
  }
  normalizeIntake(createClient(), { owner, repo: repoName }, Number(issueArg))
    .then((result) => {
      console.log(result.outcome === 'refused' ? `refused: ${result.reason}` : `${result.outcome}: ${result.slug}`);
    })
    .catch((error) => {
      console.error(errorMessage(error));
      process.exit(1);
    });
}
