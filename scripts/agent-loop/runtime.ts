import type { Octokit } from '@octokit/rest';
import { TransactionIntent, type AuthorityPayload } from '../../schemas/agent-loop-state';
import { brokerDigest } from '../control-plane/broker';
import { createNativeAuthority, NativeAuthorityConfig, type NativeAuthorityClients } from './authority';
import { NativeAuthorityStore, type NativeStoreConfig, type StateTransactionResult } from './native-store';
import { reserveAdmission, consumeAdmission, settleAdmission, ReserveRequest, ConsumeRequest, SettleRequest } from './admission';
import { GitTransactionJournal } from './journal';
import { GitDocument } from './git-document';
import { GitAuditLog } from './audit';
import { envelopeAic, StateRefusal } from './ledger';

type Result = StateTransactionResult & { audit_outcome: 'acknowledged' | 'pending' | 'not_required' };
type Options = { gh: Octokit; authorityClients: NativeAuthorityClients; now(): string; store: NativeStoreConfig; authority: unknown; journal: GitDocument; audit: GitAuditLog };
/** Native adapters wired to the retained T127 store, with no key loader or
 * workflow activation. Deployment still requires protected custody/proof gates. */
export function createNativeTrialRuntime(options: Options) {
  const authority = NativeAuthorityConfig.parse(options.authority), p = authority.proposal;
  if (brokerDigest(options.store.state_repository) !== brokerDigest(p.state_repository) ||
      brokerDigest(options.store.governed_repository) !== brokerDigest(p.governed_repository) ||
      brokerDigest(options.store.writer) !== brokerDigest(p.writer) || options.journal.config.repository.id !== p.state_repository.id ||
      options.journal.config.writer_id !== p.writer.principal_id || options.audit.repository_id !== p.audit_repository.id) throw new StateRefusal('runtime_binding_invalid');
  // Episodes carry the short frozen tag name (plan/<slug>/v<N>), as observe/reducer do.
  const planTag = p.plan_ref.slice('refs/tags/'.length);
  // Every consent on the proposal PR shares one budget lineage: a retried or
  // superseding consent for the same proposal never restores spent allowance.
  const trialConsent = `https://github.com/${authority.binding.repository.full_name}/pull/${authority.binding.pull_number}#issuecomment-`;
  const journal = new GitTransactionJournal(options.journal);
  const store = new NativeAuthorityStore(options.store, { gh: options.gh, now: options.now, journal,
    authorize: createNativeAuthority(options.authorityClients, authority, { now: options.now, audit: options.audit }) });
  const scoped = { config: store.config, transact: (raw: unknown, compute: (draft: AuthorityPayload, now: string, revision: number) => void) =>
    store.transact(raw, (draft, now, revision) => {
      const before = structuredClone(draft); compute(draft, now, revision);
      for (const [id, admission] of Object.entries(draft.admissions)) {
        if (before.admissions[id] && (!before.requests[id] || !draft.requests[id] ||
            before.requests[id]!.source_ref !== draft.requests[id]!.source_ref)) throw new StateRefusal('trial_authority_binding_changed');
        if (brokerDigest(admission) === brokerDigest(before.admissions[id] ?? null)) continue;
        const episode = draft.episodes[admission.episode_id];
        if (!episode || episode.repository_id !== p.governed_repository.id || episode.workload !== p.workload ||
            episode.work_item !== p.work_item || episode.plan_sha !== p.plan_sha || episode.plan_ref !== planTag ||
            admission.plan_sha !== p.plan_sha || brokerDigest(admission.components) !== brokerDigest(p.components) ||
            Date.parse(admission.expires_at) > Date.parse(p.expires_at) ||
            draft.requests[id]?.source_ref !== TransactionIntent.parse(raw).authority_ref) throw new StateRefusal('admission_outside_trial');
      }
      // A settled admission still counts as one generation at its whole envelope:
      // settlement frees the lock and the ledger hold, never the authorization's own limits.
      const trialAdmissions = Object.values(draft.admissions).filter(a => draft.requests[a.admission_id]?.source_ref.startsWith(trialConsent));
      if (trialAdmissions.length > p.maximum_generations || trialAdmissions.reduce((n, a) => n + envelopeAic(a.components), 0) > p.total_cap_aic) throw new StateRefusal('trial_budget_exhausted');
    }) };
  async function copyReceipts() {
    for (const receipt of await journal.unarchivedReceipts()) {
      const record = { schema_version: 1, kind: 'transaction_receipt', event_id: `receipt:${receipt.operation_id}`, receipt, outcome: 'committed' };
      const copy = await options.audit.append(record);
      await journal.acknowledgeAudit(receipt.operation_id, copy, p.audit_repository.id);
    }
  }
  async function guarded(raw: unknown, request: { safeParse(raw: unknown): { success: boolean } }, run: () => Promise<StateTransactionResult>): Promise<Result> {
    const op = (raw as { operation_id?: unknown })?.operation_id;
    const nothing = { operation_id: typeof op === 'string' ? op : '<invalid>', api_requests: 0, git_write_attempts: 0, native_outcome: 'not_attempted' } as const;
    // A malformed request writes nothing and creates no liability to reconcile.
    if (!request.safeParse(raw).success) return { ...nothing, status: 'refused', code: 'transaction_request_invalid', audit_outcome: 'not_required' };
    let result: StateTransactionResult | undefined;
    try {
      // Never allow a later effect to outrun an accepted earlier receipt.
      await copyReceipts();
      result = await run(); await copyReceipts();
      // Acknowledged only once the journal holds this exact sealed receipt's audit copy.
      return { ...result, audit_outcome: !result.receipt ? 'not_required' : await journal.archived(result.receipt) ? 'acknowledged' : 'pending' };
    } catch {
      return { ...(result ?? nothing), status: 'unknown', code: 'transaction_audit_or_journal_pending', audit_outcome: 'pending' };
    }
  }
  return {
    /** Validated canonical read; grants nothing and writes nothing. */
    read: () => store.read(),
    transact: (intent: unknown, compute: (draft: AuthorityPayload, now: string, revision: number) => void) => guarded(intent, TransactionIntent, () => scoped.transact(intent, compute)),
    reserve: (request: unknown) => guarded(request, ReserveRequest, () => reserveAdmission(scoped, request)),
    consume: async (request: unknown) => {
      const result = await guarded(request, ConsumeRequest, async () => (await consumeAdmission(scoped, request)).result);
      return { allowed: result.status === 'won' && result.audit_outcome === 'acknowledged', result };
    },
    /** Settles a finished generation: frees its locks and stops holding its allowance. Starts nothing. */
    settle: (request: unknown) => guarded(request, SettleRequest, () => settleAdmission(scoped, request)),
  };
}
