import { z } from 'zod';
import { isRepoRelative, matchesAny, normalizePath } from './gates/lib/globs';
import { nestedShellBody, opensCompound, splitTopLevelCommands, tokenizeCommand } from './gates/lib/shell-text';

/**
 * WHAT `verified` ACTUALLY MEANT — the harness says it without ever saying what was
 * verified (GHI #271).
 *
 * THE LIVE INSTANCE. `test-turtle-1` PR #107 (`plan/lza-phase0-0/v4`, `step-tests`)
 * delivered seven Bats suites — 375 lines of executable assertions. Its only two
 * verification targets were `test -f tests/<name>.bats` ×7 plus a `grep -qF`, and
 * `grep -qF "deploy/scripts/common.sh"` ×7. Both green. `bats` was never invoked by
 * anything, and three of the delivered tests are tautologies that pass against a file
 * that does not exist. A step proved by running its suite and a step proved by `test -f`
 * are indistinguishable on every surface the operator reads.
 *
 * THIS IS NOT A GATE DEFECT AND THIS IS NOT A GATE. G4, G18, G19 and the negative
 * control each behaved exactly as specified; a presence check clears all four. The
 * ladder has no rung for "the target exercises the deliverable" and is not getting one:
 * weak agent output is fixed by another agentic workload, and the harness's job is to
 * SURFACE it, never to refuse it (operator decision 2026-09-16, ADR-0007). So nothing
 * here changes a conclusion, demotes a target, withholds a result or gates completion.
 *
 * IT NEVER LABELS A TARGET STRONG. There are two values and neither is a compliment:
 * `presence-only` is a positive claim about weakness, made only when every command,
 * every option and every path in the target can be read; `unclassified` is the honest
 * non-claim. A target reaching outside its own step's scope may be guarding an invariant
 * that predates the plan (GHI #251), which is not weakness — so it is uncharacterised,
 * not demoted.
 *
 * PURE, AND THAT IS LOAD-BEARING. No `fs`, no `child_process`, no network: the reporter
 * runs in a different job from the checkout, so this must be able to say what it could
 * not read rather than go and look. It is why a wildcard in a path operand refuses
 * instead of expanding.
 */

/* ------------------------------------------------------------------ *
 * Classification
 * ------------------------------------------------------------------ */

export type TargetStrength = 'presence-only' | 'unclassified';

export interface TargetClassification {
  strength: TargetStrength;
  /** the tally an operator reads — `test -f ×7, grep -qF ×1`. Empty when unclassified. */
  evidence: string;
  /** the one phrase saying what stopped it. Empty when it could classify. */
  reason: string;
}

/**
 * The only command heads whose whole job is to assert presence or match text.
 *
 * `true`, `:` and `echo` are deliberately NOT here. "This command asserts nothing" is
 * the negative control's finding (`build-verify`'s re-run against the frozen tree), not
 * this reader's, and calling `true` a presence check would overstate what was read.
 */
export const PRESENCE_HEADS = ['test', '[', 'grep', 'egrep', 'fgrep'] as const;

/** `test` operators that take a path and assert something about its presence. */
export const FILE_TEST_OPERATORS = [
  '-e', '-f', '-d', '-s', '-r', '-w', '-x', '-L', '-h', '-b', '-c', '-p', '-S', '-g', '-u', '-k',
] as const;

/**
 * grep options this reader understands and that take NO argument.
 *
 * An option it does not recognise refuses the whole target rather than guessing: `-e`
 * and `-f` take an argument, and mis-reading either turns a pattern into a path (or a
 * path into a pattern) and the classification becomes a statement about the wrong file.
 */
export const GREP_FLAG_RE =
  /^(-[qFinEwxsclLvRrHh]+|--(quiet|silent|fixed-strings|extended-regexp|basic-regexp|recursive|dereference-recursive|no-messages|invert-match|word-regexp|line-regexp|ignore-case|count|files-with-matches|files-without-match))$/;

const unclassified = (reason: string): TargetClassification => ({ strength: 'unclassified', evidence: '', reason });

/**
 * Is this target's `run` a presence or text check over paths inside its own step's
 * declared scope?
 *
 * `scope` is the UNION of every step the target maps to, or null when any one of them
 * declares none — a union with a hole cannot answer "inside".
 *
 * The positive answer requires yes to all six: there is a `run`; the union scope is
 * non-empty; the unwrapped text contains no construct this reader cannot resolve; every
 * top-level command splits cleanly and has an allowlisted head; every operand parses
 * under that head's grammar; and every path operand is literal, wildcard-free,
 * repo-relative and inside the scope. Any no is `unclassified` with the first reason.
 */
