import { createPrivateKey, createSign, type KeyObject } from 'node:crypto';
import { Octokit } from '@octokit/rest';
import { z } from 'zod';

const id = z.number().int().positive().safe();
const repository = z.object({ id, full_name: z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/) }).strict();
const headers = { 'x-github-api-version': '2026-03-10' };
const log = { debug() {}, info() {}, warn() {}, error() {} };
/** The only token shapes this broker mints: one repository, exactly these
 * permissions. GitHub adds Metadata read to every installation token. */
export const TOKEN_ROLES = {
  state_writer: { app: 'control_plane_writer', permissions: { contents: 'write' } },
  audit_writer: { app: 'control_plane_writer', permissions: { contents: 'write' } },
  // Environment variables are read under the documented `environments` token permission;
  // GitHub documents no installation-token key for repository-level variables.
  safety_reader: { app: 'control_plane_writer', permissions: { environments: 'read' } },
  governed_reader: { app: 'proposal_author', permissions: { actions: 'read', contents: 'read', issues: 'read', pull_requests: 'read' } },
  trial_proposer: { app: 'proposal_author', permissions: { contents: 'write', pull_requests: 'write' } },
} as const;
export type TokenRole = keyof typeof TOKEN_ROLES;
export const MintPlan = z.object({ role: z.enum(Object.keys(TOKEN_ROLES) as [TokenRole, ...TokenRole[]]), app_id: id, installation_id: id,
  owner: z.string().regex(/^[A-Za-z0-9-]+$/), repository }).strict();
export type MintPlan = z.infer<typeof MintPlan>;
export class CredentialFailure extends Error { constructor(readonly code: string) { super(code); } }
const fact: (value: unknown, code: string) => asserts value = (value, code) => { if (!value) throw new CredentialFailure(code); };
const MAX_TOKEN_LIFETIME_MS = 3_600_000, CLOCK_TOLERANCE_MS = 120_000;

/** Parse an App private key held only in this process. A malformed or non-RSA
 * key fails here, with no part of the input in the error. */
export function loadAppKey(pem: string | undefined): KeyObject {
  try {
    const key = createPrivateKey({ key: z.string().min(1).parse(pem), format: 'pem' });
    fact(key.asymmetricKeyType === 'rsa', 'app_key_invalid'); return key;
  } catch { throw new CredentialFailure('app_key_invalid'); }
}
const b64 = (value: Buffer | string) => Buffer.from(value).toString('base64url');
/** Short-lived App JWT (RS256), backdated one minute for clock difference.
 * https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/generating-a-json-web-token-jwt-for-a-github-app */
export function appJwt(appId: number, key: KeyObject, now: string): string {
  const seconds = Math.floor(Date.parse(z.string().datetime().parse(now)) / 1000);
  const body = `${b64(JSON.stringify({ alg: 'RS256', typ: 'JWT' }))}.${b64(JSON.stringify({ iat: seconds - 60, exp: seconds + 540, iss: String(id.parse(appId)) }))}`;
  return `${body}.${b64(createSign('RSA-SHA256').update(body).sign(key))}`;
}
export interface MintedToken { token: string; expires_at: string; permissions: Record<string, 'read' | 'write'>; plan: MintPlan }
export interface AppTransport { mint(plan: MintPlan): Promise<MintedToken>; revoke(token: string): Promise<void>; client(token: string): Octokit }

/** Mints one-repository installation tokens for the fixed roles above. The App
 * and installation are re-read natively before each mint, and the returned
 * grant must be exactly the single repository and permissions asked for.
 * Nothing here stores, prints or returns a private key.
 * https://docs.github.com/en/rest/apps/apps#create-an-installation-access-token-for-an-app */
export function appTransport(keys: Partial<Record<'control_plane_writer' | 'proposal_author', KeyObject>>, now: () => string, baseUrl?: string): AppTransport {
  const client = (auth: string) => new Octokit({ auth, log, ...(baseUrl ? { baseUrl } : {}) });
  return {
    client,
    async mint(rawPlan) {
      const plan = MintPlan.parse(rawPlan), role = TOKEN_ROLES[plan.role], key = keys[role.app];
      fact(key, 'app_key_missing');
      fact(plan.repository.full_name.split('/')[0]!.toLowerCase() === plan.owner.toLowerCase(), 'installation_identity_changed');
      const app = client(appJwt(plan.app_id, key, now()));
      const principal = z.object({ id, owner: z.object({ login: z.literal('SunStone-Secure-LLC') }) }).safeParse((await app.request('GET /app', { headers })).data);
      fact(principal.success && principal.data.id === plan.app_id, 'app_identity_changed');
      const native = z.object({ id, app_id: id, account: z.object({ login: z.string() }), suspended_at: z.null() })
        .safeParse((await app.request('GET /app/installations/{installation_id}', { installation_id: plan.installation_id, headers })).data);
      fact(native.success && native.data.id === plan.installation_id && native.data.app_id === plan.app_id &&
        native.data.account.login.toLowerCase() === plan.owner.toLowerCase(), 'installation_identity_changed');
      // Omitting either field would inherit the installation's wider defaults.
      const response = await app.request('POST /app/installations/{installation_id}/access_tokens', { installation_id: plan.installation_id,
        repository_ids: [plan.repository.id], permissions: role.permissions, headers });
      const raw = response.data as { token?: unknown };
      const secret = typeof raw?.token === 'string' ? raw.token : null;
      try {
        const granted = z.object({ token: z.string().min(1), expires_at: z.string().datetime(), repository_selection: z.literal('selected'),
          repositories: z.array(z.object({ id, full_name: z.string() })).length(1), permissions: z.record(z.string(), z.enum(['read', 'write'])) }).safeParse(response.data);
        fact(granted.success, 'token_response_invalid');
        const token = granted.data, { metadata, ...permissions } = token.permissions;
        fact(token.repositories[0]!.id === plan.repository.id && token.repositories[0]!.full_name === plan.repository.full_name &&
          (metadata === undefined || metadata === 'read') && JSON.stringify(Object.entries(permissions).sort()) === JSON.stringify(Object.entries(role.permissions).sort()), 'token_grant_mismatch');
        const observed = Date.parse(now()), expires = Date.parse(token.expires_at);
        fact(expires > observed, 'token_expired'); fact(expires - observed <= MAX_TOKEN_LIFETIME_MS + CLOCK_TOLERANCE_MS, 'token_lifetime_exceeded');
        return { token: token.token, expires_at: token.expires_at, permissions: { ...role.permissions }, plan };
      } catch (error) {
        // A credential that fails its checks is disposed of, never handed on.
        if (secret) { try { await client(secret).apps.revokeInstallationAccessToken({ headers }); } catch { throw new CredentialFailure('token_cleanup_unknown'); } }
        throw error;
      }
    },
    // Revokes a credential, never a record: the same typed call the broker read transport uses.
    async revoke(token) { await client(token).apps.revokeInstallationAccessToken({ headers }); },
  };
}
