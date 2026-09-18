import type { Octokit } from '@octokit/rest';
import type { RepoRef } from '../../../dashboard/lib/github/client';
import type { PlanDoc } from '../../../schemas/plan';
import { MAX_MANIFESTS, readManifest } from '../../materialize-vendor';
import { readsWithoutPlanProvider, unorderedReadProviders, type RepositoryAnswer } from './checks-reads';
import { globCovers, literalPrefix } from './globs';
import { pathKindAtRef, readFileAtRef } from './repo-read';

/**
 * The REPOSITORY half of G20 — providers A and C (GHI #274).
 *
 * A declared read has exactly three legitimate providers, and only one of them is
 * answerable from the plan document alone:
 *
 *   A  it exists at the approval ref                  → this module
 *   B  an earlier step's `scope` produces it          → `checks-reads.ts`, pure
 *   C  a root `<name>.lock` fetches it into vendor/   → this module
 *
 * None of the three, and nothing will ever provide it.
 *
 * KEPT OUT OF `checks-reads.ts` FOR A REASON THAT IS NOT STYLE. This module imports
 * `scripts/materialize-vendor.ts`, whose entry guard uses `import.meta.url`, and
 * `checks-reads.ts` is reachable from `dashboard/app` through `gate-preview.ts`.
 * Webpack reads that construct as an asset reference it must resolve at build time and
 * `next build` dies on it — the break `tests/unit/dashboard-bundle-boundary.test.ts`
 * now guards. One import away.
 *
 * WHY IT SHARES THE MANIFEST READER RATHER THAN RESTATING IT. `readManifest` decides
 * what the BUILD ENVIRONMENT will actually materialize. A second definition of "is this
 * a vendor manifest" here would let the approval report promise a source the build then
 * does not fetch — a worse failure than the one this gate exists for.
 *
 * SILENCE ON A DEGRADED READ, ALWAYS. An unknown that stops the whole question being
 * asked — no plan ref, an unreadable root, more manifests than the materializer will
 * process — returns `{ read: false }` with its reason, and the caller reports
 * `not-applicable` rather than warning about paths that are probably present (ADR-0007).
 *
 * A PER-CANDIDATE UNKNOWN IS DIFFERENT AND IS NAMED. One glob whose existence could not
 * be determined produces no accusation about that glob — but it does produce a clause
 * saying the check is incomplete, because a row that reports only what it managed to
 * look at, as though that were everything, is the "an absent check reads as a passing
 * one" defect this gate was written to catch.
 *
 * PROVIDER B CAN NEVER SUPPLY A `vendor/` READ, and that is not an oversight: `vendor/**`
 * is in the reserved path set, so G16 refuses any step declaring it as `scope`. A
 * vendored source is provided by A or by C or by nothing.
 */
