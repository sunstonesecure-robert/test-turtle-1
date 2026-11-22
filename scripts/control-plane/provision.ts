import type { Octokit } from '@octokit/rest';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { z } from 'zod';
import { APP_ROLES, BrokerBootstrap, CustomerControlPlane, CustomerRegistry, type BootstrapCheck, type BootstrapReport, type InspectionScope } from '../../schemas/control-plane';

/** Registry mutation is a pure value operation. Persistence must go through the
 * broker's isolated conditional writer, not an overwrite of a customer record. */
export function registerCustomer(rawRecords: unknown, rawCustomer: unknown): CustomerControlPlane[] {
  const records = CustomerRegistry.parse(rawRecords); const customer = CustomerControlPlane.parse(rawCustomer);
  const existing = records.find(r => r.customer_id === customer.customer_id);
  if (existing) {
    if (JSON.stringify(existing) !== JSON.stringify(customer)) throw new Error('customer_binding_changed');
    return records;
  }
  return CustomerRegistry.parse([...records, customer]);
}

/** Validate the already-created sandbox repositories and prepare a provisioning
 * record. This performs GETs only, never installs Apps, writes state, enables an
 * enrollment, or treats configured installation IDs as observed membership. */
export async function provisionSandboxCustomer(gh: Octokit, rawConfig: unknown, rawRecords: unknown,
  options: { partition: 'aws' | 'aws-us-gov' }): Promise<{ customer: CustomerControlPlane; registry: CustomerControlPlane[] }> {
  const config = BrokerBootstrap.parse(rawConfig); const records = CustomerRegistry.parse(rawRecords);
  const settings = z.object({ partition: z.enum(['aws', 'aws-us-gov']) }).strict().parse(options);
  const customer = CustomerControlPlane.parse({
    schema_version: 1, customer_id: config.customer_id, stage: config.stage, sandbox: true,
    broker_repo: config.broker, control_repo: config.broker, state_repo: config.state, audit_repo: config.audit,
    governed_repos: [config.governed], oidc_subject: `repo:${config.broker.full_name}:ref:refs/heads/main`,
    app_installations: Object.fromEntries(APP_ROLES.map(role => [role, { app_id: config.apps[role].app_id,
      installation_id: config.apps[role].installation_id, repos: [], result: config.apps[role].installation_id === null ? 'missing' : 'unknown' }])),
    partition: settings.partition, release: { version: null, installed_at: null, result: 'unknown' },
    runner_attestation_ref: null, status: 'provisioned',
  });
  const existing = records.find(r => r.customer_id === customer.customer_id);
  if (existing) {
    for (const key of ['broker_repo', 'control_repo', 'state_repo', 'audit_repo', 'governed_repos', 'oidc_subject', 'stage', 'sandbox', 'partition'] as const) {
      if (JSON.stringify(existing[key]) !== JSON.stringify(customer[key])) throw new Error('customer_binding_changed');
    }
    for (const role of APP_ROLES) {
      const installation = existing.app_installations[role];
      // Null is not a request to erase a subsequently verified installation.
      if (installation.app_id !== config.apps[role].app_id || (config.apps[role].installation_id !== null && installation.installation_id !== config.apps[role].installation_id)) {
        throw new Error('customer_binding_changed');
      }
    }
  } else registerCustomer(records, customer); // Reject a second combined customer before native I/O.
  const native = z.object({ id: z.number().int().positive(), full_name: z.string(), private: z.boolean(),
    archived: z.boolean(), disabled: z.boolean(), default_branch: z.string(), owner: z.object({ login: z.string(), type: z.string() }) });
  for (const [role, repo] of Object.entries({ control: config.broker, state: config.state, audit: config.audit, governed: config.governed })) {
    const [owner, name] = repo.full_name.split('/') as [string, string];
    let observed;
    try { observed = native.safeParse((await gh.repos.get({ owner, repo: name })).data); }
    catch { throw new Error('repository_binding_unknown'); }
    if (!observed.success) throw new Error('repository_binding_unknown');
    const data = observed.data;
    if (data.id !== repo.id || data.full_name.toLowerCase() !== repo.full_name.toLowerCase() || data.owner.login.toLowerCase() !== owner.toLowerCase() ||
      data.archived || data.disabled || (role !== 'governed' && (!data.private || data.owner.type !== 'Organization' || data.default_branch !== 'main'))) {
      throw new Error('repository_binding_mismatch');
    }
  }
  return { customer: existing ?? customer, registry: existing ? records : registerCustomer(records, customer) };
}

