import { execFileSync } from 'node:child_process';
import { lstatSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

/**
 * Vendored-source materializer for the build environment (GHI #274, live run 35236838549).
 *
 * The defect, 2026-09-17: work item #113's acceptance required every LZA config key to be
 * "confirmed against the checked-out release source under `vendor/lza` rather than from
 * memory (CFG-005/CFG-006)". `build-template` checks out the gate code, then the frozen plan
 * tag, and NOTHING ELSE — and the subject's `.gitignore` ignores `vendor/`, so the frozen
 * checkout cannot carry it either. The agent looked, found zero files, correctly refused to
 * invent `useV2Stacks` from memory, and emitted `missing_data`. A 9m41s, 132.3-AIC build
 * delivered nothing, and `build-publish` failed on the absent `deliverable.patch`.
 *
 * The build environment is harness. A plan may legitimately require its agent to read the
 * pinned upstream it is configuring; nothing in the harness was willing to put it there.
 *
 * WHAT THIS IS NOT. It is not LZA-specific, and deliberately so: `build-template` is installed
 * into every governed target. It reads a MANIFEST the subject repo already maintains at the
 * frozen commit, so the harness learns what to vendor from operator-approved repository
 * content rather than from a literal compiled into the machinery. The subject's own REP-010
 * says the pin is recorded exactly once and every workflow reads it from there; this is a
 * reader, not a second copy.
 *
 * THE CONTRACT. Any file `<name>.lock` at the repository ROOT that parses as YAML carrying
 * both `sourceRepository` (an https git URL) and `commit` (40 hex) is a vendor manifest, and
 * is materialized at that commit into `vendor/<name>/`. With `version` also present, the tag
 * is resolved and compared to `commit`, and a disagreement fails the run — the subject's
 * REP-011 rule, applied before the agent spends anything rather than after.
 *
 * FAILURE POLICY. Absent manifest → nothing to do, reported as `none`, exit 0: most targets
 * vendor nothing. Malformed, unsafe, mismatched or unfetchable → hard fail, because a
 * half-materialized `vendor/` is worse than an empty one. The agent treats what is there as
 * authoritative source; an absent vendor must never read as a materialized one, the same rule
 * the gate-set resolver applies to gates.
 *
 * The JSON report is written where `build-preflight`'s report already goes, so the agent reads
 * both from the same read-only handoff mount instead of re-deriving either.
 *
 * NODE BUILTINS ONLY, AND THAT IS LOAD-BEARING. This runs AFTER the frozen checkout — it has to,
 * because `actions/checkout` cleans the workspace and would delete anything vendored before it —
 * but it must be the CURRENT harness copy, not the one the frozen tag happens to carry, for the
 * reason GHI #107 gives about gates and GHI #265 gives about every other fix: a tag frozen before
 * this file existed carries no copy at all, and re-init cannot reach it. So `build-template`
 * stages this single file out to `$RUNNER_TEMP` during the gates phase and runs it from there.
 * A staged file resolves nothing from the workspace's `node_modules`, so an import of `yaml` or
 * `zod` would fail at exactly the moment this is supposed to work. The flat `key: value` reader
 * below is the same shape the subject's own `lock_value()` helper reads (REP-010), which is why
 * the manifest contract is flat scalars rather than arbitrary YAML.
 */

/** A root `<name>.lock` we will never mistake for a vendor manifest, whatever it contains. */
export const PACKAGE_MANAGER_LOCKS = new Set([
  'yarn.lock',
  'package.lock',
  'composer.lock',
  'cargo.lock',
  'poetry.lock',
  'pdm.lock',
  'gemfile.lock',
  'flake.lock',
  'pnpm.lock',
  'bun.lock',
  'uv.lock',
  'mix.lock',
  'terraform.lock',
]);

/**
 * `<name>` must be one safe path segment: it becomes `vendor/<name>`, so no separators, no
 * dot-segments, no leading dash (which `git` would read as a flag wherever it is passed).
 */
export const VENDOR_NAME = /^[a-z0-9][a-z0-9._-]*$/;

/**
 * An https git remote, with no credentials and no leading dash. Deliberately narrow: this
 * string is handed to `git fetch` in a build runner, and the only shape any governed target
 * has needed is a plain public https clone URL.
 */
export const SOURCE_REPOSITORY = /^https:\/\/[A-Za-z0-9.-]+(?::\d+)?\/[A-Za-z0-9._~\-/]+?(?:\.git)?$/;

/** More than this many manifests at the root is a misreading of the contract, not a repo. */
export const MAX_MANIFESTS = 8;

export type VendorManifest = {
  /** The lock file, repo-relative. */ file: string;
  /** Destination directory name — `vendor/<name>`. */ name: string;
  sourceRepository: string;
  commit: string;
  version?: string;
};

export type VendorReport = {
  /**
   * `materialized` — every declared source is on disk. `none` — nothing was declared.
   * `unavailable` — this file was not in the chosen gate set and never ran; written by the
   * workflow step, not by this module, and listed here because it is part of the shape the
   * agent reads (Codex P1 on PR #275: `gates_ref` may name a pinned release older than this).
   */
  status: 'none' | 'materialized' | 'unavailable';
  /** Why nothing was vendored, when `status` is not `materialized` — so an absent vendor says so by name. */
  detail?: string;
  vendored: Array<{ name: string; path: string; sourceRepository: string; commit: string; version?: string }>;
};

/**
 * The TOP-LEVEL `key: value` scalars of a flat YAML document, and nothing else. An indented
 * line, a list item, a block scalar or a nested mapping is skipped rather than interpreted:
 * this reads a pin, it is not a YAML implementation. Quotes are stripped, a trailing `#`
 * comment is dropped when it follows whitespace (so a `#` inside a value or a URL fragment
 * survives), and a repeated key keeps the FIRST occurrence — the same choice the subject's
 * documented `lock_value()` awk helper makes, so the two readers cannot disagree about a lock.
 */
export function readFlatScalars(contents: string): Record<string, string | undefined> {
  const out: Record<string, string> = {};
  for (const rawLine of contents.split(/\r?\n/)) {
    if (rawLine.length === 0 || /^\s/.test(rawLine)) continue; // blank, or not top level
    const line = rawLine.startsWith('#') ? '' : rawLine;
    const match = /^([A-Za-z_][A-Za-z0-9_-]*):[ \t]*(.*)$/.exec(line);
    if (!match) continue;
    const key = match[1]!;
    if (key in out) continue;
    let value = match[2]!.replace(/[ \t]+#.*$/, '').trim();
    if (value.length === 0) continue; // a nested mapping or an empty scalar — not a pin
    if (
      (value.startsWith('"') && value.endsWith('"') && value.length >= 2) ||
      (value.startsWith("'") && value.endsWith("'") && value.length >= 2)
    ) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

/**
 * Decide whether one root file declares a vendored source. Pure, so the contract is testable
 * without a network or a repository: returns the manifest, `null` for "not a vendor manifest"
 * (the ordinary case — a package-manager lock, or a file without the two required keys), or
 * throws for "declares itself a vendor manifest and is unusable", which must fail the run.
 */
export function readManifest(fileName: string, contents: string): VendorManifest | null {
  if (!fileName.endsWith('.lock')) return null;
  if (PACKAGE_MANAGER_LOCKS.has(fileName.toLowerCase())) return null;

  const record = readFlatScalars(contents);
  if (!('sourceRepository' in record) || !('commit' in record)) return null;

  const name = fileName.slice(0, -'.lock'.length);
  const fail = (why: string): never => {
    throw new Error(
      `${fileName} declares a vendored source (it carries sourceRepository and commit) but ${why}. ` +
        `A build whose plan reads vendor/${name} must not start against a source this file cannot pin.`,
    );
  };

  if (!VENDOR_NAME.test(name)) fail('its name does not form a safe vendor/<name> directory');

  const sourceRepository = record.sourceRepository!;
  const commit = record.commit!;
  const version = record.version;

  if (!SOURCE_REPOSITORY.test(sourceRepository)) {
    fail(`sourceRepository "${sourceRepository}" is not a plain https git URL without credentials`);
  }
  if (!/^[0-9a-f]{40}$/.test(commit)) {
    fail(`commit "${commit}" is not a full 40-character sha (an abbreviated or symbolic pin is not a pin)`);
  }
  if (version !== undefined && (version.length === 0 || version.startsWith('-'))) {
    fail(`version "${version}" is not a usable ref name`);
  }

  return { file: fileName, name, sourceRepository, commit, version };
}

/** Every vendor manifest at the repository root, in a stable order. */
export function findManifests(root: string): VendorManifest[] {
  const found: VendorManifest[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    if (!entry.isFile() || !entry.name.endsWith('.lock')) continue;
    const manifest = readManifest(entry.name, readFileSync(join(root, entry.name), 'utf8'));
    if (manifest) found.push(manifest);
  }
  if (found.length > MAX_MANIFESTS) {
    throw new Error(
      `${found.length} vendor manifests at the repository root exceeds the cap of ${MAX_MANIFESTS} ` +
        `(${found.map((m) => m.file).join(', ')}). Materializing them all would dominate the build run.`,
    );
  }
  return found;
}

const git = (cwd: string, ...args: string[]): string =>
  execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

/**
 * Shallow-clone one manifest's source at its pinned commit. `git init` + a single-commit fetch
 * rather than `clone`: upstreams like landing-zone-accelerator carry years of history nobody in
 * a build run reads, and only the pinned tree is ever authoritative here.
 */
export function materialize(root: string, manifest: VendorManifest): void {
  const parent = join(root, 'vendor');
  const dest = join(parent, manifest.name);

  // NOTHING IS DELETED TO MAKE ROOM (Codex P1 on PR #275). The first draft opened with
  // `rmSync(dest, { recursive: true, force: true })`, which is wrong twice over. A frozen
  // repository may TRACK a `vendor` symlink — git records symlinks — and a recursive delete
  // resolves the path through it, so the target of that link is what gets destroyed, outside
  // the workspace entirely. And even on a plain directory, a tracked `vendor/<name>` tree is
  // operator-approved repository content at the frozen commit: erasing it to install an
  // upstream would replace what was approved with something nobody reviewed, silently, before
  // the agent reads either. Both are refusals, not situations to clean up: this step exists to
  // ADD a source the build environment lacked, and a destination that is already occupied means
  // the lock and the repository disagree about what `vendor/<name>` is.
  const kind = (path: string): 'absent' | 'dir' | 'other' => {
    try {
      return lstatSync(path).isDirectory() ? 'dir' : 'other';
    } catch {
      return 'absent'; // ENOENT, and anything else unreadable is equally not a directory to write into
    }
  };

  const parentKind = kind(parent);
  if (parentKind === 'other') {
    throw new Error(
      `${manifest.file} declares vendor/${manifest.name}, but "vendor" in the frozen checkout is not a ` +
        `directory (a symlink or a file). Refusing to write through it: the path it resolves to is not ` +
        `the approved worktree.`,
    );
  }
  if (kind(dest) !== 'absent') {
    throw new Error(
      `${manifest.file} declares vendor/${manifest.name}, but the frozen commit already carries ` +
        `vendor/${manifest.name}. That is approved repository content; materializing over it would replace ` +
        `what the operator approved with an upstream nobody reviewed. Either the lock or the tracked tree ` +
        `is wrong, and which one is not this step's call.`,
    );
  }

  mkdirSync(dest, { recursive: true });

  git(dest, 'init', '--quiet');
  git(dest, 'remote', 'add', 'origin', manifest.sourceRepository);

  if (manifest.version) {
    // REP-011, hoisted into the build environment: resolve the TAG and compare it to the
    // commit, so a lock whose two halves have drifted fails here rather than handing the agent
    // a tree that is not the release the plan named.
    git(dest, 'fetch', '--depth', '1', 'origin', `refs/tags/${manifest.version}:refs/tags/${manifest.version}`);
    const resolved = git(dest, 'rev-parse', `refs/tags/${manifest.version}^{commit}`);
    if (resolved !== manifest.commit) {
      throw new Error(
        `${manifest.file} pins ${manifest.version} to ${manifest.commit}, but ${manifest.sourceRepository} ` +
          `resolves ${manifest.version} to ${resolved}. The lock's tag and commit disagree; refusing to ` +
          `vendor either, because the agent would read whichever one it got as the pinned release.`,
      );
    }
  } else {
    git(dest, 'fetch', '--depth', '1', 'origin', manifest.commit);
  }

  git(dest, 'checkout', '--quiet', '--detach', manifest.commit);
}

/**
 * Materialize every declared vendored source under `<root>/vendor/`, and return what was done.
 * Callers get the report; `main` also writes it to disk for the agent's handoff mount.
 */
export function materializeAll(root: string): VendorReport {
  const manifests = findManifests(root);
  if (manifests.length === 0) {
    return {
      status: 'none',
      detail: 'no root <name>.lock declares both sourceRepository and commit — this target vendors nothing',
      vendored: [],
    };
  }
  for (const manifest of manifests) materialize(root, manifest);
  return {
    status: 'materialized',
    vendored: manifests.map((m) => ({
      name: m.name,
      path: `vendor/${m.name}`,
      sourceRepository: m.sourceRepository,
      commit: m.commit,
      ...(m.version ? { version: m.version } : {}),
    })),
  };
}

function main(argv: string[]): void {
  const arg = (flag: string): string | undefined => {
    const i = argv.indexOf(flag);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const root = arg('--root') ?? process.cwd();
  const reportPath = arg('--report');

  const report = materializeAll(root);

  if (reportPath) {
    mkdirSync(dirname(reportPath), { recursive: true });
    writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  }
  // Reported either way, so "this target vendors nothing" is a stated fact in the run log
  // rather than the silence of a step that did not run.
  if (report.status === 'none') {
    console.log(`vendor: nothing to materialize — ${report.detail}`);
  } else {
    for (const v of report.vendored) {
      console.log(`vendor: ${v.path} = ${v.sourceRepository} @ ${v.version ? `${v.version} (${v.commit})` : v.commit}`);
    }
  }
}

if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  try {
    main(process.argv.slice(2));
  } catch (err) {
    console.error(`::error::${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
}
