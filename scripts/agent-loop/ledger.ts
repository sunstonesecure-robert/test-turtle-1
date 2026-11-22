import { createHash } from 'node:crypto';
import { z } from 'zod';
import { UsageLedger, type AuthorityPayload, type Admission, type TransactionIntent } from '../../schemas/agent-loop-state';
import { brokerDigest } from '../control-plane/broker';

export class StateRefusal extends Error {
  constructor(readonly code: string) { super(code); }
}
export const envelopeAic = (components: Admission['components']) => {
  const total = Object.values(components).reduce((a, n) => a + n, 0);
  if (!Number.isSafeInteger(total) || total <= 0) throw new StateRefusal('envelope_invalid');
  return total;
};
const held = (r: UsageLedger['reservations'][string]) => r.effect_knowledge === 'unknown' || ['reserved', 'consumed'].includes(r.status);

/** A rolling day is the prior 24 hours. Active/unknown liabilities never expire
 * merely because midnight, a reservation expiry, or artifact retention passed. */
export function budgetAvailable(raw: unknown, accountId: string, now: string): number {
  const ledger = UsageLedger.parse(raw), account = ledger.accounts[accountId];
  if (!account || !Number.isFinite(Date.parse(now))) throw new StateRefusal('budget_missing_or_clock_invalid');
  const cutoff = Date.parse(now) - 24 * 60 * 60 * 1000;
  const charges = Object.values(ledger.charges).filter(c => c.account_ids.includes(accountId) &&
    (account.kind !== 'rolling_day' || Date.parse(c.charged_at) > cutoff));
  const reservations = Object.values(ledger.reservations).filter(r => r.account_ids.includes(accountId) && held(r));
  const used = charges.reduce((n, c) => n + c.amount_aic, 0) + reservations.reduce((n, r) => n + envelopeAic(r.components), 0);
  if (!Number.isSafeInteger(used)) throw new StateRefusal('budget_invalid');
  return account.limit_aic - used;
}
/** Generations an account can still admit. A rolling-day account counts every
 * held reservation and those issued in the prior 24 hours. */
export function generationsAvailable(raw: unknown, accountId: string, now: string): number {
  const ledger = UsageLedger.parse(raw), account = ledger.accounts[accountId];
  if (!account || !Number.isFinite(Date.parse(now))) throw new StateRefusal('budget_missing_or_clock_invalid');
  const cutoff = Date.parse(now) - 24 * 60 * 60 * 1000;
  return account.limit_generations - Object.values(ledger.reservations).filter(r => r.account_ids.includes(accountId) &&
    !['released', 'revoked'].includes(r.status) && (account.kind !== 'rolling_day' || held(r) || Date.parse(r.issued_at) > cutoff)).length;
}
export function validateLedger(raw: unknown, now: string) {
  const ledger = UsageLedger.parse(raw);
  if (Date.parse(ledger.retention_expires_at) <= Date.parse(now)) throw new StateRefusal('ledger_retention_expired');
  for (const [id, reservation] of Object.entries(ledger.reservations)) {
    const accounts = reservation.account_ids.map(id => ledger.accounts[id]);
    if (id !== reservation.admission_id || accounts.some(a => !a) || new Set(accounts.map(a => a!.kind)).size !== 3 ||
      !accounts.some(a => a!.kind === 'episode' && a!.episode_id === reservation.episode_id)) throw new StateRefusal('budget_scope_incomplete');
    const required = Object.entries(ledger.accounts).filter(([, a]) => a.kind !== 'episode' || a.episode_id === reservation.episode_id).map(([id]) => id).sort();
    if (new Set(reservation.account_ids).size !== reservation.account_ids.length || brokerDigest([...reservation.account_ids].sort()) !== brokerDigest(required)) throw new StateRefusal('budget_scope_incomplete');
  }
  for (const [id, charge] of Object.entries(ledger.charges)) {
    if (charge.charge_id !== id || !ledger.reservations[charge.admission_id] || charge.account_ids.some(id => !ledger.accounts[id])) throw new StateRefusal('charge_binding_invalid');
    if (Date.parse(charge.charged_at) > Date.parse(now)) throw new StateRefusal('charge_clock_invalid');
  }
  for (const id of Object.keys(ledger.accounts)) {
    if (budgetAvailable(ledger, id, now) < 0) throw new StateRefusal('budget_exhausted');
    if (generationsAvailable(ledger, id, now) < 0) throw new StateRefusal('generation_budget_exhausted');
  }
  return ledger;
}
const TERMINAL = ['settled', 'charged_at_cap'];
export const isTerminal = (status: string) => TERMINAL.includes(status);
const usageName = z.string().min(1).max(256).regex(/^[A-Za-z0-9][A-Za-z0-9:._/-]*$/);
/** `charged_at_cap` debits the whole reserved envelope and reports no usage.
 * `settled` debits complete reported usage, one record per reserved component,
 * and returns the rest.
 *
 * Seam (charged-at-cap rules, later work): this library does not decide WHICH
 * outcome a finished run has earned. It does not prove that the envelope is a
 * complete bound on every billable attempt, it does not read usage telemetry,
 * and it does not reconcile a later actual against an earlier charge. The caller
 * states the outcome; the transaction authority must approve that exact subject.
 * Charge IDs are stable per admission/run/attempt/component so a later
 * reconciliation can address the same charge. */
