import { z } from 'zod';

const id = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const sunstoneRepo = z.object({ full_name: z.string().regex(/^SunStone-Secure-LLC\/[A-Za-z0-9_.-]+$/), id }).strict();
const governedRepo = z.object({ full_name: z.string().regex(/^[A-Za-z0-9-]+\/[A-Za-z0-9_.-]+$/), id }).strict();
export const APP_ROLES = ['proposal_author', 'required_check_producer', 'operator_sign_in', 'control_plane_writer'] as const;
export const APP_SECRET_NAMES = {
  proposal_author: 'TURTLES_PROPOSAL_PRIVATE_KEY', required_check_producer: 'TURTLES_CHECKS_PRIVATE_KEY',
  operator_sign_in: null, control_plane_writer: 'TURTLES_WRITER_PRIVATE_KEY',
} as const;
const registration = (role: typeof APP_ROLES[number]) => z.object({
  app_id: id, client_id: z.string().regex(/^Iv[A-Za-z0-9.]+$/), slug: z.string().regex(/^[a-z0-9-]+$/),
  installation_id: id.nullable(), secret_name: z.literal(APP_SECRET_NAMES[role]),
}).strict();
const login = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9-]*$/);
export const ReviewedAccess = z.object({
  users: z.array(z.object({ login, role: z.enum(['write', 'maintain', 'admin']) }).strict()),
  teams: z.array(z.object({ slug: login, permission: z.enum(['push', 'maintain', 'admin']) }).strict()),
}).strict();

/** Initial credential-container preparation only. This is neither a
 * CustomerControlPlane enrollment record nor authority to load or mint tokens. */
export const BrokerBootstrap = z.object({
  schema_version: z.literal(1), mode: z.literal('off'), stage: z.literal('combined_broker'),
  customer_id: z.literal('sandbox'), customer_count: z.literal(1),
  broker: sunstoneRepo, state: sunstoneRepo, audit: sunstoneRepo, governed: governedRepo,
  branch: z.literal('main'), credential_environment: z.literal('broker-credentials'),
  reviewed_access: ReviewedAccess,
  apps: z.object({
    proposal_author: registration('proposal_author'), required_check_producer: registration('required_check_producer'),
    operator_sign_in: registration('operator_sign_in'), control_plane_writer: registration('control_plane_writer'),
  }).strict(),
}).strict().superRefine((config, context) => {
  const repositories = [config.broker, config.state, config.audit, config.governed];
  if (new Set(repositories.map(r => r.id)).size !== 4 || new Set(repositories.map(r => r.full_name.toLowerCase())).size !== 4) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'Broker/control, state, audit and governed repositories must be distinct.' });
  }
  if (new Set(APP_ROLES.map(role => config.apps[role].app_id)).size !== 4 || new Set(APP_ROLES.map(role => config.apps[role].client_id)).size !== 4) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'All four App principals must be distinct.' });
  }
  const installations = APP_ROLES.map(role => config.apps[role].installation_id).filter(value => value !== null);
  if (new Set(installations).size !== installations.length) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'Populated App installation IDs must be distinct across roles.' });
  }
  if (new Set(config.reviewed_access.users.map(u => u.login.toLowerCase())).size !== config.reviewed_access.users.length ||
      new Set(config.reviewed_access.teams.map(t => t.slug.toLowerCase())).size !== config.reviewed_access.teams.length) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'Reviewed users and teams must be unique.' });
  }
});
export type BrokerBootstrap = z.infer<typeof BrokerBootstrap>;
export const INSPECTION_SCOPES = ['workflow', 'administrator', 'all'] as const;
export type InspectionScope = typeof INSPECTION_SCOPES[number];
export const WORKFLOW_CHECK_IDS = ['repository_binding', 'credential_environment', 'source_protection',
  'app_proposal_author', 'app_required_check_producer', 'app_operator_sign_in', 'source_context', 'bootstrap_authority'] as const;
export const ADMINISTRATOR_CHECK_IDS = ['repository_binding', 'administrator_identity', 'actions_policy', 'access',
  'organization_security', 'app_control_plane_writer', 'source_context'] as const;
export const BOOTSTRAP_CHECK_IDS = [...new Set([...WORKFLOW_CHECK_IDS, ...ADMINISTRATOR_CHECK_IDS])];
export const SCOPE_CHECK_IDS = { workflow: WORKFLOW_CHECK_IDS, administrator: ADMINISTRATOR_CHECK_IDS, all: BOOTSTRAP_CHECK_IDS } as const;
export interface BootstrapCheck {
  id: typeof BOOTSTRAP_CHECK_IDS[number];
  result: 'pass' | 'fail' | 'unknown' | 'blocked'; code: string; next_action: string; http_status?: number;
}
export interface BootstrapReport {
  schema_version: 1; purpose: 'credential_container_preparation'; repository_id: number;
  scope: InspectionScope; source_sha: string | null; config_sha256: string; inspected_at: string;
  principal: { login: string; id: number; type: 'User' } | null;
  environment: string; branch: string; checks: BootstrapCheck[];
  api_effect: 'none' | 'known' | 'unknown'; keys_allowed: false; enrollment: 'off';
  access?: z.infer<typeof ReviewedAccess>;
  organization?: { two_factor_requirement_enabled: boolean; default_repository_permission: string };
}

