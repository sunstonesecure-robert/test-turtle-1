import { readFileSync } from 'node:fs';
import type { Octokit } from '@octokit/rest';
import { createClient, type RepoRef } from '../dashboard/lib/github/client';
import { getWorkload } from '../dashboard/lib/github/workloads';
import { errorMessage } from '../dashboard/lib/github/errors';
import { refusalDetail, blockingGates, type GateReport } from './gates/lib/runner';

/**
 * Lifecycle refusal reporter (GHI #127) — the failure half of the
 * workload-lifecycle workflow, and the reason it exists:
 *
 * A red `lifecycle-gate` exits 1, `pipefail` fails the gate step, and the apply
 * step — which carries no `if:`, so it defaults to `success()` — is SKIPPED. So
 * a refused `repository_dispatch` wrote NOTHING to the workload issue: the
 * caller got no refusal and no unmet-item list, only a failed Actions run with
 * the JSON in its log. T138's fourth clause is "refusals reported back", and
 * this is it. The dashboard path was never affected — `lifecycleAction` throws
 * the joined failed-gate detail — which is exactly why the gap was easy to
 * miss and why the two paths now share one formatter (`refusalDetail`).
 *
 * WHY THIS IS NOT A `workload-event:v1` COMMENT. A refusal is the ABSENCE of a
 * transition, and that marker means a transition happened. Two readers derive
 * real state from it: `archive-search.ts` renders the attributed history from
 * those markers, and `evidence.ts` finds the deferral window L8 scans by
 * looking for the latest `deferred` event. A `refused` action added to that
 * union would put a non-event in the audit timeline and give L8 a window that
 * never opened. So the refusal is plain markdown carrying no marker, exactly
 * like `intake-normalize`'s refusal — the shape GHI #127 names.
 *
 * THREE THINGS IT REFUSES TO REPORT, because `if: failure()` is broader than
 * "the gate refused":
 *   1. no readable/parseable report — a crashed `npm ci`, a transport error, a
 *      runner dying before `tee` wrote anything. Silence, not "refused": a
 *      comment blaming the gates for an infrastructure fault is worse than no
 *      comment, because it sends the operator to fix a workload that is fine.
 *   2. a report that PASSED — the gate was green and something after it broke
 *      (the apply step itself, most likely). Nothing was refused, so nothing is
 *      reported here; the failed run is the record, and whatever half-applied
 *      is the apply step's business.
 *   3. no workload issue for the slug — which is L0's own failure mode
 *      ("no workload issue with a workload:v1 header for slug X"). There is
 *      nowhere to post. The Actions log stays the only record, and it must,
 *      because inventing an issue to comment on is not available.
 *
 * IDEMPOTENCE follows `intake-normalize`: the comment carries no timestamp, so
 * re-dispatching the same refused action composes a byte-identical body and is
 * skipped rather than stacked. GitHub timestamps every comment itself, so the
 * "when" is not lost — only removed from the body, which is what makes equality
 * a usable dedupe key. A refusal whose REASON changed has a different body and
 * does post, which is right: that is new information. Unlike intake there is no
 * label to remove as a per-attempt signal (a refused transition leaves the
 * `workload:*` label exactly where it was — that is what "performs nothing"
 * means), so the failed Actions run is the per-attempt record and the comment is
 * the standing explanation.
 */

export type RefuseOutcome =
  | { outcome: 'reported'; issueNumber: number; detail: string }
  | { outcome: 'already_reported'; issueNumber: number; detail: string }
  | { outcome: 'no_workload'; detail: string }
  | { outcome: 'not_a_refusal' }
  | { outcome: 'no_report' };

/**
 * Read the gate report, or decide there isn't one.
 *
 * Every failure mode collapses to null on purpose — missing file, unreadable
 * file, malformed JSON, JSON that isn't a gate report. The caller's next move is
 * the same for all of them (say nothing), and distinguishing them here would
 * only tempt a future edit into reporting one of them as a refusal.
 */
function readGateReport(path: string): GateReport | null {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch {
    return null;
  }
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (typeof parsed !== 'object' || parsed === null) return null;
    const report = parsed as GateReport;
    // A report is only a report if it carries the two fields every decision
    // below reads. `tee` can leave a TRUNCATED file behind — the gate was
    // killed mid-write — and truncated JSON that happens to parse must not be
    // read as a verdict.
    if (report.result !== 'pass' && report.result !== 'fail') return null;
    if (!Array.isArray(report.gates)) return null;
    return report;
  } catch {
    return null;
  }
}

/**
 * The refusal comment. No timestamp — see the idempotence note above.
 *
 * The unmet items are rendered one per line rather than in `refusalDetail`'s
 * single joined sentence: this is the surface where an operator reads them to
 * act on them, and four gates joined by `·` is a wall. Both come from the same
 * `phraseGate` wording, so the dispatch comment and the dashboard error still
 * say the same thing about the same gate — only the punctuation between items
 * differs.
 */
