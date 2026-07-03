import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { checkG1Schema, checkG10Acyclic } from '../../scripts/gates/lib/checks-core';
import { PlanDoc } from '../../schemas/plan';

function fixture(name: string): unknown {
  return JSON.parse(readFileSync(new URL(`../fixtures/plans/${name}.json`, import.meta.url), 'utf8'));
}

describe('plan-gate core checks (T028/T035)', () => {
  it('G1 passes a valid plan and returns the parsed doc', () => {
    const { result, plan } = checkG1Schema(fixture('valid'));
    expect(result.status).toBe('pass');
    expect(plan?.feature).toBe('demo');
  });

  it('G1 fails schema violations with a per-path detail', () => {
    const { result, plan } = checkG1Schema(fixture('assumption-no-standin'));
    expect(result.status).toBe('fail');
    expect(plan).toBeNull();
    expect(result.detail).toContain('stand_in');
  });

  it('G10 fails a cyclic depends_on graph', () => {
    const plan = PlanDoc.parse(fixture('cyclic-deps'));
    const result = checkG10Acyclic(plan);
    expect(result.status).toBe('fail');
    expect(result.detail).toContain('cycle');
  });

  it('G10 passes an acyclic graph and flags unknown step refs', () => {
    const valid = PlanDoc.parse(fixture('valid'));
    expect(checkG10Acyclic(valid).status).toBe('pass');
    const dangling = PlanDoc.parse(fixture('valid'));
    dangling.steps[0]!.depends_on = ['step-ghost'];
    const result = checkG10Acyclic(dangling);
    expect(result.status).toBe('fail');
    expect(result.detail).toContain('step-ghost');
  });
});