const environmentSchema = z.object({
  name: z.literal('broker-credentials'), deployment_branch_policy: z.object({ protected_branches: z.literal(false), custom_branch_policies: z.literal(true) }),
}).passthrough();
const policySchema = z.array(z.object({ id: z.number().int().positive(), name: z.string(), type: z.enum(['branch', 'tag']) }).passthrough());
const ruleSchema = z.array(z.object({ type: z.string(), parameters: z.record(z.string(), z.unknown()).optional() }).passthrough());
export const BROKER_ACTIONS = [
  'actions/checkout@9c091bb21b7c1c1d1991bb908d89e4e9dddfe3e0',
  'actions/setup-node@820762786026740c76f36085b0efc47a31fe5020',
] as const;
const check = (id: BootstrapCheck['id'], result: BootstrapCheck['result'], code: string, next_action: string): BootstrapCheck => ({ id, result, code, next_action });
function unknown(id: BootstrapCheck['id'], error: unknown): BootstrapCheck {
  const status = (error as { status?: unknown })?.status;
  return { ...check(id, 'unknown', 'github_read_unavailable', 'Restore the required API access and read this protection again.'),
    ...(typeof status === 'number' && Number.isInteger(status) && status >= 100 && status <= 599 ? { http_status: status } : {}) };
}
function coordinates(config: BrokerBootstrap) {
  const [owner, repo] = config.broker.full_name.split('/') as [string, string];
  return { owner, repo };
}
function report(config: BrokerBootstrap, scope: InspectionScope, sourceSha?: string): BootstrapReport {
  return { schema_version: 1, purpose: 'credential_container_preparation', repository_id: config.broker.id,
    scope, source_sha: sourceSha && /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(sourceSha) ? sourceSha : null,
    config_sha256: createHash('sha256').update(JSON.stringify(config)).digest('hex'), inspected_at: new Date().toISOString(), principal: null,
    environment: config.credential_environment, branch: config.branch, checks: [], api_effect: 'none', keys_allowed: false, enrollment: 'off' };
}

async function administratorIdentity(gh: Octokit, config: BrokerBootstrap, result: BootstrapReport): Promise<BootstrapCheck> {
  try {
    const principal = z.object({ login: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9-]*$/), id: z.number().int().positive(), type: z.literal('User') })
      .safeParse((await gh.users.getAuthenticated()).data);
    if (!principal.success) return check('administrator_identity', 'unknown', 'administrator_unidentified', 'Use a named human organization owner with ephemeral authorization; bot identities cannot supply this report.');
    result.principal = principal.data;
    const membership = z.object({ state: z.literal('active'), role: z.literal('admin') })
      .safeParse((await gh.request('GET /user/memberships/orgs/{org}', { org: 'SunStone-Secure-LLC' })).data);
    const approved = config.reviewed_access.users.some(u => u.role === 'admin' && u.login.toLowerCase() === principal.data.login.toLowerCase());
    return membership.success && approved ? check('administrator_identity', 'pass', 'named_owner_bound', 'Retain this named owner, source SHA and config digest with the administrator report.') :
      check('administrator_identity', 'fail', 'administrator_not_approved_owner', 'The report requires an active organization owner named as an administrator in reviewed_access.');
  } catch (error) { return unknown('administrator_identity', error); }
}

const manifestFiles = { proposal_author: 'proposal-author.json', required_check_producer: 'required-check-producer.json',
  operator_sign_in: 'operator-sign-in.json', control_plane_writer: 'control-plane-writer.json' } as const;

