import { createPublicKey, sign, verify, type KeyObject } from 'node:crypto';
import { z } from 'zod';
import { AuthorityRecord, AuthorityRepository } from '../../schemas/agent-loop-authority';
import { GitSha } from '../../schemas/agent-loop';
import { ProducerBinding, TransactionIntent } from '../../schemas/agent-loop-state';
import { brokerDigest } from '../control-plane/broker';
import { GitDocument, sameJson } from './git-document';
import { TransactionReceiptSchema } from './journal';
import { StateRefusal } from './ledger';

const digest = z.string().regex(/^[a-f0-9]{64}$/), positive = z.number().int().positive().safe();
// Derived ids prefix a full 256-character operation id ('authority:' is longest).
const eventId = z.string().min(1).max(256 + 'authority:'.length).regex(/^[A-Za-z0-9:._/-]+$/);
/** Never the token: only who it was minted for, its exact scope and its expiry. */
export const TokenMint = z.object({ role: z.enum(['state_writer', 'audit_writer', 'safety_reader', 'governed_reader', 'trial_proposer']),
  app_id: positive, installation_id: positive, repository: AuthorityRepository,
  permissions: z.record(z.string().regex(/^[a-z_]{1,64}$/), z.enum(['read', 'write'])), expires_at: z.string().datetime(),
  broker_run: ProducerBinding }).strict();
// W0 loop facts. Digests, ids and enums only: no agent text, log line or URL can enter the chain.
const name = z.string().min(1).max(256).regex(/^[A-Za-z0-9][A-Za-z0-9:._/-]*$/), count = z.number().int().nonnegative().safe();
/** Which generation of which episode a fact belongs to, the admission that paid for it and the run that observed it. */
const Arc = z.object({ episode_id: name, generation: positive, admission_operation_id: name, governed_repository_id: positive,
  producer: ProducerBinding }).strict();
const Actor = z.object({ id: positive, login: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9-]{0,98}(?:\[bot\])?$/), type: z.enum(['User', 'Bot']) }).strict();
const loopFact = { schema_version: z.literal(1), event_id: eventId, arc: Arc };
/** Fields that, with the episode, generation and observing run attempt, make a fact's slot. */
const SLOT: Record<string, readonly string[]> = { candidate: [], gate_result: ['candidate_sha256', 'gate_sha256'],
  detector_verdict: ['candidate_sha256', 'detector_sha256'], proposal_pr: ['pull_number'], merge: ['pull_number', 'merge_sha'],
  merged_verification: ['merge_sha'], usage: ['admission_id', 'component', 'state'] };
/** The only event id a loop fact may carry. Derived from its slot, not its content, so one run attempt
 * can archive one answer per slot: a replay is idempotent and a changed answer is refused. Never throws. */
