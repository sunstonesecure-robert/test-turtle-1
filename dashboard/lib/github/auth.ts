import { randomBytes } from 'node:crypto';
import { Octokit } from '@octokit/rest';
import { z } from 'zod';
import { SignInApp } from '../../../schemas/agent-loop-authority';

export { SignInApp } from '../../../schemas/agent-loop-authority';
const Human = z.object({ id: z.number().int().positive().safe(), login: z.string().regex(/^[A-Za-z0-9-]+$/), type: z.literal('User') });
export type OperatorIdentity = z.infer<typeof Human> & { app_id: number };
const Tokens = z.object({ access_token: z.string().regex(/^ghu_[A-Za-z0-9_]+$/), refresh_token: z.string().regex(/^ghr_[A-Za-z0-9_]+$/),
  expires_in: z.number().int().positive().max(28800), refresh_token_expires_in: z.number().int().positive().max(15897600),
  token_type: z.literal('bearer'), scope: z.literal('') });
type Flow = { device_code: string; expires: number; next_poll: number; interval: number; busy: boolean };
type Session = { access: string; refresh: string; expires: number; refresh_expires: number; identity: OperatorIdentity; refreshing?: Promise<void> };
export class SignInFailure extends Error { constructor(readonly code: string) { super(code); } }
const quiet = { debug() {}, info() {}, warn() {}, error() {} };

/** Server-process credential vault only. Browser cookies contain random handles.
 * Restart requires sign-in again; neither sessions nor login grant loop authority.
 * No environment token fallback, client secret, generic proxy, or token export. */
