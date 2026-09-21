import { readFileSync, writeFileSync } from 'node:fs';

/**
 * Post-compile pin-comment restorer (Codex on PR #284, 2026-09-19).
 *
 * gh-aw v0.88.7 changed how it treats the version comment beside a pinned action, and
 * both halves of the change lose information that only the comment carries:
 *
 *   - for a pin it can resolve in its own registry, it REWRITES the comment — our
 *     `pre-steps:` setup-node compiled to `@48b55a01 # 48b55a01`, naming no version at
 *     all. zizmor's `ref-version-mismatch` failed CI on that one, which is how it was
 *     found;
 *   - for a pin in our own `steps:` block it STRIPS the comment outright, even when the
 *     SHA is one gh-aw itself uses elsewhere in the same file with the comment intact.
 *     zizmor did NOT fail this one, and `tests/unit/node-runtime-pins.test.ts` is what
 *     caught it — a bare SHA cannot be judged for its runtime major at all, so a pin
 *     with no comment is unjudgeable rather than merely undocumented.
 *
 * At v0.81.6 the comment was copied through verbatim, so this appeared only on upgrade.
 *
 * A 40-hex pin is secure either way; what is lost is AUDITABILITY, and these templates
 * are installed into subject repos as the example to copy. `actions/checkout@3d3c42e5`
 * tells a reader nothing about which major they are running; `# v7.0.1` does.
 *
 * The version is never invented. It is read from evidence already in the tree, in this
 * order, and a SHA with no evidence is left exactly as the compiler wrote it:
 *   1. the authored `.md`/`.yml` source, where we wrote the pin and its comment;
 *   2. the lock's own manifest header, where gh-aw lists the same SHA WITH its version.
 *
 * That second source is why this is a restorer and not a guess: the compiler documents
 * the SHA at the top of the very file in which it then strips the comment.
 *
 * Deterministic + idempotent: pure line edits, no YAML re-serialization. Run after
 * EVERY `gh aw compile` — `npm run lock:enforce` runs it alongside
 * enforce-job-timeouts.ts and enforce-upload-caps.ts, and node-runtime-pins.test.ts
 * fails the build if a lock lands without it.
 */

export const LOCKS = [
  'templates/workflows/plan-propose.lock.yml',
  'templates/workflows/plan-revise.lock.yml',
  'templates/workflows/build-template.lock.yml',
];

/** Authored sources whose pins carry the comment we wrote. */
const SOURCES = [
  'templates/workflows/plan-propose.md',
  'templates/workflows/plan-revise.md',
  'templates/workflows/build-template.md',
];

/** `owner/action@<40-hex>` optionally followed by `# <version>`. */
const PIN = /([\w.-]+\/[\w.-]+)@([0-9a-f]{40})(\s*#\s*(\S+))?/g;

/**
 * The manifest header gh-aw writes as line 2 of every lock:
 * `# gh-aw-manifest: {"version":1,"actions":[{"repo":…,"sha":…,"version":…}],…}`.
 *
 * READING IT IS THE WHOLE POINT OF THE SECOND EVIDENCE SOURCE (Codex on PR #284). The
 * paragraph above has always claimed the manifest as evidence, and `main` has always
 * passed the lock text in — but the only reader was `PIN`, which matches
 * `owner/action@sha`, a shape the manifest does not contain: it states `repo` and `sha`
 * as separate JSON fields. So the lock contributed evidence ONLY through its other
 * `uses:` lines, and a compiler-owned pin stripped in every lock and named in no
 * authored source was unrecoverable — while the version sat in the header of the very
 * file that lost it. `lock:enforce` then reported "pin comments already intact", which
 * is the failure mode worth naming: not a missing restore, but a missing restore
 * reported as a clean one.
 *
 * Malformed or absent manifest → no entries, never a throw. This script runs after
 * every compile and must not be what fails a build.
 */
export function versionsFromManifest(text: string): [string, string][] {
  const line = /^#\s*gh-aw-manifest:\s*(\{.*\})\s*$/m.exec(text);
  if (!line?.[1]) return [];
  try {
    const parsed: unknown = JSON.parse(line[1]);
    const actions = (parsed as { actions?: unknown }).actions;
    if (!Array.isArray(actions)) return [];
    return actions.flatMap((entry): [string, string][] => {
      const { sha, version } = entry as { sha?: unknown; version?: unknown };
      if (typeof sha !== 'string' || typeof version !== 'string') return [];
      return [[sha, version]];
    });
  } catch {
    return [];
  }
}

/**
 * SHA → version, from every place that already states it. A SHA that two sources
 * describe differently is DROPPED rather than resolved by precedence: this script may
 * only restore a version the tree already agrees on, and a disagreement is a thing to
 * look at rather than a thing to pick a winner from.
 */
export function versionsBySha(sources: readonly string[]): Map<string, string> {
  const seen = new Map<string, Set<string>>();
  const record = (sha: string | undefined, version: string | undefined): void => {
    // A "version" that just repeats the SHA is the v0.88.7 rewrite, not a version — and
    // the manifest carries that degenerate form too (build-template's own header states
    // `actions/checkout` with its SHA as the version), so the same filter has to guard
    // both readers.
    if (!sha || !version || version === sha || !/^v\d/.test(version)) return;
    const bucket = seen.get(sha) ?? new Set<string>();
    bucket.add(version);
    seen.set(sha, bucket);
  };
  for (const text of sources) {
    for (const [, , sha, , version] of text.matchAll(PIN)) record(sha, version);
    for (const [sha, version] of versionsFromManifest(text)) record(sha, version);
  }
  const resolved = new Map<string, string>();
  for (const [sha, versions] of seen) {
    if (versions.size === 1) resolved.set(sha, [...versions][0]!);
    else console.warn(`pin ${sha.slice(0, 8)} is described ${versions.size} ways (${[...versions].join(', ')}) — left alone`);
  }
  return resolved;
}

/** Restore the comment on every pin that lost one, and correct a SHA-as-comment rewrite. */
export function restoreComments(lock: string, versions: ReadonlyMap<string, string>): { text: string; fixed: number } {
  let fixed = 0;
  const text = lock.replace(PIN, (whole, action: string, sha: string, comment: string | undefined, version: string | undefined) => {
    const known = versions.get(sha);
    if (!known) return whole;
    // Already correct — leave it byte-for-byte, so the script is idempotent.
    if (version === known) return whole;
    // Restore an absent comment, or replace one that is the bare SHA. Anything else is
    // a real disagreement between the lock and the source and is NOT overwritten here.
    if (comment !== undefined && version !== sha) return whole;
    fixed += 1;
    return `${action}@${sha} # ${known}`;
  });
  return { text, fixed };
}

function main(): void {
  const sources = SOURCES.map((p) => readFileSync(p, 'utf8'));
  const lockTexts = LOCKS.map((p) => readFileSync(p, 'utf8'));
  // The locks are read as evidence too: the manifest header gh-aw writes at the top
  // carries the SHA with its version even where the step below has been stripped.
  const versions = versionsBySha([...sources, ...lockTexts]);

  LOCKS.forEach((path, i) => {
    const { text, fixed } = restoreComments(lockTexts[i]!, versions);
    if (fixed === 0) {
      console.log(`${path.split('/').pop()}: pin comments already intact`);
      return;
    }
    writeFileSync(path, text);
    console.log(`${path.split('/').pop()}: restored ${fixed} pin version comment(s)`);
  });
}

if (process.argv[1] && process.argv[1].endsWith('enforce-pin-comments.ts')) main();
