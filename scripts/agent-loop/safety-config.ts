import type { Octokit } from '@octokit/rest';
import { z } from 'zod';
import { brokerDigest } from '../control-plane/broker';

export const SAFETY_VARIABLE = 'AGENT_LOOP_SAFETY';
/** GitHub's documented configuration-variable limits. A workflow's `vars` context
 * keeps only the variables that fit under the combined size, taken in
 * alphabetical order, so the context can silently lose a safety setting.
 * https://docs.github.com/en/actions/reference/workflows-and-actions/variables#limits-for-configuration-variables */
export const VARIABLE_LIMITS = { repository_count: 500, environment_count: 100, value_bytes: 48 * 1024, context_bytes: 256 * 1024 } as const;
const id = z.number().int().positive().safe(), bytes = z.number().int().min(2048).max(524288);
const repository = z.object({ id, full_name: z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/) }).strict();
/** One strict versioned document. There is no default for any field: an absent,
 * unreadable or malformed setting blocks; it is never read as "no limit". */
export const SafetySettings = z.object({
  schema_version: z.literal(1), purpose: z.literal('agent_loop_safety'), governed_repository_id: id, state_repository_id: id,
  /** true: no new reservation, consume or record. Stop and receipt work continues. */
  stop: z.boolean(),
  state: z.object({ maximum_state_bytes: bytes, receipt_reserve_bytes: z.number().int().min(1024).max(262144),
    maximum_conflict_reloads: z.number().int().min(0).max(3), maximum_history_commits: z.number().int().min(1).max(100),
    maximum_api_requests: z.number().int().min(16).max(256) }).strict(),
  documents: z.object({ maximum_journal_bytes: bytes, maximum_audit_bytes: bytes }).strict(),
  /** GitHub core rate-limit requests kept back for stop and receipt work. */
  api: z.object({ minimum_remaining: z.number().int().min(0).max(15000) }).strict(),
  requests: z.object({ maximum_sources: z.number().int().min(1).max(20), overlap_seconds: z.number().int().min(60).max(86400),
    maximum_pages: z.number().int().min(1).max(10) }).strict(),
  variables: z.object({ reserve_count: z.number().int().min(0).max(VARIABLE_LIMITS.environment_count),
    reserve_bytes: z.number().int().min(0).max(VARIABLE_LIMITS.context_bytes) }).strict(),
}).strict().refine(s => s.state.receipt_reserve_bytes < s.state.maximum_state_bytes, 'The receipt reserve must fit inside the state limit.');
export type SafetySettings = z.infer<typeof SafetySettings>;
export interface VariableHeadroom {
  count: number; total_bytes: number; largest_bytes: number; count_remaining: number; bytes_remaining: number;
  /** Names a workflow's `vars` context would not carry at this size. */
  context_cutoff: string[];
}
export type SafetyBlock = 'safety_repository_mismatch' | 'safety_setting_missing' | 'safety_setting_unreadable' | 'safety_setting_invalid' |
  'safety_setting_binding_invalid' | 'safety_setting_changed' | 'safety_variables_unreadable';
export interface SafetyConfig {
  status: 'ready'; settings: SafetySettings; sha256: string; variables: VariableHeadroom; api_requests: number;
  /** Null, or why no new admission may start while stop and receipt work continues. */
  admission_block: 'operator_stop' | 'safety_variable_headroom_exhausted' | null;
}
export type SafetyRead = SafetyConfig | { status: 'blocked'; code: SafetyBlock; api_requests: number; http_status?: number };
/** `environment` null reads repository variables; a name reads that environment's
 * variables, which an installation token can be scoped to (`environments: read`). */
const Expected = z.object({ repository, environment: z.string().regex(/^[A-Za-z0-9_.-]{1,100}$/).nullable(),
  governed_repository_id: id, state_repository_id: id }).strict();
const size = (text: string) => Buffer.byteLength(text);
const statusOf = (error: unknown) => { const s = (error as { status?: unknown })?.status; return typeof s === 'number' && Number.isInteger(s) ? s : undefined; };

/** Which variables a workflow's context would drop: alphabetical by name, kept
 * while the running total stays within the combined limit. */
export function contextCutoff(variables: Array<{ name: string; value: string }>, limit: number = VARIABLE_LIMITS.context_bytes): string[] {
  let total = 0; const dropped: string[] = [];
  for (const v of [...variables].sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0)) {
    total += size(v.name) + size(v.value);
    if (total > limit) dropped.push(v.name);
  }
  return dropped;
}

