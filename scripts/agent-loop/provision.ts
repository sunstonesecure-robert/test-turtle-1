import type { Octokit } from '@octokit/rest';
import { z } from 'zod';
import { AuthorityRepository } from '../../schemas/agent-loop-authority';
import { GitSha, Instant } from '../../schemas/agent-loop';
import { AuthorityState, ProducerBinding } from '../../schemas/agent-loop-state';
import { brokerDigest } from '../control-plane/broker';
import { emptyAuditChain } from './audit';
import { documentDigest, GitDocument, gitBlob } from './git-document';
import { GitTransactionJournal, initialJournal } from './journal';
import { StateRefusal } from './ledger';
import { NativeAuthorityStore, type NativeStoreConfig } from './native-store';
import { INTAKE_WORKFLOW } from './requests';

const id = z.number().int().positive().safe(), count = z.number().int().nonnegative().safe();
const name = z.string().min(1).max(256).regex(/^[A-Za-z0-9][A-Za-z0-9:._/-]*$/);
const account = z.object({ limit_aic: count, limit_generations: count }).strict();
/** One explicit, operator-started genesis per epoch. Limits and retention are
 * inputs the operator sees; nothing here is a product default. */
export const ProvisionRequest = z.object({
  schema_version: z.literal(1), purpose: z.literal('native_state_provisioning'), epoch: name,
  governed_repository: AuthorityRepository, state_repository: AuthorityRepository, audit_repository: AuthorityRepository,
  control_repository: AuthorityRepository, writer: z.object({ principal_id: id, source_sha: GitSha }).strict(), verifier_principal_id: id,
  accounts: z.object({ rolling_day: account, lifetime: account }).strict(), retention_expires_at: Instant,
  maximum_document_bytes: z.number().int().min(2048).max(524288),
}).strict().refine(r => new Set([r.governed_repository.id, r.state_repository.id, r.audit_repository.id, r.control_repository.id]).size === 4 &&
  r.writer.principal_id !== r.verifier_principal_id, 'Four distinct repositories and a verifier other than the writer are required.');
export type ProvisionRequest = z.infer<typeof ProvisionRequest>;
export const ProvisionContext = z.object({ administrator: z.object({ id, login: z.string().regex(/^[A-Za-z0-9-]+$/) }).strict(), broker_run: ProducerBinding }).strict();
export interface AuditProvision {
  repository: z.infer<typeof AuthorityRepository>; chain_commit_sha: string; anchor_commit_sha: string;
  chain: 'created' | 'adopted';
}
export interface StateProvision {
  repository: z.infer<typeof AuthorityRepository>; control_commit_sha: string; journal_commit_sha: string;
  state_sha256: string; control: 'created' | 'adopted'; journal: 'created' | 'adopted';
}
const fact: (value: unknown, code: string) => asserts value = (value, code) => { if (!value) throw new StateRefusal(code); };
const statusOf = (error: unknown) => (error as { status?: number })?.status;
const headers = { 'cache-control': 'no-cache', 'x-github-api-version': '2026-03-10' };
const encode = (value: unknown) => JSON.stringify(value) + '\n';

/** Small bounded Contents helpers for genesis and readback. Create is always
 * "expected absence": no overwrite, delete, branch reset or blind retry. */