export const SettlementOutcome = z.discriminatedUnion('outcome', [
  z.object({ admission_id: usageName, outcome: z.literal('charged_at_cap') }).strict(),
  z.object({ admission_id: usageName, outcome: z.literal('settled'),
    usage: z.record(z.string().min(1).max(100), z.object({ usage_record_id: usageName, amount_aic: z.number().int().nonnegative().safe() }).strict()) }).strict(),
]);
export type SettlementOutcome = z.infer<typeof SettlementOutcome>;
export const CAP_USAGE_RECORD = 'charged_at_cap';
const NAME_LIMIT = 256;
/** A charge ID is itself a ledger name, so it must fit the name limit whatever the
 * admission is called. An admission ID too long to be spelled out is named by its
 * SHA-256 instead; either form is fixed by the same four facts. */
export const chargeId = (admissionId: string, run: { run_id: number; run_attempt: number }, component: string) => {
  const spelled = `charge:${admissionId}:${run.run_id}:${run.run_attempt}:${component}`;
  return spelled.length <= NAME_LIMIT ? spelled :
    `charge:sha256.${createHash('sha256').update(admissionId).digest('hex')}:${run.run_id}:${run.run_attempt}:${component}`;
};
/** What an authority approves for a settlement: the admission and its stated
 * outcome. It names no run, so it can be approved before the settling run exists. */
export const settlementSubject = (raw: unknown) => ({ purpose: 'terminal_settlement', ...SettlementOutcome.parse(raw) });
/** What a settlement writes on the episode whose running generation it finishes. */
export const settledEpisodeText = (outcome: SettlementOutcome['outcome']) => ({ last_outcome: 'generation_settled',
  reason_code: outcome === 'settled' ? 'settled_at_reported_usage' : 'charged_at_cap', next_action: 'Judge the finished generation before any repair.' });
/** Terminal settlement of one consumed admission, as a pure change to a draft.
 * The reservation stops being held and becomes charges on the same accounts;
 * every lock the admission holds is released; the episode's reserved amount
 * moves to settled. The one-use claim stays, so the admission can never start
 * another run. Only a `receipt` transaction may commit the result, and the
 * store first checks that the run which consumed the admission has completed. */