async function appRegistration(gh: Octokit, config: BrokerBootstrap, role: typeof APP_ROLES[number]): Promise<BootstrapCheck> {
  const id = `app_${role}` as const;
  try {
    const manifest = z.object({ default_permissions: z.record(z.string(), z.enum(['read', 'write'])) }).parse(
      JSON.parse(readFileSync(new URL(`../../control-plane/apps/${manifestFiles[role]}`, import.meta.url), 'utf8')));
    const app = z.object({ id: z.number().int().positive(), client_id: z.string(), slug: z.string(),
      owner: z.object({ login: z.string() }), permissions: z.record(z.string(), z.enum(['read', 'write'])) })
      .safeParse((await gh.apps.getBySlug({ app_slug: config.apps[role].slug })).data);
    if (!app.success) return check(id, 'unknown', 'app_registration_unreadable', 'Read saved App identity and permissions; omitted fields are not evidence of the manifest.');
    const expected = config.apps[role];
    if (app.data.id !== expected.app_id || app.data.client_id !== expected.client_id || app.data.slug !== expected.slug ||
        app.data.owner.login.toLowerCase() !== 'sunstone-secure-llc') {
      return check(id, 'fail', 'app_identity_mismatch', 'Reconcile native App ID, client ID, slug and owner against broker-bootstrap.json.');
    }
    const permissions = { ...manifest.default_permissions, metadata: 'read' };
    const normalize = (values: Record<string, string>) => Object.entries(values).sort(([a], [b]) => a.localeCompare(b));
    return JSON.stringify(normalize(app.data.permissions)) === JSON.stringify(normalize(permissions)) ?
      check(id, 'pass', 'app_permissions_match', 'Retain the saved App permissions; installation and key custody remain separate proofs.') :
      check(id, 'fail', 'app_permissions_mismatch', 'Update the saved App permissions to the reviewed manifest; only implicit Metadata read is added.');
  } catch (error) { return unknown(id, error); }
}

async function repositoryBinding(gh: Octokit, config: BrokerBootstrap): Promise<BootstrapCheck> {
  try {
    const { data } = await gh.repos.get(coordinates(config));
    const matches = data.id === config.broker.id && data.full_name.toLowerCase() === config.broker.full_name.toLowerCase() &&
      data.owner.login === 'SunStone-Secure-LLC' && data.owner.type === 'Organization' && data.private === true && data.archived === false && data.default_branch === config.branch;
    return matches ? check('repository_binding', 'pass', 'repository_bound', 'Use only this SunStone broker/control repository.') :
      check('repository_binding', 'fail', 'repository_mismatch', 'Reconcile the native repository identity, owner, visibility and default branch.');
  } catch (error) { return unknown('repository_binding', error); }
}

async function environmentCheck(gh: Octokit, config: BrokerBootstrap): Promise<BootstrapCheck> {
  const params = { ...coordinates(config), environment_name: config.credential_environment };
  let environmentRead = false;
  try {
    const response = await gh.repos.getEnvironment(params);
    environmentRead = true;
    if (!environmentSchema.safeParse(response.data).success) return check('credential_environment', 'fail', 'environment_policy_invalid', 'Require custom deployment policies; preserve existing protections and reconcile the difference.');
    const policies = await gh.paginate('GET /repos/{owner}/{repo}/environments/{environment_name}/deployment-branch-policies', { ...params, per_page: 100 });
    const parsed = policySchema.safeParse(policies);
    if (!parsed.success) return check('credential_environment', 'unknown', 'branch_policy_unreadable', 'Read typed deployment branch policies; an omitted type is not proof of a branch restriction.');
    return parsed.data.length === 1 && parsed.data[0]!.name === config.branch && parsed.data[0]!.type === 'branch' ?
      check('credential_environment', 'pass', 'main_branch_only', 'Keep App keys in this environment; no keys are authorized by this report.') :
      check('credential_environment', 'fail', 'branch_policy_not_exclusive', 'Require exactly one branch policy for main, with no tag or wildcard policies.');
  } catch (error) {
    return !environmentRead && (error as { status?: number })?.status === 404 ? check('credential_environment', 'fail', 'environment_missing', 'Prepare the empty broker credential environment before any key transfer.') : unknown('credential_environment', error);
  }
}

