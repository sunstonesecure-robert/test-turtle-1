import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';

type GithubMockServer = ReturnType<typeof setupServer>;

/**
 * msw-based GitHub REST mock (T007, tracer surface): issues, labels, comments,
 * git refs/tags, contents (per-commit file store), pulls + merge, check runs,
 * rulesets, environments, authenticated user. State is in-memory and
 * inspectable so integration tests can assert on the raw system of record.
 */

export interface MockIssue {
  number: number;
  title: string;
  body: string;
  labels: string[];
  state: 'open' | 'closed';
  locked: boolean;
  comments: string[];
}

export interface MockPull {
  number: number;
  head: string;
  base: string;
  merged_at: string | null;
  merged_by: string | null;
  merge_commit_sha: string | null;
}

export interface MockState {
  operator: string;
  labels: Map<string, { color: string }>;
  issues: MockIssue[];
  refs: Map<string, string>; // 'heads/main' | 'tags/plan/demo/v1' → sha
  commits: Map<string, Map<string, string>>; // sha → path → utf8 content
  tagObjects: Map<string, string>; // annotated tag sha → commit sha
  pulls: MockPull[];
  checkRuns: { name: string; head_sha: string; status: string; conclusion: string | null }[];
  rulesets: { id: number; name: string }[];
  environments: Set<string>;
  /** simulate a free-plan private repo: rulesets/environments endpoints return 403 */
  planLimited: boolean;
  /** repo owner type — push rulesets are org-only (readiness I2 waiver on 'User') */
  ownerType: 'Organization' | 'User';
}

let shaCounter = 0;
function newSha(): string {
  shaCounter += 1;
  return `sha${String(shaCounter).padStart(6, '0')}${'0'.repeat(30)}`;
}

export function createState(): MockState {
  const rootSha = newSha();
  const state: MockState = {
    operator: 'sme-operator',
    labels: new Map(),
    issues: [],
    refs: new Map([['heads/main', rootSha]]),
    commits: new Map([[rootSha, new Map()]]),
    tagObjects: new Map(),
    pulls: [],
    checkRuns: [],
    rulesets: [],
    environments: new Set(),
    planLimited: false,
    ownerType: 'Organization',
  };
  return state;
}

function resolveCommit(state: MockState, ref: string): string | null {
  let sha = state.refs.get(`heads/${ref}`) ?? state.refs.get(`tags/${ref}`) ?? state.refs.get(ref);
  if (!sha && state.commits.has(ref)) sha = ref;
  if (!sha) return null;
  return state.tagObjects.get(sha) ?? sha;
}

function commitFiles(state: MockState, fromSha: string | null, changes: Map<string, string>): string {
  const files = new Map(fromSha ? state.commits.get(fromSha) : undefined);
  for (const [path, content] of changes) files.set(path, content);
  const sha = newSha();
  state.commits.set(sha, files);
  return sha;
}

function issueJson(issue: MockIssue) {
  return {
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    locked: issue.locked,
    labels: issue.labels.map((name) => ({ name })),
    html_url: `https://github.test/issues/${issue.number}`,
  };
}

