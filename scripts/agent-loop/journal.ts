import { z } from 'zod';
import { AuthorityState, TransactionIntent } from '../../schemas/agent-loop-state';
import { documentDigest, GitDocument, gitBlob } from './git-document';
import { StateRefusal } from './ledger';
import type { PreparedTransaction, TransactionJournal, TransactionReceipt } from './native-store';

const sha = z.string().regex(/^[a-f0-9]{40}$/), digest = z.string().regex(/^[a-f0-9]{64}$/), positive = z.number().int().positive().safe();
export const JournalAnchor = z.object({ epoch: z.string().min(1).max(256), revision: positive, commit_sha: sha, state_sha256: digest }).strict();
export const TransactionReceiptSchema = z.object({ operation_id: z.string().min(1).max(256), epoch: z.string().min(1).max(256), revision: positive,
  state_repository_id: positive, path: z.literal('state/control.json'), expected_blob_sha: sha, new_blob_sha: sha, commit_sha: sha,
  state_sha256: digest, payload_sha256: digest }).strict();
const Prepared = z.object({ intent: TransactionIntent, intent_sha256: digest, expected_blob_sha: sha, parent_commit_sha: sha,
  bytes: z.string().min(1).max(524288), blob_sha: sha, epoch: z.string().min(1).max(256), revision: positive }).strict();
const AuditCopy = z.object({ repository_id: positive, path: z.literal('audit/chain.json'), commit_sha: sha, sha256: digest, sequence: positive }).strict();
const Outcome = z.object({ intent_sha256: digest, outcome: z.enum(['won', 'lost', 'refused']), receipt: TransactionReceiptSchema.optional(), audit_copy: AuditCopy.optional() }).strict();
const Journal = z.object({ schema_version: z.literal(1), purpose: z.literal('transaction_journal'), anchor: JournalAnchor,
  pending: z.record(z.string(), Prepared), outcomes: z.record(z.string(), Outcome) }).strict();
export const initialJournal = (anchor: unknown) => Journal.parse({ schema_version: 1, purpose: 'transaction_journal', anchor, pending: {}, outcomes: {} });
const fact: (value: unknown, code: string) => asserts value = (value, code) => { if (!value) throw new StateRefusal(code); };
function validatePrepared(raw: unknown) {
  const p = Prepared.parse(raw), state = AuthorityState.parse(JSON.parse(p.bytes));
  const { created_at: _time, ...intent } = state.operation;
  fact(gitBlob(p.bytes) === p.blob_sha && documentDigest(p.intent) === p.intent_sha256 && documentDigest(intent) === p.intent_sha256 &&
    state.epoch === p.epoch && state.revision === p.revision && state.parent_blob_sha === p.expected_blob_sha &&
    state.payload_sha256 === documentDigest(state.payload), 'journal_prepared_binding_invalid'); return p;
}
/** Journal lives in isolated state repo, separate from the canonical CAS document.
 * Provision initialJournal explicitly once; absent established state always blocks. */