export async function unprovidedReads(
  gh: Octokit,
  repo: RepoRef,
  plan: PlanDoc,
  planRef: string | null,
): Promise<RepositoryAnswer> {
  if (planRef === null) {
    return {
      read: false,
      why: 'the approval branch this plan came from is not known here, so nothing could be checked against the repository',
    };
  }
  const candidates = readsWithoutPlanProvider(plan);
  // Reads that another step DOES write, where the reader declares no dependency on it.
  // The pure half reports those as an ordering risk; a path the tree already holds is
  // not one, so their existence is looked up here and handed back (Codex on PR #277).
  const ordering = unorderedReadProviders(plan);
  // Nothing to ask the repository about at all — which is every plan frozen before this
  // field existed.
  if (candidates.length === 0 && ordering.length === 0) return { read: true, problems: [], presentAtRef: [] };

  // ---- provider C: what the build environment will materialize ----
  let root: Awaited<ReturnType<Octokit['repos']['getContent']>>['data'];
  try {
    ({ data: root } = await gh.repos.getContent({ ...repo, path: '', ref: planRef }));
  } catch {
    return {
      read: false,
      why: 'the repository root could not be listed at the approval branch, so which vendored sources it declares is unknown',
    };
  }
  if (!Array.isArray(root)) {
    return {
      read: false,
      why: 'the repository root could not be listed at the approval branch, so which vendored sources it declares is unknown',
    };
  }
  const locks = root
    .filter((e) => e.type === 'file' && e.name.endsWith('.lock'))
    .map((e) => e.name)
    .sort((a, b) => a.localeCompare(b));
  // A BOUND ON WHAT AN ADVISORY WILL SPEND, which is not the manifest cap. The
  // materializer walks a local directory; this walks the contents API, one request per
  // file, on a check that refuses nothing. A root carrying more `.lock` files than this
  // is not asked about at all — said as an unknown, never as a clean result.
  if (locks.length > MAX_MANIFESTS * 3) {
    return {
      read: false,
      why: `the repository root carries ${locks.length} lock files, more than this check will read at approval time, so which vendored sources it declares is unknown`,
    };
  }
  const vendored: string[] = [];
  const unusable: { file: string; why: string }[] = [];
  for (const file of locks) {
    // THE FOUR-VALUED READER, not the throwing one (Codex P1 on PR #277). This module
    // promises that a degraded read says nothing and refuses nothing, and `readTextAtRef`
    // throws on anything but a verified 404 — so one transient 5xx on one `.lock` file
    // would have aborted the whole plan gate and turned an advisory-only check into an
    // approval-blocking failure. A lock we could not read is a provider we cannot rule
    // out, so the whole answer degrades rather than accusing a path of being unprovided.
    const lock = await readFileAtRef(gh, repo, file, planRef);
    if (lock.kind === 'absent') continue;
    if (lock.kind === 'unreadable') {
      return {
        read: false,
        why: `\`${file}\` at the approval branch could not be read (${lock.why}), so which vendored sources this repository declares is unknown`,
      };
    }
    try {
      const manifest = readManifest(file, lock.text);
      if (manifest !== null) vendored.push(manifest.name);
    } catch (error: unknown) {
      unusable.push({ file, why: error instanceof Error ? error.message : String(error) });
    }
  }

  // THE MANIFEST CAP IS APPLIED WHERE THE MATERIALIZER APPLIES IT (Codex on PR #277):
  // to the files that PARSE as vendor manifests, not to every root `.lock`. A polyglot
  // monorepo with nine package-manager locks materializes fine — `readManifest` returns
  // null for each of them — and capping on the raw count would have made this check
  // decline to look at a repository the build handles without complaint.
  if (vendored.length + unusable.length > MAX_MANIFESTS) {
    return {
      read: false,
      why: `the repository root declares more vendored sources than the build environment will materialize, so the build will refuse before the agent starts and what it would have fetched is unknown`,
    };
  }

  // ---- provider A, per candidate ----
  const problems: string[] = [];
  // A glob whose existence we could not determine is NOT one nothing provides, and it
  // is not one something provides either. Collected, and named in the answer — because
  // reporting the row as if every candidate had been looked at is the same "unknown
  // read as a fact" defect this gate exists to catch, one level in.
  const unknown: string[] = [];
  const presentAtRef: string[] = [];
  for (const { stepId, glob } of ordering) {
    const base = literalPrefix(glob);
    if (base.length === 0) continue;
    const kind = await pathKindAtRef(gh, repo, base, planRef);
    // Only a POSITIVE answer suppresses the ordering clause. `absent` leaves it standing
    // (the reader really is waiting) and `null` leaves it standing too — a lookup that
    // failed must not silence a finding the document alone justifies.
    if (kind === 'file' || kind === 'directory') presentAtRef.push(`${stepId}\u0000${glob}`);
  }
  for (const { stepId, glob } of candidates) {
    if (vendored.some((name) => globCovers(`vendor/${name}/**`, glob))) continue;
    const broken = unusable.find((u) => globCovers(`vendor/${u.file.replace(/\.lock$/, '')}/**`, glob));
    if (broken !== undefined) {
      problems.push(
        `${stepId} says it reads \`${glob}\`, and the only thing that would fetch it is \`${broken.file}\`, ` +
          `which cannot be used: ${broken.why}`,
      );
      continue;
    }
    const base = literalPrefix(glob);
    // A glob with no literal prefix (`**`, `*.md`) names nothing we can ask a repository
    // about — so it is an UNKNOWN, not a skip (Codex on PR #277). Skipping it silently
    // let the row report `pass` having made no check at all for that read, which is the
    // same defect the branch below exists to prevent, two lines apart.
    if (base.length === 0) {
      unknown.push(`${stepId} → \`${glob}\``);
      continue;
    }
    const kind = await pathKindAtRef(gh, repo, base, planRef);
    // `null` is "we could not find out". No clause — a path we could not look up must
    // not be reported as one nothing provides — but it is recorded, so the row does not
    // read as a complete answer.
    if (kind === null) {
      unknown.push(`${stepId} → \`${glob}\``);
      continue;
    }
    if (kind !== 'absent') continue;
    problems.push(
      `${stepId} says it reads \`${glob}\`, and nothing will provide it: it is not in the tree at \`${planRef}\`, ` +
        `no step it comes after writes it, and no lock file at the repository root fetches it`,
    );
  }
  if (unknown.length > 0) {
    problems.push(
      `whether the tree holds ${unknown.length === 1 ? 'one declared read' : `${unknown.length} declared reads`} ` +
        `could not be determined (${unknown.join(', ')}), so this check is incomplete rather than clean`,
    );
  }
  return { read: true, problems, presentAtRef };
}