export function applyTerminalSettlement(draft: AuthorityPayload, raw: unknown, now: string): { charged_aic: number; returned_aic: number } {
  const input = SettlementOutcome.parse(raw), id = input.admission_id;
  const admission = draft.admissions[id], reservation = draft.ledger.reservations[id], claim = draft.claims[id];
  const refuse = (fact: unknown, code: string) => { if (!fact) throw new StateRefusal(code); };
  refuse(!admission || !isTerminal(admission.status), 'admission_already_settled');
  refuse(admission && reservation && claim && admission.status === 'consumed' && reservation.status === 'consumed', 'admission_not_consumed');
  // An effect whose outcome is unknown stays held until it is reconciled.
  // The same holds for an exposure whose size is unknown: only a held one is cleared.
  refuse(reservation!.effect_knowledge === 'known' && draft.exposure[id]?.status === 'held', 'settlement_effect_unknown');
  const episode = draft.episodes[admission!.episode_id];
  refuse(episode, 'admission_context_changed');
  const billable = Object.entries(admission!.components).filter(([, cap]) => cap > 0).map(([component]) => component).sort();
  const usage = input.outcome === 'settled' ? input.usage : null;
  if (usage) refuse(brokerDigest(Object.keys(usage).sort()) === brokerDigest(billable) &&
    billable.every(component => usage[component]!.amount_aic <= admission!.components[component]!), 'settlement_usage_outside_envelope');
  let charged = 0;
  for (const component of billable) {
    const charge_id = chargeId(id, claim!.producer, component), amount_aic = usage ? usage[component]!.amount_aic : admission!.components[component]!;
    refuse(!draft.ledger.charges[charge_id], 'charge_already_recorded');
    draft.ledger.charges[charge_id] = { charge_id, admission_id: id, account_ids: [...reservation!.account_ids], producer: claim!.producer,
      component, usage_record_id: usage ? usage[component]!.usage_record_id : CAP_USAGE_RECORD, amount_aic, charged_at: now };
    charged += amount_aic;
  }
  const envelope = envelopeAic(admission!.components), prior = structuredClone(episode!);
  refuse(episode!.reserved_aic >= envelope, 'episode_ledger_mismatch');
  episode!.revision++; episode!.parent_digest = brokerDigest(prior);
  episode!.reserved_aic -= envelope; episode!.settled_aic += charged;
  // The finished generation now waits for its verdict. A stopped or otherwise
  // moved episode keeps its own status: settlement never restarts anything.
  if (episode!.status === 'running' && episode!.current_generation_id === admission!.generation_id) {
    episode!.status = 'validating'; Object.assign(episode!, settledEpisodeText(input.outcome));
  }
  admission!.status = input.outcome; reservation!.status = input.outcome;
  for (const [key, holder] of Object.entries(draft.locks)) if (holder === id) delete draft.locks[key];
  draft.exposure[id] = { ...(draft.exposure[id] ?? { admission_id: id, aic: envelope }), status: 'cleared' };
  return { charged_aic: charged, returned_aic: envelope - charged };
}

const SETTLED_EPISODE_FIELDS = ['revision', 'parent_digest', 'reserved_aic', 'settled_aic', 'status', 'last_outcome', 'reason_code', 'next_action'] as const;
/** The admissions a `receipt` transaction settles. Everything a receipt may
 * change in budget, admission, claim, lock, exposure and episode state must be
 * exactly such a settlement; anything else is refused. A receipt that settles
 * nothing therefore leaves all of that state untouched. */