export function nativeRepository(gh: Octokit, repository: z.infer<typeof AuthorityRepository>) {
  const [owner, repo] = repository.full_name.split('/') as [string, string];
  const api = (route: string, params: Record<string, unknown> = {}) => gh.request(route, { owner, repo, ...params, headers, request: { timeout: 15000 } });
  async function facts() {
    fact(z.object({ id: z.literal(repository.id), full_name: z.literal(repository.full_name), private: z.literal(true), archived: z.literal(false),
      disabled: z.literal(false), default_branch: z.literal('main') }).safeParse((await api('GET /repos/{owner}/{repo}')).data).success, 'native_repository_mismatch');
    return z.object({ ref: z.literal('refs/heads/main'), object: z.object({ type: z.literal('commit'), sha: GitSha }) })
      .parse((await api('GET /repos/{owner}/{repo}/git/ref/{ref}', { ref: 'heads/main' })).data).object.sha;
  }
  async function read(path: string, ref = 'main'): Promise<{ bytes: string; blob_sha: string } | null> {
    let response;
    try { response = await api('GET /repos/{owner}/{repo}/contents/{path}', { path, ref }); }
    catch (error) { if (statusOf(error) === 404) return null; throw error; }
    const file = z.object({ type: z.literal('file'), path: z.literal(path), encoding: z.literal('base64'), sha: GitSha,
      size: z.number().int().nonnegative().max(524288), content: z.string().max(750000) }).parse(response.data);
    const encoded = file.content.replace(/\s/g, ''), buffer = Buffer.from(encoded, 'base64'), bytes = buffer.toString('utf8');
    fact(buffer.toString('base64') === encoded && buffer.length === file.size && gitBlob(bytes) === file.sha, 'native_blob_mismatch');
    return { bytes, blob_sha: file.sha };
  }
  /** Commits that changed `path`, newest first, bounded. */
  async function history(path: string, limit = 2) {
    return z.array(z.object({ sha: GitSha })).max(limit).parse((await api('GET /repos/{owner}/{repo}/commits', { sha: 'main', path, per_page: limit })).data).map(c => c.sha);
  }
  async function provenance(commit: string, principal: number) {
    fact(z.object({ sha: z.literal(commit), author: z.object({ id: z.literal(principal), type: z.literal('Bot') }),
      commit: z.object({ verification: z.object({ verified: z.literal(true), reason: z.literal('valid') }) }) })
      .safeParse((await api('GET /repos/{owner}/{repo}/commits/{ref}', { ref: commit })).data).success, 'native_writer_provenance_invalid');
  }
  async function create(path: string, bytes: string, message: string): Promise<string> {
    try {
      const written = z.object({ content: z.object({ sha: z.literal(gitBlob(bytes)) }), commit: z.object({ sha: GitSha }) })
        .parse((await api('PUT /repos/{owner}/{repo}/contents/{path}', { path, branch: 'main', message, content: Buffer.from(bytes).toString('base64') })).data);
      return written.commit.sha;
    } catch (error) {
      const status = statusOf(error);
      // 409/422: something already holds the path. Never overwrite it.
      if (status === 409 || status === 422) throw new StateRefusal('provision_path_conflict');
      if (status && status >= 400 && status < 500 && status !== 408 && status !== 429) throw new StateRefusal('provision_write_refused');
      // Unknown acceptance: exact readback may adopt it; otherwise hold, never retry.
      let current: Awaited<ReturnType<typeof read>> = null, commits: string[] = [];
      try { current = await read(path); commits = current ? await history(path, 2) : []; } catch { /* keep the outcome unknown */ }
      if (current?.bytes === bytes && commits.length === 1) return commits[0]!;
      throw new StateRefusal('provision_write_unknown');
    }
  }
  return { facts, read, history, provenance, create };
}

/** Audit side of genesis. The independent verifier's acknowledgement document
 * must already exist under its own principal; the writer never creates it. */