const name = z.string().min(1).max(128).regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]*$/);
const customerId = z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/);
export const RepositoryIdentity = governedRepo;
export type RepositoryIdentity = z.infer<typeof RepositoryIdentity>;
export const sha256 = z.string().regex(/^[a-f0-9]{64}$/);
export const commitSha = z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/);
export const AppInstallation = z.object({
  app_id: id, installation_id: id.nullable(), repos: z.array(id).max(500), result: z.enum(['present', 'missing', 'unknown']),
}).strict().superRefine((value, context) => {
  if (new Set(value.repos).size !== value.repos.length || (value.result === 'present' && value.installation_id === null)) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'Present installations need an ID and unique repository membership.' });
  }
});
export const AppInstallations = z.object({
  proposal_author: AppInstallation, required_check_producer: AppInstallation,
  operator_sign_in: AppInstallation, control_plane_writer: AppInstallation,
}).strict();

/** Trusted SunStone provisioning input; never accept this record from an agent
 * or governed request. Lifecycle values describe facts, not activation proof. */
export const CustomerControlPlane = z.object({
  schema_version: z.literal(1), customer_id: customerId, stage: z.enum(['combined_broker', 'split']), sandbox: z.boolean().default(false),
  broker_repo: sunstoneRepo, control_repo: sunstoneRepo, state_repo: sunstoneRepo, audit_repo: sunstoneRepo,
  oidc_subject: z.string(), governed_repos: z.array(governedRepo).min(1).max(100), app_installations: AppInstallations,
  partition: z.enum(['aws', 'aws-us-gov']),
  release: z.object({ version: z.string().min(1).max(128).nullable(), installed_at: z.string().datetime().nullable(),
    result: z.enum(['current', 'older', 'unknown']) }).strict(),
  runner_attestation_ref: z.string().min(1).max(512).nullable(),
  status: z.enum(['provisioned', 'apps_installed', 'bootstrapped', 'enrolled', 'revoked']),
}).strict().superRefine((value, context) => {
  const same = value.broker_repo.id === value.control_repo.id && value.broker_repo.full_name.toLowerCase() === value.control_repo.full_name.toLowerCase();
  if ((value.stage === 'combined_broker') !== same) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'Combined broker shares its control repository; split broker must be separate.' });
  }
  const repos = [value.control_repo, value.state_repo, value.audit_repo, ...value.governed_repos,
    ...(value.stage === 'split' ? [value.broker_repo] : [])];
  if (new Set(repos.map(r => r.id)).size !== repos.length || new Set(repos.map(r => r.full_name.toLowerCase())).size !== repos.length) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'Customer repository roles must be distinct by both ID and name.' });
  }
  if (value.oidc_subject !== `repo:${value.control_repo.full_name}:ref:refs/heads/main`) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'OIDC subject must bind this customer control repository main ref.' });
  }
  const installations = APP_ROLES.map(role => value.app_installations[role]);
  const ids = installations.map(i => i.installation_id).filter(i => i !== null);
  if (new Set(installations.map(i => i.app_id)).size !== APP_ROLES.length || new Set(ids).size !== ids.length) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'App and populated installation identities must be distinct across roles.' });
  }
  if (value.release.result !== 'unknown' && (!value.release.version || !value.release.installed_at)) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'A known release requires its version and installation time.' });
  }
});
export type CustomerControlPlane = z.infer<typeof CustomerControlPlane>;

export const CustomerRegistry = z.array(CustomerControlPlane).max(1000).superRefine((records, context) => {
  if (records.length > 1 && records.some(r => r.stage === 'combined_broker')) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'combined_broker: split the broker before a second customer.' });
  }
  if (new Set(records.map(r => r.customer_id)).size !== records.length) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'Customer IDs must be unique.' });
  }
  const ownersById = new Map<number, string>(); const ownersByName = new Map<string, string>();
  for (const record of records) {
    for (const repo of [record.control_repo, record.state_repo, record.audit_repo, ...record.governed_repos]) {
      const normalized = repo.full_name.toLowerCase();
      if ((ownersById.has(repo.id) && ownersById.get(repo.id) !== record.customer_id) ||
          (ownersByName.has(normalized) && ownersByName.get(normalized) !== record.customer_id)) {
        context.addIssue({ code: z.ZodIssueCode.custom, message: 'Repositories cannot belong to multiple customers.' });
      }
      ownersById.set(repo.id, record.customer_id); ownersByName.set(normalized, record.customer_id);
    }
  }
  for (const record of records) {
    if (record.stage === 'split' && (ownersById.has(record.broker_repo.id) || ownersByName.has(record.broker_repo.full_name.toLowerCase()))) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: 'Shared broker cannot be a customer repository.' });
    }
  }
});

