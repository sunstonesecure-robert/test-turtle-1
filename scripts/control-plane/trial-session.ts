import { createPrivateKey, createPublicKey, type KeyObject } from 'node:crypto';
import { Octokit } from '@octokit/rest';
import { z } from 'zod';
import { BrokerBootstrap } from '../../schemas/control-plane';
import type { ProducerBinding } from '../../schemas/agent-loop-state';
import { GitAuditAnchor, GitAuditLog } from '../agent-loop/audit';
import { GitDocument } from '../agent-loop/git-document';
import { StateRefusal } from '../agent-loop/ledger';
import { runNativeWitnesses, WitnessPlan } from '../agent-loop/native-witnesses';
import { provisionAuditChain, ProvisionRequest, provisionState } from '../agent-loop/provision';
import { readSafetyConfig } from '../agent-loop/safety-config';
import { appTransport, CredentialFailure, loadAppKey, TOKEN_ROLES, type AppTransport, type MintedToken, type TokenRole } from './credentials';

export const CREDENTIALED_ACTIONS = ['provision-state', 'witness'] as const;
export type CredentialedAction = typeof CREDENTIALED_ACTIONS[number];
const AuditKey = z.object({ key_id: z.string().min(1).max(200).regex(/^[A-Za-z0-9][A-Za-z0-9:._/-]*$/), public_key_spki: z.string().regex(/^[A-Za-z0-9+/]+=*$/).max(200) }).strict();
const ProvisionInput = z.object({ request: ProvisionRequest, audit_key: AuditKey }).strict();
const WitnessInput = z.object({ phase: z.enum(['run_a', 'run_b']), plan: WitnessPlan }).strict();
const quiet = { debug() {}, info() {}, warn() {}, error() {} };
const headers = { 'cache-control': 'no-cache', 'x-github-api-version': '2026-03-10' };
const fact: (value: unknown, code: string) => asserts value = (value, code) => { if (!value) throw new StateRefusal(code); };
export const SECRET_NAMES = ['TURTLES_WRITER_PRIVATE_KEY', 'TURTLES_PROPOSAL_PRIVATE_KEY', 'TURTLES_AUDIT_SIGNING_KEY'] as const;
type Env = Record<string, string | undefined>;
/** Key material, handed over separately from the process environment: a child
 * process the runtime spawned earlier (the TypeScript loader's) inherits the
 * environment and would keep a copy for the whole run. */
export type Secrets = Partial<Record<typeof SECRET_NAMES[number], string | null>>;
export interface SessionOptions { now?: () => string; transport?: (keys: Parameters<typeof appTransport>[0], now: () => string) => AppTransport; control?: Octokit;
  /** Receives the function that revokes every live token, so a cancel or timeout signal can run it. */
  onTokens?: (revokeAll: () => Promise<void>) => void }

/** The run this code is executing in, read back from GitHub rather than trusted
 * from the environment: the installed broker workflow, on `main`, at the current
 * protected source, started by a reviewed human administrator. */
async function verifyBrokerRun(control: Octokit, config: BrokerBootstrap, env: Env) {
  const [owner, repo] = config.broker.full_name.split('/') as [string, string];
  const runId = Number(env.GITHUB_RUN_ID), attempt = Number(env.GITHUB_RUN_ATTEMPT), sha = env.GITHUB_SHA ?? '';
  fact(Number.isSafeInteger(runId) && runId > 0 && Number.isSafeInteger(attempt) && attempt > 0 && /^[a-f0-9]{40}$/.test(sha), 'broker_run_context_invalid');
  const run = z.object({ id: z.literal(runId), run_attempt: z.literal(attempt), head_sha: z.literal(sha), head_branch: z.literal(config.branch),
    path: z.literal('.github/workflows/broker.yml'), event: z.literal('workflow_dispatch'), status: z.literal('in_progress'),
    repository: z.object({ id: z.literal(config.broker.id), full_name: z.literal(config.broker.full_name) }),
    triggering_actor: z.object({ id: z.number().int().positive(), login: z.string().regex(/^[A-Za-z0-9-]+$/), type: z.literal('User') }) })
    .safeParse((await control.request('GET /repos/{owner}/{repo}/actions/runs/{run_id}', { owner, repo, run_id: runId, headers })).data);
  fact(run.success, 'broker_run_mismatch');
  fact(z.object({ object: z.object({ type: z.literal('commit'), sha: z.literal(sha) }) })
    .safeParse((await control.request('GET /repos/{owner}/{repo}/git/ref/{ref}', { owner, repo, ref: `heads/${config.branch}`, headers })).data).success, 'broker_source_not_current');
  const actor = run.data.triggering_actor;
  fact(config.reviewed_access.users.some(u => u.login.toLowerCase() === actor.login.toLowerCase() && u.role === 'admin'), 'administrator_not_reviewed');
  const permission = z.object({ permission: z.literal('admin'), user: z.object({ id: z.literal(actor.id) }) })
    .safeParse((await control.request('GET /repos/{owner}/{repo}/collaborators/{username}/permission', { owner, repo, username: actor.login, headers })).data);
  fact(permission.success, 'administrator_permission_refused');
  const binding: ProducerBinding = { repository_id: config.broker.id, repository: config.broker.full_name, run_id: runId, run_attempt: attempt, source_sha: sha, workflow_path: '.github/workflows/broker.yml' };
  return { run: binding, administrator: { id: actor.id, login: actor.login } };
}

