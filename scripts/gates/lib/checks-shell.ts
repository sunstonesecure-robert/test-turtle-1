import { spawnSync } from 'node:child_process';
import type { PlanDoc } from '../../../schemas/plan';

/**
 * G19's SECOND HALF — `bash -n` on every verification target's `run` (GHI #232).
 *
 * KEPT OUT OF `checks-approval.ts` DELIBERATELY. That module is imported by
 * `dashboard/lib/gate-preview.ts`, which a live review page renders on every load, and
 * `scopeGatePreview` is pure and synchronous by contract. A module that spawns
 * processes must not be reachable from it — the same separation G17 already makes by
 * keeping `verifyTrackedWorkItems` (which reads the tracker) apart from its pure check.
 * So the review's preview shows the SHAPE lint only and says so; this half runs where
 * a shell is a normal thing to have, which is the gate's own job.
 *
 * WHAT IT CATCHES that the shape lint cannot: a `run` that is not valid shell at all.
 * Such a target can never report anything — `build-verify` spawns it, bash exits 2
 * before executing a byte, and the target concludes `failure` forever with an error
 * that looks like the step's fault. Caught here it is one line at the Andon break,
 * before the plan is frozen and while the command is still editable without a re-open.
 *
 * IT NEVER EXECUTES THE COMMAND. `-n` is bash's read-and-parse-only mode: it reports
 * syntax errors and runs nothing. That matters because these strings are operator-
 * approved but not operator-written — they come from a planning agent — and a gate
 * that executed them would be running unreviewed model output with the gate job's
 * credentials.
 *
 * A MISSING OR BROKEN BASH IS NOT A FINDING. If the shell cannot be spawned at all the
 * check reports nothing rather than inventing a syntax error for every target: "could
 * not ask" must never read as "it failed", which is the stance this codebase takes at
 * every other undecidable seam (`build-verify`'s negative control, `getChunk`'s 404).
 */

/** How long one `bash -n` may take. Parsing a one-line command is microseconds; this
 *  exists only so a pathological input cannot hang the gate job. */
const PARSE_TIMEOUT_MS = 5000;

/**
 * The inner program of a single `bash -c '…'` / `sh -c "…"` invocation, or null.
 *
 * `bash -n` does NOT recurse into a quoted string handed to another shell — it reads the
 * outer command and treats the inner program as one opaque word. So for the shape every
 * live target has, the syntax check was inspecting nothing:
 *
 *   printf '%s' "bash -c 'if then'" | bash -n   # exit 0
 *   bash -c 'if then'                           # exit 2, syntax error
 *
 * Extracting the body is therefore what makes the check mean anything (Codex on PR #252,
 * third review). Deliberately narrow: ONE outer command, `bash` or `sh`, a single `-c`,
 * and a wholly-quoted argument. Anything else — a pipeline, `python3 -c`, a body built by
 * expansion — returns null and only the outer command is parsed, because guessing at an
 * arbitrary nested program is the general shell-parsing problem this gate declines to
 * take on (the reason GHI #230 chose a negative control over a lint in the first place).
 */
export function nestedShellBody(run: string): string | null {
  const m = /^\s*(?:ba)?sh\s+-c\s+(['"])([\s\S]*)\1\s*$/.exec(run.trim());
  if (!m) return null;
  const body = m[2]!;
  // A single-quoted body cannot contain an escaped quote, so what we sliced is exact.
  // A double-quoted one may contain `\"` — and may also contain expansions we cannot
  // resolve, so it is parsed as-is and a false pass is preferred to a false failure.
  return body.length > 0 ? body : null;
}

/** Syntax errors in the plan's `run` commands/** Syntax errors in the plan's `run` commands, in plan order — one clause per target,
 *  each carrying bash's own message so the operator sees what bash saw. Empty when
 *  every command parses, and ALSO empty when bash could not be run at all. */
export function runSyntaxProblems(plan: PlanDoc): string[] {
  const problems: string[] = [];
  const parse = (source: string) =>
    spawnSync('bash', ['-n'], { input: source, encoding: 'utf8', timeout: PARSE_TIMEOUT_MS, maxBuffer: 1024 * 1024 });
  for (const vt of plan.verification_targets) {
    if (!vt.run) continue;
    // The OUTER command first, then the inner program when there is one — see
    // `nestedShellBody`. Without the second parse this check passed every malformed
    // nested body, which is the shape every live target has.
    const nested = nestedShellBody(vt.run);
    const proc = parse(vt.run);
    if (!proc.error && proc.status === 0 && nested !== null) {
      const inner = parse(nested);
      if (!inner.error && inner.status !== 0) {
        const said = (inner.stderr ?? '').trim().split('\n')[0] ?? `bash -n exited ${inner.status}`;
        problems.push(
          `${vt.id}: the command inside \`${/^\s*sh\s/.test(vt.run) ? 'sh' : 'bash'} -c '…'\` is not valid shell — ` +
            `bash said "${said.replace(/^bash: line \d+: /, '')}". The outer invocation parses, which is why this ` +
            'needs looking at inside the quotes: a body that does not parse can never report anything, so every ' +
            'build concludes this target `failure` with an error that reads like the step\'s fault',
        );
        continue;
      }
    }
    // No shell, no answer — and no clause. See the docblock: a spawn failure is this
    // check being unable to ask, not the target being wrong.
    if (proc.error) continue;
    if (proc.status === 0) continue;
    const said = (proc.stderr ?? '').trim().split('\n')[0] ?? `bash -n exited ${proc.status}`;
    problems.push(
      `${vt.id}: \`run\` is not valid shell — bash said "${said.replace(/^bash: line \d+: /, '')}". A command that ` +
        'does not parse can never report anything: every build concludes this target `failure` with an error that ' +
        "reads like the step's fault. Fix the command before this plan is frozen",
    );
  }
  return problems;
}
