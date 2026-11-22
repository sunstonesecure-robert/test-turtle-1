import type { Octokit } from '@octokit/rest';
import { z } from 'zod';
import { HOSTING_CHECK_IDS, HostingCapabilityReport, type HostingCheck } from '../../schemas/agent-loop';
import { brokerDigest } from '../control-plane/broker';

/**
 * Hosting readiness for one governed repository (T163, W0 part).
 *
 * Everything here is a native READ of what the host grants today: visibility,
 * owner type and plan, the rules in effect on the default branch, and the tag
 * rulesets covering approved plan tags. Nothing is installed, repaired or
 * assumed. Three answers, not two: a protection that was read and is absent
 * fails; one the plan cannot provide is unsupported; one that could not be read
 * is unknown. All three block. There is deliberately no input through which a
 * waiver, a dispatch, a comment or a command-line flag can turn any of them
 * into ready, and the options object is read field by field so extra keys are
 * inert.
 *
 * Not here (later wave): the selected deployment mode, environment-reviewer
 * configuration, and the older init readiness report's reviewer item.
 */
export interface HostingOptions {
  /** Repository ID the caller expects (from the reviewed bootstrap record). */
  expected_repository_id: number;
  /** The one App allowed to update the default branch; null = not declared. */
  trusted_merge_principal: { actor_type: 'Integration'; actor_id: number } | null;
  now?: string;
}
type CheckId = typeof HOSTING_CHECK_IDS[number];
type Report = z.infer<typeof HostingCapabilityReport>;
type Plan = Report['repository']['plan'];

const MAX_RULESETS = 100;
const BRANCH_RULES = ['deletion', 'non_fast_forward', 'pull_request', 'required_status_checks', 'update'];
const Repository = z.object({
  id: z.number().int().positive(), full_name: z.string(), private: z.boolean(), visibility: z.string().optional(), archived: z.boolean(),
  default_branch: z.string().min(1), owner: z.object({ login: z.string().min(1), id: z.number().int().positive(), type: z.string() }),
});
const Account = z.object({ id: z.number().int().positive(), plan: z.object({ name: z.string() }).optional().nullable() });
const Listed = z.array(z.object({ id: z.number().int().positive() }));
const Actor = z.object({ actor_id: z.number().int().nullable().optional(), actor_type: z.string().min(1), bypass_mode: z.string().min(1).optional() });
const Detail = z.object({
  id: z.number().int().positive(), name: z.string().min(1), target: z.string().min(1), source_type: z.string().min(1), enforcement: z.string().min(1),
  conditions: z.object({ ref_name: z.object({ include: z.array(z.string()), exclude: z.array(z.string()) }).optional() }).nullable().optional(),
  rules: z.array(z.object({ type: z.string().min(1), parameters: z.unknown().optional() })).max(100), bypass_actors: z.array(Actor).max(100).optional(),
});
type Detail = z.infer<typeof Detail>;
const NamedChecks = z.object({ required_status_checks: z.array(z.object({ context: z.string().regex(/\S/) })).min(1) });
/** A required-checks rule that names no check requires nothing, so it is not counted. */
const namesACheck = (d: Detail) => d.rules.some(r => r.type === 'required_status_checks' && NamedChecks.safeParse(r.parameters).success);
/** The report is digested by the broker's routine, which refuses large inputs.
 * A report too large for it is refused by name and size, never as a failed read. */
export class HostingReportTooLarge extends Error {
  constructor(readonly bytes: number) { super('hosting_report_too_large'); }
}
const BranchRules = z.array(z.object({ type: z.string().min(1), ruleset_id: z.number().int().positive() }));

class Unreadable extends Error { constructor(readonly status?: number) { super('unreadable'); } }
const statusOf = (error: unknown): number | undefined => {
  const status = error instanceof Unreadable ? error.status : (error as { status?: unknown } | null)?.status;
  return typeof status === 'number' && Number.isInteger(status) && status >= 100 && status <= 599 ? status : undefined;
};
const check = (id: CheckId, result: HostingCheck['result'], code: string, next_action: string, http_status?: number): HostingCheck =>
  ({ id, result, code, next_action, ...(http_status === undefined ? {} : { http_status }) });
const PLAN_NAMES: Record<string, Plan> = { free: 'free', pro: 'pro', team: 'team', enterprise: 'enterprise' };

