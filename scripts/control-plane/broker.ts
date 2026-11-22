import { createHash } from 'node:crypto';
import { z } from 'zod';
import {
  APP_ROLES, AppInstallations, BrokerContext, BrokerReceipt, BrokerRequest, CustomerRegistry, GovernedReadPayload,
  INVALID_REQUEST_IDENTITY, RepositoryIdentity, RepositoryMetadata, TokenMintRecord, commitSha, sha256,
  type CustomerControlPlane,
} from '../../schemas/control-plane';

/** These adapters are trusted broker code, not request-supplied callbacks. There
 * is intentionally no default authority, journal, audit writer or key loader.
 * T124/T125/T127/T128 must supply and prove those native implementations before
 * this component can be wired into a credentialed workflow. */
export interface RequestBinding {
  customer_id: string; request_id: string; idempotency_key: string; request_digest: string;
}
export interface ReadTokenPlan {
  customer_id: string; request_id: string; request_digest: string; app_id: number; installation_id: number;
  repositories: Array<z.infer<typeof RepositoryIdentity>>; permissions: { metadata: 'read' };
}
export type BrokerAuditEntry = TokenMintRecord | {
  schema_version: 1; kind: 'request_intent'; binding: RequestBinding; source_sha: string; token_plan: ReadTokenPlan;
} | { schema_version: 1; kind: 'request_result'; receipt: BrokerReceipt };
export interface BrokerTransport {
  mint(plan: ReadTokenPlan): Promise<unknown>;
  read(token: string, repository: z.infer<typeof RepositoryIdentity>): Promise<unknown>;
  revoke(token: string): Promise<void>;
}
export interface BrokerPorts {
  now(): string;
  loadCustomers(): Promise<unknown>;
  refreshInstallations(customer: CustomerControlPlane): Promise<unknown>;
  authorize(binding: RequestBinding, customer: CustomerControlPlane, context: BrokerContext): Promise<unknown>;
  journal: {
    /** Atomic put-if-absent on customer + idempotency key. Never reclaim an
     * unresolved claim after a timeout. A changed digest is a conflict. */
    claim(binding: RequestBinding): Promise<{ result: 'claimed' } | {
      result: 'existing'; binding: RequestBinding; receipt: unknown | null;
    } | { result: 'unknown' }>;
    complete(binding: RequestBinding, receipt: BrokerReceipt): Promise<void>;
  };
  /** Return a verified durable readback, not merely a successful write call.
   * Signed custody and chain verification belong to T128/T160's sole writer. */
  audit(customer: CustomerControlPlane, entry: BrokerAuditEntry): Promise<unknown>;
  transport: BrokerTransport;
}

export function brokerDigest(value: unknown): string {
  const encoded = JSON.stringify(value);
  if (!encoded || Buffer.byteLength(encoded) > 65_536) throw new Error('broker_input_too_large');
  const canonical = (v: unknown): unknown => Array.isArray(v) ? v.map(canonical) : v !== null && typeof v === 'object' ?
    Object.fromEntries(Object.entries(v).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, item]) => [key, canonical(item)])) : v;
  return createHash('sha256').update(JSON.stringify(canonical(JSON.parse(encoded)))).digest('hex');
}

const sameRepository = (a: z.infer<typeof RepositoryIdentity>, b: z.infer<typeof RepositoryIdentity>) =>
  a.id === b.id && a.full_name.toLowerCase() === b.full_name.toLowerCase();
const containsRepository = (repos: z.infer<typeof RepositoryIdentity>[], repo: z.infer<typeof RepositoryIdentity>) => repos.some(r => sameRepository(r, repo));
const invalidBinding = { customer_id: INVALID_REQUEST_IDENTITY, request_id: INVALID_REQUEST_IDENTITY, request_digest: '0'.repeat(64) };
const receipt = (binding: Pick<RequestBinding, 'customer_id' | 'request_id' | 'request_digest'>, code: string,
  status: BrokerReceipt['status'] = 'refused'): BrokerReceipt => ({
  schema_version: 1, ...binding, status, code, token_mint: 'none', api_effect: 'none', token_cleanup: 'not_required',
});