export function terminalSettlements(before: AuthorityPayload, after: AuthorityPayload): string[] {
  const same = (a: unknown, b: unknown) => brokerDigest(a ?? null) === brokerDigest(b ?? null);
  const refuse = (fact: unknown, code = 'control_transaction_changes_authority') => { if (!fact) throw new StateRefusal(code); };
  const keys = (record: Record<string, unknown>) => Object.keys(record).sort();
  const ids = keys(after.admissions).filter(id => before.admissions[id]?.status === 'consumed' && isTerminal(after.admissions[id]!.status));
  const settling = new Set(ids);
  const { reservations: _r, charges: _c, ...ledger } = before.ledger, { reservations: _nr, charges: _nc, ...nextLedger } = after.ledger;
  refuse(same(ledger, nextLedger) && same(before.claims, after.claims) && same(keys(before.admissions), keys(after.admissions)) &&
    same(keys(before.ledger.reservations), keys(after.ledger.reservations)) && same(keys(before.exposure), keys(after.exposure)));
  for (const id of keys(before.admissions)) {
    const status = settling.has(id) ? after.admissions[id]!.status : before.admissions[id]!.status;
    refuse(same({ ...before.admissions[id]!, status }, after.admissions[id]));
  }
  for (const id of keys(before.ledger.reservations)) {
    const reservation = before.ledger.reservations[id]!, status = settling.has(id) ? after.admissions[id]!.status : reservation.status;
    refuse(same({ ...reservation, status }, after.ledger.reservations[id]) && (!settling.has(id) || (reservation.status === 'consumed' && reservation.effect_knowledge === 'known')));
  }
  refuse(same(Object.fromEntries(Object.entries(before.locks).filter(([, holder]) => !settling.has(holder))), after.locks));
  for (const id of keys(before.exposure)) refuse(same(settling.has(id) ? { ...before.exposure[id]!, status: 'cleared' } : before.exposure[id], after.exposure[id]));
  for (const id of ids) refuse(before.exposure[id]?.status === 'held' && after.exposure[id]?.status === 'cleared');
  for (const [id, charge] of Object.entries(before.ledger.charges)) refuse(same(charge, after.ledger.charges[id]));
  const charged = new Map<string, number>(), episodes = new Map<string, { envelope: number; charged: number; outcomes: Record<string, string> }>();
  for (const [key, charge] of Object.entries(after.ledger.charges)) {
    if (before.ledger.charges[key]) continue;
    const admission = settling.has(charge.admission_id) ? after.admissions[charge.admission_id]! : null, claim = before.claims[charge.admission_id];
    const cap = admission?.components[charge.component] ?? 0;
    refuse(admission && claim && cap > 0 && key === chargeId(charge.admission_id, claim.producer, charge.component) && charge.charge_id === key &&
      same(charge.producer, claim.producer) && same(charge.account_ids, before.ledger.reservations[charge.admission_id]!.account_ids) &&
      charge.amount_aic <= cap && (admission.status !== 'charged_at_cap' || (charge.amount_aic === cap && charge.usage_record_id === CAP_USAGE_RECORD)));
    charged.set(key, charge.amount_aic);
  }
  for (const id of ids) {
    const admission = after.admissions[id]!, claim = before.claims[id];
    refuse(claim);
    let total = 0;
    // Every billable component is accounted for exactly once.
    for (const [component, cap] of Object.entries(admission.components)) if (cap > 0) {
      const amount = charged.get(chargeId(id, claim!.producer, component));
      refuse(amount !== undefined); total += amount!;
    }
    const entry = episodes.get(admission.episode_id) ?? { envelope: 0, charged: 0, outcomes: {} };
    entry.envelope += envelopeAic(admission.components); entry.charged += total; entry.outcomes[admission.generation_id] = admission.status;
    episodes.set(admission.episode_id, entry);
  }
  refuse(same(keys(before.episodes), keys(after.episodes)), 'receipt_changes_episode');
  for (const id of keys(before.episodes)) {
    const prior = before.episodes[id]!, next = after.episodes[id]!, entry = episodes.get(id);
    if (!entry) { refuse(same(prior, next), 'receipt_changes_episode'); continue; }
    const rest = (episode: typeof prior) => Object.fromEntries(Object.entries(episode).filter(([field]) => !(SETTLED_EPISODE_FIELDS as readonly string[]).includes(field)));
    // The finished running generation's own outcome fixes every word the episode now carries.
    const outcome = prior.status === 'running' ? entry.outcomes[prior.current_generation_id ?? ''] : undefined;
    const text = outcome ? { status: 'validating', ...settledEpisodeText(outcome as SettlementOutcome['outcome']) } : prior;
    refuse(same(rest(prior), rest(next)) && next.reserved_aic === prior.reserved_aic - entry.envelope && next.settled_aic === prior.settled_aic + entry.charged &&
      next.status === text.status && next.reason_code === text.reason_code && next.last_outcome === text.last_outcome &&
      next.next_action === text.next_action, 'receipt_changes_episode');
  }
  return ids;
}

/** A receipt that settles must be the settlement its authority approved. The
 * admission, the outcome and every usage record and amount are restated from the
 * change itself and must digest to the transaction's own subject. Without this,
 * any approved subject of the same authorization could carry any settlement.
 * One subject names one admission, so a receipt settles at most one. */
export function requireSettlementSubject(before: AuthorityPayload, after: AuthorityPayload, subjectSha256: string) {
  const ids = terminalSettlements(before, after);
  if (!ids.length) return;
  const id = ids[0]!, admission = after.admissions[id]!, producer = before.claims[id]!.producer;
  const usage = Object.fromEntries(Object.entries(admission.components).filter(([, cap]) => cap > 0).map(([component]) => {
    const charge = after.ledger.charges[chargeId(id, producer, component)]!;
    return [component, { usage_record_id: charge.usage_record_id, amount_aic: charge.amount_aic }];
  }));
  const written = admission.status === 'settled' ? { admission_id: id, outcome: 'settled', usage } : { admission_id: id, outcome: 'charged_at_cap' };
  if (ids.length !== 1 || brokerDigest(settlementSubject(written)) !== subjectSha256) throw new StateRefusal('settlement_subject_mismatch');
}

