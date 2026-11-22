import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { lstatSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

/** Product-side export only. Fresh output, one canonical location per source;
 * never updates an existing output tree or edits the control repository's PR. */
export function exportBroker(sourceRoot: string, output: string) {
  const root = realpathSync(sourceRoot);
  const manifest: Record<string, string> = JSON.parse(readFileSync(join(root, 'control-plane/broker/files.json'), 'utf8'));
  const seen = new Set<string>();
  const copies = Object.entries(manifest).map(([target, source]) => {
    for (const path of [target, source]) {
      if (typeof path !== 'string' || !path || isAbsolute(path) || path.split('/').some(p => !p || p === '.' || p === '..') || path.includes('\\')) {
        throw new Error('Export paths must be normalized relative paths.');
      }
    }
    const path = realpathSync(join(root, source));
    if (relative(root, path).startsWith('..') || !lstatSync(path).isFile() || seen.has(path)) {
      throw new Error('Export sources must be unique files within the product root.');
    }
    seen.add(path);
    const bytes = readFileSync(path);
    return { target, source, sha256: createHash('sha256').update(bytes).digest('hex'), bytes };
  });
  // Read source provenance before the export can add untracked output inside
  // the checkout. Existing source edits and untracked inputs still count.
  const source_commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
  const dirty = execFileSync('git', ['status', '--porcelain'], { cwd: root, encoding: 'utf8' }).trim().length > 0;
  // Refuse existing output so stale root copies cannot survive a re-export.
  const destination = resolve(output);
  mkdirSync(destination);
  for (const file of copies) {
    const path = join(destination, file.target);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, file.bytes);
  }
  const files = copies.map(({ bytes: _bytes, ...file }) => file);
  const receipt = { schema_version: 1, source_commit, source_tree: dirty ? 'working_tree' : 'commit', files };
  writeFileSync(join(destination, 'export-manifest.json'), JSON.stringify(receipt, null, 2) + '\n');
  return receipt;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.argv.length !== 4 || process.argv[2] !== '--out' || !process.argv[3]) throw new Error('Usage: export-broker.ts --out <new-directory>');
  const receipt = exportBroker(process.cwd(), process.argv[3]);
  process.stdout.write(JSON.stringify({ files: receipt.files.length, source_commit: receipt.source_commit, source_tree: receipt.source_tree }) + '\n');
}