type PlanResult = { result: 'refused'; code: string; receipt: BrokerReceipt } | {
  result: 'planned'; code: 'governed_read_planned'; customer: CustomerControlPlane; request: BrokerRequest;
  context: BrokerContext; binding: RequestBinding; tokenPlan: ReadTokenPlan;
};

/** Pure routing and scoping, never authority. Context is supplied by a trusted
 * native collector; do not derive it by copying fields out of the request. */
export function planBrokerRead(rawCustomers: unknown, rawRequest: unknown, rawPayload: unknown, rawContext: unknown): PlanResult {
  const parsed = BrokerRequest.safeParse(rawRequest);
  let binding = invalidBinding;
  const refuse = (code: string): PlanResult => ({ result: 'refused', code, receipt: receipt(binding, code) });
  if (!parsed.success) return refuse('request_invalid');
  const request = parsed.data;
  try { binding = { customer_id: request.customer_id, request_id: request.request_id, request_digest: brokerDigest(request) }; }
  catch { return refuse('request_invalid'); }
  const registry = CustomerRegistry.safeParse(rawCustomers);
  if (!registry.success) return refuse('customer_registry_invalid');
  const customer = registry.data.find(c => c.customer_id === request.customer_id);
  if (!customer) return refuse('customer_unknown');
  const context = BrokerContext.safeParse(rawContext);
  if (!context.success || !sameRepository(context.data.executor.repository, customer.broker_repo)) return refuse('broker_executor_invalid');
  if (context.data.request_digest !== binding.request_digest || brokerDigest(context.data.origin) !== brokerDigest(request.source) ||
      !containsRepository(customer.governed_repos, request.source.repo)) return refuse('request_source_mismatch');
  if (!containsRepository(customer.governed_repos, request.target_repo)) return refuse('target_outside_customer');
  if (customer.status !== 'enrolled') return refuse(customer.status === 'revoked' ? 'customer_revoked' : 'customer_not_enrolled');
  if (customer.release.result !== 'current') return refuse('release_not_current');
  if (!customer.runner_attestation_ref) return refuse('runner_attestation_missing');
  if (request.kind !== 'governed_read') return refuse('effect_not_implemented');
  const payload = GovernedReadPayload.safeParse(rawPayload);
  if (!payload.success) return refuse('payload_invalid');
  if (brokerDigest(payload.data) !== request.payload_digest) return refuse('payload_digest_mismatch');
  const installation = customer.app_installations.proposal_author;
  if (installation.installation_id === null) return refuse('app_installation_missing');
  return { result: 'planned', code: 'governed_read_planned', customer, request, context: context.data,
    binding: { ...binding, idempotency_key: request.idempotency_key }, tokenPlan: {
      ...binding, app_id: installation.app_id, installation_id: installation.installation_id,
      repositories: [request.target_repo], permissions: { metadata: 'read' },
    } };
}

const installations = z.object({ observed_at: z.string().datetime(), apps: AppInstallations }).strict();
const admission = z.object({ result: z.literal('allowed'), customer_id: z.string(), request_digest: sha256,
  source_sha: commitSha, expires_at: z.string().datetime() }).strict();
const mintedToken = z.object({
  token: z.string().min(1), expires_at: z.string().datetime(), repository_selection: z.enum(['selected', 'all']),
  repositories: z.array(RepositoryIdentity.strip()).min(1).max(500), permissions: z.record(z.string(), z.enum(['read', 'write', 'admin'])),
});
const auditReadback = z.object({ repository_id: z.number().int().positive(), record_digest: sha256, commit_sha: commitSha }).strict();
const MAX_TOKEN_LIFETIME_MS = 3_600_000;
// GitHub's clock/whole-second expiry can lead the runner. This margin applies
// only to the upper bound; an expired token or admission is never accepted.
const TOKEN_CLOCK_TOLERANCE_MS = 120_000;
type FailureCode = 'read_admission_expired' | 'token_response_invalid' | 'token_grant_mismatch' |
  'token_expired' | 'token_lifetime_exceeded' | 'repository_response_invalid' | 'repository_identity_changed' | 'audit_readback_mismatch' |
  'app_identity_changed' | 'installation_identity_changed';
/** Known outcomes from trusted broker code. The two native identity failures
 * are raised before POST /access_tokens, so their mint is provably unattempted. */
