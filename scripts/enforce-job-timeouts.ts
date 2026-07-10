import { readFileSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';

/**
 * Post-compile job-timeout enforcer (#39). gh-aw v0.81.6 compiles the
 * frontmatter `timeout-minutes` onto the Execute-CLI STEP, not the agent job —
 * and a step-level cap does not kill a hung sandboxed `awf … claude` process,
 * so PB-004 saw a 15-minute intent run ~6h to GitHub's 360-minute default job
 * ceiling. No frontmatter knob reaches the agent/detection jobs
 * (`jobs.<name>.timeout-minutes` is silently ignored for compiler-owned jobs;
 * only `safe-outputs.timeout-minutes` exists, and safe_outputs already carries
 * its job-level 45), so this script injects a job-level `timeout-minutes` into
 * the compiled `.lock.yml` files. Run it after EVERY `gh aw compile` (compile
 * procedure: runbooks/operations/model-catalog-refresh.md step 2);
 * tests/unit/workflow-timeouts.test.ts fails the build if a lock file is
 * missing the injection.
 *
 * Deterministic + idempotent: pure line edits, no YAML re-serialization (a
 * dump would reformat the whole lock file), placement mirrors gh-aw's own
 * job-level emit (after `permissions:`, before `env:`). Values are the
 * frontmatter step intent + 5 minutes headroom for the job's setup/teardown
 * steps; detection's step-level cap is 20 in both workflows.
 */

const JOB_TIMEOUTS: Record<string, Record<string, number>> = {
  'templates/workflows/plan-propose.lock.yml': { agent: 20, detection: 25 },
  'templates/workflows/build-template.lock.yml': { agent: 35, detection: 25 },
};

/** [start, end) line span of a top-level job block (`  <job>:` at 2-space indent). */
function jobSpan(lines: string[], job: string): { start: number; end: number } {
  const start = lines.indexOf(`  ${job}:`);
  if (start < 0) throw new Error(`job "${job}" not found`);
  let end = start + 1;
  while (end < lines.length && !/^ {2}\S/.test(lines[end]!)) end += 1;
  return { start, end };
}

/** Ensure the job carries `    timeout-minutes: <minutes>` (4-space = job property). Returns the action taken. */
function enforce(lines: string[], job: string, minutes: number): 'injected' | 'updated' | 'unchanged' {
  const { start, end } = jobSpan(lines, job);
  const property = `    timeout-minutes: ${minutes}`;
  for (let i = start + 1; i < end; i += 1) {
    if (/^ {4}timeout-minutes:/.test(lines[i]!)) {
      if (lines[i] === property) return 'unchanged';
      lines[i] = property;
      return 'updated';
    }
  }
  // Insert where gh-aw itself places the job-level value (see safe_outputs):
  // after the permissions block, falling back to after runs-on.
  let at = -1;
  for (let i = start + 1; i < end; i += 1) {
    if (lines[i] === '    permissions:') {
      at = i + 1;
      while (at < end && /^ {6}/.test(lines[at]!)) at += 1;
      break;
    }
    if (/^ {4}runs-on:/.test(lines[i]!)) at = i + 1;
  }
  if (at < 0) throw new Error(`job "${job}" has no permissions/runs-on anchor to insert after`);
  lines.splice(at, 0, property);
  return 'injected';
}

function main(): void {
  const root = join(import.meta.dirname, '..');
  for (const [file, jobs] of Object.entries(JOB_TIMEOUTS)) {
    const path = join(root, file);
    // CRLF-normalize: a core.autocrlf checkout leaves \r on every line, which
    // silently defeats the exact-match anchors below and the script throws
    // "job not found". The write-back is LF — the form gh-aw itself emits.
    const lines = readFileSync(path, 'utf8').replace(/\r\n/g, '\n').split('\n');
    let changed = false;
    for (const [job, minutes] of Object.entries(jobs)) {
      const action = enforce(lines, job, minutes);
      changed ||= action !== 'unchanged';
      console.log(`${basename(file)} ${job}: job-level timeout-minutes ${minutes} (${action})`);
    }
    if (changed) writeFileSync(path, lines.join('\n'));
  }
}

main();