/** Provisioning and the witness runs are the only credentialed effects. Keys
 * leave the environment into this process once, tokens are one repository and
 * one fixed permission set each, every mint is archived before its first other
 * use, and every token is revoked on the way out. Nothing printed or returned
 * contains a key or token. */
export async function runCredentialedAction(action: CredentialedAction, rawConfig: unknown, rawInput: unknown, env: Env, secrets: Secrets, options: SessionOptions = {}):
  Promise<{ exit: 0 | 1 | 2; report: Record<string, unknown> }> {
  const now = options.now ?? (() => new Date().toISOString());
  const base = { schema_version: 1, task: 'T124', purpose: `broker_${action.replace('-', '_')}`, model_calls: 0, cloud_operations: 0, enrollment: 'off' };
  const minted: MintedToken[] = [], mints: Array<Record<string, unknown>> = [];
  const revokeAll = async () => {
    for (const token of minted.splice(0)) {
      try { await transport!.revoke(token.token); if (cleanup === 'not_required') cleanup = 'revoked'; } catch { cleanup = 'unknown'; }
    }
  };
  let transport: AppTransport | undefined, cleanup: 'not_required' | 'revoked' | 'unknown' = 'not_required';
  let outcome: { exit: 0 | 1 | 2; report: Record<string, unknown> } | undefined;
  const done = (exit: 0 | 1 | 2, report: Record<string, unknown>) => (outcome = { exit, report: { ...base, ...report, token_mints: mints, token_cleanup: cleanup } });
  try {
    const config = BrokerBootstrap.parse(rawConfig);
    const input = action === 'provision-state' ? { kind: action, ...ProvisionInput.parse(rawInput) } : { kind: action, ...WitnessInput.parse(rawInput) };
    const request = input.kind === 'provision-state' ? input.request : input.plan.provisioning.request;
    const auditKey = input.kind === 'provision-state' ? input.audit_key : input.plan.audit_key;
    const same = (a: { id: number; full_name: string }, b: { id: number; full_name: string }) => a.id === b.id && a.full_name === b.full_name;
    fact(same(request.control_repository, config.broker) && same(request.state_repository, config.state) && same(request.audit_repository, config.audit) &&
      same(request.governed_repository, config.governed), 'request_outside_customer');
    fact(env.GITHUB_TOKEN, 'workflow_token_missing');
    const control = options.control ?? new Octokit({ auth: env.GITHUB_TOKEN, log: quiet });
    const { run, administrator } = await verifyBrokerRun(control, config, env);
    fact(request.writer.source_sha === run.source_sha, 'request_source_not_current');
    const writerApp = config.apps.control_plane_writer, proposalApp = config.apps.proposal_author;
    fact(writerApp.installation_id !== null, 'app_installation_missing');
    // The writer principal a stored commit must show is this App's own bot user.
    const bot = z.object({ id: z.literal(request.writer.principal_id), type: z.literal('Bot') })
      .safeParse((await control.request('GET /users/{username}', { username: `${writerApp.slug}[bot]`, headers })).data);
    fact(bot.success, 'writer_principal_mismatch');
    let signer: KeyObject;
    try { signer = createPrivateKey({ key: z.string().min(1).parse(secrets.TURTLES_AUDIT_SIGNING_KEY), format: 'pem' }); } catch { throw new StateRefusal('audit_signing_key_invalid'); }
    fact(signer.asymmetricKeyType === 'ed25519' && createPublicKey(signer).export({ type: 'spki', format: 'der' }).toString('base64') === auditKey.public_key_spki, 'audit_signing_key_invalid');
    const keys: Parameters<typeof appTransport>[0] = { control_plane_writer: loadAppKey(secrets.TURTLES_WRITER_PRIVATE_KEY ?? undefined) };
    if (input.kind === 'witness') { fact(proposalApp.installation_id !== null, 'app_installation_missing'); keys.proposal_author = loadAppKey(secrets.TURTLES_PROPOSAL_PRIVATE_KEY ?? undefined); }
    transport = (options.transport ?? appTransport)(keys, now);
    options.onTokens?.(revokeAll);
    const repositories = { state_writer: config.state, audit_writer: config.audit, safety_reader: config.broker, governed_reader: config.governed, trial_proposer: config.governed };
    let log: GitAuditLog | undefined; const unrecorded: MintedToken[] = [];
    const record = async (token: MintedToken) => {
      const copy = await log!.append({ schema_version: 1, kind: 'token_mint', event_id: `mint:${run.run_id}:${run.run_attempt}:${token.plan.role}:${mints.length + 1}`,
        mint: { role: token.plan.role, app_id: token.plan.app_id, installation_id: token.plan.installation_id, repository: token.plan.repository, permissions: token.permissions, expires_at: token.expires_at, broker_run: run } });
      mints.push({ role: token.plan.role, repository: token.plan.repository.full_name, permissions: token.permissions, expires_at: token.expires_at, audit_sequence: copy.sequence, audit_commit_sha: copy.commit_sha });
    };
    /** Mint, then archive the mint before the token is handed to anything else. */
    const mint = async (role: TokenRole) => {
      const app = TOKEN_ROLES[role].app === 'control_plane_writer' ? writerApp : proposalApp, repository = repositories[role];
      const token = await transport!.mint({ role, app_id: app.app_id, installation_id: app.installation_id!, owner: repository.full_name.split('/')[0]!, repository });
      minted.push(token);
      if (log) await record(token); else unrecorded.push(token);
      return transport!.client(token.token);
    };
    const openLog = (auditClient: Octokit, anchors: { chain_commit_sha: string; anchor_commit_sha: string }) => {
      const maximum = request.maximum_document_bytes;
      const anchor = new GitAuditAnchor(new GitDocument(auditClient, { repository: request.audit_repository, branch: 'main', path: 'audit/acknowledged.json',
        writer_id: request.verifier_principal_id, anchor_commit_sha: anchors.anchor_commit_sha, maximum_bytes: maximum }), request.writer.principal_id);
      return new GitAuditLog(new GitDocument(auditClient, { repository: request.audit_repository, branch: 'main', path: 'audit/chain.json', writer_id: request.writer.principal_id,
        anchor_commit_sha: anchors.chain_commit_sha, maximum_bytes: maximum }), { governed_repository_id: request.governed_repository.id, state_repository_id: request.state_repository.id,
        control_repository_id: request.control_repository.id, key_id: auditKey.key_id, private_key: signer, public_keys: { [auditKey.key_id]: createPublicKey(signer) }, anchor });
    };
    const context = { broker_run: run, administrator, source_sha: run.source_sha };

    if (input.kind === 'provision-state') {
      // The audit writer's first use is the archive itself, then its own mint record.
      const auditClient = await mint('audit_writer');
      const audit = await provisionAuditChain(auditClient, request);
      log = openLog(auditClient, audit);
      for (const token of unrecorded.splice(0)) await record(token);
      const established = (await log.read()).some(entry => entry.record.kind === 'transaction_receipt');
      const state = await provisionState(await mint('state_writer'), request, { administrator, broker_run: run }, { now, established });
      // Execution attempt with whatever safety settings exist now. Before the operator
      // creates them this must read blocked: nothing runs on a missing setting.
      const safety = await readSafetyConfig(await mint('safety_reader'), { repository: config.broker, environment: config.credential_environment,
        governed_repository_id: request.governed_repository.id, state_repository_id: request.state_repository.id });
      const gate = safety.status === 'ready' ? { status: 'ready', sha256: safety.sha256, admission_block: safety.admission_block } : { ...safety, execution: 'blocked' };
      return done(0, { ...context, result: 'provisioned', code: 'native_state_provisioned', request, audit_key: auditKey, audit, state, safety_gate: gate, provisioned_at: now() });
    }
    const plan = input.plan, auditClient = await mint('audit_writer');
    log = openLog(auditClient, plan.provisioning.audit);
    for (const token of unrecorded.splice(0)) await record(token);
    const stateClient = await mint('state_writer'), safetyClient = await mint('safety_reader'), governed = await mint('governed_reader');
    const stateToken = minted.find(t => t.plan.role === 'state_writer')!.token, auditToken = minted.find(t => t.plan.role === 'audit_writer')!;
    void stateClient;
    const report = await runNativeWitnesses(plan, input.phase, { now, audit_key: signer, broker_run: run,
      clients: { governed, control, safety: safetyClient, audit: auditClient, state: () => transport!.client(stateToken) },
      revokeAudit: async () => { await transport!.revoke(auditToken.token); minted.splice(minted.indexOf(auditToken), 1); } });
    return done(report.result === 'pass' ? 0 : report.result === 'fail' ? 2 : 1, { ...context, ...report });
  } catch (error) {
    // Only stable codes leave: no upstream message, key, token or request body.
    const code = error instanceof StateRefusal || error instanceof CredentialFailure ? error.code : error instanceof z.ZodError ? 'credentialed_input_invalid' : 'credentialed_action_failed';
    // A grant that failed its checks and could not be disposed of is an open credential, not a clean exit.
    if (code === 'token_cleanup_unknown') cleanup = 'unknown';
    return done(error instanceof z.ZodError ? 2 : 1, { result: 'error', code });
  } finally {
    await revokeAll();
    // The returned report is the same object: it names the cleanup that actually happened.
    if (outcome) outcome.report.token_cleanup = cleanup;
  }
}
