import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Octokit } from '@octokit/rest';
import { BrokerBootstrap } from '../../schemas/control-plane';
import { HostingReportTooLarge, readHostingCapability } from '../agent-loop/capabilities';

const sourceRoot = fileURLToPath(new URL('../../', import.meta.url));

/** Engineer-only, read-only hosting capability read for the governed repository
 * named in the reviewed bootstrap record. It sends GET requests only, writes no
 * file and changes no setting. Exit 0 = ready, 2 = blocked or refused, 1 = error.
 * The only flags are the record's path and which registered App merges; there is
 * no flag that waives a check. */
export async function hostingCapabilityCli(args: string[], deps: { github?: Octokit; now?: string } = {}): Promise<0 | 1 | 2> {
  const emit = (value: unknown) => process.stdout.write(JSON.stringify(value) + '\n');
  const refuse = (code: string): 2 => { emit({ schema_version: 1, purpose: 'hosting_capability_readiness', result: 'blocked', code, api_requests: 0 }); return 2; };
  const flags = new Map<string, string>();
  for (let i = 0; i < args.length; i++) {
    const flag = args[i]!;
    if (!['--config', '--merge-app-id'].includes(flag) || flags.has(flag) || !args[i + 1] || args[i + 1]!.startsWith('--')) return refuse('invalid_arguments');
    flags.set(flag, args[++i]!);
  }
  try {
    const config = BrokerBootstrap.parse(JSON.parse(readFileSync(flags.get('--config') ?? resolve(sourceRoot, 'control-plane/broker-bootstrap.json'), 'utf8')));
    const named = flags.get('--merge-app-id');
    // The merging App must be one of the four reviewed registrations, never an arbitrary ID.
    if (named !== undefined && (!/^[1-9]\d{0,14}$/.test(named) || !Object.values(config.apps).some(app => app.app_id === Number(named)))) return refuse('invalid_arguments');
    if (!deps.github && !process.env.GITHUB_TOKEN) return refuse('token_missing');
    const gh = deps.github ?? new Octokit({ auth: process.env.GITHUB_TOKEN, log: { debug() {}, info() {}, warn() {}, error() {} } });
    const [owner, repo] = config.governed.full_name.split('/') as [string, string];
    const outcome = await readHostingCapability(gh, { owner, repo }, { expected_repository_id: config.governed.id,
      trusted_merge_principal: named === undefined ? null : { actor_type: 'Integration', actor_id: Number(named) }, now: deps.now });
    emit(outcome);
    return outcome.report.result === 'ready' ? 0 : 2;
  } catch (error) {
    // The repository was read but its report is too large to digest: say so, with the size. Not ready.
    if (error instanceof HostingReportTooLarge) { emit({ schema_version: 1, purpose: 'hosting_capability_readiness', result: 'blocked', code: 'report_too_large', bytes: error.bytes }); return 2; }
    // Never print upstream errors or credentials.
    emit({ schema_version: 1, purpose: 'hosting_capability_readiness', result: 'blocked', code: 'read_failed' });
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exitCode = await hostingCapabilityCli(process.argv.slice(2));