export async function provisionAuditChain(gh: Octokit, rawRequest: unknown): Promise<AuditProvision> {
  const request = ProvisionRequest.parse(rawRequest), audit = nativeRepository(gh, request.audit_repository);
  try {
    await audit.facts();
    const anchor = await audit.read('audit/acknowledged.json');
    fact(anchor, 'audit_anchor_missing');
    const acknowledged = z.object({ sequence: count, sha256: z.string().regex(/^[a-f0-9]{64}$/).nullable() }).strict().safeParse(JSON.parse(anchor.bytes));
    fact(acknowledged.success, 'audit_anchor_invalid');
    const anchorCommit = (await audit.history('audit/acknowledged.json', 1))[0];
    fact(anchorCommit, 'audit_anchor_missing');
    await audit.provenance(anchorCommit, request.verifier_principal_id);
    const existing = await audit.read('audit/chain.json');
    if (existing) {
      const chain = z.object({ schema_version: z.literal(1), purpose: z.literal('audit_chain'), repository_id: z.literal(request.audit_repository.id),
        records: z.array(z.unknown()).max(1000) }).safeParse(JSON.parse(existing.bytes));
      fact(chain.success, 'audit_chain_invalid');
      const commits = await audit.history('audit/chain.json', 100);
      fact(commits.length >= 1 && commits.length < 100, 'audit_chain_history_unbounded');
      for (const commit of [commits[0]!, commits.at(-1)!]) await audit.provenance(commit, request.writer.principal_id);
      return { repository: request.audit_repository, chain_commit_sha: commits.at(-1)!, anchor_commit_sha: anchorCommit, chain: 'adopted' };
    }
    // An acknowledged history with no chain is a lost archive, not a fresh start.
    fact(acknowledged.data.sequence === 0, 'audit_chain_lost');
    const commit = await audit.create('audit/chain.json', encode(emptyAuditChain(request.audit_repository.id)), 'Provision audit/chain.json');
    await audit.provenance(commit, request.writer.principal_id);
    return { repository: request.audit_repository, chain_commit_sha: commit, anchor_commit_sha: anchorCommit, chain: 'created' };
  } catch (error) { throw error instanceof StateRefusal ? error : new StateRefusal('audit_provisioning_failed'); }
}

export function genesisState(rawRequest: unknown, rawContext: unknown, now: string) {
  const request = ProvisionRequest.parse(rawRequest), context = ProvisionContext.parse(rawContext), time = Instant.parse(now);
  fact(context.broker_run.repository_id === request.control_repository.id && context.broker_run.repository === request.control_repository.full_name &&
    context.broker_run.source_sha === request.writer.source_sha && Date.parse(request.retention_expires_at) > Date.parse(time), 'provision_context_invalid');
  const payload = { episodes: {}, ledger: { bootstrapped_by: context.administrator.id, bootstrapped_at: time, retention_expires_at: request.retention_expires_at,
    accounts: { day: { kind: 'rolling_day', ...request.accounts.rolling_day }, lifetime: { kind: 'lifetime', ...request.accounts.lifetime } }, reservations: {}, charges: {} },
    admissions: {}, claims: {}, locks: {}, exposure: {}, requests: {}, outbox: {},
    // Requests dispatched before this instant are not replayed into a new epoch.
    request_cursor: { workflow_path: INTAKE_WORKFLOW, not_before: time, created_at: time, run_id: 0 } };
  const intent = { operation_id: 'bootstrap', kind: 'record' as const, producer: context.broker_run, subject_sha256: brokerDigest(request),
    authority_ref: `https://github.com/${request.control_repository.full_name}/actions/runs/${context.broker_run.run_id}` };
  return AuthorityState.parse({ schema_version: 1, purpose: 'authority_state', state_repository_id: request.state_repository.id,
    repository_id: request.governed_repository.id, epoch: request.epoch, revision: 1, parent_blob_sha: null, parent_state_sha256: null,
    operation: { ...intent, created_at: time }, writer: { ...request.writer, authority_digest: brokerDigest({ purpose: 'authenticated_setup',
      administrator: context.administrator, request_sha256: brokerDigest(request), broker_run: context.broker_run }) },
    payload_sha256: documentDigest(payload), payload, applied_operations: { bootstrap: { intent_sha256: brokerDigest(intent), revision: 1 } } });
}

/** State side of genesis: `state/control.json` revision 1, then its journal.
 * A path that already exists is adopted only when it is exactly an unused
 * genesis of this epoch; an established or damaged state is never re-created.
 * `established` is the caller's reading of the signed audit chain: any archived
 * transaction receipt means state once existed, so its absence is a loss. */
