import { z } from 'zod';
import { Admission, ProducerBinding } from '../../schemas/agent-loop-state';
import { brokerDigest } from '../control-plane/broker';
import { NativeAuthorityStore, type StateTransactionResult } from './native-store';
import { admissionDigest } from './native-store';
import { applyTerminalSettlement, envelopeAic, SettlementOutcome, settlementSubject, StateRefusal } from './ledger';

const operation = z.string().min(1).max(256).regex(/^[A-Za-z0-9][A-Za-z0-9:._/-]*$/);
const authority = z.string().min(1).max(2048);
export const ReserveRequest = Admission.omit({ epoch: true, checkpoint_revision: true, issued_at: true,
  admission_sha256: true, status: true }).extend({ operation_id: operation, authority_ref: authority }).strict();
export const ConsumeRequest = z.object({ admission_id: operation, operation_id: operation, authority_ref: authority, producer: ProducerBinding }).strict();
const settlement = { operation_id: operation, authority_ref: authority, producer: ProducerBinding };
/** `producer` is the run doing the settling (still in progress), never the run
 * that consumed the admission: that one is read from the claim and must be complete. */
export const SettleRequest = z.discriminatedUnion('outcome', [
  SettlementOutcome.options[0].extend(settlement).strict(), SettlementOutcome.options[1].extend(settlement).strict()]);
export { settlementSubject };
const changed = (fact: unknown, code: string) => { if (!fact) throw new StateRefusal(code); };
type AdmissionStore = Pick<NativeAuthorityStore, 'transact' | 'config'>;

/** Pre-start reservation: every applicable episode, rolling-day and lifetime
 * account, full component envelope, locks and dispatch intent commit together. */
export async function reserveAdmission(store: AdmissionStore, raw: unknown): Promise<StateTransactionResult> {
  const input = ReserveRequest.parse(raw);
  const { operation_id, authority_ref, ...requested } = input;
  return store.transact({ operation_id, authority_ref, kind: 'reserve', producer: input.producer, subject_sha256: brokerDigest(requested) }, (draft, now) => {
    const episode = draft.episodes[input.episode_id];
    changed(episode && episode.repository_id === input.producer.repository_id && episode.plan_sha === input.plan_sha &&
      episode.policy_digest === input.policy_digest && episode.context_digest === input.context_digest, 'admission_context_changed');
    changed(['ready', 'retry_wait', 'waiting_for_budget'].includes(episode!.status), 'episode_not_ready');
    changed(!episode!.not_before || Date.parse(episode!.not_before) <= Date.parse(now), 'episode_backoff_pending');
    changed(Date.parse(input.expires_at) > Date.parse(now) && Date.parse(input.expires_at) <= Date.parse(episode!.deadline), 'admission_expired');
    changed(!draft.admissions[input.admission_id], 'admission_already_exists');
    const lockKeys = [...new Set([...input.resource_lock_keys, `workload:${episode!.repository_id}:${episode!.workload}`])].sort();
    changed(lockKeys.every(k => !draft.locks[k]), 'resource_lock_held');
    const amount = envelopeAic(input.components);
    const accountIds = Object.entries(draft.ledger.accounts).filter(([, a]) => a.kind !== 'episode' || a.episode_id === input.episode_id).map(([id]) => id).sort();
    const priorEpisode = structuredClone(episode!);
    episode!.revision++; episode!.parent_digest = brokerDigest(priorEpisode); episode!.reserved_aic += amount;
    const admission = Admission.parse({ ...requested, epoch: store.config.epoch, resource_lock_keys: lockKeys,
      checkpoint_revision: episode!.revision, issued_at: now, admission_sha256: '0'.repeat(64), status: 'reserved' });
    admission.admission_sha256 = admissionDigest(admission);
    draft.admissions[input.admission_id] = admission;
    draft.ledger.reservations[input.admission_id] = { admission_id: input.admission_id, episode_id: input.episode_id,
      epoch: store.config.epoch, producer: input.producer, account_ids: accountIds, components: input.components,
      cap_manifest_digest: input.cap_manifest_digest, issued_at: now, status: 'reserved', effect_knowledge: 'known' };
    for (const key of lockKeys) draft.locks[key] = input.admission_id;
    draft.exposure[input.admission_id] = { admission_id: input.admission_id, aic: amount, status: 'held' };
    changed(!draft.requests[input.admission_id] && !draft.outbox[`dispatch-${input.admission_id}`], 'request_or_effect_identity_exists');
    draft.requests[input.admission_id] = { request_id: input.admission_id, source_ref: authority_ref, digest: brokerDigest(requested), status: 'accepted' };
    draft.outbox[`dispatch-${input.admission_id}`] = { effect_id: `dispatch-${input.admission_id}`, admission_id: input.admission_id,
      episode_id: input.episode_id, kind: 'dispatch', intent_digest: brokerDigest({ admission_sha256: admission.admission_sha256, producer: input.producer }), status: 'pending' };
  });
}

