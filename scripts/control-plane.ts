import { appendFileSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { Octokit } from '@octokit/rest';
import { inspectBroker, prepareCredentialEnvironment, provisionSandboxCustomer } from './control-plane/provision';
import { bootstrapExitCode, bootstrapSummary } from './control-plane/report';
import { INSPECTION_SCOPES, type InspectionScope } from '../schemas/control-plane';
import { CREDENTIALED_ACTIONS, runCredentialedAction, SECRET_NAMES, type CredentialedAction, type Secrets } from './control-plane/trial-session';

/** Engineer bootstrap CLI. Provision prints a candidate record after native
 * reads; prepare reserves only an empty environment. Those actions load no key.
 * `provision-state` and `witness` are the broker job's credentialed actions:
 * they read their keys from the job environment and verify natively that they
 * run in the installed broker workflow on main, started by a reviewed
 * administrator. No deployment, enrollment or model action is exposed. */
export async function controlPlaneCli(args: string[], executionDirectory = process.cwd()): Promise<0 | 1 | 2> {
  if (args[0] === '--action' && (CREDENTIALED_ACTIONS as readonly string[]).includes(args[1] ?? '')) {
    const emit = (report: unknown) => process.stdout.write(`T124_REPORT ${JSON.stringify(report)}\n`);
    if (args.length !== 4 || args[2] !== '--config' || !args[3] || args[3].startsWith('--')) { emit({ schema_version: 1, result: 'error', code: 'invalid_arguments' }); return 2; }
    let config: unknown, input: unknown; const secrets: Secrets = {};
    // The request arrives as the workflow's dispatch input, never as a file an earlier step wrote.
    // Keys arrive on standard input as one JSON object and must not be in this process's environment,
    // which the TypeScript loader's child process has already inherited.
    try {
      config = JSON.parse(readFileSync(args[3], 'utf8')); input = JSON.parse(process.env.TRIAL_INPUT ?? '');
      if (SECRET_NAMES.some(name => process.env[name])) { emit({ schema_version: 1, result: 'error', code: 'keys_in_process_environment' }); return 2; }
      const piped: unknown = JSON.parse(readFileSync(0, 'utf8'));
      for (const name of SECRET_NAMES) { const value = (piped as Record<string, unknown>)?.[name]; if (typeof value === 'string' && value) secrets[name] = value; }
    } catch { emit({ schema_version: 1, result: 'error', code: 'credentialed_input_invalid' }); return 2; }
    // A workflow cancel or job timeout signals the process: revoke live tokens before exiting.
    let revokeAll: (() => Promise<void>) | undefined;
    const stop = () => { void (async () => { try { await revokeAll?.(); } finally { process.exit(1); } })(); };
    process.once('SIGINT', stop); process.once('SIGTERM', stop);
    const { exit, report } = await runCredentialedAction(args[1] as CredentialedAction, config, input, process.env, secrets, { onTokens: f => { revokeAll = f; } });
    process.removeListener('SIGINT', stop); process.removeListener('SIGTERM', stop);
    emit(report);
    if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY,
      `Broker ${args[1]}: **${String(report.result)}** (${String(report.code)}). No model call or cloud operation. Tokens: ${String(report.token_cleanup)}.\n`);
    return exit;
  }
  const values = new Map<string, string>();
  for (let i = 0; i < args.length; i += 2) {
    const flag = args[i]!; const value = args[i + 1];
    if (!['--action', '--config', '--scope', '--registry', '--partition'].includes(flag) || values.has(flag) || !value || value.startsWith('--')) {
      process.stdout.write(JSON.stringify({ schema_version: 1, error: 'invalid_arguments', keys_allowed: false }) + '\n'); return 2;
    }
    values.set(flag, value);
  }
  const action = values.get('--action'); const configFile = values.get('--config');
  const scope = values.get('--scope') ?? 'all';
  const provision = action === 'provision';
  if (!['inspect', 'prepare', 'provision'].includes(action ?? '') || !configFile || !INSPECTION_SCOPES.includes(scope as InspectionScope) ||
      (action === 'prepare' && scope !== 'all') || (provision && (values.has('--scope') || !values.has('--registry') || !['aws', 'aws-us-gov'].includes(values.get('--partition') ?? ''))) ||
      (!provision && (values.has('--registry') || values.has('--partition')))) {
    process.stdout.write(JSON.stringify({ schema_version: 1, error: 'invalid_arguments', keys_allowed: false }) + '\n'); return 2;
  }
  try {
    const config: unknown = JSON.parse(readFileSync(configFile, 'utf8'));
    let sourceSha = process.env.GITHUB_SHA;
    if (scope === 'administrator') {
      const localSha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: executionDirectory, encoding: 'utf8' }).trim();
      const changes = execFileSync('git', ['status', '--porcelain'], { cwd: executionDirectory, encoding: 'utf8' }).trim();
      if (changes) throw new Error('Administrator inspection requires the reviewed clean checkout.');
      if (sourceSha && sourceSha !== localSha) throw new Error('Administrator source context differs from the checkout.');
      sourceSha = localSha;
    }
    const gh = new Octokit({ auth: process.env.GITHUB_TOKEN, log: { debug() {}, info() {}, warn() {}, error() {} } });
    if (provision) {
      const registry: unknown = JSON.parse(readFileSync(values.get('--registry')!, 'utf8'));
      const result = await provisionSandboxCustomer(gh, config, registry, {
        partition: values.get('--partition') as 'aws' | 'aws-us-gov',
      });
      process.stdout.write(JSON.stringify({ schema_version: 1, purpose: 'sandbox_provisioning_record', ...result,
        keys_allowed: false, enrollment: 'off', api_effect: 'none' }) + '\n');
      if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY,
        'Sandbox provisioning record prepared from native repository reads. Enrollment is off; keys are not authorized.\n');
      return 0;
    }
    const result = action === 'prepare' ? await prepareCredentialEnvironment(gh, config) : await inspectBroker(gh, config, sourceSha, scope as InspectionScope);
    process.stdout.write(JSON.stringify(result) + '\n');
    if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, bootstrapSummary(result));
    return bootstrapExitCode(result);
  } catch {
    process.stdout.write(JSON.stringify({ schema_version: 1, error: 'bootstrap_input_or_execution_failed', keys_allowed: false }) + '\n'); return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exitCode = await controlPlaneCli(process.argv.slice(2));
