import { createHash } from 'node:crypto';
import type { Octokit } from '@octokit/rest';
import { z } from 'zod';
import { AuthorityRecord, ProposalBinding, TrialAuthorization, TrialConsent, SignInApp } from '../../schemas/agent-loop-authority';
import { ProducerBinding, TransactionIntent } from '../../schemas/agent-loop-state';
import { brokerDigest } from '../control-plane/broker';
import { StateRefusal } from './ledger';
import type { WriterLease } from './native-store';

const id = z.number().int().positive().safe();
const Human = z.object({ id, login: z.string().regex(/^[A-Za-z0-9-]+$/), type: z.literal('User') });
const Author = z.object({ id, login: z.string().min(1).max(100), type: z.enum(['User', 'Bot']) });
/** The review body both consent forms carry; required of an author's comment review. */
const reviewBody = (proposal: TrialAuthorization) => `Trial proposal SHA256: ${brokerDigest(proposal)}`;
export const NativeAuthorityConfig = z.object({ proposal: TrialAuthorization, binding: ProposalBinding,
  consent_comment_id: id, sign_in_app: SignInApp, broker_run: ProducerBinding }).strict();
export interface AuthorityAudit {
  append(record: unknown): Promise<{ repository_id: number; path: string; commit_sha: string; sha256: string; sequence: number }>;
}
export interface NativeAuthorityClients { governed: Octokit; control: Octokit; state: Octokit; audit: Octokit }
function fact(value: unknown, code: string): asserts value { if (!value) throw new StateRefusal(code); }
const AUDIT_OUTAGE = new Set(['git_document_unavailable', 'git_document_write_unknown', 'git_document_conflict_exhausted']);
const coordinates = (repository: string) => { const [owner, repo] = repository.split('/') as [string, string]; return { owner, repo }; };

/** Native reads never use the dashboard ETag cache or trust body-supplied actors.
 * API errors fail closed; no mutations, token loading, enrollment or paid work. */
