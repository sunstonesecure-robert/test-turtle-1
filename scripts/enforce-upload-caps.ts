import { readFileSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';

/**
 * Post-compile upload-cap enforcer (live PB-017 finding 4b, 2026-09-10).
 *
 * gh-aw's `safe-outputs.upload-artifact.max-uploads` has TWO readers that disagree:
 *   - the upload handler (`upload_artifact.cjs`) reads `max-uploads` and honours it;
 *   - the ingestion validator (`collect_ndjson_output.cjs` → `getMaxAllowedForType`) reads
 *     a key named `max`, never `max-uploads`, and with no `max` present falls back to a hard
 *     default of ONE — dropping every upload_artifact item after the first with
 *     "Too many items of type 'upload_artifact'. Maximum allowed: 1" before the handler
 *     ever sees it.
 * The compiler never writes `max` for upload_artifact (checked at v0.81.6 and v0.89.2, and
 * the validator at upstream HEAD), so `max-uploads: N` alone can only ever LOWER the
 * effective cap. Run 34513826030 (default cap) and run 34526914991 (`max-uploads: 2`) on
 * test-turtle-1 both lost `addresses.json` this way, and plan-publish refused each
 * pair-less revision. Same class as gh-aw #42249, fixed there for custom safe-jobs only.
 *
 * This script mirrors `"max-uploads":N` as `"max":N` inside every embedded upload_artifact
 * config in the compiled `.lock.yml` files — both the config.json heredoc the agent job
 * writes and the GH_AW_SAFE_OUTPUTS_HANDLER_CONFIG env string (JSON-escaped) the
 * safe_outputs job carries — so the validator and the handler agree. The handler side
 * ignores keys it does not read; the processor treats `max` as the per-type count it
 * already is for every other safe output. Run it after EVERY `gh aw compile`, alongside
 * scripts/enforce-job-timeouts.ts (`npm run lock:enforce` runs both);
 * tests/unit/upload-caps.test.ts fails the build if a lock file lands without it.
 *
 * Deterministic + idempotent: pure line edits, no YAML re-serialization.
 */

export const LOCKS = [
  'templates/workflows/plan-propose.lock.yml',
  'templates/workflows/plan-revise.lock.yml',
  'templates/workflows/build-template.lock.yml',
];

/**
 * One embedded upload_artifact config object, raw (`"k":v`) or JSON-escaped (`\"k\":v`).
 * Group 1 = the quote form in use (`"` or `\"`), group 2 = the object body.
 */
const UPLOAD_CONFIG = /(\\?")upload_artifact\1:\{([^{}]*)\}/g;

export type CapAction = 'injected' | 'updated' | 'unchanged' | 'not-needed';

/**
 * Mirror `max-uploads` as `max` inside every upload_artifact config in one lock's text.
 * Returns the rewritten text and what happened at each occurrence, in file order.
 */
export function enforceUploadCaps(text: string): { text: string; actions: CapAction[] } {
  const actions: CapAction[] = [];
  const out = text.replace(UPLOAD_CONFIG, (whole, q: string, body: string) => {
    const uploads = new RegExp(`${escape(q)}max-uploads${escape(q)}:(\\d+)`).exec(body);
    if (!uploads) {
      actions.push('not-needed');
      return whole;
    }
    const n = Number(uploads[1]);
    const maxKey = `${q}max${q}:`;
    const maxRe = new RegExp(`${escape(q)}max${escape(q)}:(\\d+)`);
    const existing = maxRe.exec(body);
    if (existing) {
      if (Number(existing[1]) === n) {
        actions.push('unchanged');
        return whole;
      }
      actions.push('updated');
      return `${q}upload_artifact${q}:{${body.replace(maxRe, `${maxKey}${n}`)}}`;
    }
    actions.push('injected');
    // Place `max` right before `max-uploads`, so the pair reads as one intent.
    const at = body.indexOf(`${q}max-uploads${q}:`);
    return `${q}upload_artifact${q}:{${body.slice(0, at)}${maxKey}${n},${body.slice(at)}}`;
  });
  return { text: out, actions };
}

function escape(s: string): string {
  return s.replace(/[\\"]/g, (c) => `\\${c}`);
}

function main(): void {
  const root = join(import.meta.dirname, '..');
  for (const file of LOCKS) {
    const path = join(root, file);
    // CRLF-normalize for the same reason enforce-job-timeouts does; write-back is LF.
    const before = readFileSync(path, 'utf8').replace(/\r\n/g, '\n');
    const { text, actions } = enforceUploadCaps(before);
    const summary = actions.length === 0 ? 'no upload_artifact config' : actions.join(', ');
    console.log(`${basename(file)}: upload_artifact "max" mirrored from "max-uploads" (${summary})`);
    if (text !== before) writeFileSync(path, text);
  }
}

const isMain = process.argv[1]?.endsWith('enforce-upload-caps.ts');
if (isMain) main();
