import { execFileSync } from 'node:child_process';
import { closeSync, fsyncSync, ftruncateSync, openSync, readFileSync, realpathSync, writeSync } from 'node:fs';
import { basename, dirname, isAbsolute, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Octokit } from '@octokit/rest';
import { nativeProbePlan, nativeProbeScope, PROBE_SOURCE_REPOSITORY, runNativeProbe, type NativeProbeReport } from '../agent-loop/native-probe';

const sourceRoot = fileURLToPath(new URL('../../', import.meta.url));

/** Engineer-only T124 probe. A plan is always offline. Execution requires an
 * exact-source native human consent and a new report outside the source checkout.
 * The installed controller never imports or dispatches this command. */
export async function nativeProbeCli(args: string[], sourceDirectory = sourceRoot): Promise<0 | 1 | 2> {
  const emit = (value: unknown) => process.stdout.write(JSON.stringify(value) + '\n');
  const error = (code: string) => emit({ schema_version: 1, task: 'T124', result: 'incomplete', partial_result: 'not_run',
    code, api_requests: 0, git_write_attempts: 0, keys_allowed: false, enrollment: 'off' });
  const flags = new Map<string, string>(); let execute = false;
  for (let i = 0; i < args.length; i++) {
    const flag = args[i]!;
    if (flag === '--execute' && !execute) { execute = true; continue; }
    if (!['--config', '--request', '--report'].includes(flag) || flags.has(flag) || !args[i + 1] || args[i + 1]!.startsWith('--')) {
      error('invalid_arguments'); return 2;
    }
    flags.set(flag, args[++i]!);
  }
  if (execute && (!flags.has('--request') || !flags.has('--report'))) { error('invalid_arguments'); return 2; }
  let descriptor: number | undefined;
  let completedReport: NativeProbeReport | undefined;
  let executionStarted = false;
  function persist(value: unknown) {
    const bytes = Buffer.from(JSON.stringify(value) + '\n');
    let offset = 0;
    while (offset < bytes.length) {
      const written = writeSync(descriptor!, bytes, offset, bytes.length - offset, offset);
      if (!written) throw new Error('Report write incomplete.');
      offset += written;
    }
    ftruncateSync(descriptor!, bytes.length); fsyncSync(descriptor!);
  }
  try {
    const config: unknown = JSON.parse(readFileSync(flags.get('--config') ?? resolve(sourceDirectory, 'control-plane/broker-bootstrap.json'), 'utf8'));
    const input: unknown = JSON.parse(readFileSync(flags.get('--request') ?? resolve(sourceDirectory, 'control-plane/trials/t124.request.json'), 'utf8'));
    const git = (parameters: string[]) => execFileSync('git', parameters, { cwd: sourceDirectory, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
    const sourceSha = git(['rev-parse', 'HEAD']);
    const plan = nativeProbePlan(config, input, sourceSha);
    const { request } = nativeProbeScope(config, input);
    const envelope = { ...plan, source_tree: git(['status', '--porcelain']) ? 'working_tree' : 'commit',
      approval_template: { schema_version: 1, purpose: 't124_keyless_probe', source_sha: sourceSha,
        scope_sha256: plan.scope_sha256, expires_at: request.expires_at }, source_repository: PROBE_SOURCE_REPOSITORY };
    if (execute) {
      if (!request.native_consent_receipt || request.trusted_source_sha !== sourceSha || !request.expires_at) {
        emit({ ...envelope, code: 'trial_not_authorized' }); return 2;
      }
      if (envelope.source_tree !== 'commit') { error('source_checkout_dirty'); return 2; }
      if (process.env.GITHUB_SHA && process.env.GITHUB_SHA !== sourceSha) { error('source_context_mismatch'); return 2; }
      if (!process.env.GITHUB_TOKEN) { error('engineer_token_missing'); return 2; }
    }
    if (flags.has('--report')) {
      const output = resolve(flags.get('--report')!);
      if (execute) {
        // Resolve the existing parent too, so a symlink cannot place the report
        // inside the clean checkout after the source-integrity check.
        const resolvedOutput = resolve(realpathSync(dirname(output)), basename(output));
        const fromSource = relative(realpathSync(sourceDirectory), resolvedOutput);
        if (!fromSource.startsWith('..' + '/') && fromSource !== '..' && !isAbsolute(fromSource)) { error('report_inside_source'); return 2; }
      }
      try { descriptor = openSync(output, 'wx', 0o600); }
      catch { error('report_unavailable'); return 1; }
      persist(execute ? { ...envelope, execution: 'github', code: 'execution_pending',
        api_requests: null, git_write_attempts: null, git_writes_confirmed: null,
        unresolved_operations: ['probe_execution_not_finalized'] } : envelope);
    }
    if (!execute) { emit(envelope); return 0; }
    const gh = new Octokit({ auth: process.env.GITHUB_TOKEN, log: { debug() {}, info() {}, warn() {}, error() {} } });
    executionStarted = true;
    const report = await runNativeProbe(gh, config, input, { sourceSha });
    completedReport = report;
    // Reserve the file before effects; fsync the final receipt before declaring
    // the command complete. Never overwrite another run's report.
    const encoded = JSON.stringify({ ...report, source_tree: 'commit', source_repository: PROBE_SOURCE_REPOSITORY }) + '\n';
    persist({ ...report, source_tree: 'commit', source_repository: PROBE_SOURCE_REPOSITORY });
    process.stdout.write(encoded);
    return report.partial_result === 'pass' ? 0 : 2;
  } catch {
    // Do not print upstream errors, review text, file contents or credentials.
    // If this follows an effect, the reserved report still proves the intended
    // scope; inspect the retained branch before any subsequent trial.
    if (completedReport) emit({ ...completedReport, partial_result: 'error', code: 'report_persistence_failed' });
    else if (executionStarted) emit({ schema_version: 1, task: 'T124', result: 'incomplete', partial_result: 'error',
      execution: 'github', code: 'probe_execution_interrupted', api_requests: null, git_write_attempts: null,
      git_writes_confirmed: null, unresolved_operations: ['probe_execution_not_finalized'], keys_allowed: false, enrollment: 'off' });
    else error('probe_input_or_execution_failed');
    return 1;
  } finally { if (descriptor !== undefined) closeSync(descriptor); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exitCode = await nativeProbeCli(process.argv.slice(2));
