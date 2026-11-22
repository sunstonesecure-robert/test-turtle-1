import { createHash } from 'node:crypto';
import type { Octokit } from '@octokit/rest';
import { z } from 'zod';
import { Digest, GitSha, Instant } from '../../schemas/agent-loop';
import { Admission, AuthorityPayload, AuthorityState, ProducerBinding, TransactionIntent } from '../../schemas/agent-loop-state';
import { documentDigest } from './git-document';
import { envelopeAic, isTerminal, requireSettlementSubject, settlementReserveBytes, StateRefusal, terminalSettlements, validateLedger, validateStateTransition } from './ledger';

const repository = z.object({ id: z.number().int().positive().safe(), full_name: z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/) }).strict();
const writer = z.object({ principal_id: z.number().int().positive().safe(), source_sha: GitSha }).strict();
const StoreConfig = z.object({ state_repository: repository, governed_repository: repository,
  branch: z.literal('main'), path: z.literal('state/control.json'), epoch: z.string().min(1).max(256), anchor_commit_sha: GitSha, writer,
  maximum_state_bytes: z.number().int().min(2048).max(524288), receipt_reserve_bytes: z.number().int().positive(),
  maximum_conflict_reloads: z.number().int().min(0).max(3), maximum_history_commits: z.number().int().min(1).max(100),
  maximum_api_requests: z.number().int().min(16).max(256),
}).strict().refine(c => c.receipt_reserve_bytes < c.maximum_state_bytes && c.state_repository.id !== c.governed_repository.id);
export type NativeStoreConfig = z.infer<typeof StoreConfig>;
const Lease = writer.extend({ authority_digest: Digest, expires_at: Instant }).strict();
export type WriterLease = z.infer<typeof Lease>;
export interface PreparedTransaction {
  intent: TransactionIntent; intent_sha256: string; expected_blob_sha: string; parent_commit_sha: string;
  bytes: string; blob_sha: string; epoch: string; revision: number;
}
export interface TransactionReceipt {
  operation_id: string; epoch: string; revision: number; state_repository_id: number; path: string;
  expected_blob_sha: string; new_blob_sha: string; commit_sha: string; state_sha256: string; payload_sha256: string;
}
export interface TransactionJournal {
  /** Must survive process loss. Returning an empty list on a read error is forbidden. */
  pending(): Promise<PreparedTransaction[]>;
  /** Persisted high-water mark; seal must advance it monotonically with the
   * verified receipt. An outage may never become an empty/bootstrap anchor. */
  acknowledged(): Promise<{ epoch: string; revision: number; commit_sha: string; state_sha256: string }>;
  prepare(transaction: PreparedTransaction): Promise<void>;
  seal(operationId: string, outcome: 'won' | 'lost' | 'refused', receipt?: TransactionReceipt): Promise<void>;
}
export interface AuthorityStorePorts {
  gh: Octokit; now(): string;
  /** Mandatory trusted native-authority/audit adapter. No default permissive path. */
  authorize(intent: TransactionIntent): Promise<WriterLease>;
  journal: TransactionJournal;
}
export interface StateTransactionResult {
  status: 'won' | 'reconciled' | 'replayed' | 'lost' | 'unknown' | 'refused'; code: string;
  operation_id: string; api_requests: number; git_write_attempts: number; receipt?: TransactionReceipt;
  native_outcome: 'not_attempted' | 'committed' | 'conflict' | 'refused' | 'unknown';
}
interface Snapshot { state: AuthorityState; bytes: string; blob_sha: string; head: string }
const gitBlob = (bytes: string) => createHash('sha1').update(`blob ${Buffer.byteLength(bytes)}\0`).update(bytes).digest('hex');
const statusOf = (error: unknown) => (error as { status?: number })?.status;
function requireFact(fact: unknown, code: string): asserts fact { if (!fact) throw new StateRefusal(code); }
export const admissionDigest = (admission: Admission) => {
  const { admission_sha256: _hash, status: _status, ...body } = admission;
  return documentDigest(body);
};

/** Isolated-writer library only. No bootstrap, restore, force push, dispatch,
 * model, key-loading or installed entrypoint. Native authority and durable
 * journaling are required ports; their deployment proofs remain separate. */
