import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { assembleRemainingWitnesses, bindWitnessPlan, buildWitnessPlan, witnessScope } from '../agent-loop/native-witnesses';
import { brokerDigest } from '../control-plane/broker';
import { StateRefusal } from '../agent-loop/ledger';

/** Engineer-only, offline helper for the remaining T124 witnesses. It computes
 * and checks documents; it holds no credential and makes no request. The native
 * effects happen only in the broker's credentialed job and the audit
 * repository's verifier. `assemble` exits 0 only when all five witnesses pass. */
export function nativeWitnessesCli(args: string[]): 0 | 1 | 2 {
  const emit = (value: unknown) => process.stdout.write(JSON.stringify(value) + '\n');
  const command = args[0], flags = new Map<string, string>();
  const allowed: Record<string, string[]> = { plan: ['--input', '--attempt'], bind: ['--plan', '--binding', '--consent-comment-id'],
    assemble: ['--provision', '--run-a', '--run-b', '--verifications', '--isolation'] };
  for (let i = 1; i < args.length; i += 2) {
    const flag = args[i]!;
    if (!command || !allowed[command]?.includes(flag) || flags.has(flag) || !args[i + 1] || args[i + 1]!.startsWith('--')) { emit({ schema_version: 1, error: 'invalid_arguments' }); return 2; }
    flags.set(flag, args[i + 1]!);
  }
  if (!command || !allowed[command] || (command !== 'assemble' && allowed[command].some(flag => !flags.has(flag)))) { emit({ schema_version: 1, error: 'invalid_arguments' }); return 2; }
  const read = (flag: string): unknown => flags.has(flag) ? JSON.parse(readFileSync(flags.get(flag)!, 'utf8')) : undefined;
  try {
    if (command === 'plan') {
      // The attempt is stated on the command line, never read from the input file or defaulted.
      if (!/^[1-9]$/.test(flags.get('--attempt')!)) { emit({ schema_version: 1, error: 'invalid_arguments' }); return 2; }
      const { proposal, plan } = buildWitnessPlan({ ...(read('--input') as object), attempt: Number(flags.get('--attempt')) });
      emit({ schema_version: 1, purpose: 't124_witness_plan', attempt: plan.attempt, workload: proposal.workload, proposal_sha256: brokerDigest(proposal), plan_sha256: witnessScope(plan), proposal, plan }); return 0;
    }
    if (command === 'bind') {
      const plan = bindWitnessPlan(read('--plan'), read('--binding'), Number(flags.get('--consent-comment-id')));
      emit({ schema_version: 1, purpose: 't124_witness_plan', proposal_sha256: brokerDigest(plan.authority.proposal), plan_sha256: witnessScope(plan), plan }); return 0;
    }
    const result = assembleRemainingWitnesses({ provision: read('--provision'), run_a: read('--run-a'), run_b: read('--run-b'), verifications: read('--verifications'), isolation: read('--isolation') });
    emit(result); return result.result === 'pass' ? 0 : 2;
  } catch (error) { emit({ schema_version: 1, error: error instanceof StateRefusal ? error.code : 'witness_input_invalid' }); return 1; }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exitCode = nativeWitnessesCli(process.argv.slice(2));