export function w0EventId(raw: unknown): string {
  const r = (raw ?? {}) as Record<string, unknown>, arc = (r.arc ?? {}) as Record<string, unknown>, by = (arc.producer ?? {}) as Record<string, unknown>;
  const kind = typeof r.kind === 'string' && Object.hasOwn(SLOT, r.kind) ? r.kind : 'unknown';
  const text = (v: unknown) => typeof v === 'string' || typeof v === 'number' ? String(v).slice(0, 256) : null;
  return `${kind}:${brokerDigest([kind, arc.episode_id, arc.generation, by.repository_id, by.run_id, by.run_attempt, ...(SLOT[kind] ?? []).map(k => r[k])].map(text))}`;
}
const AuditEvent = z.discriminatedUnion('kind', [
  // One candidate per generation. A later generation names the typed feedback it was given.
  z.object({ ...loopFact, kind: z.literal('candidate'), candidate_sha256: digest, input_feedback_sha256: digest.nullable() }).strict(),
  // A failed gate carries the fingerprint of its typed feedback; a pass carries none.
  z.object({ ...loopFact, kind: z.literal('gate_result'), candidate_sha256: digest, gate_sha256: digest,
    result: z.enum(['pass', 'fail']), feedback_sha256: digest.nullable() }).strict(),
  z.object({ ...loopFact, kind: z.literal('detector_verdict'), candidate_sha256: digest, detector_sha256: digest,
    verdict: z.enum(['clean', 'flagged', 'unavailable']) }).strict(),
  z.object({ ...loopFact, kind: z.literal('proposal_pr'), candidate_sha256: digest, pull_number: positive, head_sha: GitSha, author: Actor }).strict(),
  // Who GitHub says merged it (supporting metadata, never proof of approval). Null = GitHub named nobody; the walk reports that.
  z.object({ ...loopFact, kind: z.literal('merge'), pull_number: positive, head_sha: GitSha, merge_sha: GitSha,
    method: z.enum(['automatic', 'manual']), merged_by: Actor.nullable() }).strict(),
  z.object({ ...loopFact, kind: z.literal('merged_verification'), merge_sha: GitSha, verification_sha256: digest,
    result: z.enum(['pass', 'fail', 'unknown']) }).strict(),
  // Cost per component: what was held, what settled, or that settlement is unknown. Unknown is never zero.
  z.object({ ...loopFact, kind: z.literal('usage'), admission_id: name, component: z.enum(['generator', 'detector', 'critic', 'probe', 'evaluator', 'proposer']),
    state: z.enum(['held', 'settled', 'unknown']), held_aic: count, settled_aic: count.nullable() }).strict(),
  z.object({ schema_version: z.literal(1), kind: z.literal('authority_intent'), event_id: eventId,
    authority: AuthorityRecord, intent: TransactionIntent }).strict(),
  z.object({ schema_version: z.literal(1), kind: z.literal('transaction_receipt'), event_id: eventId,
    receipt: TransactionReceiptSchema, outcome: z.literal('committed') }).strict(),
  // V82: every broker-minted installation token is recorded before its first other use.
  z.object({ schema_version: z.literal(1), kind: z.literal('token_mint'), event_id: eventId, mint: TokenMint }).strict(),
]).superRefine((r, ctx) => {
  if (!('arc' in r)) return;
  const coherent = r.event_id === w0EventId(r) &&
    (r.kind !== 'candidate' || (r.arc.generation === 1) === (r.input_feedback_sha256 === null)) &&
    (r.kind !== 'gate_result' || (r.result === 'fail') === (r.feedback_sha256 !== null)) &&
    (r.kind !== 'usage' || (r.state === 'settled') === (r.settled_aic !== null));
  if (!coherent) ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'audit_event_incoherent' });
});
type AuditRecord = z.infer<typeof AuditEvent>;
type Of<K extends AuditRecord['kind']> = Extract<AuditRecord, { kind: K }>;
const Signed = z.object({ repository_id: positive, sequence: positive, previous_sha256: digest.nullable(), record_sha256: digest, key_id: eventId,
  record: AuditEvent, sha256: digest, signature: z.string().max(256) }).strict();
const Chain = z.object({ schema_version: z.literal(1), purpose: z.literal('audit_chain'), repository_id: positive,
  records: z.array(Signed).max(1000) }).strict();
const Anchor = z.object({ sequence: z.number().int().nonnegative().safe(), sha256: digest.nullable() }).strict()
  .refine(a => (a.sequence === 0) === (a.sha256 === null));
export interface AuditAnchorReader { read(): Promise<{ sequence: number; sha256: string | null }> }
export const emptyAuditChain = (repository_id: number) => Chain.parse({ schema_version: 1, purpose: 'audit_chain', repository_id, records: [] });
const fact: (value: unknown, code: string) => asserts value = (value, code) => { if (!value) throw new StateRefusal(code); };
type Options = { governed_repository_id: number; state_repository_id: number; control_repository_id?: number; key_id: string; private_key?: KeyObject;
  public_keys: Record<string, KeyObject>; anchor: AuditAnchorReader };

