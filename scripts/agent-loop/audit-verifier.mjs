// Independent audit verifier. Deliberately dependency-free and separate from
// scripts/agent-loop/audit.ts: it runs in the audit repository under that
// repository's own workflow token, holds no writer or signing key, and trusts
// only the public key, writer identity and repository pinned in its workflow file.
import { createHash, createPublicKey, verify } from 'node:crypto';
import { appendFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const canonical = v => Array.isArray(v) ? v.map(canonical) : v !== null && typeof v === 'object'
  ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([k, item]) => [k, canonical(item)])) : v;
export const digest = value => createHash('sha256').update(JSON.stringify(canonical(JSON.parse(JSON.stringify(value))))).digest('hex');
const HEX = /^[a-f0-9]{64}$/;

/** Pure check of archive bytes against pinned keys and the acknowledged history.
 * Returns { ok, code, sequence, sha256 }; never throws on hostile input. */
export function verifyChain(text, pinned) {
  const refuse = code => ({ ok: false, code, sequence: 0, sha256: null });
  let chain;
  try { chain = JSON.parse(text); } catch { return refuse('audit_chain_unreadable'); }
  if (!chain || chain.schema_version !== 1 || chain.purpose !== 'audit_chain' || chain.repository_id !== pinned.repository_id ||
      !Array.isArray(chain.records) || chain.records.length > 1000) return refuse('audit_chain_invalid');
  let previous = null; const seen = new Set();
  for (const [index, entry] of chain.records.entries()) {
    if (!entry || typeof entry !== 'object' || !entry.record || typeof entry.record !== 'object') return refuse('audit_chain_invalid');
    const { sha256, signature, ...signed } = entry;
    const key = Object.hasOwn(pinned.public_keys, entry.key_id) ? pinned.public_keys[entry.key_id] : null;
    let valid = false;
    try {
      valid = typeof sha256 === 'string' && HEX.test(sha256) && typeof signature === 'string' && typeof key === 'string' &&
        entry.repository_id === pinned.repository_id && entry.sequence === index + 1 && entry.previous_sha256 === previous &&
        typeof entry.record.event_id === 'string' && !seen.has(entry.record.event_id) && entry.record_sha256 === digest(entry.record) && sha256 === digest(signed) &&
        verify(null, Buffer.from(sha256, 'hex'), createPublicKey({ key: Buffer.from(key, 'base64'), format: 'der', type: 'spki' }), Buffer.from(signature, 'base64'));
    } catch { valid = false; }
    if (!valid) return refuse('audit_signature_or_hash_invalid');
    seen.add(entry.record.event_id); previous = sha256;
  }
  const { sequence, sha256 } = pinned.acknowledged;
  // Valid signatures are not enough: acknowledged history may only be extended.
  if (chain.records.length < sequence) return refuse('audit_rollback');
  if (sequence > 0 && chain.records[sequence - 1].sha256 !== sha256) return refuse('audit_history_conflict');
  return { ok: true, code: 'audit_chain_verified', sequence: chain.records.length, sha256: previous };
}
export function nextAcknowledgement(current, verified) {
  if (!verified.ok || verified.sequence < current.sequence) return null;
  if (verified.sequence === current.sequence) return verified.sha256 === current.sha256 ? current : null;
  return { sequence: verified.sequence, sha256: verified.sha256 };
}

const blobSha = text => createHash('sha1').update(`blob ${Buffer.byteLength(text)}\0`).update(text).digest('hex');
/** Native run. `env` carries only pinned literals from the workflow file and the
 * repository's own token. Writes exactly one path, `audit/acknowledged.json`,
 * with its expected blob SHA, and only for the default branch. */