export function createGithubMock(): { server: GithubMockServer; state: MockState; reset: () => void } {
  let state = createState();
  const API = 'https://api.github.com';

  const handlers = [
    // ---------- user & repo ----------
    http.get(`${API}/user`, () => HttpResponse.json({ login: state.operator })),
    http.get(`${API}/repos/:owner/:repo`, ({ params }) =>
      HttpResponse.json({
        full_name: `${params.owner}/${params.repo}`,
        owner: { login: String(params.owner), type: state.ownerType },
      }),
    ),

    // ---------- labels ----------
    http.get(`${API}/repos/:owner/:repo/labels`, () =>
      HttpResponse.json([...state.labels.entries()].map(([name, l]) => ({ name, color: l.color }))),
    ),
    http.post(`${API}/repos/:owner/:repo/labels`, async ({ request }) => {
      const body = (await request.json()) as { name: string; color?: string };
      state.labels.set(body.name, { color: body.color ?? 'ededed' });
      return HttpResponse.json({ name: body.name }, { status: 201 });
    }),

    // ---------- issues ----------
    http.get(`${API}/repos/:owner/:repo/issues`, ({ request }) => {
      const url = new URL(request.url);
      const labelFilter = url.searchParams.get('labels');
      const stateFilter = url.searchParams.get('state') ?? 'open';
      const wanted = labelFilter ? labelFilter.split(',') : [];
      const matches = state.issues.filter((issue) => {
        if (stateFilter !== 'all' && issue.state !== stateFilter) return false;
        return wanted.every((l) => issue.labels.includes(l));
      });
      return HttpResponse.json(matches.map(issueJson));
    }),
    http.post(`${API}/repos/:owner/:repo/issues`, async ({ request }) => {
      const body = (await request.json()) as { title: string; body?: string; labels?: string[] };
      const issue: MockIssue = {
        number: state.issues.length + 1,
        title: body.title,
        body: body.body ?? '',
        labels: body.labels ?? [],
        state: 'open',
        locked: false,
        comments: [],
      };
      state.issues.push(issue);
      return HttpResponse.json(issueJson(issue), { status: 201 });
    }),
    http.get(`${API}/repos/:owner/:repo/issues/:number`, ({ params }) => {
      const issue = state.issues.find((i) => i.number === Number(params.number));
      return issue ? HttpResponse.json(issueJson(issue)) : HttpResponse.json({ message: 'Not Found' }, { status: 404 });
    }),
    http.patch(`${API}/repos/:owner/:repo/issues/:number`, async ({ params, request }) => {
      const issue = state.issues.find((i) => i.number === Number(params.number));
      if (!issue) return HttpResponse.json({ message: 'Not Found' }, { status: 404 });
      if (issue.locked) return HttpResponse.json({ message: 'Locked' }, { status: 403 });
      const body = (await request.json()) as { body?: string; state?: 'open' | 'closed'; title?: string };
      if (body.body !== undefined) issue.body = body.body;
      if (body.state !== undefined) issue.state = body.state;
      if (body.title !== undefined) issue.title = body.title;
      return HttpResponse.json(issueJson(issue));
    }),
    http.put(`${API}/repos/:owner/:repo/issues/:number/lock`, ({ params }) => {
      const issue = state.issues.find((i) => i.number === Number(params.number));
      if (!issue) return HttpResponse.json({ message: 'Not Found' }, { status: 404 });
      issue.locked = true;
      return new HttpResponse(null, { status: 204 });
    }),
    http.post(`${API}/repos/:owner/:repo/issues/:number/comments`, async ({ params, request }) => {
      const issue = state.issues.find((i) => i.number === Number(params.number));
      if (!issue) return HttpResponse.json({ message: 'Not Found' }, { status: 404 });
      const body = (await request.json()) as { body: string };
      issue.comments.push(body.body);
      return HttpResponse.json({ id: issue.comments.length, body: body.body }, { status: 201 });
    }),
    http.get(`${API}/repos/:owner/:repo/issues/:number/comments`, ({ params }) => {
      const issue = state.issues.find((i) => i.number === Number(params.number));
      if (!issue) return HttpResponse.json({ message: 'Not Found' }, { status: 404 });
      return HttpResponse.json(issue.comments.map((body, i) => ({ id: i + 1, body })));
    }),
    http.post(`${API}/repos/:owner/:repo/issues/:number/labels`, async ({ params, request }) => {
      const issue = state.issues.find((i) => i.number === Number(params.number));
      if (!issue) return HttpResponse.json({ message: 'Not Found' }, { status: 404 });
      const body = (await request.json()) as { labels: string[] } | string[];
      const labels = Array.isArray(body) ? body : body.labels;
      for (const l of labels) if (!issue.labels.includes(l)) issue.labels.push(l);
      return HttpResponse.json(issue.labels.map((name) => ({ name })));
    }),
    http.delete(`${API}/repos/:owner/:repo/issues/:number/labels/*`, ({ params, request }) => {
      const issue = state.issues.find((i) => i.number === Number(params.number));
      if (!issue) return HttpResponse.json({ message: 'Not Found' }, { status: 404 });
      const name = decodeURIComponent(new URL(request.url).pathname.split('/labels/')[1]!);
      if (!issue.labels.includes(name)) return HttpResponse.json({ message: 'Label does not exist' }, { status: 404 });
      issue.labels = issue.labels.filter((l) => l !== name);
      return HttpResponse.json(issue.labels.map((n) => ({ name: n })));
    }),

    // ---------- git data ----------
    http.get(`${API}/repos/:owner/:repo/git/matching-refs/*`, ({ request }) => {
      const prefix = decodeURIComponent(new URL(request.url).pathname.split('/git/matching-refs/')[1]!);
      const matches = [...state.refs.entries()]
        .filter(([ref]) => ref.startsWith(prefix))
        .map(([ref, sha]) => ({ ref: `refs/${ref}`, object: { sha, type: state.tagObjects.has(sha) ? 'tag' : 'commit' } }));
      return HttpResponse.json(matches);
    }),
    http.get(`${API}/repos/:owner/:repo/git/ref/*`, ({ request }) => {
      const ref = decodeURIComponent(new URL(request.url).pathname.split('/git/ref/')[1]!);
      const sha = state.refs.get(ref);
      if (!sha) return HttpResponse.json({ message: 'Not Found' }, { status: 404 });
      return HttpResponse.json({ ref: `refs/${ref}`, object: { sha, type: state.tagObjects.has(sha) ? 'tag' : 'commit' } });
    }),
    http.post(`${API}/repos/:owner/:repo/git/refs`, async ({ request }) => {
      const body = (await request.json()) as { ref: string; sha: string };
      const ref = body.ref.replace(/^refs\//, '');
      if (state.refs.has(ref)) {
        return HttpResponse.json({ message: 'Reference already exists' }, { status: 422 });
      }
      state.refs.set(ref, body.sha);
      return HttpResponse.json({ ref: body.ref, object: { sha: body.sha } }, { status: 201 });
    }),
    http.post(`${API}/repos/:owner/:repo/git/tags`, async ({ request }) => {
      const body = (await request.json()) as { tag: string; message: string; object: string; type: string };
      const tagSha = newSha();
      state.tagObjects.set(tagSha, body.object);
      return HttpResponse.json({ sha: tagSha, tag: body.tag, message: body.message, object: { sha: body.object } }, { status: 201 });
    }),

    // ---------- contents ----------
    http.get(`${API}/repos/:owner/:repo/contents/*`, ({ request }) => {
      const url = new URL(request.url);
      const path = decodeURIComponent(url.pathname.split('/contents/')[1]!);
      const ref = url.searchParams.get('ref') ?? 'main';
      const commitSha = resolveCommit(state, ref);
      const content = commitSha ? state.commits.get(commitSha)?.get(path) : undefined;
      if (content === undefined) return HttpResponse.json({ message: 'Not Found' }, { status: 404 });
      return HttpResponse.json({
        type: 'file',
        path,
        sha: `file-${path}`,
        content: Buffer.from(content).toString('base64'),
        encoding: 'base64',
      });
    }),
    http.put(`${API}/repos/:owner/:repo/contents/*`, async ({ request }) => {
      const url = new URL(request.url);
      const path = decodeURIComponent(url.pathname.split('/contents/')[1]!);
      const body = (await request.json()) as { message: string; content: string; branch?: string; sha?: string };
      const branch = body.branch ?? 'main';
      const headSha = state.refs.get(`heads/${branch}`);
      if (headSha === undefined) return HttpResponse.json({ message: 'Branch not found' }, { status: 404 });
      const content = Buffer.from(body.content, 'base64').toString('utf8');
      const sha = commitFiles(state, headSha, new Map([[path, content]]));
      state.refs.set(`heads/${branch}`, sha);
      return HttpResponse.json({ content: { path, sha: `file-${path}` }, commit: { sha } }, { status: 201 });
    }),

    // ---------- pulls ----------
    http.post(`${API}/repos/:owner/:repo/pulls`, async ({ request }) => {
      const body = (await request.json()) as { title: string; head: string; base: string; body?: string };
      if (!state.refs.has(`heads/${body.head}`)) return HttpResponse.json({ message: 'head not found' }, { status: 422 });
      const pull: MockPull = {
        number: state.pulls.length + 1000,
        head: body.head,
        base: body.base,
        merged_at: null,
        merged_by: null,
        merge_commit_sha: null,
      };
      state.pulls.push(pull);
      return HttpResponse.json(
        { number: pull.number, html_url: `https://github.test/pulls/${pull.number}` },
        { status: 201 },
      );
    }),
    http.get(`${API}/repos/:owner/:repo/pulls/:number`, ({ params }) => {
      const pull = state.pulls.find((p) => p.number === Number(params.number));
      if (!pull) return HttpResponse.json({ message: 'Not Found' }, { status: 404 });
      return HttpResponse.json({
        number: pull.number,
        merged_at: pull.merged_at,
        merged_by: pull.merged_by ? { login: pull.merged_by } : null,
        merge_commit_sha: pull.merge_commit_sha,
        html_url: `https://github.test/pulls/${pull.number}`,
      });
    }),
    http.put(`${API}/repos/:owner/:repo/pulls/:number/merge`, ({ params }) => {
      const pull = state.pulls.find((p) => p.number === Number(params.number));
      if (!pull) return HttpResponse.json({ message: 'Not Found' }, { status: 404 });
      const headSha = state.refs.get(`heads/${pull.head}`)!;
      const baseSha = state.refs.get(`heads/${pull.base}`)!;
      const headFiles = state.commits.get(headSha) ?? new Map<string, string>();
      const mergeSha = commitFiles(state, baseSha, headFiles);
      state.refs.set(`heads/${pull.base}`, mergeSha);
      pull.merged_at = '2026-07-02T12:00:00Z';
      pull.merged_by = state.operator; // merges run under the operator's own identity (SC-003)
      pull.merge_commit_sha = mergeSha;
      return HttpResponse.json({ merged: true, sha: mergeSha });
    }),

    // ---------- check runs ----------
    http.post(`${API}/repos/:owner/:repo/check-runs`, async ({ request }) => {
      const body = (await request.json()) as { name: string; head_sha: string; status?: string; conclusion?: string };
      state.checkRuns.push({
        name: body.name,
        head_sha: body.head_sha,
        status: body.status ?? 'completed',
        conclusion: body.conclusion ?? null,
      });
      return HttpResponse.json({ id: state.checkRuns.length, name: body.name }, { status: 201 });
    }),
    http.get(`${API}/repos/:owner/:repo/commits/:ref/check-runs`, ({ params }) => {
      const commitSha = resolveCommit(state, String(params.ref));
      const runs = state.checkRuns.filter((r) => r.head_sha === commitSha);
      return HttpResponse.json({ total_count: runs.length, check_runs: runs });
    }),

    // ---------- rulesets & environments ----------
    http.get(`${API}/repos/:owner/:repo/rulesets`, () =>
      state.planLimited
        ? HttpResponse.json({ message: 'Upgrade to GitHub Pro or make this repository public to enable this feature.' }, { status: 403 })
        : HttpResponse.json(state.rulesets),
    ),
    http.post(`${API}/repos/:owner/:repo/rulesets`, async ({ request }) => {
      if (state.planLimited) {
        return HttpResponse.json({ message: 'Upgrade to GitHub Pro or make this repository public to enable this feature.' }, { status: 403 });
      }
      const body = (await request.json()) as { name: string };
      const ruleset = { id: state.rulesets.length + 1, name: body.name };
      state.rulesets.push(ruleset);
      return HttpResponse.json(ruleset, { status: 201 });
    }),
    http.get(`${API}/repos/:owner/:repo/environments/:name`, ({ params }) => {
      if (state.planLimited) {
        return HttpResponse.json({ message: 'Upgrade to GitHub Pro or make this repository public to enable this feature.' }, { status: 403 });
      }
      return state.environments.has(String(params.name))
        ? HttpResponse.json({ name: params.name })
        : HttpResponse.json({ message: 'Not Found' }, { status: 404 });
    }),
    http.put(`${API}/repos/:owner/:repo/environments/:name`, ({ params }) => {
      state.environments.add(String(params.name));
      return HttpResponse.json({ name: params.name });
    }),
  ];

  const server = setupServer(...handlers);
  return {
    server,
    get state() {
      return state;
    },
    reset() {
      state = createState();
    },
  };
}

/** Seed the workflow files readiness I5 expects (compiled .lock.yml + plain .yml). */
export function seedCompiledWorkflows(state: MockState, workflowFiles: readonly string[]): void {
  const mainSha = state.refs.get('heads/main')!;
  const files = new Map(state.commits.get(mainSha));
  for (const file of workflowFiles) {
    files.set(`.github/workflows/${file}`, `# installed ${file}\n`);
  }
  const sha = newSha();
  state.commits.set(sha, files);
  state.refs.set('heads/main', sha);
}