export class NativeAuthorityStore {
  readonly config: NativeStoreConfig;
  constructor(config: unknown, private readonly ports: AuthorityStorePorts) {
    this.config = StoreConfig.parse(config);
    requireFact(ports?.gh && typeof ports.authorize === 'function' && typeof ports.now === 'function' &&
      ['pending', 'acknowledged', 'prepare', 'seal'].every(k => typeof (ports.journal as unknown as Record<string, unknown>)?.[k] === 'function'), 'state_ports_missing');
  }
  private clock() { return Instant.parse(this.ports.now()); }
  async transact(rawIntent: unknown, compute: (draft: AuthorityPayload, now: string, revision: number) => void): Promise<StateTransactionResult> {
    let operationId = '<invalid>'; let requests = 0, writes = 0;
    let nativeOutcome: StateTransactionResult['native_outcome'] = 'not_attempted';
    let knownReceipt: TransactionReceipt | undefined;
    const result = (status: StateTransactionResult['status'], code: string, receipt?: TransactionReceipt): StateTransactionResult =>
      ({ status, code, operation_id: operationId, api_requests: requests, git_write_attempts: writes,
        native_outcome: nativeOutcome, ...(receipt ? { receipt } : {}) });
    const api = async (route: string, params: Record<string, unknown>) => {
      requireFact(requests < this.config.maximum_api_requests, 'state_api_budget_exhausted'); requests++;
      return this.ports.gh.request(route, { ...params, headers: { 'x-github-api-version': '2026-03-10' }, request: { timeout: 15000 } });
    };
    let attempted: PreparedTransaction | undefined;
    try {
      const intent = TransactionIntent.parse(rawIntent); operationId = intent.operation_id;
      const intentHash = documentDigest(intent);
      let pending: PreparedTransaction[];
      try { pending = await this.ports.journal.pending(); }
      catch { return result('unknown', 'state_journal_unavailable'); }
      if (!Array.isArray(pending) || pending.length > 100) return result('unknown', 'state_journal_invalid');
      const existing = pending.find(p => p.intent?.operation_id === operationId);
      if (existing) {
        requireFact(existing.intent_sha256 === intentHash, 'operation_identity_changed');
        attempted = existing;
        const receipt = await this.reconcile(existing, api);
        if (!receipt) return result('unknown', 'operation_outcome_unknown');
        knownReceipt = receipt; nativeOutcome = 'committed';
        await this.ports.journal.seal(operationId, 'won', receipt);
        attempted = undefined;
        return result('reconciled', 'native_history_reconciled', receipt);
      }
      if (pending.length) return result('unknown', 'prior_transaction_unresolved');
      for (let reload = 0; reload <= this.config.maximum_conflict_reloads; reload++) {
        const snapshot = await this.load(api), old = snapshot.state;
        const prior = old.applied_operations[operationId];
        if (prior) {
          requireFact(prior.intent_sha256 === intentHash, 'operation_identity_changed');
          return result('replayed', 'operation_already_committed');
        }
        await this.producer(intent.producer, api);
        const now = this.clock(), payload = structuredClone(old.payload);
        compute(payload, now, old.revision + 1);
        if (intent.kind === 'receipt') {
          // A receipt changes budget, admission, lock, exposure or episode state only
          // as the terminal settlement of a consumed admission, and only once the
          // exact attempt that consumed it is natively complete, whatever later attempts do.
          // The settlement written must be the one this transaction's subject names.
          requireSettlementSubject(old.payload, payload, intent.subject_sha256);
          // A completed attempt's record is final: GitHub starts a re-run as a new attempt and
          // leaves this one as it ended, so one read is enough and none follows the journal entry.
          for (const id of terminalSettlements(old.payload, payload)) await this.completed(old.payload.claims[id]!.producer, api);
        } else if (intent.kind === 'stop') {
          for (const field of ['ledger', 'admissions', 'claims', 'locks', 'exposure'] as const) requireFact(
            documentDigest(payload[field]) === documentDigest(old.payload[field]), 'control_transaction_changes_authority');
          {
            requireFact(documentDigest(Object.keys(payload.episodes).sort()) === documentDigest(Object.keys(old.payload.episodes).sort()), 'stop_changes_episode_set');
            for (const [id, episode] of Object.entries(payload.episodes)) {
              const prior = old.payload.episodes[id]!;
              if (documentDigest(prior) === documentDigest(episode)) continue;
              const { status: _status, reason_code: _reason, next_action: _action, last_outcome: _outcome,
                evidence: _evidence, revision: _revision, parent_digest: _parent, ...identity } = episode;
              const { status: _s, reason_code: _r, next_action: _a, last_outcome: _o,
                evidence: _e, revision: _v, parent_digest: _p, ...priorIdentity } = prior;
              requireFact(episode.status === 'stopped' && documentDigest(identity) === documentDigest(priorIdentity), 'stop_changes_episode_authority');
            }
          }
        }
        validateStateTransition(old.payload, payload, now, intent.kind);
        const lease = Lease.parse(await this.ports.authorize(intent));
        requireFact(lease.principal_id === this.config.writer.principal_id && lease.source_sha === this.config.writer.source_sha &&
          Date.parse(lease.expires_at) > Date.parse(this.clock()), 'writer_authority_refused');
        const state = AuthorityState.parse({ ...old, revision: old.revision + 1, parent_blob_sha: snapshot.blob_sha,
          parent_state_sha256: documentDigest(old), operation: { ...intent, created_at: now }, writer: {
            principal_id: lease.principal_id, source_sha: lease.source_sha, authority_digest: lease.authority_digest },
          payload, payload_sha256: documentDigest(payload),
          applied_operations: { ...old.applied_operations, [operationId]: { intent_sha256: intentHash, revision: old.revision + 1 } } });
        this.validate(state, now);
        const bytes = JSON.stringify(state) + '\n';
        // New work leaves room for the fixed receipt reserve and for settling every admission
        // that still holds a lock, so a finished generation can always be closed out.
        const reserveBytes = ['stop', 'receipt'].includes(intent.kind) ? 0 : this.config.receipt_reserve_bytes + settlementReserveBytes(payload);
        requireFact(Buffer.byteLength(bytes) + reserveBytes <= this.config.maximum_state_bytes, 'state_capacity_exhausted');
        requireFact(requests + 16 <= this.config.maximum_api_requests, 'state_api_receipt_headroom');
        attempted = { intent, intent_sha256: intentHash, expected_blob_sha: snapshot.blob_sha, parent_commit_sha: snapshot.head,
          bytes, blob_sha: gitBlob(bytes), epoch: state.epoch, revision: state.revision };
        await this.ports.journal.prepare(attempted);
        // Native producer and expiring authority must still be current after
        // the durable pre-effect acknowledgement, immediately before the PUT.
        await this.producer(intent.producer, api);
        const fresh = Lease.parse(await this.ports.authorize(intent));
        requireFact(documentDigest(fresh) === documentDigest(lease) && Date.parse(fresh.expires_at) > Date.parse(this.clock()), 'writer_authority_changed');
        let response;
        try {
          writes++; nativeOutcome = 'unknown';
          response = await api('PUT /repos/{owner}/{repo}/contents/{path}', { ...this.coordinates(), path: this.config.path,
            branch: this.config.branch, sha: snapshot.blob_sha, content: Buffer.from(bytes).toString('base64'), message: `Authority transaction ${operationId}` });
        } catch (error) {
          const status = statusOf(error);
          if (status === 409) {
            nativeOutcome = 'conflict';
            await this.ports.journal.seal(operationId, 'lost'); attempted = undefined;
            if (reload === this.config.maximum_conflict_reloads) return result('lost', 'state_conflict_exhausted');
            continue; // Recompute the same intent from a newly validated snapshot.
          }
          if (status && status >= 400 && status < 500 && status !== 408 && status !== 429) {
            nativeOutcome = 'refused';
            await this.ports.journal.seal(operationId, 'refused'); attempted = undefined;
            return result('refused', 'native_state_write_refused');
          }
          const receipt = await this.reconcile(attempted, api);
          if (!receipt) return result('unknown', 'operation_outcome_unknown');
          knownReceipt = receipt; nativeOutcome = 'committed';
          await this.ports.journal.seal(operationId, 'won', receipt); attempted = undefined;
          return result('reconciled', 'native_history_reconciled', receipt);
        }
        const written = z.object({ content: z.object({ sha: z.literal(attempted.blob_sha) }), commit: z.object({ sha: GitSha }) }).parse(response.data);
        const receipt = await this.verifyCommit(written.commit.sha, attempted, api);
        knownReceipt = receipt; nativeOutcome = 'committed';
        await this.ports.journal.seal(operationId, 'won', receipt); attempted = undefined;
        await this.producer(intent.producer, api);
        const finalLease = Lease.parse(await this.ports.authorize(intent));
        requireFact(documentDigest(finalLease) === documentDigest(lease) && Date.parse(finalLease.expires_at) > Date.parse(this.clock()), 'writer_authority_changed_after_commit');
        return result('won', 'native_transaction_committed', receipt);
      }
      return result('lost', 'state_conflict_exhausted');
    } catch (error) {
      // A verified native commit is never a refusal, including when the
      // post-commit authority recheck fails: the effect exists, start is not granted.
      return result(attempted || knownReceipt || (error instanceof StateRefusal && error.code.startsWith('state_journal_')) ? 'unknown' : 'refused', error instanceof StateRefusal ? error.code :
        knownReceipt ? 'transaction_journal_unsealed' : attempted ? 'transaction_receipt_unknown' : 'state_input_or_read_failed', knownReceipt);
    }
  }
  /** Validated read of the canonical state through the same lineage, provenance and
   * acknowledgement checks as a transaction. No write, lease or journal change. */
  async read(): Promise<{ state: AuthorityState; blob_sha: string; commit_sha: string; bytes: number; api_requests: number }> {
    let requests = 0;
    const api: Api = async (route, params) => {
      requireFact(requests < this.config.maximum_api_requests, 'state_api_budget_exhausted'); requests++;
      return this.ports.gh.request(route, { ...params, headers: { 'x-github-api-version': '2026-03-10' }, request: { timeout: 15000 } });
    };
    try {
      const snapshot = await this.load(api);
      return { state: snapshot.state, blob_sha: snapshot.blob_sha, commit_sha: snapshot.head, bytes: Buffer.byteLength(snapshot.bytes), api_requests: requests };
    } catch (error) { throw error instanceof StateRefusal ? error : new StateRefusal('state_input_or_read_failed'); }
  }
  private coordinates() { const [owner, repo] = this.config.state_repository.full_name.split('/'); return { owner, repo }; }
  private async producer(raw: ProducerBinding, api: Api) {
    const p = ProducerBinding.parse(raw), expected = this.config.governed_repository;
    requireFact(p.repository_id === expected.id && p.repository === expected.full_name, 'producer_repository_mismatch');
    const [owner, repo] = expected.full_name.split('/');
    const run = z.object({ id: z.literal(p.run_id), run_attempt: z.literal(p.run_attempt), head_sha: z.literal(p.source_sha),
      path: z.literal(p.workflow_path), repository: z.object({ id: z.literal(expected.id), full_name: z.literal(expected.full_name) }),
      status: z.enum(['queued', 'in_progress']) }).safeParse((await api('GET /repos/{owner}/{repo}/actions/runs/{run_id}', { owner, repo, run_id: p.run_id })).data);
    requireFact(run.success, 'native_producer_mismatch');
  }
  /** The exact attempt that consumed an admission, read natively at settlement. The
   * run-level read reports only the latest attempt, so a re-run would hide the consumed
   * one for good; the attempt's own record keeps its status and conclusion whatever
   * later attempts do. A later attempt is another start: it holds no claim and is never
   * read or settled here. An attempt that cannot be read, or that reports completion
   * without a conclusion, is unknown, not complete: refused with no write, and the same
   * request can be sent again. */
  private async completed(raw: ProducerBinding, api: Api) {
    const p = ProducerBinding.parse(raw), expected = this.config.governed_repository;
    requireFact(p.repository_id === expected.id && p.repository === expected.full_name, 'producer_repository_mismatch');
    const [owner, repo] = expected.full_name.split('/');
    let data: unknown;
    try {
      data = (await api('GET /repos/{owner}/{repo}/actions/runs/{run_id}/attempts/{attempt_number}',
        { owner, repo, run_id: p.run_id, attempt_number: p.run_attempt })).data;
    } catch (error) {
      if (error instanceof StateRefusal) throw error;
      throw new StateRefusal('settlement_run_unknown');
    }
    const read = z.object({ id: z.number(), run_attempt: z.number(), head_sha: z.string(), path: z.string(),
      repository: z.object({ id: z.number(), full_name: z.string() }), status: z.string().min(1), conclusion: z.string().min(1).nullable() }).safeParse(data);
    requireFact(read.success, 'settlement_run_unknown');
    const run = read.data;
    requireFact(run.id === p.run_id && run.run_attempt === p.run_attempt && run.head_sha === p.source_sha && run.path === p.workflow_path &&
      run.repository.id === expected.id && run.repository.full_name === expected.full_name && run.status === 'completed', 'settlement_run_not_completed');
    requireFact(run.conclusion !== null, 'settlement_run_unknown');
  }
  private async file(ref: string, api: Api): Promise<{ bytes: string; sha: string; state: AuthorityState }> {
    const response = await api('GET /repos/{owner}/{repo}/contents/{path}', { ...this.coordinates(), path: this.config.path, ref });
    const file = z.object({ type: z.literal('file'), path: z.literal(this.config.path), sha: GitSha, encoding: z.literal('base64'),
      size: z.number().int().min(1).max(this.config.maximum_state_bytes), content: z.string().max(750000) }).parse(response.data);
    const encoded = file.content.replace(/\s/g, ''), bytes = Buffer.from(encoded, 'base64');
    requireFact(bytes.length === file.size && bytes.toString('base64') === encoded && gitBlob(bytes.toString('utf8')) === file.sha, 'native_state_blob_invalid');
    const state = AuthorityState.parse(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)));
    this.validate(state, this.clock());
    return { bytes: bytes.toString('utf8'), sha: file.sha, state };
  }
  private validate(state: AuthorityState, now: string) {
    requireFact(state.state_repository_id === this.config.state_repository.id && state.repository_id === this.config.governed_repository.id &&
      state.epoch === this.config.epoch && state.writer.principal_id === this.config.writer.principal_id, 'state_identity_or_epoch_changed');
    requireFact(state.payload_sha256 === documentDigest(state.payload), 'state_payload_digest_invalid');
    requireFact(Date.parse(state.operation.created_at) <= Date.parse(now) && Date.parse(state.payload.ledger.bootstrapped_at) <= Date.parse(now), 'state_clock_invalid');
    validateLedger(state.payload.ledger, now);
    const { created_at: _time, ...intent } = state.operation;
    requireFact(state.applied_operations[intent.operation_id]?.intent_sha256 === documentDigest(intent) &&
      state.applied_operations[intent.operation_id]?.revision === state.revision, 'state_operation_binding_invalid');
    for (const [id, admission] of Object.entries(state.payload.admissions)) {
      const reservation = state.payload.ledger.reservations[id], claim = state.payload.claims[id], exposure = state.payload.exposure[id];
      requireFact(id === admission.admission_id && admission.epoch === state.epoch && admission.admission_sha256 === admissionDigest(admission) &&
        reservation && reservation.epoch === state.epoch && reservation.status === admission.status &&
        reservation.episode_id === admission.episode_id && reservation.cap_manifest_digest === admission.cap_manifest_digest &&
        state.payload.episodes[admission.episode_id] && reservation.issued_at === admission.issued_at &&
        documentDigest(reservation.producer) === documentDigest(admission.producer) && documentDigest(reservation.components) === documentDigest(admission.components), 'admission_reservation_mismatch');
      if (['reserved', 'consumed'].includes(admission.status) || reservation.effect_knowledge === 'unknown') {
        requireFact(exposure && exposure.admission_id === id && exposure.status !== 'cleared' && exposure.aic >= envelopeAic(admission.components) &&
          admission.resource_lock_keys.every(k => state.payload.locks[k] === id), 'admission_liability_missing');
      }
      if (isTerminal(admission.status)) requireFact(reservation.effect_knowledge === 'known' && exposure?.status === 'cleared' &&
        !Object.values(state.payload.locks).includes(id), 'settled_admission_still_held');
      if (admission.status === 'consumed' || isTerminal(admission.status)) requireFact(claim && claim.epoch === state.epoch && claim.admission_sha256 === admission.admission_sha256 &&
        Date.parse(claim.consumed_at) >= Date.parse(admission.issued_at) && Date.parse(claim.consumed_at) <= Date.parse(now) &&
        claim.producer.repository_id === admission.producer.repository_id && claim.producer.repository === admission.producer.repository &&
        state.applied_operations[claim.operation_id]?.revision === claim.revision, 'claim_binding_invalid');
      else requireFact(!claim, 'unexpected_generation_claim');
    }
    requireFact(Object.keys(state.payload.claims).every(id => !!state.payload.admissions[id]) &&
      Object.keys(state.payload.ledger.reservations).every(id => !!state.payload.admissions[id]), 'orphan_claim_or_reservation');
    for (const [id, episode] of Object.entries(state.payload.episodes)) {
      const reservations = Object.values(state.payload.ledger.reservations).filter(r => r.episode_id === id &&
        (['reserved', 'consumed'].includes(r.status) || r.effect_knowledge === 'unknown'));
      requireFact(episode.episode_id === id && episode.repository_id === this.config.governed_repository.id &&
        episode.reserved_aic === reservations.reduce((sum, r) => sum + envelopeAic(r.components), 0), 'episode_ledger_mismatch');
    }
    for (const [id, effect] of Object.entries(state.payload.outbox)) requireFact(effect.effect_id === id &&
      state.payload.admissions[effect.admission_id]?.episode_id === effect.episode_id, 'outbox_binding_invalid');
  }
  private async ancestry(head: string, api: Api, base = this.config.anchor_commit_sha) {
    const result = await api('GET /repos/{owner}/{repo}/compare/{basehead}', { ...this.coordinates(), basehead: `${base}...${head}` });
    requireFact(z.object({ status: z.enum(['ahead', 'identical']), behind_by: z.literal(0),
      merge_base_commit: z.object({ sha: z.literal(base) }) }).safeParse(result.data).success, 'state_ancestry_invalid');
  }
  private async writerCommit(commit: string, api: Api) {
    const response = await api('GET /repos/{owner}/{repo}/commits/{ref}', { ...this.coordinates(), ref: commit });
    requireFact(z.object({ sha: z.literal(commit), author: z.object({ id: z.literal(this.config.writer.principal_id), type: z.literal('Bot') }),
      commit: z.object({ verification: z.object({ verified: z.literal(true), reason: z.literal('valid') }) }) })
      .safeParse(response.data).success, 'state_writer_provenance_invalid');
  }
  private async load(api: Api): Promise<Snapshot> {
    let acknowledged: { epoch: string; revision: number; commit_sha: string; state_sha256: string };
    try { acknowledged = z.object({ epoch: z.string().min(1), revision: z.number().int().positive().safe(), commit_sha: GitSha, state_sha256: Digest })
      .strict().parse(await this.ports.journal.acknowledged()); }
    catch { throw new StateRefusal('state_journal_anchor_unavailable'); }
    const native = await api('GET /repos/{owner}/{repo}', this.coordinates());
    requireFact(z.object({ id: z.literal(this.config.state_repository.id), full_name: z.literal(this.config.state_repository.full_name),
      private: z.literal(true), archived: z.literal(false), disabled: z.literal(false), default_branch: z.literal(this.config.branch) }).safeParse(native.data).success, 'state_repository_mismatch');
    const head = z.object({ ref: z.literal(`refs/heads/${this.config.branch}`), object: z.object({ type: z.literal('commit'), sha: GitSha }) })
      .parse((await api('GET /repos/{owner}/{repo}/git/ref/{ref}', { ...this.coordinates(), ref: `heads/${this.config.branch}` })).data).object.sha;
    await this.ancestry(head, api);
    await this.writerCommit(head, api);
    const file = await this.file(head, api);
    requireFact(acknowledged.epoch === this.config.epoch && file.state.revision >= acknowledged.revision &&
      (file.state.revision !== acknowledged.revision || documentDigest(file.state) === acknowledged.state_sha256), 'state_rollback_detected');
    if (acknowledged.commit_sha !== this.config.anchor_commit_sha) await this.ancestry(head, api, acknowledged.commit_sha);
    const acknowledgedFile = acknowledged.commit_sha === head ? file : await this.file(acknowledged.commit_sha, api);
    requireFact(acknowledgedFile.state.epoch === acknowledged.epoch && acknowledgedFile.state.revision === acknowledged.revision &&
      documentDigest(acknowledgedFile.state) === acknowledged.state_sha256, 'state_acknowledgement_invalid');
    const history = z.array(z.object({ sha: GitSha, parents: z.array(z.object({ sha: GitSha })).max(1) })).min(1)
      .parse((await api('GET /repos/{owner}/{repo}/commits', { ...this.coordinates(), sha: head, path: this.config.path, per_page: 1 })).data);
    const latest = history[0]!;
    if (latest.sha !== head) await this.writerCommit(latest.sha, api);
    if (latest.sha !== head) requireFact((await this.file(latest.sha, api)).sha === file.sha, 'state_head_binding_invalid');
    if (file.state.revision === 1) requireFact(latest.sha === this.config.anchor_commit_sha && file.state.parent_blob_sha === null &&
      file.state.parent_state_sha256 === null, 'state_bootstrap_anchor_invalid');
    else {
      requireFact(latest.parents.length === 1, 'state_parent_missing');
      await this.writerCommit(latest.parents[0]!.sha, api);
      const parent = await this.file(latest.parents[0]!.sha, api);
      requireFact(parent.sha === file.state.parent_blob_sha && documentDigest(parent.state) === file.state.parent_state_sha256 &&
        parent.state.epoch === file.state.epoch && parent.state.revision + 1 === file.state.revision, 'state_lineage_invalid');
      validateStateTransition(parent.state.payload, file.state.payload, this.clock(), file.state.operation.kind, file.state.operation.created_at);
      if (file.state.operation.kind === 'receipt') requireSettlementSubject(parent.state.payload, file.state.payload, file.state.operation.subject_sha256);
      for (const [id, op] of Object.entries(parent.state.applied_operations)) requireFact(documentDigest(op) === documentDigest(file.state.applied_operations[id] ?? null), 'operation_history_changed');
    }
    return { state: file.state, bytes: file.bytes, blob_sha: file.sha, head };
  }
  private async verifyCommit(commit: string, prepared: PreparedTransaction, api: Api): Promise<TransactionReceipt> {
    requireFact(gitBlob(prepared.bytes) === prepared.blob_sha && documentDigest(prepared.intent) === prepared.intent_sha256, 'prepared_transaction_invalid');
    await this.ancestry(commit, api);
    await this.writerCommit(commit, api);
    const file = await this.file(commit, api);
    requireFact(file.bytes === prepared.bytes && file.sha === prepared.blob_sha && file.state.revision === prepared.revision &&
      file.state.epoch === prepared.epoch && file.state.parent_blob_sha === prepared.expected_blob_sha, 'operation_history_mismatch');
    const native = z.object({ sha: z.literal(commit), parents: z.array(z.object({ sha: GitSha })).length(1) })
      .parse((await api('GET /repos/{owner}/{repo}/git/commits/{commit_sha}', { ...this.coordinates(), commit_sha: commit })).data);
    const parent = await this.file(native.parents[0]!.sha, api);
    requireFact(parent.sha === prepared.expected_blob_sha && file.state.parent_state_sha256 === documentDigest(parent.state) &&
      parent.state.revision + 1 === file.state.revision, 'operation_parent_mismatch');
    return { operation_id: prepared.intent.operation_id, epoch: file.state.epoch, revision: file.state.revision,
      state_repository_id: this.config.state_repository.id, path: this.config.path, expected_blob_sha: parent.sha,
      new_blob_sha: file.sha, commit_sha: commit, state_sha256: documentDigest(file.state), payload_sha256: file.state.payload_sha256 };
  }
  private async reconcile(prepared: PreparedTransaction, api: Api): Promise<TransactionReceipt | null> {
    const snapshot = await this.load(api);
    requireFact(prepared.epoch === this.config.epoch && prepared.intent_sha256 === documentDigest(TransactionIntent.parse(prepared.intent)), 'prepared_transaction_invalid');
    const record = snapshot.state.applied_operations[prepared.intent.operation_id];
    if (!record) return null; // Missing history never establishes that a request was dropped.
    requireFact(record.intent_sha256 === prepared.intent_sha256 && record.revision === prepared.revision, 'operation_identity_changed');
    const history = z.array(z.object({ sha: GitSha })).parse((await api('GET /repos/{owner}/{repo}/commits', {
      ...this.coordinates(), sha: snapshot.head, path: this.config.path, per_page: this.config.maximum_history_commits })).data);
    requireFact(history.length <= this.config.maximum_history_commits, 'state_history_bound_exceeded');
    for (const item of history) {
      const file = await this.file(item.sha, api);
      if (file.state.operation.operation_id === prepared.intent.operation_id) return this.verifyCommit(item.sha, prepared, api);
    }
    return null;
  }
}
type Api = (route: string, params: Record<string, unknown>) => Promise<Awaited<ReturnType<Octokit['request']>>>;