/** One FR-050 collector, bounded signed Git chain. Caller supplies pinned public
 * trust roots and independently custodied acknowledgement; no generated trust.
 * Only strict sanitized record types are accepted, never arbitrary agent text. */
export class GitAuditLog {
  readonly repository_id: number;
  constructor(private document: GitDocument, private options: Options) {
    const id = document.config.repository.id;
    this.repository_id = id;
    fact(document.config.path === 'audit/chain.json' && id !== options.governed_repository_id && id !== options.state_repository_id, 'audit_repository_not_isolated');
    fact(options.anchor && typeof options.anchor.read === 'function' && options.public_keys[options.key_id] &&
      Object.values(options.public_keys).every(k => k.type === 'public' && k.asymmetricKeyType === 'ed25519'), 'audit_trust_missing');
    if (options.private_key) fact(options.private_key.type === 'private' && options.private_key.asymmetricKeyType === 'ed25519' &&
      createPublicKey(options.private_key).export({ type: 'spki', format: 'der' }).equals(options.public_keys[options.key_id]!.export({ type: 'spki', format: 'der' })), 'audit_signer_mismatch');
  }
  /** Every entry names this customer's configured audit, governed and state repositories. */
  private bound(record: AuditRecord, auditRepositoryId: number) {
    // A loop fact is about this customer's governed repository, observed by a run of it or of its control repository.
    if ('arc' in record) return record.arc.governed_repository_id === this.options.governed_repository_id &&
      [this.options.governed_repository_id, this.options.control_repository_id].includes(record.arc.producer.repository_id);
    if (record.kind === 'transaction_receipt') return record.receipt.state_repository_id === this.options.state_repository_id;
    // A mint is for one of this customer's own repositories, by a run of its control repository.
    if (record.kind === 'token_mint') return this.options.control_repository_id !== undefined &&
      record.mint.broker_run.repository_id === this.options.control_repository_id &&
      [auditRepositoryId, this.options.state_repository_id, this.options.governed_repository_id, this.options.control_repository_id].includes(record.mint.repository.id);
    const p = record.authority.proposal;
    return p.audit_repository.id === auditRepositoryId && p.governed_repository.id === this.options.governed_repository_id &&
      p.state_repository.id === this.options.state_repository_id && record.intent.producer.repository_id === this.options.governed_repository_id;
  }
  private async validate(raw: unknown) {
    const chain = Chain.parse(raw), anchor = Anchor.parse(await this.options.anchor.read());
    fact(chain.repository_id === this.document.config.repository.id, 'audit_repository_mismatch');
    let previous: string | null = null;
    const seen = new Set<string>();
    for (const [index, entry] of chain.records.entries()) {
      const { sha256: hash, signature, ...signed } = entry;
      fact(entry.repository_id === chain.repository_id && !seen.has(entry.record.event_id) && entry.sequence === index + 1 && entry.previous_sha256 === previous && entry.record_sha256 === brokerDigest(entry.record) &&
        hash === brokerDigest(signed), 'audit_chain_invalid');
      seen.add(entry.record.event_id);
      fact(this.bound(entry.record, chain.repository_id), 'audit_customer_binding_invalid');
      const key = this.options.public_keys[entry.key_id];
      fact(key?.asymmetricKeyType === 'ed25519' && verify(null, Buffer.from(hash, 'hex'), key, Buffer.from(signature, 'base64')), 'audit_signature_invalid');
      previous = hash;
    }
    fact(chain.records.length >= anchor.sequence && (anchor.sequence === 0 || chain.records[anchor.sequence - 1]?.sha256 === anchor.sha256), 'audit_acknowledgement_mismatch');
    return chain;
  }
  async read() { return (await this.validate((await this.document.read()).value)).records; }
  async append(raw: unknown) {
    fact(this.options.private_key?.asymmetricKeyType === 'ed25519', 'audit_read_only');
    const record = AuditEvent.parse(raw), recordDigest = brokerDigest(record);
    // Independent anchor is read before each conditional update and readback.
    const snapshot = await this.document.read(); await this.validate(snapshot.value);
    const receipt = await this.document.update(rawChain => {
      const chain = Chain.parse(rawChain);
      // Full signature/anchor validation immediately above; concurrent writers
      // may only append. A changed prefix or an unvalidated retry must hold.
      const prior = Chain.parse(snapshot.value);
      // An event that is already archived writes nothing, so another writer's
      // later append cannot invalidate it; the full chain is validated on readback.
      const existing = chain.records.find(e => e.record.event_id === record.event_id);
      if (existing) { fact(existing.record_sha256 === recordDigest, 'audit_event_identity_changed'); return chain; }
      fact(sameJson(chain, prior), 'audit_concurrent_change');
      fact(this.bound(record, chain.repository_id), 'audit_customer_binding_invalid');
      const signed = { repository_id: chain.repository_id, sequence: chain.records.length + 1, previous_sha256: chain.records.at(-1)?.sha256 ?? null,
        record_sha256: recordDigest, key_id: this.options.key_id, record };
      const hash = brokerDigest(signed), signature = sign(null, Buffer.from(hash, 'hex'), this.options.private_key!).toString('base64');
      chain.records.push({ ...signed, sha256: hash, signature }); return Chain.parse(chain);
    });
    const chain = await this.validate(receipt.value), entry = chain.records.find(e => e.record.event_id === record.event_id);
    fact(entry?.record_sha256 === recordDigest, 'audit_readback_invalid');
    return { repository_id: this.document.config.repository.id, path: this.document.config.path,
      commit_sha: receipt.commit_sha, sha256: recordDigest, sequence: entry.sequence };
  }
}