const WIDEST = { run: Number.MAX_SAFE_INTEGER, usage_record_id: 'x'.repeat(NAME_LIMIT), instant: '0000-00-00T00:00:00.000000000Z',
  // GitHub file names are at most 255 bytes; the executor's workflow is not known before it consumes.
  workflow_path: `.github/workflows/${'x'.repeat(255)}` };
/** Bytes besides its charges that one settlement can add: longer statuses on the admission,
 * reservation and exposure, and the episode's amounts, lineage digest and settled text. */
const SETTLEMENT_FIELD_BYTES = 256;
/** State bytes that must stay free so that every admission still holding a lock can
 * be settled: one widest-case charge record per billable component, each with its
 * own copy of the producer and account IDs. A consumed admission is measured with
 * its claim's run; a reserved one with the widest run and workflow it could be
 * consumed by, and the consume itself is refused if the exact figure does not fit.
 * Kept free by every transaction that is not a stop or a receipt, on top of the
 * fixed receipt reserve, which still covers the settling operation's own record. */
export function settlementReserveBytes(payload: AuthorityPayload): number {
  let bytes = 0;
  for (const [id, admission] of Object.entries(payload.admissions)) {
    if (!['reserved', 'consumed'].includes(admission.status)) continue;
    const producer = payload.claims[id]?.producer ?? { ...admission.producer, run_id: WIDEST.run, run_attempt: WIDEST.run, workflow_path: WIDEST.workflow_path };
    const account_ids = payload.ledger.reservations[id]?.account_ids ?? [];
    for (const [component, cap] of Object.entries(admission.components)) if (cap > 0) {
      const charge_id = chargeId(id, producer, component);
      bytes += Buffer.byteLength(JSON.stringify({ [charge_id]: { charge_id, admission_id: id, account_ids, producer, component,
        usage_record_id: WIDEST.usage_record_id, amount_aic: cap, charged_at: WIDEST.instant } }));
    }
    bytes += SETTLEMENT_FIELD_BYTES;
  }
  return bytes;
}

/** Normal transactions cannot erase charges, claims or active liabilities.
 * A consumed admission leaves that state only by terminal settlement inside a
 * `receipt` transaction. Authenticated restore, compaction, policy changes and
 * release of a never-consumed reservation are separate future capabilities;
 * this store does not silently implement those paths.
 *
 * `transactedAt` is the transaction's own time: `now` while it is being written,
 * the recorded operation time when history is reloaded. A settlement charge must
 * carry exactly that time, so it cannot be dated out of the rolling day it was spent in. */