export function classify(run: string | undefined, scope: readonly string[] | null): TargetClassification {
  if (run === undefined || run.trim().length === 0) return unclassified('the target has no executable form');
  if (scope === null || scope.length === 0) return unclassified('the step declares no scope');

  const body = nestedShellBody(run) ?? run;
  // ONE unwrap. A shell inside a shell inside a shell is a program this reader will not
  // guess at, and every live target has exactly one level.
  if (nestedShellBody(body) !== null) return unclassified('a shell inside a shell inside a shell');

  const segments = splitTopLevelCommands(body);
  if (segments === null) return unclassified('a value the command computes at run time');

  const tally = new Map<string, number>();
  for (const segment of segments) {
    if (opensCompound(segment)) return unclassified('a shell construct this reader does not parse');
    const tokens = tokenizeCommand(segment);
    if (tokens === null || tokens.length === 0) return unclassified('a command this reader could not read');
    const head = tokens[0]!;
    if (!head.literal || !(PRESENCE_HEADS as readonly string[]).includes(head.text)) {
      return unclassified(`the command runs \`${head.text}\`, which is not an existence or text check`);
    }
    const outcome = head.text === 'grep' || head.text === 'egrep' || head.text === 'fgrep'
      ? readGrep(tokens)
      : readTest(tokens);
    if ('reason' in outcome) return unclassified(outcome.reason);
    for (const path of outcome.paths) {
      const bad = pathProblem(path, scope);
      if (bad !== null) return unclassified(bad);
    }
    tally.set(outcome.key, (tally.get(outcome.key) ?? 0) + 1);
  }

  const keys = [...tally.entries()];
  const shown = keys.slice(0, 6).map(([key, n]) => `${key} ×${n}`);
  return {
    strength: 'presence-only',
    evidence: keys.length > 6 ? `${shown.join(', ')}, …` : shown.join(', '),
    reason: '',
  };
}

type Read = { key: string; paths: ShellPath[] } | { reason: string };
interface ShellPath {
  text: string;
  literal: boolean;
}

/** `test -f x`, `[ -f x ]`, `test ! -e x`. Both spellings tally as `test`. */
function readTest(tokens: { text: string; literal: boolean }[]): Read {
  const bracket = tokens[0]!.text === '[';
  let rest = tokens.slice(1);
  if (bracket) {
    if (rest.length === 0 || rest[rest.length - 1]!.text !== ']') {
      return { reason: 'a comparison this reader does not recognise' };
    }
    rest = rest.slice(0, -1);
  }
  const paths: ShellPath[] = [];
  let negated = false;
  let op: string | null = null;
  let expectPath = false;
  for (const token of rest) {
    if (expectPath) {
      paths.push(token);
      expectPath = false;
      continue;
    }
    if (token.text === '!') {
      negated = true;
      continue;
    }
    if ((FILE_TEST_OPERATORS as readonly string[]).includes(token.text)) {
      op = token.text;
      expectPath = true;
      continue;
    }
    // `=`, `-eq`, `-z`, a bare operand — a comparison, not a presence check.
    return { reason: 'a comparison this reader does not recognise' };
  }
  if (expectPath || op === null || paths.length === 0) {
    return { reason: 'a comparison this reader does not recognise' };
  }
  return { key: `test ${negated ? '! ' : ''}${op}`, paths };
}

/** `grep -qF 'pattern' path…`. The first non-flag token is the pattern, never a path. */
function readGrep(tokens: { text: string; literal: boolean }[]): Read {
  const head = tokens[0]!.text;
  const flags: string[] = [];
  let i = 1;
  for (; i < tokens.length; i += 1) {
    const t = tokens[i]!;
    if (!t.text.startsWith('-')) break;
    if (!GREP_FLAG_RE.test(t.text)) return { reason: 'an option this reader does not recognise' };
    flags.push(t.text);
  }
  if (i >= tokens.length) return { reason: 'a pattern but no file to search' };
  // The pattern is consumed and never path-tested — sniffing a token for a `/` is how a
  // regex becomes a path and a path becomes a regex.
  i += 1;
  const paths = tokens.slice(i);
  if (paths.length === 0) return { reason: 'a pattern but no file to search' };
  return { key: `${head}${flags.length > 0 ? ` ${flags.join(' ')}` : ''}`, paths };
}

