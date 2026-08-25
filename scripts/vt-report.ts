import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { Octokit } from '@octokit/rest';
import { z } from 'zod';
import { createClient, type RepoRef } from '../dashboard/lib/github/client';
import { readPlanAtRef, resolveCurrent, slugFromPlanRef, tagTargetSha } from '../dashboard/lib/github/plans';
import { errorMessage } from '../dashboard/lib/github/errors';

/**
 * vt-report (T154 + T211, FR-034 / FR-063) — the deterministic reporter that turns
 * a run's verification-target results into `vt-*` check runs on the commit those
 * results actually describe: the MERGED DELIVERABLE COMMIT, or the frozen plan SHA
 * for the pre-US18 cohort the compatibility shim covers.
 *
 * This is what makes workload completion real in live operation: lifecycle-gate row
 * L3 asks whether every MUST-mapped verification target's LATEST `vt-<id>` check run
 * on the workload's verified commit concluded `success`. Nothing else writes those
 * check runs.
 *
 * SUBSTRATE SPLIT — why this is a separate script behind a separate workflow:
 * the build-template agent job is read-only (gh-aw strict mode; its
 * `permissions:` are contents/issues/checks: READ). Emitting the check runs
 * from inside that job would require granting the agent `checks: write` — the
 * exact write capability the split exists to withhold. So the agent uploads an
 * artifact and templates/workflows/vt-report.yml (workflow_run on the build's
 * completion) runs this reporter with the narrow write scope, exactly as
 * plan-propose → plan-publish already does for plan branches.
 *
 * UNTRUSTED INPUT: vt-results.json is agent-authored data crossing the
 * read-only boundary (constitution: "the dashboard MUST treat downloaded
 * artifacts as untrusted input" — the same rule binds this reporter, which has
 * the write scope the agent does not). Everything below is validated BEFORE the
 * first check run is created, so a bad artifact stamps nothing at all rather
 * than half a report.
 *
 * PROVENANCE (GHI #72 option A, decided 2026-07-28; rebound 2026-08-24 for FR-063):
 * the validation also binds the artifact to the run that produced it.
 * `workflow_run.head_sha` is the one signal here the agent cannot author, and it is
 * both the binding AND the answer to "which commit do these results describe?" — a
 * verify run's head is the merged deliverable commit, a pre-US18 build's head is the
 * frozen tag's own commit. The reported plan_ref must be the official version and
 * the run's commit must DESCEND from its tag, which is what stops a run for workload
 * A reporting against workload B's plan and completing B without B ever being built.
 *
 * CHECK-RUN NAME = THE TARGET ID, VERBATIM. L3's row words the name `vt-<id>`,
 * and the schema constrains ids to `^vt-[a-z0-9-]+$` (schemas/plan.ts
 * VerificationTarget) — so "vt-" + the id and the id itself are the same
 * string. Recording that reading here because the obvious "fix" (prefixing
 * again) yields `vt-vt-hello-copy`, a name L3's lookup would never find.
 *
 * RE-RUNNING IS SAFE, AND DELETES NOTHING (FR-042). A second report for the
 * same target creates a SECOND check run with the same name on the same SHA;
 * L3 reads the LATEST run per name (dashboard/lib/github/checks.ts
 * `listVtCheckRuns`, ordered by `started_at`, then the monotonic check-run id),
 * so the newer result supersedes the older for completion purposes while every
 * earlier attempt stays in the permanent record. Both ordering keys are assigned
 * by GitHub at creation, in creation order — which is why this reporter creates
 * rather than updates, and why it never needs (or has) a delete.
 */

/**
 * GitHub's accepted check-run conclusions ("Create a check run", REST v3).
 * Enumerated here rather than passed through because an arbitrary string does
 * not fail locally — it 422s at the API, mid-report, after earlier targets have
 * already been stamped. Validating the set up front is what keeps a malformed
 * artifact from producing a partial report.
 */
export const CHECK_CONCLUSIONS = [
  'success',
  'failure',
  'neutral',
  'cancelled',
  'skipped',
  'timed_out',
  'action_required',
  // `stale` completes the endpoint's enum. Omitting it made this list not the
  // exhaustive set it claims to be: a target legitimately reporting `stale` would
  // have refused the WHOLE artifact (validation is all-or-nothing by design, so no
  // partial report is ever written), discarding every other target's result with
  // it. L3 already treats every non-`success` conclusion as unmet, so admitting it
  // costs nothing and keeps the failure evidence. Our own check-run type in
  // tests/unit/completion-gate.test.ts already listed it — this removes that
  // inconsistency rather than adding a capability.
  'stale',
] as const;