export async function provisionState(gh: Octokit, rawRequest: unknown, rawContext: unknown, ports: { now(): string; established: boolean }): Promise<StateProvision> {
  const request = ProvisionRequest.parse(rawRequest), state = nativeRepository(gh, request.state_repository);
  try {
    await state.facts();
    let control = await state.read('state/control.json'), journal = await state.read('state/journal.json');
    let controlCommit: string, controlUse: 'created' | 'adopted' = 'adopted', journalUse: 'created' | 'adopted' = 'adopted';
    if (!control) {
      fact(!journal && !ports.established, 'state_lost_after_establishment');
      const bytes = encode(genesisState(request, rawContext, ports.now()));
      fact(Buffer.byteLength(bytes) <= request.maximum_document_bytes, 'provision_capacity_exhausted');
      controlCommit = await state.create('state/control.json', bytes, 'Provision state/control.json');
      control = { bytes, blob_sha: gitBlob(bytes) }; controlUse = 'created';
    } else {
      const commits = await state.history('state/control.json', 2);
      // More than one commit on the path means transactions already ran.
      fact(commits.length === 1, 'state_already_established'); controlCommit = commits[0]!;
    }
    await state.provenance(controlCommit, request.writer.principal_id);
    const genesis = AuthorityState.parse(JSON.parse(control.bytes));
    // Rebuild at the recorded creation time: retries may run later, but every
    // immutable field must still match this request and authenticated context.
    const expectedGenesis = genesisState(request, rawContext, genesis.operation.created_at);
    fact(documentDigest(genesis) === documentDigest(expectedGenesis), 'state_genesis_mismatch');
    const expectedJournal = encode(initialJournal({ epoch: genesis.epoch, revision: 1, commit_sha: controlCommit, state_sha256: documentDigest(genesis) }));
    let journalCommit: string;
    if (!journal) {
      journalCommit = await state.create('state/journal.json', expectedJournal, 'Provision state/journal.json'); journalUse = 'created';
    } else {
      fact(journal.bytes === expectedJournal, 'state_already_established');
      journalCommit = (await state.history('state/journal.json', 1))[0]!;
    }
    await state.provenance(journalCommit, request.writer.principal_id);
    const provision: StateProvision = { repository: request.state_repository, control_commit_sha: controlCommit,
      journal_commit_sha: journalCommit, state_sha256: documentDigest(genesis), control: controlUse, journal: journalUse };
    // The provisioned documents must satisfy the real store's own load checks.
    await provisionedStore(gh, request, provision, { now: ports.now, limits: { maximum_state_bytes: request.maximum_document_bytes,
      receipt_reserve_bytes: 1024, maximum_conflict_reloads: 0, maximum_history_commits: 1, maximum_api_requests: 32 } }).read();
    return provision;
  } catch (error) { throw error instanceof StateRefusal ? error : new StateRefusal('state_provisioning_failed'); }
}

type Limits = Pick<NativeStoreConfig, 'maximum_state_bytes' | 'receipt_reserve_bytes' | 'maximum_conflict_reloads' | 'maximum_history_commits' | 'maximum_api_requests'>;
export const journalDocument = (gh: Octokit, request: ProvisionRequest, state: Pick<StateProvision, 'journal_commit_sha'>, maximumBytes: number) =>
  new GitDocument(gh, { repository: request.state_repository, branch: 'main', path: 'state/journal.json', writer_id: request.writer.principal_id,
    anchor_commit_sha: state.journal_commit_sha, maximum_bytes: maximumBytes });
export const storeConfig = (request: ProvisionRequest, state: Pick<StateProvision, 'control_commit_sha'>, limits: Limits): NativeStoreConfig => ({
  state_repository: request.state_repository, governed_repository: request.governed_repository, branch: 'main', path: 'state/control.json',
  epoch: request.epoch, anchor_commit_sha: state.control_commit_sha, writer: request.writer, ...limits });
/** Read-only composition over provisioned documents. Its authority port refuses
 * every write: provisioning grants no transaction. */
export function provisionedStore(gh: Octokit, request: ProvisionRequest, state: StateProvision, ports: { now(): string; limits: Limits }) {
  return new NativeAuthorityStore(storeConfig(request, state, ports.limits), { gh, now: ports.now,
    journal: new GitTransactionJournal(journalDocument(gh, request, state, request.maximum_document_bytes)),
    authorize: async () => { throw new StateRefusal('provisioning_grants_no_authority'); } });
}
