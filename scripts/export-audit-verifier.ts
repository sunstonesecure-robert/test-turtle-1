import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { z } from 'zod';

const root = fileURLToPath(new URL('../', import.meta.url));
const Input = z.object({ audit_repository_id: z.number().int().positive().safe(), writer_principal_id: z.number().int().positive().safe(),
  /** The bot user of the principal the workflow commits as: `github-actions[bot]` is 41898282. */
  verifier_principal_id: z.number().int().positive().safe(),
  public_keys: z.record(z.string().regex(/^[A-Za-z0-9][A-Za-z0-9:._/-]{0,199}$/), z.string().regex(/^[A-Za-z0-9+/]+=*$/).max(200))
    .refine(keys => Object.keys(keys).length >= 1 && Object.keys(keys).length <= 4) }).strict()
  .refine(input => input.writer_principal_id !== input.verifier_principal_id, 'The verifier must not be the writer.');

/** The audit repository's whole product-owned content: the verifier and the
 * workflow that pins its digest, the audit public keys, the writer identity and
 * the repository. Deterministic; the caller reviews and commits it there. */
export function renderAuditVerifier(raw: unknown, sourceRoot = root): Record<string, string> {
  const input = Input.parse(raw);
  const verifier = readFileSync(join(sourceRoot, 'scripts/agent-loop/audit-verifier.mjs'), 'utf8');
  const pins = { __AUDIT_REPOSITORY_ID__: String(input.audit_repository_id), __WRITER_PRINCIPAL_ID__: String(input.writer_principal_id), __VERIFIER_PRINCIPAL_ID__: String(input.verifier_principal_id),
    __PUBLIC_KEYS_JSON__: JSON.stringify(Object.fromEntries(Object.entries(input.public_keys).sort(([a], [b]) => a < b ? -1 : 1))),
    __VERIFIER_SHA256__: createHash('sha256').update(verifier).digest('hex') };
  let workflow = readFileSync(join(sourceRoot, 'templates/audit-workflows/audit-verify.yml'), 'utf8');
  for (const [placeholder, value] of Object.entries(pins)) workflow = workflow.replaceAll(placeholder, value);
  if (/__[A-Z0-9_]+__/.test(workflow)) throw new Error('Audit verifier template has an unfilled pin.');
  return { '.github/workflows/audit-verify.yml': workflow, 'verifier/audit-verifier.mjs': verifier };
}

/** Engineer export into a new directory. It publishes nothing and reads no key. */
export function exportAuditVerifierCli(args: string[]): 0 | 1 | 2 {
  const flags = new Map<string, string>();
  for (let i = 0; i < args.length; i += 2) {
    if (!['--out', '--pins'].includes(args[i]!) || flags.has(args[i]!) || !args[i + 1] || args[i + 1]!.startsWith('--')) return 2;
    flags.set(args[i]!, args[i + 1]!);
  }
  if (!flags.has('--out') || !flags.has('--pins')) return 2;
  try {
    if (existsSync(flags.get('--out')!)) throw new Error('Output directory already exists.');
    const files = renderAuditVerifier(JSON.parse(readFileSync(flags.get('--pins')!, 'utf8')));
    for (const [path, content] of Object.entries(files)) { const target = join(flags.get('--out')!, path); mkdirSync(dirname(target), { recursive: true }); writeFileSync(target, content, { flag: 'wx' }); }
    process.stdout.write(JSON.stringify({ schema_version: 1, purpose: 'audit_verifier_export', files: Object.keys(files),
      sha256: Object.fromEntries(Object.entries(files).map(([path, content]) => [path, createHash('sha256').update(content).digest('hex')])) }) + '\n');
    return 0;
  } catch { process.stdout.write(JSON.stringify({ schema_version: 1, error: 'audit_verifier_export_failed' }) + '\n'); return 1; }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exitCode = exportAuditVerifierCli(process.argv.slice(2));