export type CheckConclusion = (typeof CHECK_CONCLUSIONS)[number];

const VtResult = z
  .object({
    id: z.string().regex(/^vt-[a-z0-9-]+$/, 'must be a verification target id matching ^vt-[a-z0-9-]+$'),
    conclusion: z.enum(CHECK_CONCLUSIONS),
  })
  .strict();

/**
 * The `vt-results.json` artifact contract (documented in
 * templates/workflows/build-template.md, which the build agent follows).
 *
 * `plan_ref` is carried IN the artifact because the artifact is the only
 * channel across the read-only boundary: the workflow_run event payload the
 * reporter is triggered by exposes the build run's id, not the `plan_ref`
 * input the build was dispatched with, so there is nowhere else for the frozen
 * ref to come from. It is treated as a claim, not a fact — see the
 * resolveCurrent check in reportVtResults.
 *
 * `.strict()` on both objects: an unknown key means the build is emitting a
 * contract this reporter does not implement, and silently ignoring it would
 * report results the agent believes it qualified somehow.
 */
export const VtResults = z
  .object({
    plan_ref: z.string().min(1),
    results: z.array(VtResult),
  })
  .strict();

export type VtResults = z.infer<typeof VtResults>;

export interface VtReportResult {
  /** the frozen plan tag the results were validated against */
  planRef: string;
  /** the commit the check runs were created on — the MERGED deliverable commit, or
   *  the frozen tag's own commit under the pre-US18 compatibility shim (FR-063) */
  headSha: string;
  reported: { id: string; conclusion: CheckConclusion }[];
}