export const BrokerRequestSource = z.object({ repo: governedRepo, run_id: id, run_attempt: id,
  actor: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9-]*(?:\[bot\])?$/) }).strict();
export const BROKER_REQUEST_KINDS = ['governed_read', 'proposal_pr', 'check_run', 'merge', 'comment', 'agent_dispatch', 'control_op'] as const;
/** Intake envelope only. A producer cannot supply its own completion receipt. */
export const BrokerRequest = z.object({
  schema_version: z.literal(1), request_id: name, customer_id: customerId, kind: z.enum(BROKER_REQUEST_KINDS),
  target_repo: governedRepo, payload_digest: sha256, source: BrokerRequestSource,
  idempotency_key: name, status: z.literal('pending'), receipt: z.null(),
}).strict();
export type BrokerRequest = z.infer<typeof BrokerRequest>;
export const GovernedReadPayload = z.object({ resource: z.literal('repository_metadata') }).strict();
export const RepositoryMetadata = governedRepo.extend({
  default_branch: z.string().min(1).max(255), private: z.boolean(), archived: z.boolean(), disabled: z.boolean(),
}).strip();
export const BrokerContext = z.object({
  executor: z.object({ repository: sunstoneRepo, ref: z.literal('refs/heads/main'),
    workflow: z.literal('.github/workflows/broker.yml'), source_sha: commitSha }).strict(),
  origin: BrokerRequestSource, request_digest: sha256,
}).strict();
export type BrokerContext = z.infer<typeof BrokerContext>;
export const TokenMintRecord = z.object({
  schema_version: z.literal(1), kind: z.literal('token_mint'), customer_id: customerId, request_id: name,
  request_digest: sha256, installation_id: id, app_id: id,
  repositories: z.array(governedRepo).min(1).max(500), permissions: z.object({ metadata: z.literal('read') }).strict(),
  expires_at: z.string().datetime(),
}).strict();
export type TokenMintRecord = z.infer<typeof TokenMintRecord>;
export const INVALID_REQUEST_IDENTITY = '<invalid-request>';
export const BrokerReceipt = z.object({
  schema_version: z.literal(1), customer_id: z.union([customerId, z.literal(INVALID_REQUEST_IDENTITY)]),
  request_id: z.union([name, z.literal(INVALID_REQUEST_IDENTITY)]), request_digest: sha256,
  status: z.enum(['done', 'refused', 'unknown']), code: z.string().regex(/^[a-z_]+$/),
  token_mint: z.enum(['none', 'known', 'unknown']), api_effect: z.enum(['none', 'known', 'unknown']),
  token_cleanup: z.enum(['not_required', 'revoked', 'unknown']),
  uncertainties: z.array(z.enum(['token_revocation_unknown', 'request_audit_unknown', 'request_receipt_unknown'])).min(1).max(3).optional(),
  data: RepositoryMetadata.optional(),
}).strict().superRefine((value, context) => {
  if ((value.customer_id === INVALID_REQUEST_IDENTITY || value.request_id === INVALID_REQUEST_IDENTITY) &&
      (value.customer_id !== INVALID_REQUEST_IDENTITY || value.request_id !== INVALID_REQUEST_IDENTITY ||
       value.request_digest !== '0'.repeat(64) || value.status !== 'refused' || value.code !== 'request_invalid' ||
       value.token_mint !== 'none' || value.api_effect !== 'none' || value.token_cleanup !== 'not_required' || value.data)) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'Invalid-request identity is reserved for unparseable, uneffected requests.' });
  }
  if (value.token_mint === 'unknown' && value.token_cleanup !== 'unknown') {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'Unknown token creation retains unknown cleanup liability.' });
  }
  if (value.uncertainties && value.status !== 'unknown') {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'Unresolved cleanup/audit/journal outcomes cannot be terminal known results.' });
  }
  if (value.status === 'done' && (value.code !== 'governed_read_complete' || value.token_mint !== 'known' ||
      value.api_effect !== 'known' || value.token_cleanup !== 'revoked' || !value.data)) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'Completed reads require bound metadata, known mint/read and revoked credentials.' });
  }
});
export type BrokerReceipt = z.infer<typeof BrokerReceipt>;