async function sourceProtection(gh: Octokit, config: BrokerBootstrap): Promise<BootstrapCheck> {
  try {
    const rules = await gh.paginate('GET /repos/{owner}/{repo}/rules/branches/{branch}', { ...coordinates(config), branch: config.branch, per_page: 100 });
    const parsed = ruleSchema.safeParse(rules);
    if (!parsed.success) return check('source_protection', 'unknown', 'source_rules_unreadable', 'Read the active main-branch rules; unreadable protection is not protected.');
    const types = new Set(parsed.data.map(r => r.type));
    // GitHub layers all applicable rulesets, taking the strongest value of
    // each restriction. Required contexts accumulate across status-check rules.
    const pullRequests = parsed.data.filter(r => r.type === 'pull_request').map(r => r.parameters);
    const statusChecks = parsed.data.filter(r => r.type === 'required_status_checks').map(r => r.parameters);
    const strictChecks = statusChecks.some(parameters => parameters?.strict_required_status_checks_policy === true);
    const contractsRequired = statusChecks.some(parameters => Array.isArray(parameters?.required_status_checks) &&
      parameters.required_status_checks.some((c: unknown) => typeof c === 'object' && c !== null &&
        'context' in c && c.context === 'contracts' && 'integration_id' in c && c.integration_id === 15368));
    const protectedSource = types.has('deletion') && types.has('non_fast_forward') &&
      pullRequests.some(parameters => typeof parameters?.required_approving_review_count === 'number' && Number.isInteger(parameters.required_approving_review_count) && parameters.required_approving_review_count >= 0) &&
      pullRequests.some(parameters => parameters?.dismiss_stale_reviews_on_push === true) &&
      pullRequests.some(parameters => typeof parameters?.require_last_push_approval === 'boolean') && strictChecks && contractsRequired;
    return protectedSource ? check('source_protection', 'pass', 'source_rules_present', 'Second-human review deferred; retain PR protection, strict contracts from GitHub Actions (15368), and deletion/force-push protection.') :
      check('source_protection', 'fail', 'source_rules_missing', 'Review and merge the bootstrap source, then apply the proposed main-branch protection before key transfer.');
  } catch (error) { return unknown('source_protection', error); }
}

async function actionsPolicy(gh: Octokit, config: BrokerBootstrap): Promise<BootstrapCheck> {
  try {
    const params = coordinates(config);
    const workflow = z.object({ default_workflow_permissions: z.enum(['read', 'write']), can_approve_pull_request_reviews: z.boolean() })
      .safeParse((await gh.request('GET /repos/{owner}/{repo}/actions/permissions/workflow', params)).data);
    const actions = z.object({ enabled: z.boolean(), allowed_actions: z.enum(['all', 'local_only', 'selected']), sha_pinning_required: z.boolean() })
      .safeParse((await gh.request('GET /repos/{owner}/{repo}/actions/permissions', params)).data);
    if (!workflow.success || !actions.success) return check('actions_policy', 'unknown', 'actions_policy_unreadable', 'Read workflow approval, default permissions, selected actions and SHA-pinning settings with repository administration access.');
    if (workflow.data.can_approve_pull_request_reviews || workflow.data.default_workflow_permissions !== 'read' ||
        !actions.data.enabled || actions.data.allowed_actions !== 'selected' || !actions.data.sha_pinning_required) {
      return check('actions_policy', 'fail', 'actions_policy_unsafe', 'Disable Actions PR approval, default to read, and allow only the two pinned broker actions with full-SHA enforcement.');
    }
    const selected = z.object({ github_owned_allowed: z.boolean(), verified_allowed: z.boolean(), patterns_allowed: z.array(z.string()) })
      .safeParse((await gh.request('GET /repos/{owner}/{repo}/actions/permissions/selected-actions', params)).data);
    if (!selected.success) return check('actions_policy', 'unknown', 'actions_allowlist_unreadable', 'Read the selected-actions allowlist; omitted settings are not protection.');
    const allowed = !selected.data.github_owned_allowed && !selected.data.verified_allowed &&
      JSON.stringify([...selected.data.patterns_allowed].sort()) === JSON.stringify([...BROKER_ACTIONS].sort());
    return allowed ? check('actions_policy', 'pass', 'actions_policy_restricted', 'Keep Actions unable to approve and retain only the two reviewed action SHAs.') :
      check('actions_policy', 'fail', 'actions_allowlist_unsafe', 'Remove broad action allowances and select only the exact checkout and setup-node SHAs in broker.yml.');
  } catch (error) { return unknown('actions_policy', error); }
}

