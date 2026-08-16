import type { Octokit } from '@octokit/rest';
import type { RepoRef } from './client';
import { PlanDoc } from '../../../schemas/plan';
import { errorMessage } from './errors';

/**
 * Run-artifact handling for the monitor (T069, FR-014). Two responsibilities,
 * kept strictly apart:
 *   - I/O (thin): list a run's artifacts and download one, through the
 *     ETag-caching client (client.ts).
 *   - PURE derivations over already-extracted ENTRY content: zod-parse the
 *     UNTRUSTED payload against schemas/plan.ts and render as DATA (never
 *     executed/eval'd — constitutional constraint, dashboard-github-api.md), and
 *     detect the missing-data safe-output signal.
 *
 * NO-NEW-DEPENDENCIES: the repo has no zip library and must not gain one. The
 * only archive-container concern — turning a downloaded artifact into entry
 * content — is isolated in extractArtifactEntry (the parked seam below); every
 * tested rule runs over entry text a caller supplies, so the wave is fully
 * testable regardless of how the container is unpacked.
 */

export interface RunArtifact {
  id: number;
  name: string;
  sizeInBytes: number;
  expired: boolean;
}

/** List a run's artifacts (GET /actions/runs/{run_id}/artifacts). Paginated. */
export async function listRunArtifacts(gh: Octokit, repo: RepoRef, runId: number): Promise<RunArtifact[]> {
  // A malformed id would silently build /actions/runs//artifacts — a request
  // that can only 404 while looking like a real read (seen live, PB run
  // 2026-08-16, after a crashed render left a caller with corrupted state).
  if (!Number.isInteger(runId) || runId <= 0) throw new Error(`listRunArtifacts: invalid run id ${String(runId)}`);
  const data = await gh.paginate(gh.actions.listWorkflowRunArtifacts, { ...repo, run_id: runId, per_page: 100 });
  return data.map((a) => ({ id: a.id, name: a.name, sizeInBytes: a.size_in_bytes, expired: a.expired }));
}

/**
 * Is this artifact a candidate carrier of the safe-output signal? gh-aw's
 * collected safe outputs land in artifacts named `safe-outputs-*` (observed
 * live: safe-outputs-items at ~575 BYTES) — while the same runs also carry
 * multi-hundred-KB binary bundles (`agent`, `activation`) that can never hold
 * the signal. Scanning those wasted ~4 MB of downloads per cold poll (the 7 s
 * first paint) and fed megabytes of decoded binary garbage into the render
 * path (live /runs 500, PB run 2026-08-16). Name-match plus a generous size
 * cap: a signal file is KBs; anything bigger is a bundle, whatever its name.
 */
export const MAX_SIGNAL_ARTIFACT_BYTES = 256 * 1024;

export function isSafeOutputArtifact(artifact: Pick<RunArtifact, 'name' | 'sizeInBytes'>): boolean {
  return /^safe[-_]?outputs?\b/i.test(artifact.name) && artifact.sizeInBytes <= MAX_SIGNAL_ARTIFACT_BYTES;
}

/** Download one artifact's archive bytes (GET /actions/artifacts/{id}/zip). */
export async function downloadArtifactArchive(gh: Octokit, repo: RepoRef, artifactId: number): Promise<Uint8Array> {
  const res = await gh.request('GET /repos/{owner}/{repo}/actions/artifacts/{artifact_id}/{archive_format}', {
    ...repo,
    artifact_id: artifactId,
    archive_format: 'zip',
  });
  // Non-JSON content: octokit returns the body as an ArrayBuffer.
  return new Uint8Array(res.data as unknown as ArrayBuffer);
}

