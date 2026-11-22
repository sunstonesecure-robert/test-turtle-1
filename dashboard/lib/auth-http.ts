import { z } from 'zod';
import { DeviceSignIn, SignInFailure } from './github/auth';

export const SESSION_COOKIE = 'turtles_session', DEVICE_COOKIE = 'turtles_device';
export function requireSameOrigin(request: Request) {
  const origin = request.headers.get('origin');
  if (origin !== new URL(request.url).origin || request.headers.get('sec-fetch-site') === 'cross-site' ||
      request.headers.get('content-type')?.split(';')[0] !== 'application/json') throw new SignInFailure('request_origin_refused');
}
export function cookieValue(request: Request, name: string) {
  const cookie = (request.headers.get('cookie') ?? '').split(';').map(p => p.trim()).find(p => p.startsWith(`${name}=`));
  return cookie?.slice(name.length + 1) ?? '';
}
export function authResponse(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });
}
function setCookie(response: Response, request: Request, name: string, value: string, age: number) {
  const path = name === DEVICE_COOKIE ? '/api/auth' : '/';
  response.headers.append('set-cookie', `${name}=${value}; Path=${path}; HttpOnly; SameSite=Strict; Max-Age=${age}${new URL(request.url).protocol === 'https:' ? '; Secure' : ''}`);
}
export function authHandlers(service: DeviceSignIn) {
  return {
    async GET(request: Request) {
      try { return authResponse({ status: 'authenticated', identity: await service.identity(cookieValue(request, SESSION_COOKIE)) }); }
      catch { return authResponse({ status: 'signed_out' }); }
    },
    async POST(request: Request) {
      try {
        requireSameOrigin(request);
        const parsed = z.object({ action: z.enum(['start', 'poll', 'logout']) }).strict().safeParse(await request.json());
        if (!parsed.success) return authResponse({ code: 'invalid_auth_request' }, 400);
        const device = cookieValue(request, DEVICE_COOKIE), session = cookieValue(request, SESSION_COOKIE);
        if (parsed.data.action === 'start') {
          service.logout(device);
          const { flow_id, ...view } = await service.start();
          const response = authResponse(view); setCookie(response, request, DEVICE_COOKIE, flow_id, view.expires_in); return response;
        }
        if (parsed.data.action === 'logout') {
          service.logout(session); service.logout(device);
          const response = authResponse({ status: 'signed_out' });
          setCookie(response, request, SESSION_COOKIE, '', 0); setCookie(response, request, DEVICE_COOKIE, '', 0); return response;
        }
        const result = await service.poll(device);
        if (result.status === 'pending') return authResponse(result);
        service.logout(session);
        const response = authResponse({ status: 'authenticated', identity: result.identity });
        setCookie(response, request, SESSION_COOKIE, result.session_id, 15897600); setCookie(response, request, DEVICE_COOKIE, '', 0); return response;
      } catch (error) {
        const code = error instanceof SignInFailure ? error.code : 'sign_in_unavailable';
        return authResponse({ code }, code === 'request_origin_refused' ? 403 : 400);
      }
    },
  };
}