export class DeviceSignIn {
  readonly app: z.infer<typeof SignInApp>;
  private flows = new Map<string, Flow>();
  private sessions = new Map<string, Session>();
  private now: () => number;
  private fetch: typeof globalThis.fetch;
  constructor(app: unknown, options: { now?: () => number; fetch?: typeof globalThis.fetch } = {}) {
    this.app = SignInApp.parse(app); this.now = options.now ?? Date.now; this.fetch = options.fetch ?? globalThis.fetch;
  }
  private async oauth(path: 'device/code' | 'oauth/access_token', parameters: Record<string, string>): Promise<unknown> {
    try {
      const response = await this.fetch(`https://github.com/login/${path}`, { method: 'POST', redirect: 'error',
        headers: { accept: 'application/json', 'content-type': 'application/x-www-form-urlencoded', 'cache-control': 'no-store' },
        body: new URLSearchParams({ client_id: this.app.client_id, ...parameters }), signal: AbortSignal.timeout(15000) });
      if (!response.ok) throw new Error(); return await response.json();
    } catch { throw new SignInFailure('device_authorization_refused'); }
  }
  private prune() {
    const now = this.now();
    for (const [id, flow] of this.flows) if (flow.expires < now) this.flows.delete(id);
    for (const [id, session] of this.sessions) if (session.refresh_expires <= now) this.sessions.delete(id);
    if (this.flows.size + this.sessions.size >= 100) throw new SignInFailure('sign_in_capacity_exhausted');
  }
  async start() {
    this.prune();
    try {
      const response = await this.fetch(`https://api.github.com/apps/${this.app.slug}`, { redirect: 'error',
        headers: { accept: 'application/vnd.github+json', 'cache-control': 'no-store' }, signal: AbortSignal.timeout(15000) });
      const native = z.object({ id: z.literal(this.app.app_id), client_id: z.literal(this.app.client_id), slug: z.literal(this.app.slug),
        permissions: z.object({ contents: z.literal('read'), issues: z.literal('write'), pull_requests: z.literal('write'), metadata: z.literal('read').optional() }).strict() });
      if (!response.ok || !native.safeParse(await response.json()).success) throw new Error();
    } catch { throw new SignInFailure('sign_in_app_mismatch'); }
    const raw = await this.oauth('device/code', { scope: 'offline_access' });
    const value = z.object({ device_code: z.string().min(1).max(1024), user_code: z.string().regex(/^[A-Z0-9-]{4,32}$/),
      verification_uri: z.literal('https://github.com/login/device'), expires_in: z.number().int().positive().max(900),
      interval: z.number().int().min(1).max(60) }).safeParse(raw);
    if (!value.success) throw new SignInFailure('device_authorization_refused');
    const flow_id = randomBytes(32).toString('hex'), now = this.now(), d = value.data;
    this.flows.set(flow_id, { device_code: d.device_code, expires: now + d.expires_in * 1000,
      next_poll: now + d.interval * 1000, interval: d.interval * 1000, busy: false });
    return { flow_id, user_code: d.user_code, verification_uri: d.verification_uri, expires_in: d.expires_in, interval: d.interval };
  }
  private client(access: string) { return new Octokit({ auth: access, request: { fetch: this.fetch, timeout: 15000 }, log: quiet }); }
  private async human(access: string): Promise<OperatorIdentity> {
    try {
      const response = await this.client(access).request('GET /user', { headers: { 'cache-control': 'no-cache' } });
      return { ...Human.parse(response.data), app_id: this.app.app_id };
    } catch { throw new SignInFailure('sign_in_required'); }
  }
  async poll(id: string): Promise<{ status: 'pending'; interval: number } | { status: 'authenticated'; session_id: string; identity: OperatorIdentity }> {
    const flow = this.flows.get(id);
    if (!flow) throw new SignInFailure('sign_in_required');
    if (flow.expires <= this.now()) { this.flows.delete(id); throw new SignInFailure('device_authorization_expired'); }
    if (flow.busy || flow.next_poll > this.now()) return { status: 'pending', interval: Math.ceil(flow.interval / 1000) };
    flow.busy = true; flow.next_poll = this.now() + flow.interval;
    try {
      const raw = await this.oauth('oauth/access_token', { device_code: flow.device_code, grant_type: 'urn:ietf:params:oauth:grant-type:device_code' });
      const error = z.object({ error: z.enum(['authorization_pending', 'slow_down']) }).safeParse(raw);
      if (error.success) {
        if (error.data.error === 'slow_down') { flow.interval += 5000; flow.next_poll = this.now() + flow.interval; }
        return { status: 'pending', interval: Math.ceil(flow.interval / 1000) };
      }
      const tokens = Tokens.safeParse(raw);
      if (!tokens.success) throw new SignInFailure('device_authorization_refused');
      if (this.now() >= flow.expires) throw new SignInFailure('device_authorization_expired');
      const identity = await this.human(tokens.data.access_token), session_id = randomBytes(32).toString('hex');
      this.sessions.set(session_id, { access: tokens.data.access_token, refresh: tokens.data.refresh_token,
        expires: this.now() + tokens.data.expires_in * 1000, refresh_expires: this.now() + tokens.data.refresh_token_expires_in * 1000, identity });
      this.flows.delete(id); return { status: 'authenticated', session_id, identity };
    } catch (error) { this.flows.delete(id); throw error instanceof SignInFailure ? error : new SignInFailure('device_authorization_refused'); }
    finally { flow.busy = false; }
  }
  private async current(id: string): Promise<Session> {
    const session = this.sessions.get(id);
    if (!session || session.refresh_expires <= this.now()) { this.sessions.delete(id); throw new SignInFailure('sign_in_required'); }
    if (session.expires <= this.now()) {
      if (!session.refreshing) session.refreshing = (async () => {
        const raw = await this.oauth('oauth/access_token', { grant_type: 'refresh_token', refresh_token: session.refresh });
        const tokens = Tokens.safeParse(raw);
        if (!tokens.success) throw new SignInFailure('sign_in_required');
        session.access = tokens.data.access_token; session.refresh = tokens.data.refresh_token;
        session.expires = this.now() + tokens.data.expires_in * 1000;
        session.refresh_expires = this.now() + tokens.data.refresh_token_expires_in * 1000;
      })();
      try { await session.refreshing; } catch { this.sessions.delete(id); throw new SignInFailure('sign_in_required'); }
      finally { session.refreshing = undefined; }
    }
    try {
      const human = await this.human(session.access);
      if (human.id !== session.identity.id) throw new SignInFailure('operator_identity_changed');
      session.identity = human; return session;
    } catch (error) { this.sessions.delete(id); throw error; }
  }
  async identity(id: string) { return { ...(await this.current(id)).identity }; }
  /** Only trusted, fixed-purpose server actions receive this client. Never proxy a browser route. */
  async asOperator<T>(id: string, action: (gh: Octokit, identity: OperatorIdentity) => Promise<T>): Promise<T> {
    const session = await this.current(id); return action(this.client(session.access), { ...session.identity });
  }
  logout(id: string) { this.sessions.delete(id); this.flows.delete(id); }
}