export async function verifyTrialAuthority(clients: NativeAuthorityClients, raw: unknown, now: string): Promise<AuthorityRecord> {
  try {
    const config = NativeAuthorityConfig.parse(raw), { proposal: p, binding: b } = config;
    const timestamp = Date.parse(z.string().datetime().parse(now));
    fact(Date.parse(p.expires_at) > timestamp, 'trial_expired');
    fact(b.repository.id === p.governed_repository.id && b.repository.full_name === p.governed_repository.full_name &&
      config.broker_run.repository_id === p.control_repository.id && config.broker_run.repository === p.control_repository.full_name &&
      config.broker_run.source_sha === p.writer.source_sha &&
      config.broker_run.workflow_path === '.github/workflows/broker.yml', 'authority_repository_mismatch');
    let calls = 0;
    const api = async (route: string, params: Record<string, unknown>) => {
      fact(++calls <= 32, 'authority_api_budget_exhausted');
      const entry = ([[p.governed_repository, clients.governed], [p.control_repository, clients.control],
        [p.state_repository, clients.state], [p.audit_repository, clients.audit]] as const)
        .find(([repository]) => repository.full_name === `${params.owner}/${params.repo}`);
      fact(entry?.[1], 'authority_transport_missing');
      return entry[1].request(route, { ...params, headers: { 'cache-control': 'no-cache', 'x-github-api-version': '2026-03-10' }, request: { timeout: 15000 } });
    };
    const repo = coordinates(b.repository.full_name), pullParams = { ...repo, pull_number: b.pull_number };
    for (const repository of [p.control_repository, p.state_repository, p.audit_repository, p.governed_repository]) {
      fact(z.object({ id: z.literal(repository.id), full_name: z.literal(repository.full_name), archived: z.literal(false), disabled: z.literal(false),
        default_branch: z.literal('main') }).safeParse((await api('GET /repos/{owner}/{repo}', coordinates(repository.full_name))).data).success, 'authority_repository_mismatch');
    }
    let author: z.infer<typeof Author> | undefined;
    const checkPull = async () => {
      const pull = z.object({ number: z.literal(b.pull_number), state: z.literal('open'), draft: z.literal(false), merged: z.literal(false), user: Author,
        head: z.object({ sha: z.literal(b.head_sha), repo: z.object({ id: z.literal(b.repository.id), full_name: z.literal(b.repository.full_name) }) }),
        base: z.object({ sha: z.literal(b.base_sha), ref: z.literal('main'), repo: z.object({ id: z.literal(b.repository.id), full_name: z.literal(b.repository.full_name) }) }) })
        .safeParse((await api('GET /repos/{owner}/{repo}/pulls/{pull_number}', pullParams)).data);
      fact(pull.success && (!author || author.id === pull.data.user.id), 'approval_head_or_base_changed');
      author = { id: pull.data.user.id, login: pull.data.user.login, type: pull.data.user.type };
    };
    await checkPull();
    const file = z.object({ type: z.literal('file'), path: z.literal(b.path), encoding: z.literal('base64'), sha: z.string().regex(/^[a-f0-9]{40}$/),
      size: z.number().int().positive().max(65536), content: z.string().max(100000) }).parse((await api('GET /repos/{owner}/{repo}/contents/{path}', { ...repo, path: b.path, ref: b.head_sha })).data);
    const bytes = Buffer.from(file.content.replace(/\s/g, ''), 'base64');
    fact(bytes.length === file.size && bytes.toString('base64') === file.content.replace(/\s/g, '') &&
      createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex') === file.sha &&
      brokerDigest(TrialAuthorization.parse(JSON.parse(bytes.toString('utf8')))) === brokerDigest(p), 'approval_proposal_mismatch');
    const comment = z.object({ id: z.literal(config.consent_comment_id), user: Human,
      performed_via_github_app: z.object({ id: z.literal(config.sign_in_app.app_id) }),
      issue_url: z.literal(`https://api.github.com/repos/${b.repository.full_name}/issues/${b.pull_number}`),
      html_url: z.literal(`https://github.com/${b.repository.full_name}/pull/${b.pull_number}#issuecomment-${config.consent_comment_id}`),
      body: z.string().max(4096), created_at: z.string().datetime(), updated_at: z.string().datetime() })
      .parse((await api('GET /repos/{owner}/{repo}/issues/comments/{comment_id}', { ...repo, comment_id: config.consent_comment_id })).data);
    const consent = TrialConsent.parse(JSON.parse(comment.body));
    fact(consent.proposal_sha256 === brokerDigest(p) && consent.head_sha === b.head_sha && consent.base_sha === b.base_sha &&
      consent.source_sha === p.writer.source_sha && consent.expires_at === p.expires_at && comment.created_at === comment.updated_at &&
      Date.parse(comment.created_at) <= timestamp && Date.parse(comment.created_at) < Date.parse(p.expires_at), 'approval_consent_mismatch');
    const reviews: unknown[] = [];
    for (let page = 1; page <= 5; page++) {
      const response = await api('GET /repos/{owner}/{repo}/pulls/{pull_number}/reviews', { ...pullParams, per_page: 100, page });
      reviews.push(...z.array(z.unknown()).max(100).parse(response.data));
      if (!/rel="next"/.test(response.headers.link ?? '')) break;
      fact(page < 5, 'authority_pagination_incomplete');
    }
    // GitHub refuses an author's approving review of their own pull request. Only a
    // proposal that itself defers the second human may be consented to by its
    // author, and then by that author's comment review at the exact head carrying
    // the proposal digest. Anyone else still needs their latest decisive review to
    // be an approval. Neither form is a second person's review.
    const policy = p.second_human_review ?? 'required', selfAuthored = author!.id === comment.user.id;
    fact(!selfAuthored || policy === 'deferred', 'approval_second_human_required');
    const relevant = reviews.filter(r => z.object({ user: z.object({ id: z.literal(comment.user.id) }),
      state: z.enum(['APPROVED', 'CHANGES_REQUESTED', 'DISMISSED']) }).safeParse(r).success);
    const review = selfAuthored
      ? z.object({ id: z.literal(consent.review_id), user: Human, state: z.literal('COMMENTED'), commit_id: z.literal(b.head_sha),
        submitted_at: z.string().datetime(), body: z.literal(reviewBody(p)) }).parse(reviews.find(r => (r as { id?: unknown } | null)?.id === consent.review_id))
      : z.object({ id: z.literal(consent.review_id), user: Human, state: z.literal('APPROVED'),
        commit_id: z.literal(b.head_sha), submitted_at: z.string().datetime() }).parse(relevant.at(-1));
    fact(review.user.id === comment.user.id && review.user.login === comment.user.login && Date.parse(review.submitted_at) <= Date.parse(comment.created_at), 'approval_review_mismatch');
    let permission: 'admin' | 'maintain' | 'write' = 'write';
    for (const repository of [p.governed_repository]) {
      const response = await api('GET /repos/{owner}/{repo}/collaborators/{username}/permission', { ...coordinates(repository.full_name), username: comment.user.login });
      const native = z.object({ permission: z.enum(['admin', 'maintain', 'write']), user: Human }).parse(response.data);
      fact(native.user.id === comment.user.id, 'approval_permission_identity_mismatch');
      permission = native.permission;
    }
    const run = config.broker_run;
    const controlRepo = coordinates(p.control_repository.full_name);
    fact(z.object({ id: z.literal(run.run_id), run_attempt: z.literal(run.run_attempt), head_sha: z.literal(run.source_sha),
      path: z.literal(run.workflow_path), head_branch: z.literal('main'), status: z.literal('in_progress'),
      repository: z.object({ id: z.literal(run.repository_id), full_name: z.literal(run.repository) }) })
      .safeParse((await api('GET /repos/{owner}/{repo}/actions/runs/{run_id}', { ...controlRepo, run_id: run.run_id })).data).success, 'authority_source_mismatch');
    fact(z.object({ object: z.object({ sha: z.literal(p.writer.source_sha), type: z.literal('commit') }) })
      .safeParse((await api('GET /repos/{owner}/{repo}/git/ref/{ref}', { ...controlRepo, ref: 'heads/main' })).data).success, 'authority_source_mismatch');
    await checkPull();
    return AuthorityRecord.parse({ schema_version: 1, purpose: 'trial', proposal_sha256: brokerDigest(p), proposal: p,
      source_sha: p.writer.source_sha, binding: b, human: { id: comment.user.id, login: comment.user.login, permission },
      second_human_review: policy,
      native: { review_id: review.id, comment_id: comment.id, consent_url: comment.html_url, sign_in_app_id: config.sign_in_app.app_id,
        review_at: review.submitted_at, consent_at: comment.created_at, consent, review_state: review.state, proposal_author: author },
      expires_at: p.expires_at, enrollment: 'off' });
  } catch (error) { throw error instanceof StateRefusal ? error : new StateRefusal('native_authority_unavailable'); }
}

