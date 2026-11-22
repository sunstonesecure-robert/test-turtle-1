import { createHash } from 'node:crypto';
import type { Octokit } from '@octokit/rest';
import { z } from 'zod';
import { AuthorityRepository } from '../../schemas/agent-loop-authority';
import { StateRefusal } from './ledger';

const sha = z.string().regex(/^[a-f0-9]{40}$/);
const Config = z.object({ repository: AuthorityRepository, branch: z.literal('main'),
  path: z.enum(['state/journal.json', 'audit/chain.json', 'audit/acknowledged.json']),
  writer_id: z.number().int().positive().safe(), anchor_commit_sha: sha,
  maximum_bytes: z.number().int().min(2048).max(524288) }).strict();
const fact: (value: unknown, code: string) => asserts value = (value, code) => { if (!value) throw new StateRefusal(code); };
export const gitBlob = (bytes: string) => createHash('sha1').update(`blob ${Buffer.byteLength(bytes)}\0`).update(bytes).digest('hex');
const canonical = (v: unknown): unknown => Array.isArray(v) ? v.map(canonical) : v !== null && typeof v === 'object' ?
  Object.fromEntries(Object.entries(v).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, item]) => [key, canonical(item)])) : v;
/** Key-order-independent equality with no 64 KiB brokerDigest bound: chain and
 * journal documents legitimately grow to their configured maximum_bytes. */
export const sameJson = (a: unknown, b: unknown) => JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));
/** The same canonical SHA-256 as `brokerDigest`, without its 64 KiB request bound:
 * canonical state, payloads and prepared bytes legitimately grow to the document limit. */
export const documentDigest = (value: unknown) => createHash('sha256').update(JSON.stringify(canonical(JSON.parse(JSON.stringify(value))))).digest('hex');
export interface GitSnapshot { value: unknown; bytes: string; blob_sha: string; commit_sha: string }

/** Bounded Contents transport for established protected documents. No create,
 * deletion, force update, implicit empty state or retry of unknown PUTs. */
export class GitDocument {
  readonly config: z.infer<typeof Config>;
  constructor(private gh: Octokit, raw: unknown) { this.config = Config.parse(raw); }
  private async api(route: string, params: Record<string, unknown> = {}) {
    const [owner, repo] = this.config.repository.full_name.split('/') as [string, string];
    return this.gh.request(route, { owner, repo, ...params,
      headers: { 'cache-control': 'no-cache', 'x-github-api-version': '2026-03-10' }, request: { timeout: 15000 } });
  }
  private async writer(commit: string) {
    const response = await this.api('GET /repos/{owner}/{repo}/commits/{ref}', { ref: commit });
    fact(z.object({ sha: z.literal(commit), author: z.object({ id: z.literal(this.config.writer_id), type: z.literal('Bot') }),
      commit: z.object({ verification: z.object({ verified: z.literal(true), reason: z.literal('valid') }) }) }).safeParse(response.data).success, 'git_writer_provenance_invalid');
  }
  async read(): Promise<GitSnapshot> {
    try {
      const c = this.config;
      fact(z.object({ id: z.literal(c.repository.id), full_name: z.literal(c.repository.full_name), private: z.literal(true), archived: z.literal(false),
        disabled: z.literal(false), default_branch: z.literal(c.branch) }).safeParse((await this.api('GET /repos/{owner}/{repo}')).data).success, 'git_repository_mismatch');
      const head = z.object({ ref: z.literal('refs/heads/main'), object: z.object({ type: z.literal('commit'), sha }) })
        .parse((await this.api('GET /repos/{owner}/{repo}/git/ref/{ref}', { ref: 'heads/main' })).data).object.sha;
      const comparison = await this.api('GET /repos/{owner}/{repo}/compare/{basehead}', { basehead: `${c.anchor_commit_sha}...${head}` });
      fact(z.object({ status: z.enum(['identical', 'ahead']), behind_by: z.literal(0), merge_base_commit: z.object({ sha: z.literal(c.anchor_commit_sha) }) })
        .safeParse(comparison.data).success, 'git_document_rollback');
      // Provenance belongs to the commit that last changed THIS document. A shared
      // audit repository also carries the independent verifier's acknowledgement
      // commits, so the branch head is legitimately another principal's.
      const latest = z.array(z.object({ sha })).length(1).parse((await this.api('GET /repos/{owner}/{repo}/commits', { sha: head, path: c.path, per_page: 1 })).data)[0]!.sha;
      await this.writer(latest);
      const contents = (ref: string) => this.api('GET /repos/{owner}/{repo}/contents/{path}', { path: c.path, ref });
      const file = z.object({ type: z.literal('file'), path: z.literal(c.path), encoding: z.literal('base64'), sha,
        size: z.number().int().positive().max(c.maximum_bytes), content: z.string().max(750000) })
        .parse((await contents(head)).data);
      if (latest !== head) fact(z.object({ sha: z.literal(file.sha) }).safeParse((await contents(latest)).data).success, 'git_document_head_binding_invalid');
      const encoded = file.content.replace(/\s/g, ''), buffer = Buffer.from(encoded, 'base64'), bytes = buffer.toString('utf8');
      fact(buffer.toString('base64') === encoded && Buffer.byteLength(bytes) === file.size && gitBlob(bytes) === file.sha, 'git_document_bytes_invalid');
      return { value: JSON.parse(bytes), bytes, blob_sha: file.sha, commit_sha: head };
    } catch (error) { throw error instanceof StateRefusal ? error : new StateRefusal('git_document_unavailable'); }
  }
  async update(compute: (prior: unknown) => unknown): Promise<GitSnapshot> {
    for (let attempt = 0; attempt < 3; attempt++) {
      const old = await this.read(), value = compute(structuredClone(old.value)), bytes = JSON.stringify(value) + '\n';
      fact(Buffer.byteLength(bytes) <= this.config.maximum_bytes, 'git_document_capacity_exhausted');
      if (sameJson(value, old.value)) return old;
      try {
        await this.api('PUT /repos/{owner}/{repo}/contents/{path}', { path: this.config.path, branch: this.config.branch,
          sha: old.blob_sha, content: Buffer.from(bytes).toString('base64'), message: `Update ${this.config.path}` });
      } catch (error) {
        if ((error as { status?: number })?.status === 409) continue;
        // Unknown acceptance never triggers another PUT. Exact readback may
        // acknowledge this update; otherwise callers keep their pending state.
        try {
          const current = await this.read();
          if (current.bytes === bytes) return current;
        } catch { /* preserve uncertain effect */ }
        throw new StateRefusal('git_document_write_unknown');
      }
      const current = await this.read();
      fact(current.bytes === bytes, 'git_document_readback_changed'); return current;
    }
    throw new StateRefusal('git_document_conflict_exhausted');
  }
}
