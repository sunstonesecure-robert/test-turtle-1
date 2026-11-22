import type { Decision, Summary } from '../../schemas/agent-loop';
import type { z } from 'zod';

/** Shared read-side projection. Missing ledger/usage never displays as zero spend.
 * No node imports: dashboard loaders can reuse this without pulling in the store. */
export function projectStatus(decisions: Decision[]): z.infer<typeof Summary> {
  return {
    total: decisions.length,
    action_required: decisions.filter(d => d.status === 'action_required').length,
    waiting: decisions.filter(d => d.status.startsWith('waiting_') || d.status === 'retry_wait').length,
    proposed_effects: decisions.reduce((n, d) => n + d.effects.length, 0),
    executed_effects: 0,
    unknown_facts: [...new Set(decisions.flatMap(d => d.unknown))].sort(),
    cost: 'unknown',
  };
}
