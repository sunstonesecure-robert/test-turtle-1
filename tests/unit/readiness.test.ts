import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createGithubMock, seedCompiledWorkflows } from '../mocks/github-api';
import { createClient } from '../../dashboard/lib/github/client';
import { checkReadiness, unmetItems, OVERSIGHT_WORKFLOW_FILES } from '../../scripts/gates/lib/readiness';
import { init } from '../../scripts/setup-repo';

const mock = createGithubMock();
const repo = { owner: 'sunstone', repo: 'agentic-turtles' };

beforeAll(() => mock.server.listen({ onUnhandledRequest: 'error' }));
afterAll(() => mock.server.close());
beforeEach(() => mock.reset());

describe('Day-1 init + readiness I1–I6 (T124/T126/T127)', () => {
  it('reports not-ready on an empty repo with the unmet list', async () => {
    const gh = createClient({ token: 't' });
    const results = await checkReadiness(gh, repo);
    expect(results.map((r) => r.id)).toEqual(['I1', 'I2', 'I3', 'I4', 'I5', 'I6']);
    const unmet = unmetItems(results);
    expect(unmet.length).toBeGreaterThan(0);
    expect(unmet.join(' ')).toContain('I1');
  });

  it('init reconciles to ready (with compiled workflows present) and is idempotent (FR-030)', async () => {
    const gh = createClient({ token: 't' });

    const first = await init(gh, repo);
    expect(first.alreadyInitialized).toBe(false);
    expect(first.changed.join(' ')).toContain('label');
    expect(first.changed.join(' ')).toContain('ruleset');
    expect(first.changed.join(' ')).toContain('environment agent-build');

    // Second run: no destructive change, reports already_initialized.
    const second = await init(gh, repo);
    expect(second.alreadyInitialized).toBe(true);
    expect(second.changed).toEqual([]);

    // Readiness still requires the compiled .lock.yml files (quickstart §2).
    let results = await checkReadiness(gh, repo);
    expect(results.find((r) => r.id === 'I5')?.status).toBe('fail');

    seedCompiledWorkflows(mock.state, OVERSIGHT_WORKFLOW_FILES);
    results = await checkReadiness(gh, repo);
    expect(results.every((r) => r.status === 'pass')).toBe(true);
  });

  it('waives the CURRENT push ruleset on user-owned repos (push rules are org-only)', async () => {
    const gh = createClient({ token: 't' });
    mock.state.ownerType = 'User';

    await init(gh, repo);
    seedCompiledWorkflows(mock.state, OVERSIGHT_WORKFLOW_FILES);
    // Simulate GitHub rejecting the push ruleset on a personal repo: remove it as if never created.
    mock.state.rulesets = mock.state.rulesets.filter((r) => r.name !== 'oversight: protect CURRENT pointers');

    const results = await checkReadiness(gh, repo);
    const i2 = results.find((r) => r.id === 'I2')!;
    expect(i2.status).toBe('pass');
    expect(i2.detail).toContain('waived');
    expect(results.every((r) => r.status === 'pass')).toBe(true);
  });

  it('reports plan-limited repos (rulesets/environments 403) as unmet items, not a crash', async () => {
    const gh = createClient({ token: 't' });
    mock.state.planLimited = true;

    const results = await checkReadiness(gh, repo);
    for (const id of ['I2', 'I3', 'I4']) {
      const result = results.find((r) => r.id === id)!;
      expect(result.status).toBe('fail');
      expect(result.detail).toContain('plan');
    }
    expect(unmetItems(results).join(' ')).toContain('GitHub Pro');

    // init refuses with the remedy instead of a raw API error
    await expect(init(gh, repo)).rejects.toThrow(/GitHub Pro|public/);
  });
});