/** Use with a separate verifier credential/principal. Writer never advances
 * this anchor; only independently verified prefix acknowledgements may do so. */
export class GitAuditAnchor implements AuditAnchorReader {
  constructor(private document: GitDocument, auditWriterId: number) {
    fact(document.config.path === 'audit/acknowledged.json' && document.config.writer_id !== auditWriterId, 'audit_anchor_custody_not_independent');
  }
  async read() { return Anchor.parse((await this.document.read()).value); }
  async acknowledge(raw: unknown) {
    const next = Anchor.parse(raw);
    await this.document.update(value => {
      const old = Anchor.parse(value);
      fact(next.sequence >= old.sequence && (next.sequence !== old.sequence || next.sha256 === old.sha256), 'audit_anchor_rollback');
      return next;
    });
  }
}

/** FR-050 backward walk over an already validated chain (`GitAuditLog.read()`), from a merged commit to the
 * authority that paid for each generation. Pure: it reads nothing else, so it still answers after the
 * runs, artifacts and pull request are gone. A link that was never archived, or whose only answer is "unknown" or
 * "unavailable", is named in `missing`; an archived refusal of the merged candidate or commit (failed gate, flagged
 * detector, failed verification) is named in `failed`; two archived answers that disagree are named in `conflicts`.
 * Every traversed generation, merged or not, needs its detector verdict, usage for each component its authority admits,
 * one admission and a generation number its authority allows. Absent evidence is `missing`, never agreement.
 * Only an unbroken, agreeing chain with no refusal is `complete`. */
