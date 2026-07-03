import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { PlanDoc } from '../../schemas/plan';

function fixture(name: string): unknown {
  return JSON.parse(readFileSync(new URL(`../fixtures/plans/${name}.json`, import.meta.url), 'utf8'));
}

describe('plan document schema (T009/T011)', () => {
  it('accepts a valid plan', () => {
    expect(PlanDoc.safeParse(fixture('valid')).success).toBe(true);
  });

  it('rejects an assumption step with no stand_in (FR-020)', () => {
    const result = PlanDoc.safeParse(fixture('assumption-no-standin'));
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some((i) => i.path.join('.').endsWith('stand_in'))).toBe(true);
    }
  });

  it('rejects a high-stakes step with no authority (FR-023)', () => {
    const result = PlanDoc.safeParse(fixture('highstakes-no-authority'));
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some((i) => i.path.join('.').endsWith('authority'))).toBe(true);
    }
  });

  it('rejects unknown top-level properties (strict)', () => {
    const plan = { ...(fixture('valid') as Record<string, unknown>), extra: true };
    expect(PlanDoc.safeParse(plan).success).toBe(false);
  });

  it('accepts the cyclic fixture structurally (cycles are G10, not schema)', () => {
    expect(PlanDoc.safeParse(fixture('cyclic-deps')).success).toBe(true);
  });
});