/** Only the invocation that receives a newly won, verified and journal-sealed
 * conditional consume may start. Replays/reconciliation retain liabilities but
 * never grant another model start, including the same run on another attempt. */
export async function consumeAdmission(store: AdmissionStore, raw: unknown): Promise<{ allowed: boolean; result: StateTransactionResult }> {
  const input = ConsumeRequest.parse(raw);
  const { operation_id, authority_ref, ...subject } = input;
  const result = await store.transact({ operation_id, authority_ref, kind: 'consume', producer: input.producer,
    subject_sha256: brokerDigest(subject) }, (draft, now, revision) => {
    const admission = draft.admissions[input.admission_id];
    changed(admission && admission.epoch === store.config.epoch && admission.status === 'reserved' && !draft.claims[input.admission_id], 'admission_already_consumed_or_missing');
    // The executor is a run dispatched after reservation, never the reserving controller run.
    // transact() natively verifies this producer's run/attempt/source/workflow; the claim records it.
    changed(admission!.producer.repository_id === input.producer.repository_id &&
      admission!.producer.repository === input.producer.repository, 'executor_repository_mismatch');
    changed(Date.parse(admission!.expires_at) > Date.parse(now), 'admission_expired');
    const episode = draft.episodes[admission!.episode_id], reservation = draft.ledger.reservations[input.admission_id];
    changed(episode && episode.revision === admission!.checkpoint_revision && episode.plan_sha === admission!.plan_sha &&
      episode.policy_digest === admission!.policy_digest && episode.context_digest === admission!.context_digest &&
      Date.parse(episode.deadline) > Date.parse(now), 'admission_context_changed');
    changed(reservation && reservation.status === 'reserved' && reservation.effect_knowledge === 'known', 'reservation_not_consumable');
    changed(admission!.resource_lock_keys.every(k => draft.locks[k] === input.admission_id), 'resource_lock_changed');
    admission!.status = 'consumed'; reservation!.status = 'consumed';
    draft.claims[input.admission_id] = { admission_sha256: admission!.admission_sha256, producer: input.producer,
      epoch: store.config.epoch, operation_id, revision, consumed_at: now };
    const before = structuredClone(episode!);
    episode!.revision++; episode!.parent_digest = brokerDigest(before); episode!.generation_count++;
    episode!.current_generation_id = admission!.generation_id; episode!.status = 'running';
    episode!.last_outcome = 'generation_consumed'; episode!.reason_code = 'one_use_claim_won'; episode!.next_action = 'Run the admitted bounded executor.';
    draft.requests[input.admission_id]!.status = 'consumed';
  });
  return { allowed: result.status === 'won', result };
}

/** Terminal settlement of a consumed admission. A `receipt` transaction, so it
 * keeps its reserved room when new admissions are blocked. Replaying the same
 * operation changes nothing; a different operation on a settled admission is refused. */
export async function settleAdmission(store: AdmissionStore, raw: unknown): Promise<StateTransactionResult> {
  const input = SettleRequest.parse(raw);
  const { operation_id, authority_ref, producer, ...outcome } = input;
  return store.transact({ operation_id, authority_ref, kind: 'receipt', producer, subject_sha256: brokerDigest(settlementSubject(outcome)) }, (draft, now) => {
    const admission = draft.admissions[input.admission_id];
    changed(!admission || admission.epoch === store.config.epoch, 'admission_epoch_changed');
    applyTerminalSettlement(draft, outcome, now);
  });
}