export class GitTransactionJournal implements TransactionJournal {
  constructor(private document: GitDocument) { fact(document.config.path === 'state/journal.json', 'journal_path_invalid'); }
  private parse(raw: unknown) {
    const j = Journal.parse(raw);
    fact(Object.keys(j.pending).length <= 1 && Object.keys(j.outcomes).length <= 100, 'journal_capacity_exhausted');
    for (const [id, p] of Object.entries(j.pending)) fact(id === validatePrepared(p).intent.operation_id && j.anchor.epoch === p.epoch, 'journal_identity_invalid');
    return j;
  }
  async pending() { return Object.values(this.parse((await this.document.read()).value).pending); }
  async acknowledged() { return this.parse((await this.document.read()).value).anchor; }
  /** Outcomes held and the most this journal accepts; nothing removes one yet. */
  async capacity() { return { outcomes: Object.keys(this.parse((await this.document.read()).value).outcomes).length, maximum: 100 }; }
  async unarchivedReceipts() {
    return Object.values(this.parse((await this.document.read()).value).outcomes).filter(o => o.receipt && !o.audit_copy).map(o => o.receipt!);
  }
  /** True only when this exact receipt is sealed AND its audit copy is recorded. */
  async archived(rawReceipt: TransactionReceipt) {
    const receipt = TransactionReceiptSchema.parse(rawReceipt), outcome = this.parse((await this.document.read()).value).outcomes[receipt.operation_id];
    return !!outcome?.audit_copy && documentDigest(outcome.receipt ?? null) === documentDigest(receipt);
  }
  async acknowledgeAudit(operationId: string, raw: unknown, auditRepositoryId: number) {
    const copy = AuditCopy.parse(raw);
    await this.document.update(value => {
      const j = this.parse(value), outcome = j.outcomes[operationId];
      fact(outcome?.receipt && copy.repository_id === auditRepositoryId && copy.sha256 === documentDigest({ schema_version: 1,
        kind: 'transaction_receipt', event_id: `receipt:${operationId}`, receipt: outcome.receipt, outcome: 'committed' }), 'journal_audit_binding_invalid');
      if (outcome.audit_copy) { fact(documentDigest(outcome.audit_copy) === documentDigest(copy), 'journal_audit_copy_changed'); return j; }
      outcome.audit_copy = copy; return j;
    });
  }
  async prepare(raw: PreparedTransaction) {
    const p = validatePrepared(raw);
    await this.document.update(value => {
      const j = this.parse(value), previous = j.pending[p.intent.operation_id], outcome = j.outcomes[p.intent.operation_id];
      fact(j.anchor.epoch === p.epoch && p.revision > j.anchor.revision, 'journal_epoch_or_revision_invalid');
      if (previous) { fact(documentDigest(previous) === documentDigest(p), 'journal_operation_changed'); return j; }
      fact(!Object.keys(j.pending).length && (!outcome || outcome.outcome === 'lost') &&
        (!outcome || outcome.intent_sha256 === p.intent_sha256), 'journal_replay_or_pending');
      j.pending[p.intent.operation_id] = p; return this.parse(j);
    });
  }
  async seal(operationId: string, outcome: 'won' | 'lost' | 'refused', rawReceipt?: TransactionReceipt) {
    const receipt = rawReceipt ? TransactionReceiptSchema.parse(rawReceipt) : undefined;
    await this.document.update(value => {
      const j = this.parse(value), pending = j.pending[operationId], previous = j.outcomes[operationId];
      if (!pending) {
        fact(previous && previous.outcome === outcome && documentDigest(previous.receipt ?? null) === documentDigest(receipt ?? null), 'journal_seal_unknown'); return j;
      }
      fact((outcome === 'won') === !!receipt, 'journal_receipt_required');
      if (receipt) {
        const state = AuthorityState.parse(JSON.parse(pending.bytes));
        fact(receipt.operation_id === operationId && receipt.epoch === pending.epoch && receipt.revision === pending.revision &&
          receipt.expected_blob_sha === pending.expected_blob_sha && receipt.new_blob_sha === pending.blob_sha &&
          receipt.state_sha256 === documentDigest(state) && receipt.payload_sha256 === state.payload_sha256 &&
          receipt.state_repository_id === this.document.config.repository.id && receipt.epoch === j.anchor.epoch &&
          receipt.revision > j.anchor.revision, 'journal_receipt_binding_invalid');
        j.anchor = { epoch: receipt.epoch, revision: receipt.revision, commit_sha: receipt.commit_sha, state_sha256: receipt.state_sha256 };
      }
      j.outcomes[operationId] = { intent_sha256: pending.intent_sha256, outcome, ...(receipt ? { receipt } : {}) };
      delete j.pending[operationId]; return this.parse(j);
    });
  }
}
