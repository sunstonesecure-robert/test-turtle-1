import { Octokit } from '@octokit/rest';

/**
 * The Migration-Ready seam: every GitHub read/write in the dashboard AND the
 * gate CLIs goes through a client created here. V2 swaps this module, nothing else.
 *
 * ETag caching: GETs send If-None-Match from an in-memory cache and re-serve the
 * cached body on 304 (dashboard-github-api.md "Error & consistency contract").
 */

export interface RepoRef {
  owner: string;
  repo: string;
}

export interface ClientOptions {
  token?: string;
  baseUrl?: string;
  /** injectable fetch so tests and the msw mock intercept every request */
  fetch?: typeof globalThis.fetch;
}

const etagCache = new Map<string, { etag: string; body: unknown; status: number }>();

export function createClient(opts: ClientOptions = {}): Octokit {
  const token = opts.token ?? process.env.GITHUB_TOKEN;
  const octokit = new Octokit({
    auth: token,
    baseUrl: opts.baseUrl ?? process.env.GITHUB_API_URL ?? 'https://api.github.com',
    request: {
      fetch: opts.fetch,
      retries: 2,
      retryAfter: 1,
    },
  });

  octokit.hook.wrap('request', async (request, options) => {
    const isGet = options.method === 'GET';
    const key = isGet ? `${options.method} ${options.url} ${JSON.stringify(options)}` : '';
    if (isGet) {
      const cached = etagCache.get(key);
      if (cached) {
        (options.headers as Record<string, string>)['if-none-match'] = cached.etag;
      }
      try {
        const response = await request(options);
        const etag = response.headers?.etag;
        if (etag) etagCache.set(key, { etag, body: response.data, status: response.status });
        return response;
      } catch (error: unknown) {
        const status = (error as { status?: number }).status;
        const cached = etagCache.get(key);
        if (status === 304 && cached) {
          return { data: cached.body, status: cached.status, headers: {}, url: options.url } as never;
        }
        throw error;
      }
    }
    return request(options);
  });

  return octokit;
}

export function repoFromEnv(): RepoRef {
  const owner = process.env.OWNER;
  const repo = process.env.REPO;
  if (!owner || !repo) throw new Error('OWNER and REPO environment variables are required');
  return { owner, repo };
}
