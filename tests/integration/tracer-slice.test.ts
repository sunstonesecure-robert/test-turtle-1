import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createGithubMock, seedCompiledWorkflows } from '../mocks/github-api';
import { createClient } from '../../dashboard/lib/github/client';
import { init } from '../../scripts/setup-repo';
import { checkReadiness, OVERSIGHT_WORKFLOW_FILES } from '../../scripts/gates/lib/readiness';
import { introduceWorkload, applyLifecycleTransition, getWorkload } from '../../dashboard/lib/github/workloads';
import { lifecycleGate } from '../../scripts/gates/lifecycle-gate';
import { proposeDemoPlan } from '../../scripts/demo/propose-plan';
import { getAndon, openAndon, judgeItem } from '../../dashboard/lib/github/andon';
import { readPlanAtRef, freezeApprovedPlan, resolveCurrent, tagExists } from '../../dashboard/lib/github/plans';
import { planGate } from '../../scripts/gates/plan-gate';
import { openApprovalPr, getApprovalRecord } from '../../dashboard/lib/github/approval';
import { buildPreflight } from '../../scripts/gates/build-preflight';

/**
 * THE TRACER BULLET (plan.md "Tracer Bullet Slice", tasks.md "MVP tracer"):
 * one workload, one step, one judgment, one approval, one build — happy path,
 * every layer crossed exactly once:
 *   init/readiness → intake/activate (lifecycle gate) → plan branch + Andon →
 *   plan-gate → operator-identity merge → post-merge freeze (tag + CURRENT +
 *   andon:resolved) → build-preflight (B1/B2/B7) → vt-* check run.
 */

const mock = createGithubMock();
const repo = { owner: 'sunstone', repo: 'agentic-turtles' };
const gh = createClient({ token: 'test-token' });
const AT = '2026-07-02T11:00:00Z';

beforeAll(() => mock.server.listen({ onUnhandledRequest: 'error' }));
afterAll(() => mock.server.close());