export async function reportVtResults(
  gh: Octokit,
  repo: RepoRef,
  raw: unknown,
  /** The triggering build run's commit (`workflow_run.head_sha`) — the trusted
   *  provenance the artifact's claim is bound against. Omitted only by callers
   *  with no triggering run (a local invocation); see the binding below. */
  expectSha?: string,
): Promise<VtReportResult> {
  // The pre-extension artifact shape was a bare `[{ id, conclusion }]` array.
  // It is NOT accepted: it carries no plan_ref, and the reporter cannot derive
  // one (see the VtResults docblock), so accepting it would mean guessing which
  // frozen SHA to stamp — the one thing this reporter must never do. Named
  // explicitly so an old build emitting it gets a fix, not a generic type error.
  if (Array.isArray(raw)) {
    throw new Error(
      'refusing to report: vt-results.json is the legacy bare array [{ id, conclusion }], which carries no plan_ref — ' +
        'the reporter cannot know which frozen plan SHA to stamp. Emit the object form: ' +
        '{ "plan_ref": "plan/<slug>/v<N>", "results": [{ "id": "vt-...", "conclusion": "success" }] }',
    );
  }
  const parsed = VtResults.safeParse(raw);
  if (!parsed.success) {
    throw new Error(
      `refusing to report: vt-results.json failed validation: ${parsed.error.issues
        .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
        .join('; ')}`,
    );
  }
  const { plan_ref: planRef, results } = parsed.data;

  // slugFromPlanRef is the single parser for this ref grammar (plans.ts): a
  // second, looser one is how a gate and a reporter come to disagree about
  // which workload a ref belongs to.
  const slug = slugFromPlanRef(planRef);
  if (slug === null) {
    throw new Error(
      `refusing to report: plan_ref "${planRef}" is not a frozen plan ref (plan/<slug>/v<N>) — a build may only run ` +
        'against a frozen plan tag (build preflight B1, FR-007)',
    );
  }

  // The reported ref is the AGENT's claim. It must be the derived official
  // version for its slug — the newest frozen plan/<slug>/v* tag (plans.ts
  // resolveCurrent, GHI #44). This is not extra strictness: L3 reads check runs
  // on "the current frozen plan SHA", so results for a superseded version could
  // never satisfy it anyway, while stamping them would make a stale green look
  // current. Refuse instead of writing onto an arbitrary SHA.
  const official = await resolveCurrent(gh, repo, slug);
  if (official === null) {
    throw new Error(
      `refusing to report: plan_ref "${planRef}" names workload "${slug}", which has no frozen plan (no ` +
        `plan/${slug}/v* tag exists) — nothing was ever approved to build against (FR-006/FR-007)`,
    );
  }
  if (official !== planRef) {
    throw new Error(
      `refusing to report: plan_ref "${planRef}" is not the official version of workload "${slug}" — that is ` +
        `"${official}". Verification results for a superseded version can never satisfy completion (gate L3 reads ` +
        `the CURRENT frozen plan SHA); re-run the build against ${official}`,
    );
  }

  // Every reported id must be a target the frozen plan actually defines. A
  // check run whose name no plan can explain is unexplainable evidence: L3
  // would ignore it, and an operator auditing the record would find a green
  // check with no requirement behind it (FR-035's "record remains reviewable").
  const plan = await readPlanAtRef(gh, repo, planRef);
  const known = new Set(plan.verification_targets.map((vt) => vt.id));
  const unknown = results.map((r) => r.id).filter((id) => !known.has(id));
  if (unknown.length > 0) {
    throw new Error(
      `refusing to report: vt-results.json reports verification target ids that ${planRef} does not define: ` +
        `${unknown.join(', ')} — the plan defines: ${[...known].join(', ') || '(none)'}. Fix the build's target ids, ` +
        'or take the missing target through a plan re-open (FR-008) so it is an approved commitment first',
    );
  }

  // A duplicated id inside ONE report makes L3's "latest run per name" read
  // depend on the order two same-named check runs happened to be created in —
  // i.e. a pass and a fail for the same target would resolve arbitrarily. A
  // re-report in a LATER run is the supported supersede path (see the module
  // docblock); two conclusions in the same artifact is a build bug.
  const duplicated = [...new Set(results.map((r) => r.id).filter((id, i, all) => all.indexOf(id) !== i))];
  if (duplicated.length > 0) {
    throw new Error(
      `refusing to report: vt-results.json reports the same verification target more than once: ` +
        `${duplicated.join(', ')} — one conclusion per target per run, or L3's latest-run read is order-dependent`,
    );
  }

  // The frozen TAG's commit. tagTargetSha is the shared annotated-tag dereference
  // (plans.ts, also used by the freeze, the re-open, and L3's own read): freezes are
  // always annotated, so reading `getRef().object.sha` directly would yield the TAG
  // object's sha and every check run would land on a commit nothing looks at.
  const tagSha = await tagTargetSha(gh, repo, planRef);
  if (tagSha === null) {
    // resolveCurrent found the tag a moment ago, so this is a genuine
    // disappearance rather than a normal absence — report it as such.
    throw new Error(`refusing to report: ${planRef} resolved as the official version but its tag has no target commit`);
  }

  // PROVENANCE BINDING (GHI #72 option A, decided 2026-07-28; REBOUND 2026-08-24 for
  // FR-063) — the check that makes "untrusted input" true rather than aspirational,
  // and the check that decides WHICH COMMIT the results describe.
  //
  // Everything validated above establishes the artifact's plan_ref is AN official
  // frozen version whose plan defines the reported ids. None of it establishes it is
  // the version THIS run was about: a run for workload A could name workload B's
  // official plan and B's real target ids, and B would satisfy L3 without ever being
  // built.
  //
  // TWO ACCEPTED BINDINGS, and the difference between them is the whole of US18:
  //
  //   DESCENDANT (the rule, FR-063). A verify run executes against the MERGED
  //   deliverable commit, so its `workflow_run.head_sha` is a descendant of the
  //   frozen tag. The check runs are recorded THERE — on the code that actually
  //   contains the work. This is what makes completion earnable against code that
  //   exists.
  //
  //   IDENTICAL (the compatibility shim, constitution Frozen-Artifact Compatibility
  //   route (a)). Before US18 a build verified the frozen TREE and produced no
  //   deliverable, so its head_sha IS the tag's commit. Every plan frozen before
  //   2026-08-24 depends on that reading, and refusing it would make each one
  //   permanently unverifiable — the GHI #44/#109 mistake exactly.
  //
  //   REMOVAL DATE: 2027-02-24, or when no plan frozen before 2026-08-24 remains
  //   un-completed in any governed repo, whichever is later. What the shim admits is
  //   narrow and worth naming: results about the frozen tree, which describe code the
  //   deliverable path did not produce. That is exactly the shape GHI #141 found —
  //   which is why the shim accepts it only for the cohort that predates the fix, and
  //   why `build-publish` refuses to create anything at all for a build with no
  //   deliverable.
  //
  // Anything else — `behind`, `diverged`, unrelated — is refused. A result about a
  // commit the approved plan does not lead to is a result about something else.
  let headSha = tagSha;
  const verified = expectSha?.trim();
  if (verified !== undefined && verified.length > 0 && verified !== tagSha) {
    let status: string;
    try {
      const { data } = await gh.repos.compareCommits({ ...repo, base: tagSha, head: verified });
      status = data.status;
    } catch {
      status = 'unrelated';
    }
    if (status !== 'ahead' && status !== 'identical') {
      throw new Error(
        `refusing to report: vt-results.json claims ${planRef} (frozen commit ${tagSha.slice(0, 8)}), but the run ` +
          `that produced it verified commit ${verified.slice(0, 8)}, which is "${status}" relative to the frozen ` +
          'tag — not a descendant of it. Verification results may only describe code the approved plan led to ' +
          '(FR-063, preflight B9). Nothing was written.',
      );
    }
    // Record on the MERGED commit — the code that actually contains the verified
    // work. This one assignment is what US18 moved.
    headSha = verified;
  }

  // Coverage is deliberately NOT checked here. A report naming only some
  // targets is legitimate (a re-run of a single failing check), and refusing it
  // would discard the results that WERE produced. "Every MUST-mapped target
  // concluded success" is L3's question, asked at the completion transition,
  // and it fails closed on a target with no check run.
  const byId = new Map(plan.verification_targets.map((vt) => [vt.id, vt]));
  for (const result of results) {
    const target = byId.get(result.id)!; // membership proven above
    await gh.checks.create({
      ...repo,
      // Verbatim id — see the CHECK-RUN NAME note in the module docblock.
      name: result.id,
      head_sha: headSha,
      // Completed with a conclusion: L3 reads conclusions, and a queued or
      // in_progress run has none, so an unconcluded run would read as unmet.
      status: 'completed',
      conclusion: result.conclusion,
      output: {
        // The operator-facing side of the record (FR-035: the completed
        // workload's record stays reviewable) — the check text the target
        // committed to, next to the result it got.
        title: `${target.kind} — ${result.conclusion}`,
        summary:
          `${target.check}\n\n` +
          `${target.run ? `Executed: \`${target.run}\`\n` : ''}` +
          `Frozen plan: ${planRef} (${tagSha})\n` +
          `Verified commit: ${headSha}${headSha === tagSha ? ' — the frozen tree itself (pre-US18 compatibility shim)' : ' — the merged deliverable'}\n` +
          `Maps to: ${target.maps_to.join(', ')}`,
      },
    });
  }

  return { planRef, headSha, reported: results };
}

/** Locate vt-results.json anywhere under the downloaded-artifacts directory
 *  (download-artifact@v4 nests each artifact in its own subdirectory). */
export function findVtResultsFile(dir: string): string | null {
  if (!existsSync(dir)) return null;
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      const nested = findVtResultsFile(full);
      if (nested) return nested;
    } else if (entry === 'vt-results.json') {
      return full;
    }
  }
  return null;
}

const isMain = process.argv[1]?.endsWith('vt-report.ts');
if (isMain) {
  const argv = process.argv.slice(2);
  const get = (name: string): string | undefined => {
    const i = argv.indexOf(`--${name}`);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const dir = get('dir');
  const repoArg = get('repo');
  const [owner, repoName] = (repoArg ?? '').split('/');
  // The triggering build run's commit — the workflow passes
  // `workflow_run.head_sha`, which preflight B8 guarantees is the frozen tag's
  // commit. Required in the workflow; optional here only so the CLI stays runnable
  // by hand, which is why the binding inside reportVtResults skips when absent.
  const expectSha = get('expect-sha');
  if (!dir || !owner || !repoName) {
    console.error('usage: vt-report --dir <artifacts-dir> --repo <owner/repo> [--expect-sha <sha>]');
    process.exit(2);
  }
  const resultsFile = findVtResultsFile(dir);
  if (!resultsFile) {
    // Not silently green: a build that reported nothing leaves every target
    // without a check run, and L3 refuses completion on exactly that (fail
    // closed). Exit non-zero so the missing artifact is visible on the run.
    console.error(`no vt-results.json found under ${dir} — the build run uploaded no verification-results artifact`);
    process.exit(1);
  }
  reportVtResults(createClient(), { owner, repo: repoName }, JSON.parse(readFileSync(resultsFile, 'utf8')), expectSha)
    .then((result) => {
      console.log(
        `reported ${result.reported.length} verification target(s) on ${result.planRef} (${result.headSha}): ` +
          (result.reported.map((r) => `${r.id}=${r.conclusion}`).join(', ') || '(none)'),
      );
    })
    .catch((error) => {
      console.error(errorMessage(error));
      process.exit(1);
    });
}