/**
 * ARCHIVE-CONTAINER BOUNDARY (parked — GHI candidate). The ONLY place a
 * downloaded artifact container is turned into entry content. GitHub serves
 * artifact downloads as a ZIP archive; extracting a named entry from a
 * multi-file ZIP central directory needs a ZIP reader, which the Node standard
 * library does not provide and NO-NEW-DEPENDENCIES forbids adding — and a
 * hand-rolled central-directory parser is explicitly out of scope. This wave
 * therefore treats the downloaded container as the single entry's UTF-8 bytes
 * (the shape tests and the msw mock's download endpoint produce), so the pure
 * parse + missing-data derivations run end to end over real entry content.
 * Real multi-file / DEFLATE ZIP extraction is parked on GHI #55. Callers that
 * already hold extracted text bypass this and call the pure functions directly.
 */
export function extractArtifactEntry(archive: Uint8Array): string {
  return new TextDecoder('utf-8').decode(archive);
}

/** Download + extract one artifact to its entry text (I/O + the boundary). */
export async function fetchArtifactEntry(gh: Octokit, repo: RepoRef, artifactId: number): Promise<string> {
  return extractArtifactEntry(await downloadArtifactArchive(gh, repo, artifactId));
}

export interface ParsedPlanArtifact {
  /** the parsed plan, or null on any failure (rendered as data, never executed) */
  plan: PlanDoc | null;
  /** path:message issues, mirroring plans.ts tryReadPlanAtRef; empty on success */
  errors: string[];
}

/**
 * PURE: zod-parse an UNTRUSTED artifact entry against PlanDoc. Returns issues
 * instead of throwing so the monitor can render a malformed payload as data.
 * Nothing from the artifact is ever executed or eval'd.
 */
export function parsePlanArtifact(entry: string): ParsedPlanArtifact {
  let json: unknown;
  try {
    json = JSON.parse(entry);
  } catch (error: unknown) {
    return { plan: null, errors: [`artifact is not valid JSON: ${errorMessage(error)}`] };
  }
  const parsed = PlanDoc.safeParse(json);
  if (!parsed.success) {
    return { plan: null, errors: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`) };
  }
  return { plan: parsed.data, errors: [] };
}

// gh-aw emits safe outputs as NDJSON (safeoutputs.jsonl), one object per line;
// the missing-data tool surfaces as a `missing_data` type (config underscores),
// which the collected form hyphenates. Normalize both to the contract token.
const MISSING_DATA_TYPE = 'missing-data';

function normalizeType(value: unknown): string | null {
  return typeof value === 'string' ? value.trim().toLowerCase().replace(/_/g, '-') : null;
}

/** Candidate safe-output entries from a payload: a JSON array, a wrapping object
 *  ({items|outputs|safe_outputs}), a single object, or NDJSON lines. Every parse
 *  is defensive — this is untrusted input; unparseable lines are ignored. */
function safeOutputEntries(content: string): unknown[] {
  const trimmed = content.trim();
  if (trimmed.length === 0) return [];
  try {
    const doc: unknown = JSON.parse(trimmed);
    if (Array.isArray(doc)) return doc;
    if (doc !== null && typeof doc === 'object') {
      for (const key of ['items', 'outputs', 'safe_outputs'] as const) {
        const arr = (doc as Record<string, unknown>)[key];
        if (Array.isArray(arr)) return arr;
      }
      return [doc];
    }
    return [];
  } catch {
    // Multi-line NDJSON: parse each line independently.
    const entries: unknown[] = [];
    for (const line of trimmed.split('\n')) {
      const l = line.trim();
      if (l.length === 0) continue;
      try {
        entries.push(JSON.parse(l));
      } catch {
        /* skip non-JSON lines — untrusted input */
      }
    }
    return entries;
  }
}

/**
 * PURE (FR-014): does the artifact carry a missing-data safe-output signal?
 * Scans safe-output entries for a `missing-data`/`missing_data` type. Reads only
 * as data.
 */
export function detectMissingDataSignal(entry: string): boolean {
  return safeOutputEntries(entry).some(
    (e) => e !== null && typeof e === 'object' && normalizeType((e as { type?: unknown }).type) === MISSING_DATA_TYPE,
  );
}