export function refusalComment(input: { slug: string; action: string; actor: string; report: GateReport }): string {
  const items = blockingGates(input.report.gates).map((g) => `- **${g.id}** (${g.requirement}) — ${g.detail ?? 'failed'}`);
  return [
    `**Workload lifecycle refused** — \`${input.action}\` requested by @${input.actor} was not performed.`,
    '',
    ...items,
    '',
    'Nothing changed: the gate runs before any effect, so the workload is in the state it was in ' +
      'before this attempt. Resolve the item(s) above and dispatch the transition again.',
  ].join('\n');
}

export async function reportLifecycleRefusal(
  gh: Octokit,
  repo: RepoRef,
  input: { slug: string; action: string; actor: string; gateReportPath: string },
): Promise<RefuseOutcome> {
  const report = readGateReport(input.gateReportPath);
  if (report === null) return { outcome: 'no_report' };

  // Both halves checked, not just `result`: a report claiming `fail` with no
  // blocking gate would compose a refusal with no reason in it, and a blank
  // accusation is the failure mode this whole change exists to end. The
  // `refusalDetail` invariant makes the pair equivalent for every report the
  // runner produces — this is the belt for a hand-edited or future one.
  if (report.result !== 'fail') return { outcome: 'not_a_refusal' };
  const detail = refusalDetail(report.gates);
  if (detail === '') return { outcome: 'not_a_refusal' };

  const workload = await getWorkload(gh, repo, input.slug);
  if (workload === null) return { outcome: 'no_workload', detail };

  const body = refusalComment({ slug: input.slug, action: input.action, actor: input.actor, report });
  const existing = await gh.paginate(gh.issues.listComments, {
    ...repo,
    issue_number: workload.issueNumber,
    per_page: 100,
  });
  if (existing.some((c) => c.body === body)) {
    return { outcome: 'already_reported', issueNumber: workload.issueNumber, detail };
  }
  await gh.issues.createComment({ ...repo, issue_number: workload.issueNumber, body });
  return { outcome: 'reported', issueNumber: workload.issueNumber, detail };
}

const isMain = process.argv[1]?.endsWith('lifecycle-refuse.ts');
if (isMain) {
  const argv = process.argv.slice(2);
  const get = (name: string): string | undefined => {
    const i = argv.indexOf(`--${name}`);
    const v = i >= 0 ? argv[i + 1] : undefined;
    return v && v.length > 0 && !v.startsWith('--') ? v : undefined;
  };
  const slug = get('workload');
  const action = get('action');
  const repoArg = get('repo');
  const gateReportPath = get('gate-report');
  if (!slug || !action || !repoArg || !gateReportPath) {
    console.error('usage: lifecycle-refuse --workload <slug> --action <action> --gate-report <path> --repo <owner/repo> [--actor <login>]');
    process.exit(2);
  }
  const [owner, repoName] = repoArg.split('/');
  if (!owner || !repoName) {
    console.error(`invalid --repo: ${repoArg}`);
    process.exit(2);
  }

  reportLifecycleRefusal(createClient(), { owner, repo: repoName }, {
    slug,
    action,
    // Same default as lifecycle-apply: a dispatch payload without an actor still
    // gets an attributed comment, attributed to the writer that posted it.
    actor: get('actor') ?? 'workload-lifecycle[bot]',
    gateReportPath,
  })
    .then((result) => {
      switch (result.outcome) {
        case 'reported':
          console.log(`refusal reported on workload issue #${result.issueNumber}: ${result.detail}`);
          break;
        case 'already_reported':
          console.log(`refusal already reported on workload issue #${result.issueNumber} (identical body) — not stacking a duplicate`);
          break;
        case 'no_workload':
          console.log(`no workload issue for slug ${slug} — nowhere to report: ${result.detail}`);
          break;
        case 'not_a_refusal':
          console.log('the gate report is not a refusal — the step failed for another reason; reporting nothing');
          break;
        case 'no_report':
          console.log('no readable gate report — the step failed before the gates ran; reporting nothing');
          break;
      }
      // ALWAYS exit 0. This step runs under `if: failure()`, so the job is
      // already failing and that is the outcome the caller sees; exiting
      // non-zero here would only replace the gate's failure with this
      // reporter's, hiding the reason the run failed behind the note about it.
      process.exit(0);
    })
    .catch((error) => {
      // A reporting failure must not masquerade as a gate verdict either, but it
      // does need to be loud in the log — the operator is owed the refusal and
      // did not get it.
      console.error(`failed to report the refusal: ${errorMessage(error)}`);
      process.exit(1);
    });
}