export function createNativeAuthority(clients: NativeAuthorityClients, raw: unknown, ports: { now(): string; audit: AuthorityAudit }) {
  const config = NativeAuthorityConfig.parse(raw);
  return async (rawIntent: unknown): Promise<WriterLease> => {
    const intent = TransactionIntent.parse(rawIntent), record = await verifyTrialAuthority(clients, config, ports.now()), p = record.proposal;
    fact(intent.authority_ref === record.native.consent_url && p.operations.includes(intent.kind) && p.subjects.includes(intent.subject_sha256) &&
      p.producers.some(producer => producer.repository_id === intent.producer.repository_id && producer.repository === intent.producer.repository &&
        producer.source_sha === intent.producer.source_sha && producer.workflow_path === intent.producer.workflow_path), 'transaction_outside_trial');
    const event = { schema_version: 1, kind: 'authority_intent', event_id: `authority:${intent.operation_id}`, authority: record, intent };
    let receipt: Awaited<ReturnType<AuthorityAudit['append']>>;
    // Only an outage reads as unavailable; integrity/binding refusals keep their own code.
    try { receipt = await ports.audit.append(event); }
    catch (error) { throw error instanceof StateRefusal && !AUDIT_OUTAGE.has(error.code) ? error : new StateRefusal('authority_audit_unavailable'); }
    fact(receipt.repository_id === p.audit_repository.id && receipt.sha256 === brokerDigest(event) && /^[a-f0-9]{40}$/.test(receipt.commit_sha) && receipt.sequence > 0, 'authority_audit_binding_invalid');
    fact(Date.parse(p.expires_at) > Date.parse(ports.now()), 'trial_expired');
    return { ...p.writer, authority_digest: brokerDigest(record), expires_at: p.expires_at };
  };
}

/** Fixed purpose action used only with DeviceSignIn.asOperator's user client.
 * Native author identity is rechecked; a body-supplied `by` has no role. */
export async function submitTrialConsent(gh: Octokit, rawBinding: unknown, rawProposal: unknown, expectedHumanId: number) {
  const b = ProposalBinding.parse(rawBinding), proposal = TrialAuthorization.parse(rawProposal);
  const user = Human.parse((await gh.request('GET /user')).data);
  fact(user.id === expectedHumanId, 'operator_identity_changed');
  const repo = coordinates(b.repository.full_name);
  const pull = await gh.request('GET /repos/{owner}/{repo}/pulls/{pull_number}', { ...repo, pull_number: b.pull_number });
  fact(pull.data.head.sha === b.head_sha && pull.data.base.sha === b.base_sha && !pull.data.draft && pull.data.state === 'open', 'approval_head_or_base_changed');
  // The author of a pull request cannot approve it. Refuse before any write unless
  // the proposal defers the second human; then record a comment review instead.
  const selfAuthored = pull.data.user?.id === user.id;
  fact(!selfAuthored || proposal.second_human_review === 'deferred', 'approval_second_human_required');
  const review = await gh.request('POST /repos/{owner}/{repo}/pulls/{pull_number}/reviews', { ...repo, pull_number: b.pull_number, commit_id: b.head_sha,
    event: selfAuthored ? 'COMMENT' : 'APPROVE', body: reviewBody(proposal) });
  const consent = TrialConsent.parse({ schema_version: 1, purpose: 'trial_consent', proposal_sha256: brokerDigest(proposal),
    head_sha: b.head_sha, base_sha: b.base_sha, source_sha: proposal.writer.source_sha, expires_at: proposal.expires_at, review_id: review.data.id });
  const response = await gh.request('POST /repos/{owner}/{repo}/issues/{issue_number}/comments', { ...repo, issue_number: b.pull_number, body: JSON.stringify(consent) });
  return { comment_id: response.data.id, receipt_url: response.data.html_url, review_id: review.data.id,
    review_state: selfAuthored ? 'COMMENTED' as const : 'APPROVED' as const, second_human_review: proposal.second_human_review ?? 'required' as const };
}