export async function readHostingCapability(gh: Pick<Octokit, 'request'>, repo: { owner: string; repo: string }, options: HostingOptions):
Promise<{ report: Report; sha256: string }> {
  const principal = options.trusted_merge_principal ? { actor_type: 'Integration' as const, actor_id: options.trusted_merge_principal.actor_id } : null;
  let requests = 0;
  const get = async (route: `GET ${string}`, params: Record<string, unknown> = {}): Promise<unknown> => {
    requests++;
    return (await (gh.request as (route: string, params: Record<string, unknown>) => Promise<{ data: unknown }>)(route, { ...repo, ...params })).data;
  };
  const pages = async (route: `GET ${string}`, params: Record<string, unknown> = {}): Promise<unknown[]> => {
    const all: unknown[] = [];
    for (let page = 1; page <= 10; page++) {
      const data = await get(route, { ...params, per_page: 100, page });
      if (!Array.isArray(data)) throw new Unreadable();
      all.push(...data);
      if (data.length < 100) return all;
    }
    throw new Unreadable();
  };

  // 1. Repository identity, visibility and owner.
  const repository: Report['repository'] = { id: null, full_name: `${repo.owner}/${repo.repo}`, visibility: 'unknown', owner_type: 'unknown', plan: 'unknown', default_branch: null };
  let identity: HostingCheck; let owner: z.infer<typeof Repository>['owner'] | null = null;
  try {
    const parsed = Repository.safeParse(await get('GET /repos/{owner}/{repo}'));
    if (!parsed.success) throw new Unreadable();
    const data = parsed.data; owner = data.owner;
    repository.id = data.id; repository.default_branch = data.default_branch;
    repository.visibility = data.visibility === 'public' || data.visibility === 'private' || data.visibility === 'internal' ? data.visibility : data.private ? 'private' : 'unknown';
    if (data.private && repository.visibility === 'public') repository.visibility = 'unknown';
    repository.owner_type = data.owner.type === 'User' || data.owner.type === 'Organization' ? data.owner.type : 'unknown';
    identity = data.id !== options.expected_repository_id || data.full_name.toLowerCase() !== repository.full_name.toLowerCase() ?
      check('repository_identity', 'fail', 'repository_mismatch', 'This name now points at a different repository than the one that was reviewed. Confirm which repository is governed before going further.') :
      data.archived ? check('repository_identity', 'fail', 'repository_archived', 'The repository is archived. Unarchive it or choose another repository.') :
        check('repository_identity', 'pass', 'repository_bound', 'No action needed.');
  } catch (error) {
    identity = check('repository_identity', 'unknown', 'repository_unreadable', 'The repository could not be read. Check that the credential can see it, then read again.', statusOf(error));
  }

  // 2. Plan. Only the owner's own record counts; a collaborator's plan says nothing.
  if (owner && repository.owner_type !== 'unknown') {
    try {
      const account = Account.safeParse(await get(repository.owner_type === 'User' ? 'GET /user' : 'GET /orgs/{org}', { org: owner.login }));
      if (account.success && account.data.id === owner.id) repository.plan = PLAN_NAMES[account.data.plan?.name ?? ''] ?? 'unknown';
    } catch { /* plan stays unknown */ }
  }
  const closed = repository.visibility === 'private' || repository.visibility === 'internal';
  const hosting: HostingCheck =
    repository.visibility === 'unknown' ? check('hosting_plan', 'unknown', 'visibility_unreadable', 'The repository\'s visibility could not be read. Read again with a credential that can see the repository.') :
    repository.visibility === 'public' ? check('hosting_plan', 'pass', 'public_repository', 'No action needed.') :
    repository.plan === 'free' ? check('hosting_plan', 'unsupported', 'free_private_unsupported', 'A private repository on the Free plan cannot enforce the protections this needs. Move to a paid plan or make the repository public; nothing else unblocks it.') :
    repository.plan === 'unknown' ? check('hosting_plan', 'unknown', 'plan_unreadable', 'The owner\'s plan could not be read, so a private repository cannot be assumed to support the protections. Read again as the owning account or an organization owner.') :
    repository.plan === 'enterprise' ? check('hosting_plan', 'pass', 'private_enterprise_plan', 'No action needed.') :
      check('hosting_plan', 'pass', 'private_paid_plan', 'No action needed. This plan has no per-deployment reviewers on a private repository; approval rests on your signed consent to the plan.');
  const native_environment_reviewers: Report['native_environment_reviewers'] = repository.visibility === 'public' ? 'available' :
    !closed || repository.plan === 'unknown' ? 'unknown' : repository.plan === 'enterprise' ? 'available' : 'unavailable';

  // 3. Rulesets: every ruleset the repository lists (its own and inherited), in detail.
  const details: Detail[] = []; let rulesetsUnreadable: { status?: number } | null = null;
  try {
    const listed = Listed.safeParse(await pages('GET /repos/{owner}/{repo}/rulesets', { includes_parents: true }));
    if (!listed.success || listed.data.length > MAX_RULESETS) throw new Unreadable();
    for (const { id } of listed.data) {
      const detail = Detail.safeParse(await get('GET /repos/{owner}/{repo}/rulesets/{ruleset_id}', { ruleset_id: id, includes_parents: true }));
      if (!detail.success || detail.data.id !== id) throw new Unreadable();
      details.push(detail.data);
    }
  } catch (error) { rulesetsUnreadable = { status: statusOf(error) }; details.length = 0; }
  const readAgain = 'Read again with a credential that can administer the repository\'s rules. Protection that cannot be read is not counted as protection.';

  // 4. Default branch: the host computes which active rules apply; we judge them.
  let branchIds = new Set<number>();
  const branch = await (async (): Promise<HostingCheck> => {
    const id = 'default_branch_protection';
    if (rulesetsUnreadable) return check(id, 'unknown', 'rulesets_unreadable', readAgain, rulesetsUnreadable.status);
    if (!repository.default_branch) return check(id, 'unknown', 'default_branch_unknown', 'The default branch could not be read. Read the repository again.');
    let rules: z.infer<typeof BranchRules>;
    try {
      const parsed = BranchRules.safeParse(await pages('GET /repos/{owner}/{repo}/rules/branches/{branch}', { branch: repository.default_branch }));
      if (!parsed.success) return check(id, 'unknown', 'default_branch_rules_unreadable', readAgain);
      rules = parsed.data;
    } catch (error) { return check(id, 'unknown', 'default_branch_rules_unreadable', readAgain, statusOf(error)); }
    const ids = new Set(rules.map(r => r.ruleset_id));
    const applying = details.filter(d => ids.has(d.id));
    if (applying.length !== ids.size || applying.some(d => d.enforcement !== 'active' || d.target !== 'branch')) return check(id, 'unknown', 'default_branch_rules_unreadable', readAgain);
    branchIds = ids;
    if (applying.some(d => !d.bypass_actors)) return check(id, 'unknown', 'bypass_list_unreadable', 'The list of who may bypass the default-branch rules is hidden from this credential. ' + readAgain);
    const types = new Set(rules.map(r => r.type));
    const missing = BRANCH_RULES.filter(type => !types.has(type));
    if (missing.length) return check(id, 'fail', 'default_branch_rules_missing', `The default branch is missing active rules: ${missing.map(m => m.replaceAll('_', ' ')).join(', ')}. Run the repository setup again, then read again.`);
    if (!applying.some(namesACheck)) return check(id, 'fail', 'required_checks_empty', 'The default branch has a required-checks rule that names no check, so nothing has to pass before a merge. Add the checks that must pass, then read again.');
    const isPrincipal = (a: z.infer<typeof Actor>) => !!principal && a.actor_type === 'Integration' && a.actor_id === principal.actor_id;
    if (applying.some(d => d.bypass_actors!.some(a => !isPrincipal(a)))) return check(id, 'fail', 'bypass_beyond_merge_principal', 'Someone other than the merging App, such as an administrator role, can bypass the default-branch rules. Remove every other bypass, then read again.');
    if (!principal) return check(id, 'unknown', 'merge_principal_not_declared', 'No merging App was named for this read, so nothing proves who may update the default branch. Name the App and read again.');
    const has = (d: Detail, ...wanted: string[]) => d.rules.some(r => wanted.includes(r.type));
    // Rules add up across rulesets: every update restriction in effect must let the App through, or nobody can merge.
    const restricting = applying.filter(d => has(d, 'update'));
    if (!restricting.length || !restricting.every(d => d.bypass_actors!.some(isPrincipal))) return check(id, 'fail', 'merge_principal_cannot_update', 'Updates to the default branch are restricted, but the merging App is not the one allowed through. Allow only that App on the update restriction.');
    if (applying.some(d => has(d, 'pull_request', 'required_status_checks') && d.bypass_actors!.some(isPrincipal))) return check(id, 'fail', 'merge_principal_exempt_from_checks', 'The merging App can skip the pull-request and required-check rules. Keep its exception on the update restriction only, in a separate ruleset.');
    // An exception covers every rule in its ruleset, so the App's exception must not sit beside the deletion or force-push rules either.
    if (applying.some(d => has(d, 'deletion', 'non_fast_forward') && d.bypass_actors!.some(isPrincipal))) return check(id, 'fail', 'merge_principal_can_delete_or_force_push', 'The merging App\'s exception sits in a ruleset that also carries the deletion or force-push rule, so the App could delete or force-push the default branch. Keep its exception on the update restriction only, in a separate ruleset.');
    return check(id, 'pass', 'default_branch_restricted', 'No action needed.');
  })();

  // 5. Plan tags. The host has no "rules for this tag" read, so only a ruleset
  // whose own conditions plainly cover every plan tag is counted. Plan tags are
  // nested (plan/<workload>/vN) and `*` does not cross a slash; the host's
  // documentation shows only the `/**/*` form as matching any number of slashes,
  // so `refs/tags/plan/**` is not counted.
  const coversPlanTags = (d: Detail) => d.target === 'tag' && d.source_type === 'Repository' && !!d.conditions?.ref_name &&
    d.conditions.ref_name.exclude.length === 0 && d.conditions.ref_name.include.some(pattern => pattern === 'refs/tags/plan/**/*' || pattern === '~ALL');
  const tag = ((): HostingCheck => {
    const id = 'plan_tag_protection';
    if (rulesetsUnreadable) return check(id, 'unknown', 'rulesets_unreadable', readAgain, rulesetsUnreadable.status);
    const candidates = details.filter(d => coversPlanTags(d) && d.enforcement === 'active' && ['update', 'deletion'].every(type => d.rules.some(r => r.type === type)));
    if (candidates.some(d => d.bypass_actors?.length === 0)) return check(id, 'pass', 'plan_tags_protected', 'No action needed.');
    if (candidates.some(d => !d.bypass_actors)) return check(id, 'unknown', 'bypass_list_unreadable', 'The list of who may bypass the plan-tag rules is hidden from this credential. ' + readAgain);
    return check(id, 'fail', 'plan_tags_unprotected', 'An approved plan tag can still be moved or deleted. It needs an active tag ruleset on this repository covering every plan tag, blocking updates and deletions, with nobody allowed to bypass it.');
  })();

  const checks = [identity, hosting, branch, tag];
  const blocked_by = checks.filter(c => c.result !== 'pass').map(c => c.id);
  const report = HostingCapabilityReport.parse({
    schema_version: 1, purpose: 'hosting_capability_readiness', repository, trusted_merge_principal: principal, native_environment_reviewers,
    rulesets: details.map(d => ({ id: d.id, name: d.name, target: d.target, source_type: d.source_type, enforcement: d.enforcement,
      applies_to: branchIds.has(d.id) ? 'default_branch' : coversPlanTags(d) ? 'plan_tags' : 'not_counted', rule_types: d.rules.map(r => r.type),
      bypass_actors: d.bypass_actors ? d.bypass_actors.map(a => ({ actor_type: a.actor_type, actor_id: a.actor_id ?? null, bypass_mode: a.bypass_mode ?? 'unknown' })) : null })),
    checks, result: blocked_by.length ? 'blocked' : 'ready', blocked_by, waivers: 0, api_effect: 'none', api_requests: requests,
    observed_at: options.now ?? new Date().toISOString(),
  });
  try { return { report, sha256: brokerDigest(report) }; } catch (error) {
    if (error instanceof Error && error.message === 'broker_input_too_large') throw new HostingReportTooLarge(Buffer.byteLength(JSON.stringify(report)));
    throw error;
  }
}

/** Consumer side: a report counts only as the exact bytes that were read, for
 * the repository the caller means. Anything else is not ready. */
export function checkHostingCapability(raw: unknown, sha256: string, expected: { repository_id: number }):
{ ready: boolean; code: string; blocked_by: CheckId[] } {
  const parsed = HostingCapabilityReport.safeParse(raw);
  if (!parsed.success) return { ready: false, code: 'hosting_report_invalid', blocked_by: [] };
  let digest: string;
  try { digest = brokerDigest(parsed.data); } catch { return { ready: false, code: 'hosting_report_invalid', blocked_by: [] }; }
  if (digest !== sha256) return { ready: false, code: 'hosting_report_digest_mismatch', blocked_by: [] };
  if (parsed.data.repository.id !== expected.repository_id) return { ready: false, code: 'hosting_report_other_repository', blocked_by: [] };
  return parsed.data.result === 'ready' ? { ready: true, code: 'hosting_ready', blocked_by: [] } :
    { ready: false, code: 'hosting_blocked', blocked_by: parsed.data.blocked_by };
}