export class BrokerFailure extends Error {
  constructor(readonly code: FailureCode, readonly status: 'refused' | 'unknown' = 'refused') { super(code); }
  get mintNotAttempted() { return this.code === 'app_identity_changed' || this.code === 'installation_identity_changed'; }
}

function freshInstallations(raw: unknown, customer: CustomerControlPlane, now: string): string | null {
  const facts = installations.safeParse(raw);
  if (!facts.success || Date.parse(facts.data.observed_at) > Date.parse(now) || Date.parse(now) - Date.parse(facts.data.observed_at) > 60_000) {
    return 'app_installation_unknown';
  }
  for (const role of APP_ROLES) {
    const expected = customer.app_installations[role]; const observed = facts.data.apps[role];
    if (observed.result !== 'present') return `app_installation_${observed.result}`;
    if (expected.installation_id === null || observed.installation_id !== expected.installation_id || observed.app_id !== expected.app_id) return 'app_identity_changed';
    const required = role === 'control_plane_writer' ? [customer.control_repo.id, customer.state_repo.id, customer.audit_repo.id] : customer.governed_repos.map(r => r.id);
    if (required.some(id => !observed.repos.includes(id))) return 'installation_repository_removed';
  }
  return null;
}

/** First broker component: metadata GET only. No workflow calls this until the
 * native authority, fresh installation reads, CAS journal and independent audit
 * adapters have their own retained proofs. Mutation kinds are always refused. */
