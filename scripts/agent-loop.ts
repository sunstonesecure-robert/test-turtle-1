import { pathToFileURL } from 'node:url';
import type { Octokit } from '@octokit/rest';
import { createClient, type RepoRef } from '../dashboard/lib/github/client';
import { ControllerOutput, type Decision } from '../schemas/agent-loop';
import { observe } from './agent-loop/observe';
import { decideNext } from './agent-loop/reducer';
import { projectStatus } from './agent-loop/status';

export async function runAgentLoop(gh: Octokit, repo: RepoRef, options: { mode: 'observe' | 'reconcile'; now: string }): Promise<ControllerOutput> {
  const observation = await observe(gh, repo, options.now);
  const policy = observation.policy;
  const decisions: Decision[] = observation.workloads.map(w => {
    const p = policy && options.mode === 'observe' && policy.mode === 'enforce' ? { ...policy, mode: 'observe' } : policy;
    return { ...decideNext(null, w.facts, p, options.now).decision, workload: w.workload };
  });
  if (!decisions.length) {
    const unknown = Object.keys(observation.errors);
    const invalidPolicy = observation.policy_fact.state === 'unknown';
    if (invalidPolicy) unknown.push('policy');
    decisions.push({ mode: policy?.mode === 'off' || (!policy && !invalidPolicy && !unknown.length) ? 'off' : 'observe',
      status: unknown.length ? 'action_required' : 'stopped',
      reason_code: observation.policy_fact.state === 'unknown' ? observation.policy_fact.reason : unknown.length ? 'observation_failed' : 'not_enrolled',
      next_action: unknown.length ? 'Resolve the named unknown observations before activation.' : 'Configure an observe policy for selected workloads.',
      effects: [], evidence: [...Object.values(observation.errors), observation.policy_fact].flatMap(f => f.state === 'unknown' ? f.evidence : []),
      unknown, observed_at: options.now, policy_digest: policy?.sha256 ?? null });
  }
  return ControllerOutput.parse({ schema_version: 1, mode: decisions.every(d => d.mode === 'off') ? 'off' : 'observe',
    repository_id: observation.repository_id, decisions, summary: projectStatus(decisions) });
}

export function outputExitCode(output: ControllerOutput): 0 | 1 | 2 {
  if (output.repository_id === null) return 1;
  return output.decisions.some(d => d.status === 'action_required') ? 2 : 0;
}

export async function agentLoopCli(args: string[], deps: { gh?: Octokit; now?: string; write?: (text: string) => void } = {}): Promise<0 | 1 | 2> {
  const write = deps.write ?? (text => process.stdout.write(text));
  const fail = (reason_code: string, next_action: string, code: 1 | 2) => {
    const decisions: Decision[] = [{ mode: 'off', status: 'action_required', reason_code, next_action, effects: [], evidence: [], unknown: [], observed_at: deps.now ?? new Date().toISOString(), policy_digest: null }];
    write(JSON.stringify({ schema_version: 1, mode: 'off', repository_id: null, decisions, summary: projectStatus(decisions) }) + '\n');
    return code;
  };
  const values = new Map<string, string>();
  for (let i = 0; i < args.length; i += 2) {
    const key = args[i]!; const value = args[i + 1];
    if (!['--repo', '--mode'].includes(key) || values.has(key) || !value || value.startsWith('--')) {
      return fail('invalid_arguments', 'Use --repo OWNER/REPO --mode observe|reconcile.', 2);
    }
    values.set(key, value);
  }
  const repository = values.get('--repo'); const mode = values.get('--mode');
  if (!repository || !/^[A-Za-z0-9][A-Za-z0-9-]*\/[A-Za-z0-9_.-]+$/.test(repository) || !['observe', 'reconcile'].includes(mode ?? '')) {
    return fail('invalid_arguments', 'Use --repo OWNER/REPO --mode observe|reconcile.', 2);
  }
  try {
    // Silence client exception logging at this boundary; only the sanitized
    // decision reaches stdout. No raw error/response is used in the report.
    const gh = deps.gh ?? createClient({ token: process.env.GITHUB_TOKEN });
    gh.log.error = () => {};
    const [owner, repo] = repository.split('/') as [string, string];
    const output = await runAgentLoop(gh, { owner, repo }, { mode: mode as 'observe' | 'reconcile', now: deps.now ?? new Date().toISOString() });
    write(JSON.stringify(output) + '\n');
    return outputExitCode(output);
  } catch {
    return fail('observation_integrity_failed', 'Reconcile the read or schema failure; no effects were performed.', 1);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exitCode = await agentLoopCli(process.argv.slice(2));