/** Direct REST reads of one repository's or environment's variables with the supplied
 * client. There is deliberately no `vars`-context, environment or default
 * fallback: this module never reads `process.env`. Only status codes leave a
 * failed request; response bodies and messages are not copied anywhere. */
export async function readSafetyConfig(gh: Octokit, rawExpected: unknown): Promise<SafetyRead> {
  const expected = Expected.parse(rawExpected), [owner, repo] = expected.repository.full_name.split('/') as [string, string];
  let requests = 0;
  const scope = expected.environment === null ? '/repos/{owner}/{repo}/actions/variables' : '/repos/{owner}/{repo}/environments/{environment_name}/variables';
  const maximumCount = expected.environment === null ? VARIABLE_LIMITS.repository_count : VARIABLE_LIMITS.environment_count;
  const where = expected.environment === null ? {} : { environment_name: expected.environment };
  const api = (route: string, params: Record<string, unknown> = {}) => { requests++;
    return gh.request(route, { owner, repo, ...params, headers: { 'cache-control': 'no-cache', 'x-github-api-version': '2026-03-10' }, request: { timeout: 15000 } }); };
  const blocked = (code: SafetyBlock, error?: unknown): SafetyRead => ({ status: 'blocked', code, api_requests: requests, ...(statusOf(error) ? { http_status: statusOf(error) } : {}) });
  try {
    const native = z.object({ id: z.literal(expected.repository.id), full_name: z.literal(expected.repository.full_name) }).safeParse((await api('GET /repos/{owner}/{repo}')).data);
    if (!native.success) return blocked('safety_repository_mismatch');
  } catch (error) { return blocked('safety_setting_unreadable', error); }
  let value: string;
  try {
    const response = await api(`GET ${scope}/{name}`, { ...where, name: SAFETY_VARIABLE });
    value = z.object({ name: z.literal(SAFETY_VARIABLE), value: z.string().max(VARIABLE_LIMITS.value_bytes) }).parse(response.data).value;
  } catch (error) {
    // Only a verified 404 is absence. Both absence and an unreadable setting block.
    return blocked(statusOf(error) === 404 ? 'safety_setting_missing' : 'safety_setting_unreadable', error);
  }
  let settings: SafetySettings;
  try { settings = SafetySettings.parse(JSON.parse(value)); } catch { return blocked('safety_setting_invalid'); }
  if (settings.governed_repository_id !== expected.governed_repository_id || settings.state_repository_id !== expected.state_repository_id) return blocked('safety_setting_binding_invalid');
  const variables: Array<{ name: string; value: string }> = [];
  try {
    // The list endpoints return at most 30 per page.
    const pages = Math.ceil(maximumCount / 30);
    for (let page = 1; page <= pages; page++) {
      const data = z.object({ total_count: z.number().int().nonnegative().max(maximumCount),
        variables: z.array(z.object({ name: z.string().min(1).max(256), value: z.string() })).max(30) })
        .parse((await api(`GET ${scope}`, { ...where, per_page: 30, page })).data);
      variables.push(...data.variables.map(v => ({ name: v.name, value: v.value })));
      if (variables.length === data.total_count) break;
      if (!data.variables.length || variables.length > data.total_count || page === pages) return blocked('safety_variables_unreadable');
    }
  } catch (error) { return blocked('safety_variables_unreadable', error); }
  const listed = variables.filter(v => v.name === SAFETY_VARIABLE);
  if (new Set(variables.map(v => v.name)).size !== variables.length || listed.length !== 1) return blocked('safety_variables_unreadable');
  if (listed[0]!.value !== value) return blocked('safety_setting_changed');
  const total = variables.reduce((n, v) => n + size(v.name) + size(v.value), 0);
  const headroom: VariableHeadroom = { count: variables.length, total_bytes: total, largest_bytes: Math.max(...variables.map(v => size(v.value))),
    count_remaining: maximumCount - variables.length, bytes_remaining: VARIABLE_LIMITS.context_bytes - total,
    context_cutoff: contextCutoff(variables) };
  const exhausted = headroom.count_remaining < settings.variables.reserve_count || headroom.bytes_remaining < settings.variables.reserve_bytes;
  return { status: 'ready', settings, sha256: brokerDigest(settings), variables: headroom, api_requests: requests,
    admission_block: settings.stop ? 'operator_stop' : exhausted ? 'safety_variable_headroom_exhausted' : null };
}

