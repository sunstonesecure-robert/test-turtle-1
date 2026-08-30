import { spawnSync } from 'node:child_process';
import { accessSync, constants, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import type { ScanFinding, SubjectWorkflowFile } from './checks-subject-workflow';

/**
 * The D6.5 scanner runner — actionlint + zizmor over subject-workflow files (T274,
 * FR-069, GHI #174).
 *
 * `checks-subject-workflow.ts` is pure and takes the scanners as an INJECTED function
 * so the same guard can be asked the same question by `deliverable-gate`,
 * `build-publish` and a unit test. This module is the one non-pure piece: it finds the
 * binaries, writes the files where the scanners expect a workflow to live, runs them,
 * and maps their output to `ScanFinding`.
 *
* MISSING IS NOT PASSING (GHI #108). `scannerRunner()` returns `null` — not a runner
 * that returns `[]` — when either binary is absent (from `SUBJECT_SCANNERS_DIR` when the
 * workflow sets it, else from PATH), and the guard turns
 * `null` into a D6.5 FAILURE: "scanners unavailable — refusing rather than passing
 * unscanned". The workflow templates install both binaries, pinned, in every job that
 * runs D6; a curl failure there fails the step. A scanner that crashes, or whose output
 * cannot be parsed, is reported as a finding for the same reason — the file was not
 * scanned, and "not scanned" must never read as "clean".
 *
* WHY A VARIABLE AND NOT `GITHUB_PATH` (CI on PR #175, 2026-08-29). The first version of
 * the install steps appended the scanner directory to `$GITHUB_PATH`, and zizmor's
 * `github-env` audit refused every one of them: a run step that writes PATH for every
 * later step is a code-execution vector as a CLASS, whoever writes it — exactly the
 * shape D6.5 asks zizmor to refuse in a subject workflow, so our own templates could
 * not carry it and keep a straight face. The install step now writes nothing shared;
 * the ONE consumer is handed the directory as `SUBJECT_SCANNERS_DIR` on its own step,
 * and when that variable is set it is the only place looked in — a binary missing from
 * it is `null` (fail closed), never a fallback to whatever PATH happens to hold.
 *
 * WHY THE FILES ARE WRITTEN UNDER THEIR OWN `.github/workflows/` PATH. Both tools
 * classify a file by where it sits: zizmor treats `.github/workflows/*.yml` as a
 * workflow and `action.yml` as an action, and actionlint's checks are workflow-shaped.
 * A subject workflow written to `<tmp>/subject_x.yml` would be scanned as the wrong
 * kind of thing, or not at all.
 */

const SCANNER_NAMES = ['actionlint', 'zizmor'] as const;
type ScannerName = (typeof SCANNER_NAMES)[number];

/** The step-level variable the workflow templates set to the directory their install
 *  step filled. When present it is the ONLY place a scanner is looked for. */
export const SCANNERS_DIR_VARIABLE = 'SUBJECT_SCANNERS_DIR';

/** The absolute path of a binary on PATH, or `null`. `which` is what the brief names,
 *  and it is present on every runner and developer shell this project targets. */
export function findOnPath(name: string, env: NodeJS.ProcessEnv = process.env): string | null {
  const result = spawnSync('which', [name], { encoding: 'utf8', env });
  if (result.status !== 0) return null;
  const found = result.stdout.trim();
  return found.length > 0 ? found : null;
}

/** Where a scanner is: `$SUBJECT_SCANNERS_DIR/<name>` when the variable is set (an
 *  executable regular file, or `null` — no fallback), else the first hit on PATH. */
export function findScanner(name: string, env: NodeJS.ProcessEnv = process.env): string | null {
  const dir = env[SCANNERS_DIR_VARIABLE]?.trim();
  if (dir) {
    const candidate = join(dir, name);
    try {
      if (!statSync(candidate).isFile()) return null;
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {
      return null;
    }
  }
  return findOnPath(name, env);
}

/**
 * A runner over the scanners, or `null` when either is missing — from
 * `SUBJECT_SCANNERS_DIR` when the workflow set it, otherwise from PATH.
 *
 * Resolved at CALL time, not module load: the gate is imported by the dashboard's
 * build too, where no scanner exists and none is needed, and a test may add or remove
 * a shim between cases.
 */
export function scannerRunner(env: NodeJS.ProcessEnv = process.env): ((files: SubjectWorkflowFile[]) => Promise<ScanFinding[]>) | null {
  const bins: Partial<Record<ScannerName, string>> = {};
  for (const name of SCANNER_NAMES) {
    const found = findScanner(name, env);
    if (!found) return null;
    bins[name] = found;
  }
  return async (files) => runScanners(files, bins as Record<ScannerName, string>, env);
}

/**
 * Run both scanners over the files and return every finding.
 *
 * The files are written to a fresh temp directory under `RUNNER_TEMP` (the runner's
 * per-job scratch space) or the OS temp dir, keeping the `.github/workflows/` layout,
 * and removed afterwards whatever happens. Deleted files never reach here — the guard
 * filters them.
 */
export function runScanners(
  files: readonly SubjectWorkflowFile[],
  bins: Record<ScannerName, string>,
  env: NodeJS.ProcessEnv = process.env,
): ScanFinding[] {
  const live = files.filter((f): f is SubjectWorkflowFile & { content: string } => f.content !== null);
  if (live.length === 0) return [];
  const root = mkdtempSync(join(env.RUNNER_TEMP ?? tmpdir(), 'subject-workflows-'));
  try {
    const byAbsolute = new Map<string, string>();
    for (const file of live) {
      const abs = join(root, file.path);
      mkdirSync(dirname(abs), { recursive: true });
      writeFileSync(abs, file.content, 'utf8');
      byAbsolute.set(abs, file.path);
    }
    const targets = [...byAbsolute.keys()];
    // Map whatever path a scanner prints back to the repo-relative path the pull
    // request named. Scanners print the path as given, or relative to their cwd, so
    // three spellings are tried before falling back to the only file when there is one.
    const toRepoPath = (printed: string | undefined): string => {
      if (printed) {
        const candidates = [printed, join(root, printed), join(root, relative(root, printed))];
        for (const c of candidates) {
          const hit = byAbsolute.get(c);
          if (hit) return hit;
        }
        const tail = [...byAbsolute.entries()].find(([abs]) => abs.endsWith(printed) || printed.endsWith(relative(root, abs)));
        if (tail) return tail[1];
      }
      return live.length === 1 ? live[0]!.path : (live[0]?.path ?? printed ?? '(unknown file)');
    };
    return [...runActionlint(bins.actionlint, targets, root, env, toRepoPath), ...runZizmor(bins.zizmor, targets, root, env, toRepoPath)];
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

/** A scanner that could not be run or read is a FINDING against every file (fail closed). */
function crashed(tool: ScanFinding['tool'], files: readonly string[], message: string): ScanFinding[] {
  return files.map((path) => ({ tool, path, message: `${tool} did not complete — ${message}; refusing rather than passing unscanned` }));
}

/**
 * actionlint: `-format '{{json .}}'` prints one JSON array of
 * `{message, filepath, line, column, kind}`. Exit 0 = clean, 1 = findings, anything
 * else = the tool itself failed.
 */
function runActionlint(
  bin: string,
  targets: string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
  toRepoPath: (printed: string | undefined) => string,
): ScanFinding[] {
  const result = spawnSync(bin, ['-format', '{{json .}}', '-no-color', ...targets], { cwd, encoding: 'utf8', env });
  const repoPaths = targets.map((t) => toRepoPath(t));
  if (result.error) return crashed('actionlint', repoPaths, result.error.message);
  if (result.status !== 0 && result.status !== 1) {
    return crashed('actionlint', repoPaths, `exit ${result.status}: ${(result.stderr || result.stdout).trim().slice(0, 500)}`);
  }
  let parsed: unknown;
  try {
    parsed = result.stdout.trim().length === 0 ? [] : JSON.parse(result.stdout);
  } catch (error: unknown) {
    return crashed('actionlint', repoPaths, `unreadable output (${error instanceof Error ? error.message : String(error)})`);
  }
  if (!Array.isArray(parsed)) return crashed('actionlint', repoPaths, 'output was not a JSON array');
  return parsed.map((raw) => {
    const f = (raw ?? {}) as { message?: string; filepath?: string; line?: number; column?: number; kind?: string };
    const where = f.line !== undefined ? ` (line ${f.line}${f.column !== undefined ? `:${f.column}` : ''})` : '';
    return { tool: 'actionlint' as const, path: toRepoPath(f.filepath), message: `${f.kind ? `[${f.kind}] ` : ''}${f.message ?? 'finding'}${where}` };
  });
}

/**
 * zizmor: `--persona=regular --format json` prints one JSON array of findings, each
 * `{ident, desc, determinations: {severity, confidence, persona}, locations: [{symbolic:
 * {key: {Local: {given_path}}}, ...}], ignored, url}`. `--no-exit-codes` so a finding
 * is reported through the JSON rather than through a status the runner would have to
 * interpret; then any non-zero exit IS a crash.
 */
function runZizmor(
  bin: string,
  targets: string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
  toRepoPath: (printed: string | undefined) => string,
): ScanFinding[] {
  // zizmor authenticates its online audits (impostor commits, known-vulnerable
  // actions) with GH_TOKEN; in Actions the job has GITHUB_TOKEN, so hand it over when
  // GH_TOKEN itself is unset. Without any token zizmor skips those audits with a note
  // — still a scan, and D6.5's static pin checks cover the shape they would refuse.
  const zizmorEnv = { ...env, ...(env.GH_TOKEN || !env.GITHUB_TOKEN ? {} : { GH_TOKEN: env.GITHUB_TOKEN }) };
  const result = spawnSync(bin, ['--persona=regular', '--format', 'json', '--no-exit-codes', ...targets], { cwd, encoding: 'utf8', env: zizmorEnv });
  const repoPaths = targets.map((t) => toRepoPath(t));
  if (result.error) return crashed('zizmor', repoPaths, result.error.message);
  if (result.status !== 0) {
    return crashed('zizmor', repoPaths, `exit ${result.status}: ${(result.stderr || result.stdout).trim().slice(0, 500)}`);
  }
  let parsed: unknown;
  try {
    parsed = result.stdout.trim().length === 0 ? [] : JSON.parse(result.stdout);
  } catch (error: unknown) {
    return crashed('zizmor', repoPaths, `unreadable output (${error instanceof Error ? error.message : String(error)})`);
  }
  if (!Array.isArray(parsed)) return crashed('zizmor', repoPaths, 'output was not a JSON array');
  const findings: ScanFinding[] = [];
  for (const raw of parsed) {
    const f = (raw ?? {}) as {
      ident?: string;
      desc?: string;
      ignored?: boolean;
      determinations?: { severity?: string; confidence?: string };
      locations?: { symbolic?: { key?: { Local?: { given_path?: string } } } }[];
    };
    // `ignored` = suppressed by an in-file `# zizmor: ignore[...]` comment. Honoured,
    // as zizmor itself honours it — the comment is in the file the operator will read.
    if (f.ignored) continue;
    const printed = f.locations?.map((l) => l.symbolic?.key?.Local?.given_path).find((p) => typeof p === 'string');
    const sev = f.determinations?.severity ? ` [${f.determinations.severity}${f.determinations.confidence ? `, ${f.determinations.confidence} confidence` : ''}]` : '';
    findings.push({ tool: 'zizmor', path: toRepoPath(printed), message: `${f.ident ?? 'finding'}${sev}: ${f.desc ?? ''}`.trim() });
  }
  return findings;
}