async function accessCheck(gh: Octokit, config: BrokerBootstrap, result: BootstrapReport): Promise<BootstrapCheck> {
  try {
    const params = { ...coordinates(config), per_page: 100 };
    const users = z.array(z.object({ login: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9-]*(?:\[bot\])?$/), type: z.string(),
      permissions: z.object({ push: z.boolean(), maintain: z.boolean(), admin: z.boolean() }) }))
      .safeParse(await gh.paginate('GET /repos/{owner}/{repo}/collaborators', { ...params, affiliation: 'all' }));
    const teams = z.array(z.object({ slug: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9-]*$/), permission: z.enum(['pull', 'triage', 'push', 'maintain', 'admin']) }))
      .safeParse(await gh.paginate('GET /repos/{owner}/{repo}/teams', params));
    if (!users.success || !teams.success) return check('access', 'unknown', 'access_unreadable', 'Read all effective collaborators and teams, including inherited access and every page.');
    const writers = users.data.filter(u => u.permissions.push || u.permissions.maintain || u.permissions.admin);
    result.access = {
      users: writers.map(u => ({ login: u.login, role: u.permissions.admin ? 'admin' : u.permissions.maintain ? 'maintain' : 'write' })),
      teams: teams.data.filter(t => ['push', 'maintain', 'admin'].includes(t.permission)) as NonNullable<BootstrapReport['access']>['teams'],
    };
    // Effective collaborators include organization owners and inherited grants.
    // Second-human availability is deferred; every effective custodian is still named.
    const normalize = (items: Array<{ login: string; role: string }>) => items.map(u => `${u.login.toLowerCase()}:${u.role}`).sort();
    const normalizeTeams = (items: Array<{ slug: string; permission: string }>) => items.map(t => `${t.slug.toLowerCase()}:${t.permission}`).sort();
    if (!config.reviewed_access.users.length || !config.reviewed_access.users.some(u => u.role === 'admin')) {
      return check('access', 'fail', 'access_review_required', 'Name at least one human administrator and every effective custodian in reviewed_access before any key import; second-human review is deferred.');
    }
    const matches = writers.every(u => u.type === 'User') &&
      JSON.stringify(normalize(result.access.users)) === JSON.stringify(normalize(config.reviewed_access.users)) &&
      JSON.stringify(normalizeTeams(result.access.teams)) === JSON.stringify(normalizeTeams(config.reviewed_access.teams));
    return matches ? check('access', 'pass', 'access_matches_review', 'Keep all effective writers and teams equal to the reviewed custody set.') :
      check('access', 'fail', 'access_differs_from_review', 'Reconcile direct, team, owner and organization-base grants with the named custody set.');
  } catch (error) { return unknown('access', error); }
}