export async function run(env, fetcher = fetch) {
  const report = { schema_version: 1, purpose: 'audit_verification', repository: env.GITHUB_REPOSITORY ?? null, ref: null, mode: env.VERIFY_MODE ?? null,
    result: 'error', code: 'verifier_input_invalid', sequence: 0, sha256: null, acknowledged: null, advanced: false, chain_commit: null, run_id: Number(env.GITHUB_RUN_ID) || null };
  const api = async (method, path, body) => {
    const response = await fetcher(`https://api.github.com${path}`, { method, headers: { authorization: `Bearer ${env.GITHUB_TOKEN}`, accept: 'application/vnd.github+json',
      'x-github-api-version': '2022-11-28', 'cache-control': 'no-cache', ...(body ? { 'content-type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
    return { status: response.status, data: response.status === 204 ? null : await response.json().catch(() => null) };
  };
  const file = async (path, ref) => {
    const r = await api('GET', `/repos/${env.GITHUB_REPOSITORY}/contents/${path}?ref=${encodeURIComponent(ref)}`);
    if (r.status === 404) return null;
    if (r.status !== 200 || r.data?.type !== 'file' || r.data.encoding !== 'base64' || typeof r.data.content !== 'string' || r.data.size > 524288) throw new Error('native_file_invalid');
    const text = Buffer.from(r.data.content.replace(/\s/g, ''), 'base64').toString('utf8');
    if (blobSha(text) !== r.data.sha) throw new Error('native_blob_mismatch');
    return { text, sha: r.data.sha };
  };
  /** Newest commit that changed `path` on `ref`, with whether `principal` natively signed it. */
  const lastCommit = async (path, ref, principal) => {
    const r = await api('GET', `/repos/${env.GITHUB_REPOSITORY}/commits?sha=${encodeURIComponent(ref)}&path=${path}&per_page=1`);
    if (r.status !== 200 || !Array.isArray(r.data)) throw new Error('native_history_unreadable');
    const commit = r.data[0] ?? null;
    return { commit, signed: !!commit && commit.author?.id === principal && commit.author.type === 'Bot' &&
      commit.commit?.verification?.verified === true && commit.commit.verification.reason === 'valid' };
  };
  try {
    const repositoryId = Number(env.PINNED_REPOSITORY_ID), writerId = Number(env.PINNED_WRITER_ID), verifierId = Number(env.PINNED_VERIFIER_ID), ref = env.VERIFY_REF ?? '';
    const keys = JSON.parse(env.PINNED_PUBLIC_KEYS ?? 'null');
    if (!env.GITHUB_TOKEN || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(env.GITHUB_REPOSITORY ?? '') || !Number.isSafeInteger(repositoryId) || !Number.isSafeInteger(writerId) || !Number.isSafeInteger(verifierId) || verifierId === writerId ||
        !keys || typeof keys !== 'object' || !Object.keys(keys).length || !['provision', 'verify'].includes(env.VERIFY_MODE) ||
        !/^[A-Za-z0-9][A-Za-z0-9._/-]{0,200}$/.test(ref) || ref.includes('..')) return report;
    report.ref = ref;
    const native = await api('GET', `/repos/${env.GITHUB_REPOSITORY}`);
    if (native.status !== 200 || native.data?.id !== repositoryId || native.data.default_branch !== 'main' || native.data.private !== true) return { ...report, code: 'audit_repository_mismatch' };
    const anchorPath = 'audit/acknowledged.json', stored = await file(anchorPath, 'main');
    if (env.VERIFY_MODE === 'provision') {
      // The anchor is created once, empty, before the writer provisions its chain. A path that
      // ever existed has history even after deletion, so deleting both files cannot reset it.
      if (stored || await file('audit/chain.json', 'main') || (await lastCommit(anchorPath, 'main', verifierId)).commit ||
          (await lastCommit('audit/chain.json', 'main', writerId)).commit) return { ...report, result: 'refused', code: 'audit_already_provisioned' };
      const text = JSON.stringify({ sequence: 0, sha256: null }) + '\n';
      const put = await api('PUT', `/repos/${env.GITHUB_REPOSITORY}/contents/${anchorPath}`, { message: 'Provision audit/acknowledged.json', branch: 'main', content: Buffer.from(text).toString('base64') });
      if (put.status !== 201) return { ...report, code: 'anchor_write_failed' };
      return { ...report, result: 'verified', code: 'audit_anchor_provisioned', acknowledged: { sequence: 0, sha256: null }, advanced: true };
    }
    if (!stored) return { ...report, result: 'refused', code: 'audit_anchor_missing' };
    // Only this verifier's own signed commit is acknowledged history. The writer can
    // change the file, but then nothing is verified against it or advanced from it.
    if (!(await lastCommit(anchorPath, 'main', verifierId)).signed) return { ...report, result: 'refused', code: 'audit_anchor_provenance_invalid' };
    const acknowledged = JSON.parse(stored.text);
    if (!Number.isSafeInteger(acknowledged?.sequence) || acknowledged.sequence < 0 || (acknowledged.sequence === 0) !== (acknowledged.sha256 === null) ||
        (acknowledged.sha256 !== null && !HEX.test(acknowledged.sha256))) return { ...report, result: 'refused', code: 'audit_anchor_invalid' };
    report.acknowledged = acknowledged;
    const chain = await file('audit/chain.json', ref);
    if (!chain) return { ...report, result: 'refused', code: 'audit_chain_missing' };
    const verified = verifyChain(chain.text, { repository_id: repositoryId, public_keys: keys, acknowledged });
    report.sequence = verified.sequence; report.sha256 = verified.sha256;
    if (!verified.ok) return { ...report, result: 'refused', code: verified.code };
    // The archive bytes must also be what the expected writer natively committed.
    const { commit, signed } = await lastCommit('audit/chain.json', ref, writerId);
    report.chain_commit = commit ? { sha: commit.sha, author_id: commit.author?.id ?? null, verified: commit.commit?.verification?.verified === true } : null;
    if (!signed) return { ...report, result: 'refused', code: 'audit_writer_provenance_invalid' };
    if (ref !== 'main') return { ...report, result: 'verified', code: 'audit_chain_verified_not_default_branch' };
    const next = nextAcknowledgement(acknowledged, verified);
    if (!next) return { ...report, result: 'refused', code: 'audit_history_conflict' };
    if (next.sequence === acknowledged.sequence) return { ...report, result: 'verified', code: 'audit_chain_verified' };
    const text = JSON.stringify(next) + '\n';
    const put = await api('PUT', `/repos/${env.GITHUB_REPOSITORY}/contents/${anchorPath}`, { message: `Acknowledge audit sequence ${next.sequence}`, branch: 'main',
      sha: stored.sha, content: Buffer.from(text).toString('base64') });
    // A lost race or response leaves the old acknowledgement in place; the next run re-verifies.
    if (put.status !== 200) return { ...report, code: 'anchor_write_failed' };
    return { ...report, result: 'verified', code: 'audit_chain_acknowledged', acknowledged: next, advanced: true };
  } catch { return { ...report, code: 'verifier_execution_failed' }; }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const report = await run(process.env);
  process.stdout.write(`AUDIT_VERIFICATION ${JSON.stringify(report)}\n`);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `Audit verification of \`${report.ref}\`: **${report.result}** (${report.code}), sequence ${report.sequence}.\n`);
  // Exit 0 only when the outcome is the one the caller said it expected.
  process.exitCode = report.result === (process.env.VERIFY_EXPECT ?? 'verified') ? 0 : 1;
}