/** Why this path operand stops the target being classified, or null. */
function pathProblem(path: ShellPath, scope: readonly string[]): string | null {
  if (!path.literal) return 'a value the command computes at run time';
  if (/[*?[\]{}~]/.test(path.text)) return 'a path with a wildcard this reader cannot expand';
  if (!isRepoRelative(path.text)) return 'a path that leaves the repository';
  // The SCOPE reading (`bareIsDirectory: false`), so this and D2 agree about what a
  // declared scope covers.
  if (!matchesAny(normalizePath(path.text), scope, false)) {
    return `a path outside the step's declared scope: \`${path.text}\``;
  }
  return null;
}

/* ------------------------------------------------------------------ *
 * What was delivered, and how an operator would run it
 * ------------------------------------------------------------------ */

export type Runner = 'bats' | 'bash' | 'pytest' | 'npx vitest run';

const TEST_DIR = /(^|\/)(tests?|__tests__)(\/|$)/;
const TEST_FILE = /\.(test|spec)\.[cm]?[jt]sx?$/;

/** Is this delivered path a test root or a test file by NAME? */
function underTestRoot(path: string): boolean {
  const p = normalizePath(path);
  return TEST_DIR.test(p) || TEST_FILE.test(p.split('/').pop() ?? '');
}

/**
 * "Executable" is decided by the DELIVERED PATH, not by file mode — a patch carries no
 * mode this reader can trust, and the reporter holds no checkout to stat.
 */
export function isExecutableDeliverable(path: string): boolean {
  const p = normalizePath(path);
  if (/\.(bats|sh|py)$/.test(p)) return true;
  if (/\.[cm]?[jt]sx?$/.test(p) && underTestRoot(p)) return true;
  return /^\.github\/workflows\/[a-z0-9][a-z0-9-]*_[^/]+\.ya?ml$/.test(p);
}

/** The command that would run this file, or null when naming one would be a guess. */
export function runnerFor(path: string): Runner | null {
  const p = normalizePath(path);
  if (p.endsWith('.bats')) return 'bats';
  if (p.endsWith('.sh')) return 'bash';
  if (p.endsWith('.py')) return underTestRoot(p) ? 'pytest' : null;
  if (/\.[cm]?[jt]sx?$/.test(p) && underTestRoot(p)) return 'npx vitest run';
  return null;
}

/* ------------------------------------------------------------------ *
 * The note, the artifact and the panel
 * ------------------------------------------------------------------ */

export interface AssuranceTarget {
  id: string;
  strength: TargetStrength;
  detail: string;
}

export interface AssuranceNote {
  stepId: string;
  targets: AssuranceTarget[];
  /**
   * Every path this step's counted deliverables touched, or NULL when one diff could
   * not be read. Never `[]` for "we did not ask" — an authoritative empty list is a
   * real state (a re-delivered byte-identical tree merges an empty commit, live on
   * PR #104), and rendering "could not be read" over it would be a different lie.
   */
  deliveredPaths: string[] | null;
  deliverablePrNumbers: number[];
  executablePaths: string[];
  /** executable, and this module names no runner for it */
  unrunnablePaths: string[];
  /** from the delivery record: steps this one declares it comes after that had not landed */
  pendingPrerequisiteIds: string[];
}

/**
 * One path as a shell ARGUMENT, quoted when it is not obviously safe.
 *
 * The panel prints a command under the words "Check it yourself", which is an explicit
 * invitation to paste it into a shell. The paths come from a deliverable's diff — agent
 * output — and git permits a filename like `tests/x;touch PWNED.sh`, which a
 * `tests/**` scope accepts and D2 does not refuse. Unquoted, the line we hand the
 * operator runs a second command (Codex P1 on PR #277).
 *
 * Single quotes, with the POSIX `'\''` escape for an embedded quote: it is the one
 * form that needs no reasoning about what the shell will expand.
 */