export async function runBrokerRequest(rawRequest: unknown, rawPayload: unknown, rawContext: unknown, ports: BrokerPorts): Promise<BrokerReceipt> {
  const time = () => Date.parse(z.string().datetime().parse(ports.now()));
  const input = BrokerRequest.safeParse(rawRequest);
  if (!input.success) return receipt(invalidBinding, 'request_invalid');
  let inputBinding;
  try { inputBinding = { customer_id: input.data.customer_id, request_id: input.data.request_id, request_digest: brokerDigest(input.data) }; }
  catch { return receipt(invalidBinding, 'request_invalid'); }
  let customers: unknown;
  try { customers = await ports.loadCustomers(); }
  catch { return receipt(inputBinding, 'customer_registry_unknown', 'unknown'); }
  const plan = planBrokerRead(customers, input.data, rawPayload, rawContext);
  if (plan.result === 'refused') return plan.receipt;
  const { customer, binding, tokenPlan } = plan;
  const base = { customer_id: binding.customer_id, request_id: binding.request_id, request_digest: binding.request_digest };
  let grant: z.infer<typeof admission>;
  try {
    const now = z.string().datetime().parse(ports.now());
    const reason = freshInstallations(await ports.refreshInstallations(customer), customer, now);
    if (reason) return receipt(base, reason);
    const parsed = admission.safeParse(await ports.authorize(binding, customer, plan.context));
    if (!parsed.success || parsed.data.customer_id !== binding.customer_id || parsed.data.request_digest !== binding.request_digest ||
        parsed.data.source_sha !== plan.context.executor.source_sha) {
      return receipt(base, 'read_admission_refused');
    }
    if (Date.parse(parsed.data.expires_at) <= time()) return receipt(base, 'read_admission_expired');
    grant = parsed.data;
  } catch { return receipt(base, 'read_admission_unknown'); }
  try {
    const claim = await ports.journal.claim(binding);
    if (claim.result === 'unknown') return receipt(base, 'request_claim_unknown', 'unknown');
    if (claim.result === 'existing') {
      if (brokerDigest(claim.binding) !== brokerDigest(binding)) return receipt(base, 'idempotency_conflict');
      const existing = BrokerReceipt.safeParse(claim.receipt);
      if (!existing.success) return receipt(base, 'request_in_progress', 'unknown');
      if (existing.data.customer_id !== binding.customer_id || existing.data.request_id !== binding.request_id || existing.data.request_digest !== binding.request_digest ||
          (existing.data.data && !sameRepository(existing.data.data, plan.request.target_repo))) {
        return receipt(base, 'request_receipt_invalid', 'unknown');
      }
      return existing.data;
    }
    if (claim.result !== 'claimed') return receipt(base, 'request_claim_unknown', 'unknown');
  } catch { return receipt(base, 'request_claim_unknown', 'unknown'); }

  const appendAudit = async (entry: BrokerAuditEntry) => {
    const result = auditReadback.parse(await ports.audit(customer, entry));
    if (result.repository_id !== customer.audit_repo.id || result.record_digest !== brokerDigest(entry)) throw new BrokerFailure('audit_readback_mismatch', 'unknown');
  };
  let result = receipt(base, 'request_intent_unknown', 'unknown');
  const retainUncertainty = (code: NonNullable<BrokerReceipt['uncertainties']>[number]) => {
    result = { ...result, code: result.status === 'done' ? code : result.code, status: 'unknown',
      uncertainties: [...(result.uncertainties ?? []), code] };
  };
  let secret: string | null = null;
  let stage: 'intent' | 'mint' | 'audit' | 'read' = 'intent';
  try {
    await appendAudit({ schema_version: 1, kind: 'request_intent', binding, source_sha: plan.context.executor.source_sha, token_plan: tokenPlan });
    if (Date.parse(grant.expires_at) <= time()) throw new BrokerFailure('read_admission_expired');
    stage = 'mint'; result.token_mint = 'unknown'; result.token_cleanup = 'unknown';
    const raw = await ports.transport.mint(tokenPlan);
    // Capture a returned credential only for disposal, including malformed grants.
    if (raw && typeof raw === 'object' && typeof (raw as { token?: unknown }).token === 'string') secret = (raw as { token: string }).token;
    result.token_mint = 'known'; result.token_cleanup = secret ? 'unknown' : 'not_required';
    const parsed = mintedToken.safeParse(raw);
    if (!parsed.success) throw new BrokerFailure('token_response_invalid');
    const token = parsed.data;
    if (token.repository_selection !== 'selected' || token.repositories.length !== 1 ||
        !sameRepository(token.repositories[0]!, tokenPlan.repositories[0]!) || brokerDigest(token.permissions) !== brokerDigest(tokenPlan.permissions)) {
      throw new BrokerFailure('token_grant_mismatch');
    }
    const observedAt = time();
    if (Date.parse(token.expires_at) <= observedAt) throw new BrokerFailure('token_expired');
    if (Date.parse(token.expires_at) - observedAt > MAX_TOKEN_LIFETIME_MS + TOKEN_CLOCK_TOLERANCE_MS) throw new BrokerFailure('token_lifetime_exceeded');
    stage = 'audit';
    await appendAudit(TokenMintRecord.parse({ schema_version: 1, kind: 'token_mint', ...tokenPlan, expires_at: token.expires_at }));
    if (Date.parse(grant.expires_at) <= time()) throw new BrokerFailure('read_admission_expired');
    if (Date.parse(token.expires_at) <= time()) throw new BrokerFailure('token_expired');
    stage = 'read'; result.api_effect = 'unknown';
    const rawMetadata = await ports.transport.read(token.token, plan.request.target_repo);
    result.api_effect = 'known';
    const metadata = RepositoryMetadata.safeParse(rawMetadata);
    if (!metadata.success) throw new BrokerFailure('repository_response_invalid');
    const data = metadata.data;
    if (!sameRepository(data, plan.request.target_repo)) throw new BrokerFailure('repository_identity_changed');
    result = { ...result, status: 'done', code: 'governed_read_complete', api_effect: 'known', data };
  } catch (error) {
    if (error instanceof BrokerFailure && error.mintNotAttempted && stage === 'mint' && secret === null) {
      result.token_mint = 'none'; result.token_cleanup = 'not_required';
    }
    result = { ...result, status: error instanceof BrokerFailure ? error.status : 'unknown',
      code: error instanceof BrokerFailure ? error.code : { intent: 'request_intent_unknown', mint: 'token_mint_unknown', audit: 'token_audit_unknown', read: 'governed_read_unknown' }[stage] };
  } finally {
    if (secret) {
      try { await ports.transport.revoke(secret); result.token_cleanup = 'revoked'; }
      catch { retainUncertainty('token_revocation_unknown'); result.token_cleanup = 'unknown'; }
      secret = null;
    }
  }
  try { await appendAudit({ schema_version: 1, kind: 'request_result', receipt: result }); }
  catch { retainUncertainty('request_audit_unknown'); }
  try { await ports.journal.complete(binding, result); }
  catch { retainUncertainty('request_receipt_unknown'); }
  return BrokerReceipt.parse(result);
}