describe('tracer bullet: empty repo → frozen plan → unblocked build', () => {
  it('workload intake is refused while readiness is unmet (FR-029)', async () => {
    const results = await checkReadiness(gh, repo);
    expect(results.some((r) => r.status === 'fail')).toBe(true);
    // The dashboard refuses intake off this same check — asserted here at the module level.
  });

  it('Day-1 init reaches verified readiness (I1–I6)', async () => {
    await init(gh, repo);
    seedCompiledWorkflows(mock.state, OVERSIGHT_WORKFLOW_FILES); // quickstart §2: gh aw compile + push
    const results = await checkReadiness(gh, repo);
    expect(results.map((r) => `${r.id}:${r.status}`)).toEqual([
      'I1:pass',
      'I2:pass',
      'I3:pass',
      'I4:pass',
      'I5:pass',
      'I6:pass',
    ]);
  });

  it('operator introduces the demo workload (proposed) and activates it through the gated single writer', async () => {
    const workload = await introduceWorkload(gh, repo, {
      slug: 'demo',
      title: 'Demo workload',
      actor: 'sme-operator',
      at: AT,
    });
    expect(workload.state).toBe('proposed');

    // Agents may not touch a proposed workload: preflight B7 blocks it (FR-033).
    const gate = await lifecycleGate(gh, repo, { slug: 'demo', action: 'activate' });
    expect(gate.result).toBe('pass'); // L0 + L1 green
    const activated = await applyLifecycleTransition(gh, repo, {
      slug: 'demo',
      action: 'activated',
      actor: 'sme-operator',
      at: AT,
    });
    expect(activated.state).toBe('active');

    const issue = mock.state.issues.find((i) => i.number === workload.issueNumber)!;
    expect(issue.labels).toContain('workload:active');
    expect(issue.labels).not.toContain('workload:proposed');
    expect(issue.comments.some((c) => c.includes('action:introduced'))).toBe(true);
    expect(issue.comments.some((c) => c.includes('action:activated'))).toBe(true);
  });

  let andonIssue = 0;
  let planRef = '';

  it('the agent proposes a one-step plan and raises an Andon break (andon:open)', async () => {
    const proposed = await proposeDemoPlan(gh, repo, { runId: 'run-tracer-1', actor: 'sme-operator', at: AT });
    andonIssue = proposed.andonIssue;
    planRef = proposed.planRef;
    expect(planRef).toBe('plan/demo/v1');

    const andon = await getAndon(gh, repo, andonIssue);
    expect(andon.labels).toContain('andon:open');
    expect(andon.items).toHaveLength(1);
    expect(andon.items[0]).toMatchObject({ id: 'bc-empty-name', judged: false });

    const plan = await readPlanAtRef(gh, repo, planRef);
    expect(plan.steps).toHaveLength(1);
    expect(plan.verification_targets).toHaveLength(1);
    expect(plan.andon_issue).toBe(andonIssue);
  });

  it('opening the Andon flips it to under-review; plan-gate blocks while the item is unjudged (G8)', async () => {
    await openAndon(gh, repo, andonIssue);
    const andon = await getAndon(gh, repo, andonIssue);
    expect(andon.labels).toContain('andon:under-review');

    const plan = await readPlanAtRef(gh, repo, planRef);
    const blocked = await planGate(gh, repo, plan, planRef);
    expect(blocked.result).toBe('fail');
    expect(blocked.gates.find((g) => g.id === 'G8')?.status).toBe('fail');
  });

  it('after the single ✓ judgment, plan-gate is green (G1, G7–G10)', async () => {
    await judgeItem(gh, repo, andonIssue, 'bc-empty-name');
    const plan = await readPlanAtRef(gh, repo, planRef);
    const report = await planGate(gh, repo, plan, planRef);
    expect(report.gates.map((g) => `${g.id}:${g.status}`)).toEqual([
      'G1:pass',
      'G7:pass',
      'G8:pass',
      'G9:pass',
      'G10:pass',
    ]);
    expect(report.result).toBe('pass');
  });

  let mergeSha = '';

  it('the operator merges the approval PR under their own identity (FR-006, SC-003)', async () => {
    const pr = await openApprovalPr(gh, repo, { slug: 'demo', version: 1 });
    await gh.pulls.merge({ ...repo, pull_number: pr.number });
    const record = await getApprovalRecord(gh, repo, pr.number);
    expect(record).not.toBeNull();
    expect(record!.approver).toBe('sme-operator');
    expect(record!.approvedAt).toBeTruthy();
    mergeSha = record!.mergeSha;
  });

  it('post-merge freezes exactly one immutable tagged version and resolves the Andon (FR-007, FR-027)', async () => {
    const record = { approver: 'sme-operator', approvedAt: '2026-07-02T12:00:00Z' };
    const { tagRef } = await freezeApprovedPlan(gh, repo, {
      slug: 'demo',
      version: 1,
      mergeSha,
      andonIssue,
      approver: record.approver,
      approvedAt: record.approvedAt,
    });
    expect(tagRef).toBe('plan/demo/v1');
    expect(await tagExists(gh, repo, 'plan/demo/v1')).toBe(true);
    expect(await resolveCurrent(gh, repo, 'demo')).toBe('plan/demo/v1');

    const andon = await getAndon(gh, repo, andonIssue);
    expect(andon.labels).toContain('andon:resolved');
    expect(andon.labels).not.toContain('andon:under-review');

    // Atomicity (SC-008): a second freeze of the same version loses the create-ref race.
    await expect(
      freezeApprovedPlan(gh, repo, {
        slug: 'demo',
        version: 1,
        mergeSha,
        andonIssue,
        approver: 'someone-else',
        approvedAt: record.approvedAt,
      }),
    ).rejects.toThrow();
  });

  it('one dispatched build passes preflight (B1/B2/B7) and emits one vt-* check run on the frozen SHA', async () => {
    const report = await buildPreflight(gh, repo, { planRef: 'plan/demo/v1', workload: 'demo' });
    expect(report.gates.map((g) => `${g.id}:${g.status}`)).toEqual(['B1:pass', 'B2:pass', 'B7:pass']);
    expect(report.result).toBe('pass');

    // The build's verification-target result: a vt-<id> check run bound to the frozen tag's SHA.
    const plan = await readPlanAtRef(gh, repo, 'plan/demo/v1');
    const frozenSha = mergeSha;
    await gh.checks.create({
      ...repo,
      name: plan.verification_targets[0]!.id,
      head_sha: frozenSha,
      status: 'completed',
      conclusion: 'success',
    });
    // Results are bound to the frozen tag's SHA (issue-tracker-contract "Immutability & audit").
    const { data } = await gh.checks.listForRef({ ...repo, ref: frozenSha });
    expect(data.check_runs).toHaveLength(1);
    expect(data.check_runs[0]).toMatchObject({ name: 'vt-hello-copy', conclusion: 'success' });
  });

  it('the gates block what they must block: a bogus ref fails B1, a deferred workload fails B7', async () => {
    const bogus = await buildPreflight(gh, repo, { planRef: 'plan/demo/v0-bogus', workload: 'demo' });
    expect(bogus.result).toBe('fail');
    expect(bogus.gates.find((g) => g.id === 'B1')?.status).toBe('fail');

    await applyLifecycleTransition(gh, repo, {
      slug: 'demo',
      action: 'deferred',
      actor: 'sme-operator',
      at: AT,
      revisit: '2026-08-01',
    });
    const deferred = await buildPreflight(gh, repo, { planRef: 'plan/demo/v1', workload: 'demo' });
    expect(deferred.gates.find((g) => g.id === 'B7')?.status).toBe('fail');

    // restore for any later expansion
    await applyLifecycleTransition(gh, repo, { slug: 'demo', action: 'reactivated', actor: 'sme-operator', at: AT });
    expect((await getWorkload(gh, repo, 'demo'))?.state).toBe('active');
  });
});