export type SafetyRecheck = { status: 'unchanged'; api_requests: 1 } |
  { status: 'blocked'; code: Extract<SafetyBlock, 'safety_setting_missing' | 'safety_setting_unreadable' | 'safety_setting_invalid' | 'safety_setting_changed'>; api_requests: 1; http_status?: number };
/** One read of the setting alone, made before each new admission, so a stop or a
 * lowered limit set during a run takes hold at the next admission instead of the
 * next run. The settings the run started with stay in force for stop and receipt
 * work. Any difference, loss or unreadable answer admits nothing further in this
 * run; the next run reads the new settings in full. Whitespace-only edits are not
 * a difference: the comparison is of the parsed settings' digest. */
export async function recheckSafety(gh: Octokit, rawExpected: unknown, held: Pick<SafetyConfig, 'sha256'>): Promise<SafetyRecheck> {
  const expected = Expected.parse(rawExpected), [owner, repo] = expected.repository.full_name.split('/') as [string, string];
  const route = expected.environment === null ? 'GET /repos/{owner}/{repo}/actions/variables/{name}' : 'GET /repos/{owner}/{repo}/environments/{environment_name}/variables/{name}';
  let value: string;
  try {
    const response = await gh.request(route, { owner, repo, ...(expected.environment === null ? {} : { environment_name: expected.environment }), name: SAFETY_VARIABLE,
      headers: { 'cache-control': 'no-cache', 'x-github-api-version': '2026-03-10' }, request: { timeout: 15000 } });
    value = z.object({ name: z.literal(SAFETY_VARIABLE), value: z.string().max(VARIABLE_LIMITS.value_bytes) }).parse(response.data).value;
  } catch (error) {
    const status = statusOf(error);
    return { status: 'blocked', code: status === 404 ? 'safety_setting_missing' : 'safety_setting_unreadable', api_requests: 1, ...(status ? { http_status: status } : {}) };
  }
  let settings: SafetySettings;
  try { settings = SafetySettings.parse(JSON.parse(value)); } catch { return { status: 'blocked', code: 'safety_setting_invalid', api_requests: 1 }; }
  return brokerDigest(settings) === held.sha256 ? { status: 'unchanged', api_requests: 1 } : { status: 'blocked', code: 'safety_setting_changed', api_requests: 1 };
}

export interface RateSnapshot { limit: number; remaining: number; reset_at: string }
/** GitHub's own remaining core quota for this credential; null when unreadable. */
export async function readRateLimit(gh: Octokit): Promise<RateSnapshot | null> {
  try {
    const core = z.object({ resources: z.object({ core: z.object({ limit: z.number().int().nonnegative(), remaining: z.number().int().nonnegative(),
      reset: z.number().int().positive() }) }) }).parse((await gh.request('GET /rate_limit', { headers: { 'x-github-api-version': '2026-03-10' }, request: { timeout: 15000 } })).data).resources.core;
    return { limit: core.limit, remaining: core.remaining, reset_at: new Date(core.reset * 1000).toISOString() };
  } catch { return null; }
}

export type Gate = { allowed: true } | { allowed: false; code: 'safety_settings_missing' | 'operator_stop' | 'safety_variable_headroom_exhausted' | 'api_rate_unknown' | 'api_rate_headroom_exhausted' };
/** Stop and receipt work keeps the reserved room. Everything that admits new
 * work needs readable settings, variable headroom and room for its API budget
 * above the reserve. The runtime also counts adapter calls against that room. */
export function admissionGate(config: SafetyRead, kind: 'reserve' | 'consume' | 'record' | 'stop' | 'receipt', rate: RateSnapshot | null): Gate {
  if (config.status !== 'ready') return { allowed: false, code: 'safety_settings_missing' };
  if (kind === 'stop' || kind === 'receipt') return { allowed: true };
  if (config.admission_block) return { allowed: false, code: config.admission_block };
  if (!rate) return { allowed: false, code: 'api_rate_unknown' };
  if (rate.remaining < config.settings.api.minimum_remaining + config.settings.state.maximum_api_requests) return { allowed: false, code: 'api_rate_headroom_exhausted' };
  return { allowed: true };
}

/** The canonical store's limits come only from readable settings. */
export const storeLimits = (settings: SafetySettings) => ({ ...SafetySettings.parse(settings).state });
