import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Octokit } from '@octokit/rest';
import type { RepoRef } from '../../dashboard/lib/github/client';
import { Fact, type EvidenceRef } from '../../schemas/agent-loop';

export { NativeAuthorityStore } from './native-store';
export type { PreparedTransaction, TransactionJournal, TransactionReceipt, StateTransactionResult, AuthorityStorePorts, NativeStoreConfig } from './native-store';

export const MAX_EVIDENCE_BYTES = 256 * 1024;
export const hashBytes = (bytes: string | Uint8Array) => createHash('sha256').update(bytes).digest('hex');
export const known = (value: unknown, now: string, source: string): Fact => {
  if (value === undefined) return unknown('fact_value_missing');
  return Fact.parse({ state: 'known', value, observed_at: now, source });
};
export const unknown = (reason: string, evidence: EvidenceRef[] = []): Fact => ({ state: 'unknown', reason, evidence });

/** Only status and bounded Retry-After leave an exception. Octokit errors can
 * contain authorization headers, response bodies and untrusted server messages. */
export function readFailure(error: unknown, ref: string): Fact {
  const e = error as { status?: unknown; response?: { headers?: Record<string, unknown> } };
  const status = typeof e?.status === 'number' && Number.isInteger(e.status) && e.status >= 100 && e.status <= 599 ? e.status : undefined;
  const retry = Number(e?.response?.headers?.['retry-after']);
  const retry_after_seconds = Number.isSafeInteger(retry) && retry >= 0 && retry <= 86400 ? retry : undefined;
  return unknown(status === 429 || (status === 403 && retry_after_seconds !== undefined) ? 'github_rate_limited' : 'github_read_failed', [{
    kind: 'github_response', ref, ...(status ? { status } : {}), ...(retry_after_seconds !== undefined ? { retry_after_seconds } : {}),
  }]);
}

export interface EvidenceRead {
  run_id: number; run_attempt: number; artifact_id: number; name: string; entry: string; sha256?: string;
}

/** Read immutable payload evidence. This is not the canonical state writer.
 * In particular, no missing artifact bootstraps an episode or ledger.
 * unzip streams one exact named entry to stdout; no archive path is extracted. */
export async function readEvidence(gh: Octokit, repo: RepoRef, ref: EvidenceRead, now: string): Promise<Fact> {
  const source = `https://github.com/${repo.owner}/${repo.repo}/actions/runs/${ref.run_id}/attempts/${ref.run_attempt}`;
  let directory: string | undefined;
  let stage: 'github' | 'archive' = 'github';
  try {
    if (![ref.run_id, ref.run_attempt, ref.artifact_id].every(id => Number.isSafeInteger(id) && id > 0) ||
      !['loop-candidate.json', 'loop-feedback.json', 'deliverable.patch'].includes(ref.entry)) return unknown('evidence_ref_invalid');
    const { data: run } = await gh.actions.getWorkflowRun({ ...repo, run_id: ref.run_id });
    if (run.run_attempt !== ref.run_attempt || run.status !== 'completed') return unknown('evidence_producer_mismatch', [{ kind: 'run', ref: source }]);
    const artifacts = await gh.paginate(gh.actions.listWorkflowRunArtifacts, { ...repo, run_id: ref.run_id, per_page: 100 });
    const matches = artifacts.filter(a => a.id === ref.artifact_id && a.name === ref.name);
    if (matches.length !== 1 || matches[0]!.expired || matches[0]!.size_in_bytes > MAX_EVIDENCE_BYTES) return unknown('evidence_unavailable', [{ kind: 'run', ref: source }]);
    const response = await gh.request('GET /repos/{owner}/{repo}/actions/artifacts/{artifact_id}/{archive_format}', { ...repo, artifact_id: ref.artifact_id, archive_format: 'zip' });
    const bytes = new Uint8Array(response.data as unknown as ArrayBuffer);
    if (!bytes.length || bytes.length > MAX_EVIDENCE_BYTES || bytes[0] !== 0x50 || bytes[1] !== 0x4b) return unknown('evidence_archive_invalid', [{ kind: 'run', ref: source }]);
    stage = 'archive';
    directory = mkdtempSync(join(tmpdir(), 'agent-loop-evidence-'));
    const archive = join(directory, 'evidence.zip');
    writeFileSync(archive, bytes, { mode: 0o600 });
    const limits = { timeout: 5000, maxBuffer: MAX_EVIDENCE_BYTES, stdio: ['ignore', 'pipe', 'pipe'] as ['ignore', 'pipe', 'pipe'] };
    const entries = execFileSync('unzip', ['-Z1', archive], limits).toString('utf8').trim().split(/\r?\n/);
    if (entries.length !== 1 || entries[0] !== ref.entry) return unknown('evidence_entries_invalid', [{ kind: 'run', ref: source }]);
    const entry = execFileSync('unzip', ['-p', archive, ref.entry], limits);
    if (!entry.length || (ref.sha256 && hashBytes(entry) !== ref.sha256)) return unknown('evidence_digest_mismatch', [{ kind: 'run', ref: source }]);
    const content = new TextDecoder('utf-8', { fatal: true }).decode(entry);
    // Parsing happens in the observer only after producer and byte binding.
    return known({ content, sha256: hashBytes(entry) }, now, source);
  } catch (error) {
    if (stage === 'archive') return unknown((error as { code?: string })?.code === 'ENOENT' ? 'archive_reader_unavailable' : 'evidence_archive_invalid', [{ kind: 'run', ref: source }]);
    return readFailure(error, source);
  } finally {
    if (directory) rmSync(directory, { recursive: true, force: true });
  }
}
