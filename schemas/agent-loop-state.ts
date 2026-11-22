import { z } from 'zod';
import { Digest, EpisodeCheckpoint, GitSha, Instant } from './agent-loop';

const name = z.string().min(1).max(256).regex(/^[A-Za-z0-9][A-Za-z0-9:._/-]*$/);
const count = z.number().int().nonnegative().safe();
const id = z.number().int().positive().safe();
const repository = z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/);
export const ProducerBinding = z.object({ repository_id: id, repository, run_id: id, run_attempt: id,
  source_sha: GitSha, workflow_path: z.string().regex(/^\.github\/workflows\/[A-Za-z0-9_.-]+\.ya?ml$/) }).strict();
export type ProducerBinding = z.infer<typeof ProducerBinding>;
export const TransactionIntent = z.object({ operation_id: name, kind: z.enum(['reserve', 'consume', 'record', 'stop', 'receipt']),
  producer: ProducerBinding, subject_sha256: Digest, authority_ref: z.string().min(1).max(2048) }).strict();
export type TransactionIntent = z.infer<typeof TransactionIntent>;
export const ReservedComponents = z.record(z.string().regex(/^(generator|detector|critic|probe|evaluator|proposer)$/), count)
  .refine(c => Object.values(c).some(n => n > 0), 'A complete positive envelope is required.');
export const Reservation = z.object({ admission_id: name, episode_id: name, epoch: name, producer: ProducerBinding,
  account_ids: z.array(name).min(3).max(100), components: ReservedComponents, cap_manifest_digest: Digest,
  issued_at: Instant, status: z.enum(['reserved', 'consumed', 'settled', 'charged_at_cap', 'released', 'revoked']),
  effect_knowledge: z.enum(['known', 'unknown']) }).strict();
export const UsageLedger = z.object({ bootstrapped_by: id, bootstrapped_at: Instant, retention_expires_at: Instant,
  accounts: z.record(name, z.object({ kind: z.enum(['episode', 'rolling_day', 'lifetime']), episode_id: name.optional(),
    limit_aic: count, limit_generations: count }).strict()),
  reservations: z.record(name, Reservation),
  charges: z.record(name, z.object({ charge_id: name, admission_id: name, account_ids: z.array(name).min(3).max(100),
    producer: ProducerBinding, component: z.string().min(1).max(100), usage_record_id: name, amount_aic: count, charged_at: Instant }).strict()),
}).strict();
export type UsageLedger = z.infer<typeof UsageLedger>;
export const Admission = z.object({ admission_id: name, generation_id: name, episode_id: name, epoch: name,
  producer: ProducerBinding, policy_digest: Digest, plan_sha: GitSha, context_digest: Digest, cap_manifest_digest: Digest,
  components: ReservedComponents, resource_lock_keys: z.array(name).min(1).max(100),
  checkpoint_revision: id, issued_at: Instant, expires_at: Instant, admission_sha256: Digest,
  status: z.enum(['reserved', 'consumed', 'settled', 'charged_at_cap', 'released', 'revoked']),
}).strict();
export type Admission = z.infer<typeof Admission>;
/** T126 intake fields are optional: a reservation's own request entry carries only
 * the first four. `source` is the authenticated native dispatch, never body text. */
export const RequestReceipt = z.object({ request_id: name, source_ref: z.string().min(1).max(2048), digest: Digest,
  status: z.enum(['pending', 'accepted', 'consumed', 'refused', 'unknown']),
  action: z.enum(['observe', 'reconcile', 'start', 'resume', 'stop']).optional(), workload: name.optional(),
  // Actor is null only for a dispatch GitHub lists without a readable actor; such a receipt is always a refusal.
  source: z.object({ repository_id: id, run_id: id, run_attempt: id, actor_id: id.nullable(), actor_login: z.string().min(1).max(100).nullable(),
    created_at: Instant }).strict().optional(),
  recorded_at: Instant.optional(), reason_code: name.optional(), linked_to: name.optional() }).strict();
export type RequestReceipt = z.infer<typeof RequestReceipt>;
/** Durable intake high-water mark. It moves only inside the transaction that
 * records the receipt it passes; a missing cursor never means "scan nothing".
 * `not_before` is the fixed floor set at provisioning: no earlier dispatch is
 * ever read, whatever overlap a later scan uses. */
export const RequestCursor = z.object({ workflow_path: z.string().regex(/^\.github\/workflows\/[A-Za-z0-9_.-]+\.ya?ml$/),
  not_before: Instant, created_at: Instant, run_id: count }).strict();
export type RequestCursor = z.infer<typeof RequestCursor>;
export const AuthorityPayload = z.object({ episodes: z.record(name, EpisodeCheckpoint), ledger: UsageLedger,
  admissions: z.record(name, Admission),
  claims: z.record(name, z.object({ admission_sha256: Digest, producer: ProducerBinding, epoch: name,
    operation_id: name, revision: id, consumed_at: Instant }).strict()),
  locks: z.record(name, name), exposure: z.record(name, z.object({ admission_id: name, aic: count,
    status: z.enum(['held', 'unknown', 'cleared']) }).strict()),
  requests: z.record(name, RequestReceipt),
  outbox: z.record(name, z.object({ effect_id: name, admission_id: name, episode_id: name, kind: z.enum(['dispatch', 'publish', 'merge', 'deploy', 'verify', 'record']),
    intent_digest: Digest, status: z.enum(['pending', 'accepted', 'unknown', 'acknowledged', 'refused']) }).strict()),
  request_cursor: RequestCursor.optional(),
}).strict();
export type AuthorityPayload = z.infer<typeof AuthorityPayload>;
export const AuthorityState = z.object({ schema_version: z.literal(1), purpose: z.literal('authority_state'),
  state_repository_id: id, repository_id: id, epoch: name, revision: id,
  parent_blob_sha: GitSha.nullable(), parent_state_sha256: Digest.nullable(),
  operation: TransactionIntent.extend({ created_at: Instant }).strict(),
  writer: z.object({ principal_id: id, source_sha: GitSha, authority_digest: Digest }).strict(),
  payload_sha256: Digest, payload: AuthorityPayload,
  applied_operations: z.record(name, z.object({ intent_sha256: Digest, revision: id }).strict()),
}).strict();
export type AuthorityState = z.infer<typeof AuthorityState>;