function shellArg(path: string): string {
  return /^[A-Za-z0-9._\/@+-]+$/.test(path) ? path : `'${path.split("'").join(`'\\''`)}'`;
}

const RUNNER_ORDER: Runner[] = ['bats', 'bash', 'pytest', 'npx vitest run'];

/** The rendered block, one line per element. Empty when there is nothing to say. */
export function assurancePanel(note: AssuranceNote, verifiedCommit: string): string[] {
  const presence = note.targets.filter((t) => t.strength === 'presence-only');
  const x = note.executablePaths.length;
  const n = note.targets.length;
  const unknownPaths = note.deliveredPaths === null;

  if (!unknownPaths && x === 0 && presence.length === 0) return [];

  const head = unknownPaths
    ? `${note.stepId} — the files this step delivered could not be read. What was delivered is unknown; it is not known to be nothing.`
    : x > 0 && presence.length === n
      ? `${note.stepId} — ${x} executable file(s) were delivered, and every check on this step was a file-existence or text check. Nothing ran them.`
      : x > 0 && presence.length > 0
        ? `${note.stepId} — ${x} executable file(s) were delivered. ${presence.length} of its ${n} checks were file-existence or text checks; what the other ${n - presence.length} do could not be read from the command(s).`
        : x > 0
          ? `${note.stepId} — ${x} executable file(s) were delivered. What its ${n} check(s) do could not be read from the command(s).`
          : `${note.stepId} — nothing executable was delivered here, so there was nothing for a check to run.`;

  const width = Math.max(0, ...note.targets.map((t) => t.id.length));
  const lines = [head];
  for (const t of note.targets) {
    const label = t.strength === 'presence-only' ? `presence-only (${t.detail})` : `not characterised (${t.detail})`;
    lines.push(`  ${t.id.padEnd(width)}  ${label}`);
  }
  if (note.pendingPrerequisiteIds.length > 0) {
    lines.push(`  Out of declared order: delivered before ${note.pendingPrerequisiteIds.join(', ')} landed.`);
  }

  if (unknownPaths) {
    const where =
      note.deliverablePrNumbers.length > 0
        ? ` — then read the files pull request ${note.deliverablePrNumbers.map((p) => `#${p}`).join(', ')} changed.`
        : '.';
    lines.push(`  Check it yourself:  git checkout ${verifiedCommit}${where}`);
    return lines;
  }

  lines.push(`  Check it yourself:  git checkout ${verifiedCommit}`);
  const pad = ' '.repeat('  Check it yourself:  '.length);
  for (const runner of RUNNER_ORDER) {
    const group = note.executablePaths.filter((p) => runnerFor(p) === runner);
    // Never truncated: a partial command is a command that fails, and one that fails
    // teaches the operator the panel lies.
    if (group.length > 0) lines.push(`${pad}${runner} ${group.map(shellArg).join(' ')}`);
  }
  if (note.unrunnablePaths.length > 0) {
    lines.push(`  No runner named:    ${note.unrunnablePaths.map(shellArg).join(', ')}`);
  }
  if (x === 0 && note.deliveredPaths !== null && note.deliveredPaths.length > 0) {
    lines.push(`  Delivered here:     ${note.deliveredPaths.map(shellArg).join(', ')}`);
  }
  return lines;
}

/** The sibling artifact, beside the results it describes. */
export const ASSURANCE_FILE = 'vt-assurance.json';

const AssuranceNoteSchema = z
  .object({
    stepId: z.string().min(1),
    targets: z.array(
      z.object({ id: z.string().min(1), strength: z.enum(['presence-only', 'unclassified']), detail: z.string() }).strict(),
    ),
    deliveredPaths: z.array(z.string()).nullable(),
    deliverablePrNumbers: z.array(z.number()),
    executablePaths: z.array(z.string()),
    unrunnablePaths: z.array(z.string()),
    pendingPrerequisiteIds: z.array(z.string()),
  })
  .strict();

export const AssuranceFile = z
  .object({
    plan_ref: z.string().min(1),
    verified_commit: z.string().min(1),
    notes: z.array(AssuranceNoteSchema).default([]),
  })
  .strict();
export type AssuranceFile = z.infer<typeof AssuranceFile>;

/**
 * The block to append to one `vt-*` check run's body, or `''`.
 *
 * NEVER THROWS, for any input. It is prose beneath a record the completion gate reads;
 * letting a cosmetic file refuse would give it the power to stop the check runs
 * completion depends on — a far worse outcome than a summary that says less.
 * `vt-results.json` refuses for the opposite reason: it decides conclusions.
 */
export function assuranceBlockFor(
  file: AssuranceFile | null,
  targetId: string,
  mapsTo: readonly string[],
  verifiedCommit: string,
): string {
  if (file === null) return '';
  // EVERY mapped step, not the first (Codex on PR #277). A target mapped to two
  // delivered steps has two notes, and `.find` rendered one of them — omitting the
  // other step's files and command, and, when the first panel was empty, suppressing a
  // later step's presence-only warning entirely.
  const notes = file.notes.filter((n) => mapsTo.includes(n.stepId) && n.targets.some((t) => t.id === targetId));
  if (notes.length === 0) return '';
  const lines = notes.flatMap((n) => assurancePanel(n, verifiedCommit));
  if (lines.length === 0) return '';
  // Fenced, because GitHub renders `output.summary` as markdown and the column
  // alignment would otherwise collapse. Capped well inside GitHub's 65535-character
  // summary limit, which the text above it already draws on.
  const block = `\n\n\`\`\`\n${lines.join('\n')}\n\`\`\``;
  return block.length > 8000 ? `${block.slice(0, 7990)}\n…\n\`\`\`` : block;
}
