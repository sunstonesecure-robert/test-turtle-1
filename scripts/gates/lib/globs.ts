/**
 * The one path-glob matcher (T206/T238/T239/T240).
 *
 * Two gates ask path questions and they must not answer them differently: D2 asks
 * "is this path INSIDE the step's declared scope?" and D5/G16 ask "is this path
 * inside the RESERVED set?". A second matcher is how one gate comes to accept a
 * path the other refuses, which on these two gates means a build that is both
 * in-scope and out-of-bounds — or neither.
 *
 * Deliberately small, and deliberately not `minimatch`: the vendored toolchain is
 * installed into every governed repo, so a dependency here is a dependency there
 * (install.ts vendors package.json too), and the grammar a plan step needs is
 * three constructs wide. What is supported, exhaustively:
 *
 *   `docs/index.html`  exact path
 *   `docs/*.html`      one segment, no `/`
 *   `docs/**`          this directory and everything beneath it
 *   `docs/`            trailing slash = the same as `docs/**`
 *   `docs`             a BARE DIRECTORY NAME also matches everything beneath it
 *
 * That last one is a deliberate leniency in the SCOPE direction and a necessity in
 * the RESERVED direction. A plan author writing `scope: ["docs"]` plainly means the
 * directory, and reading it as "a file literally named docs" would refuse their
 * whole deliverable for a missing slash. In the reserved set it is load-bearing:
 * `TOOLCHAIN_DIRS` holds bare directory names (`scripts`, `schemas`), and a matcher
 * that read those as file names would reserve nothing at all.
 *
 * Note the asymmetry that follows and is intended: leniency widens what a scope
 * ALLOWS, which D5 then re-judges against the reserved set regardless. Leniency in
 * the reserved set widens what is FORBIDDEN. Both directions err toward refusing,
 * which is the direction a gate should err in.
 */

/** Normalize to the repo-relative, forward-slash, no-leading-`./` form every
 *  comparison here assumes. Anything that escapes the repo root is not normalized
 *  into safety — see `isRepoRelative`, which refuses it outright. */
export function normalizePath(path: string): string {
  return path.trim().replace(/\\/g, '/').replace(/^\.\//, '').replace(/^\/+/, '').replace(/\/+/g, '/');
}

/**
 * Does this path stay inside the repository?
 *
 * Refused, not repaired: `../`, an absolute path, and a Windows drive letter are
 * all ways a patch names a file outside the checkout, and "resolve it and see" is
 * how a traversal becomes a write. The deliverable gate calls this before any glob
 * question, because a path that is not repo-relative has no meaningful answer to
 * "is it in scope?" — it is simply refused.
 */
export function isRepoRelative(path: string): boolean {
  // The RAW value is what decides, not the normalized one. `normalizePath` strips a
  // leading slash — so asking it about `/etc/passwd` yields `etc/passwd`, which looks
  // perfectly repo-relative. That is the whole class of bug this function exists to
  // stop, and it was present in the first draft (found by
  // tests/unit/subject-boundary.test.ts).
  const raw = path.trim().replace(/\\/g, '/');
  if (raw.length === 0) return false;
  if (raw.startsWith('/')) return false;
  if (/^[a-zA-Z]:/.test(path.trim())) return false;
  return !raw.split('/').includes('..');
}

/**
 * One glob → a full-match regex over a normalized path.
 *
 * Built segment by segment rather than character by character. The character-wise
 * version was subtly wrong in the two places it mattered most, and the tests in
 * `tests/unit/subject-boundary.test.ts` are what found them:
 *   • `docs/**` did not match `docs` itself, so a patch that touched a reserved
 *     DIRECTORY entry rather than a file inside it slipped past.
 *   • a middle `**` (`**\/*.md`) emitted a doubled separator and matched nothing.
 * Segments make the `**`-spans-separators rule explicit instead of emergent.
 */
function globToRegExp(glob: string): RegExp {
  let g = normalizePath(glob);
  // `docs/` and a bare `docs` both mean the directory and everything under it. The
  // bare form is only read as a directory when it carries no wildcard — `*.md` is a
  // pattern, not a folder. An exact file path gets the same treatment harmlessly:
  // nothing can live under `package.json`.
  if (g.endsWith('/')) g = `${g.slice(0, -1)}/**`;
  else if (!/[*?]/.test(g)) g = `${g}/**`;

  const escape = (seg: string): string =>
    seg
      .replace(/[.+^${}()|[\]\\]/g, '\\$&')
      .replace(/\*/g, '[^/]*')
      .replace(/\?/g, '[^/]');

  const segments = g.split('/');
  let out = '';
  /** true when the pattern so far already ends in a separator (or is empty), so the
   *  next segment must NOT add one — the doubled-slash bug. */
  let separatorPending = true;
  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i]!;
    const last = i === segments.length - 1;
    if (seg === '**') {
      if (last) {
        // A trailing `**` also matches the parent itself: `docs/**` covers `docs`.
        out += i === 0 ? '.*' : '(?:/.*)?';
      } else {
        out += i === 0 ? '(?:[^/]+/)*' : '(?:/[^/]+)*/';
      }
      separatorPending = true;
      continue;
    }
    if (!separatorPending) out += '/';
    out += escape(seg);
    separatorPending = false;
  }
  return new RegExp(`^${out}$`);
}

/** Does `path` match `glob`? Both are normalized first. */
export function matchesGlob(path: string, glob: string): boolean {
  return globToRegExp(glob).test(normalizePath(path));
}

/** Does `path` match ANY of `globs`? An empty pattern list matches nothing —
 *  never everything, which is the reading that would turn an unset scope into a
 *  licence and an empty reserved set into an open door. */
export function matchesAny(path: string, globs: readonly string[]): boolean {
  return globs.some((g) => matchesGlob(path, g));
}

/** The subset of `paths` that matches none of `globs` — i.e. what strayed.
 *  Returned rather than a boolean because every refusal in this system names the
 *  offending paths, and a caller that has to recompute them will phrase it
 *  differently from the gate that decided. */
export function pathsOutside(paths: readonly string[], globs: readonly string[]): string[] {
  return paths.filter((p) => !matchesAny(p, globs));
}

/** The subset of `paths` that matches at least one of `globs` — the reserved-set
 *  question, which is the complement of the scope question and is asked by D5/G16. */
export function pathsInside(paths: readonly string[], globs: readonly string[]): string[] {
  return paths.filter((p) => matchesAny(p, globs));
}