export function auditBackwardWalk(entries: ReadonlyArray<{ record: AuditRecord }>, mergeSha: string) {
  const all = entries.map(e => e.record), of = <K extends AuditRecord['kind']>(kind: K) => all.filter((r): r is Of<K> => r.kind === kind);
  const missing: string[] = [], conflicts: string[] = [], failed: string[] = [];
  const differ = (values: unknown[]) => new Set(values.map(v => JSON.stringify(v))).size > 1;
  type Cost = { generation: number; component: Of<'usage'>['component']; state: Of<'usage'>['state']; held_aic: number; settled_aic: number | null };
  const generations: Array<{ generation: number; candidate: Of<'candidate'>; gate: Of<'gate_result'>[]; detector: Of<'detector_verdict'>[];
    authority: Of<'authority_intent'> | null; receipt: Of<'transaction_receipt'> | null; usage: Of<'usage'>[] }> = [], cost: Cost[] = [];
  const merges = of('merge').filter(r => r.merge_sha === mergeSha), merge = merges[0] ?? null;
  const result = (extra: { episode_id: string | null; verification: Of<'merged_verification'>[]; proposal: Of<'proposal_pr'> | null }) =>
    ({ complete: missing.length === 0 && conflicts.length === 0 && failed.length === 0, missing, conflicts, failed, merge, ...extra, generations, cost });
  if (!merge) { missing.push('merge'); return result({ episode_id: null, verification: [], proposal: null }); }
  if (differ(merges.map(m => [m.arc.episode_id, m.arc.generation, m.pull_number, m.head_sha, m.method, m.merged_by?.id ?? null]))) conflicts.push('merge');
  // A merge is a consequential act: who performed it is part of the chain, and "nobody named" is not an answer.
  if (!merge.merged_by) missing.push('merged_by');
  const episode = merge.arc.episode_id, mine = <K extends 'candidate' | 'gate_result' | 'detector_verdict' | 'proposal_pr' | 'merged_verification' | 'usage'>(kind: K) =>
    of(kind).filter(r => (r as { arc: z.infer<typeof Arc> }).arc.episode_id === episode);
  // A merge SHA is one commit whatever episode a record claims, so every verification of it is weighed.
  const verification = of('merged_verification').filter(r => r.merge_sha === mergeSha);
  if (!verification.length) missing.push('merged_verification');
  else if (differ(verification.map(v => [v.arc.episode_id, v.result, v.verification_sha256]))) conflicts.push('merged_verification');
  else if (verification[0]!.result === 'fail') failed.push('merged_verification');
  else if (verification[0]!.result !== 'pass') missing.push('merged_verification_pass');
  const proposals = mine('proposal_pr').filter(r => r.pull_number === merge.pull_number && r.head_sha === merge.head_sha), proposal = proposals[0] ?? null;
  if (!proposal) missing.push('proposal_pr');
  // The merge names its generation; a proposal for the same pull request and head in another generation disagrees with it.
  else if (differ(proposals.map(p => [p.arc.generation, p.candidate_sha256, p.author.id])) || proposal.arc.generation !== merge.arc.generation) conflicts.push('proposal_pr');
  const candidates = mine('candidate'), gates = mine('gate_result'), detectors = mine('detector_verdict'), usages = mine('usage');
  let wanted = proposal ? { sha256: proposal.candidate_sha256, generation: merge.arc.generation, merged: true, label: 'candidate' } : null;
  while (wanted) {
    const want = wanted, merged = want.merged;
    const candidate = candidates.find(c => c.candidate_sha256 === want.sha256 && c.arc.generation === want.generation);
    if (!candidate) { missing.push(want.label); break; }
    const generation = candidate.arc.generation, at = `generation-${generation}`, operation = candidate.arc.admission_operation_id;
    // One candidate per generation: a second, different one (another run attempt) is unaccounted for by this chain.
    if (differ(candidates.filter(c => c.arc.generation === generation).map(c => [c.candidate_sha256, c.input_feedback_sha256]))) conflicts.push(`candidate:${at}`);
    const gate = gates.filter(g => g.candidate_sha256 === candidate.candidate_sha256 && g.arc.generation === generation);
    const detector = detectors.filter(d => d.candidate_sha256 === candidate.candidate_sha256 && d.arc.generation === generation);
    // Only the merged candidate must have passed. Absent or "unavailable" is missing; an archived refusal is failed.
    // Two failures with different typed feedback disagree as much as a pass and a fail do.
    if (differ(gate.map(g => [g.result, g.feedback_sha256]))) conflicts.push(`gate_result:${at}`);
    else if (merged && gate[0]?.result === 'fail') failed.push(`gate_result:${at}`);
    else if (merged && gate[0]?.result !== 'pass') missing.push(`gate_pass:${at}`);
    if (differ(detector.map(d => d.verdict))) conflicts.push(`detector_verdict:${at}`);
    else if (merged && detector[0]?.verdict === 'flagged') failed.push(`detector_verdict:${at}`);
    else if (merged && detector[0]?.verdict !== 'clean') missing.push(`detector_clean:${at}`);
    // An earlier generation need not be clean, but its verdict must have been archived: no record is not a verdict.
    else if (!detector.length) missing.push(`detector_verdict:${at}`);
    const authorities = of('authority_intent').filter(r => r.intent.operation_id === operation), authority = authorities[0] ?? null;
    const receipts = of('transaction_receipt').filter(r => r.receipt.operation_id === operation), receipt = receipts[0] ?? null;
    if (!authority) missing.push(`authority_intent:${at}`);
    else if (differ(authorities.map(a => [a.authority.proposal_sha256, a.intent.subject_sha256]))) conflicts.push(`authority_intent:${at}`);
    // The archived authority bounds the run: a generation past its limit was not authorized by it.
    else if (generation > authority.authority.proposal.maximum_generations) conflicts.push(`authority_generation:${at}`);
    if (!receipt) missing.push(`transaction_receipt:${at}`);
    else if (differ(receipts.map(r => r.receipt))) conflicts.push(`transaction_receipt:${at}`);
    const usage = usages.filter(u => u.arc.generation === generation);
    // One admission pays for a generation; a fact of it archived under another admission is not covered by this authority.
    if (differ([candidate, ...gate, ...detector, ...usage, ...(merged ? [merge, ...proposals] : [])].map(r => r.arc.admission_operation_id))) conflicts.push(`admission:${at}`);
    // Every component the authority admits has a liability to account for; usage of one says nothing about another.
    const admitted = authority ? Object.entries(authority.authority.proposal.components).filter(([, aic]) => (aic ?? 0) > 0).map(([c]) => c).sort() : [];
    if (!usage.length) missing.push(`usage:${at}`);
    else for (const component of admitted) if (!usage.some(u => u.component === component)) missing.push(`usage:${at}:${component}`);
    for (const component of [...new Set(usage.map(u => u.component))].sort()) {
      const own = usage.filter(u => u.component === component), settled = own.filter(u => u.state === 'settled');
      const disagree = differ(settled.map(u => u.settled_aic)) || differ(own.map(u => [u.admission_id, u.held_aic]));
      if (disagree) conflicts.push(`usage:${at}:${component}`);
      cost.push({ generation, component, held_aic: Math.max(...own.map(u => u.held_aic)),
        state: disagree ? 'unknown' : settled.length ? 'settled' : own.some(u => u.state === 'unknown') ? 'unknown' : 'held',
        settled_aic: disagree ? null : settled[0]?.settled_aic ?? null });
    }
    generations.push({ generation, candidate, gate, detector, authority, receipt, usage });
    if (candidate.input_feedback_sha256 === null) break;
    // This generation was given typed feedback: find the failed gate that produced exactly that fingerprint.
    const before = generation - 1, fed = gates.find(g => g.arc.generation === before && g.result === 'fail' && g.feedback_sha256 === candidate.input_feedback_sha256);
    if (!fed) { missing.push(`gate_feedback:generation-${before}`); break; }
    wanted = { sha256: fed.candidate_sha256, generation: before, merged: false, label: `candidate:generation-${before}` };
  }
  return result({ episode_id: episode, verification, proposal });
}