export function validateStateTransition(before: AuthorityPayload, after: AuthorityPayload, now: string, kind: TransactionIntent['kind'] = 'record', transactedAt: string = now) {
  validateLedger(after.ledger, now);
  const settling = new Set(kind === 'receipt' ? terminalSettlements(before, after) : []);
  if (settling.size) for (const [id, charge] of Object.entries(after.ledger.charges)) {
    if (!before.ledger.charges[id] && charge.charged_at !== transactedAt) throw new StateRefusal('settlement_charge_time_invalid');
  }
  for (const field of ['bootstrapped_by', 'bootstrapped_at', 'retention_expires_at'] as const) {
    if (before.ledger[field] !== after.ledger[field]) throw new StateRefusal('ledger_identity_changed');
  }
  for (const [id, account] of Object.entries(before.ledger.accounts)) {
    if (brokerDigest(account) !== brokerDigest(after.ledger.accounts[id] ?? null)) throw new StateRefusal('budget_policy_changed');
  }
  for (const [id, charge] of Object.entries(before.ledger.charges)) {
    if (brokerDigest(charge) !== brokerDigest(after.ledger.charges[id] ?? null)) throw new StateRefusal('charge_history_changed');
  }
  for (const [id, r] of Object.entries(before.ledger.reservations)) {
    const next = after.ledger.reservations[id];
    const { status: _status, effect_knowledge: _knowledge, ...identity } = r;
    const { status: _nextStatus, effect_knowledge: _nextKnowledge, ...nextIdentity } = next ?? r;
    if (!next || brokerDigest(identity) !== brokerDigest(nextIdentity)) {
      throw new StateRefusal('reservation_identity_changed');
    }
    if (next.status !== r.status && !(r.status === 'reserved' && next.status === 'consumed') && !settling.has(id)) throw new StateRefusal('reservation_release_not_authorized');
    if (r.effect_knowledge === 'unknown' && next.effect_knowledge !== 'unknown') throw new StateRefusal('unknown_liability_erased');
  }
  for (const [id, claim] of Object.entries(before.claims)) {
    if (brokerDigest(claim) !== brokerDigest(after.claims[id] ?? null)) throw new StateRefusal('claim_history_changed');
  }
  for (const [id, exposure] of Object.entries(before.exposure)) {
    if (exposure.status !== 'cleared' && (!after.exposure[id] || after.exposure[id]!.aic < exposure.aic || (after.exposure[id]!.status === 'cleared' && !settling.has(id)))) throw new StateRefusal('exposure_erased');
  }
  for (const [key, admission] of Object.entries(before.locks)) {
    if (['reserved', 'consumed'].includes(before.admissions[admission]?.status ?? '') && after.locks[key] !== admission && !settling.has(admission)) throw new StateRefusal('active_lock_erased');
  }
  for (const [id, effect] of Object.entries(before.outbox)) {
    const next = after.outbox[id];
    if (['pending', 'unknown', 'accepted'].includes(effect.status) && (!next || next.intent_digest !== effect.intent_digest || next.admission_id !== effect.admission_id)) throw new StateRefusal('outbox_intent_erased');
  }
  for (const [id, request] of Object.entries(before.requests)) {
    if (['accepted', 'unknown'].includes(request.status) && !after.requests[id]) throw new StateRefusal('request_receipt_erased');
    // A recorded intake receipt keeps its authenticated source and decision; only an
    // accepted request may later read consumed.
    const next = after.requests[id];
    if (!request.source || !next) { if (request.source) throw new StateRefusal('request_receipt_erased'); continue; }
    const { status: _status, ...identity } = request; const { status: _nextStatus, ...nextIdentity } = next;
    if (brokerDigest(identity) !== brokerDigest(nextIdentity) ||
        (next.status !== request.status && !(request.status === 'accepted' && next.status === 'consumed'))) throw new StateRefusal('request_receipt_changed');
  }
  const cursor = before.request_cursor, nextCursor = after.request_cursor;
  if (cursor && (!nextCursor || nextCursor.workflow_path !== cursor.workflow_path || nextCursor.not_before !== cursor.not_before || Date.parse(nextCursor.created_at) < Date.parse(cursor.created_at) ||
      (Date.parse(nextCursor.created_at) === Date.parse(cursor.created_at) && nextCursor.run_id < cursor.run_id))) throw new StateRefusal('request_cursor_rollback');
  for (const [id, admission] of Object.entries(before.admissions)) {
    const next = after.admissions[id];
    const { status: _status, ...authority } = admission;
    const { status: _nextStatus, ...nextAuthority } = next ?? admission;
    if (!next || brokerDigest(authority) !== brokerDigest(nextAuthority)) throw new StateRefusal('admission_authority_changed');
    if (next.status !== admission.status && !(admission.status === 'reserved' && next.status === 'consumed') && !settling.has(id)) throw new StateRefusal('admission_release_not_authorized');
  }
  for (const [id, episode] of Object.entries(before.episodes)) {
    const next = after.episodes[id];
    if (!next || next.generation_count < episode.generation_count || next.settled_aic < episode.settled_aic || next.revision < episode.revision) throw new StateRefusal('episode_history_changed');
    if (brokerDigest(next) === brokerDigest(episode)) continue;
    if (next.revision !== episode.revision + 1 || next.parent_digest !== brokerDigest(episode)) throw new StateRefusal('episode_lineage_invalid');
    if (brokerDigest(episodeIdentity(next)) !== brokerDigest(episodeIdentity(episode))) throw new StateRefusal('episode_identity_changed');
  }
}
/** data-model.md EpisodeCheckpoint "Identity" fields; lineage/state fields may change with a revision. */
const EPISODE_IDENTITY = ['schema_version', 'episode_id', 'repository_id', 'workload', 'kind', 'work_item', 'step_id',
  'plan_ref', 'plan_sha', 'request_actor', 'automation_principal'] as const;
const episodeIdentity = (episode: AuthorityPayload['episodes'][string]) => EPISODE_IDENTITY.map(k => episode[k] ?? null);