async function organizationSecurity(gh: Octokit, result: BootstrapReport): Promise<BootstrapCheck> {
  try {
    const parsed = z.object({ two_factor_requirement_enabled: z.boolean(), default_repository_permission: z.enum(['none', 'read', 'write', 'admin']) })
      .safeParse((await gh.request('GET /orgs/{org}', { org: 'SunStone-Secure-LLC' })).data);
    if (!parsed.success) return check('organization_security', 'unknown', 'organization_security_unreadable', 'An organization owner must read the 2FA requirement and base repository permission; missing fields are unknown.');
    result.organization = parsed.data;
    return parsed.data.two_factor_requirement_enabled && ['none', 'read'].includes(parsed.data.default_repository_permission) ?
      check('organization_security', 'pass', 'organization_security_restricted', 'Keep organization 2FA required and base repository permissions at read or none.') :
      check('organization_security', 'fail', 'organization_security_unsafe', 'Require organization 2FA and review reducing inherited base access to read or none before narrowing broker writers.');
  } catch (error) { return unknown('organization_security', error); }
}

/** No credentials are loaded here. Source/branch metadata does not prove native
 * human approval, App-key custody, signing isolation, or operational enrollment. */
export async function inspectBroker(gh: Octokit, rawConfig: unknown, sourceSha?: string, scope: InspectionScope = 'all'): Promise<BootstrapReport> {
  const config = BrokerBootstrap.parse(rawConfig);
  const result = report(config, scope, sourceSha);
  const binding = await repositoryBinding(gh, config); result.checks.push(binding);
  if (binding.result !== 'pass') return result;
  if (scope !== 'administrator') {
    result.checks.push(await environmentCheck(gh, config), await sourceProtection(gh, config));
    for (const role of APP_ROLES.filter(role => role !== 'control_plane_writer')) result.checks.push(await appRegistration(gh, config, role));
  }
  if (scope !== 'workflow') {
    result.checks.push(await administratorIdentity(gh, config, result), await actionsPolicy(gh, config),
      await accessCheck(gh, config, result), await organizationSecurity(gh, result), await appRegistration(gh, config, 'control_plane_writer'));
  }
  let context = check('source_context', 'unknown', 'source_context_not_bound', 'Run the reviewed workflow from its pinned default-branch commit.');
  if (sourceSha && /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(sourceSha)) {
    try {
      const { data } = await gh.repos.getBranch({ ...coordinates(config), branch: config.branch });
      context = data.commit.sha === sourceSha ? check('source_context', 'pass', 'current_main_commit', 'Keep the executor bound to this current main commit.') :
        check('source_context', 'fail', 'source_head_changed', 'Reconcile the changed source head before any credentialed run.');
    } catch (error) { context = unknown('source_context', error); }
  }
  result.checks.push(context);
  if (scope !== 'administrator') result.checks.push(check('bootstrap_authority', 'blocked', 'credential_effects_not_implemented', 'Implement the exact-source credential effect, native operator consent, custody and audit-before-use proofs before importing any operational key; second-human review is deferred.'));
  return result;
}

/** Reversible, pre-key setup only. Existing environments are inspected, never
 * rewritten. An unknown write response stops without a second submission. */
export async function prepareCredentialEnvironment(gh: Octokit, rawConfig: unknown): Promise<BootstrapReport> {
  const config = BrokerBootstrap.parse(rawConfig);
  const initial = await inspectBroker(gh, config);
  if (initial.checks.find(c => c.id === 'repository_binding')?.result !== 'pass') return initial;
  if (initial.checks.find(c => c.id === 'credential_environment')?.code !== 'environment_missing') return initial;
  const params = { ...coordinates(config), environment_name: config.credential_environment };
  try {
    await gh.repos.createOrUpdateEnvironment({ ...params, deployment_branch_policy: { protected_branches: false, custom_branch_policies: true } });
    await gh.request('POST /repos/{owner}/{repo}/environments/{environment_name}/deployment-branch-policies', { ...params, name: config.branch, type: 'branch' });
  } catch {
    return { ...initial, api_effect: 'unknown', checks: initial.checks.map(c => c.id === 'credential_environment' ?
      check(c.id, 'unknown', 'environment_write_unknown', 'Read back the environment and operation before retrying; no key transfer is allowed.') : c) };
  }
  return { ...await inspectBroker(gh, config), api_effect: 'known' };
}
