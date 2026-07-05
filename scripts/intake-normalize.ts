import { existsSync } from 'node:fs';
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

/** FR-053: paths from the `### Context` section that don't normalize to inside a special folder or don't exist. */
export function invalidContextPaths(body: string, rootDir: string): string[] {
  const section = CONTEXT_SECTION_RE.exec(body)?.[1] ?? '';
  const lines = section
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line && line !== '_No response_');
  return lines.filter((line) => {
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
  opts: { rootDir?: string } = {},
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

  const badPaths = invalidContextPaths(body, opts.rootDir ?? process.cwd());
  if (badPaths.length > 0) {
    return refuse(
      `context path(s) invalid: ${badPaths.map((p) => `\`${p}\``).join(', ')} — every \`### Context\` line must be a repo-relative path inside \`runbooks/\`, \`useful-context/\`, or \`inputs/\` that exists in the repository (FR-053)`,
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
