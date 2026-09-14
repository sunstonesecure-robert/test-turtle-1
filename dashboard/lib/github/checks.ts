import type { Octokit } from '@octokit/rest';
import type { RepoRef } from './client';
// TYPE-ONLY on purpose: scripts/gates/* already imports dashboard/lib/github/*,
// so a runtime import back the other way would close an import cycle. The scope
// itself is always DERIVED by the caller with commitmentScope() — this module
// never re-derives it (checks-scope.ts's one-derivation invariant, FR-010).
import type { CommitmentScope } from '../../../scripts/gates/lib/checks-scope';
import type { PlanDoc } from '../../../schemas/plan';

/**
 * Verification-target results & the completion verdict (FR-034, SC-002).
 *
 * A verification target's result is a check run NAMED FOR THE TARGET on the
 * frozen plan tag's commit SHA (data-model.md "Verification Target Result";
 * dashboard-github-api.md's completion read is
 * `GET /repos/{o}/{r}/commits/{frozen-sha}/check-runs` filtered to `vt-*`).
 * Target ids are schema-forced to `^vt-[a-z0-9-]+$`, so the contract's
 * `vt-<id>` check-run name IS the target id — no prefixing is applied here.
 *
 * `deriveCompletionStatus` is PURE (inputs in / verdict out, no I/O, no clock),
 * mirroring checks-scope.ts: lifecycle-gate L3 is a thin wrapper over it and the
 * dashboard completion view renders the SAME verdict from the SAME function. A
 * second derivation on the view is exactly the gate-vs-preview drift this repo
 * forbids (gate-checks-cli.md "Shared conventions").
 */

/** Only the check-run fields the verdict and the latest-run choice read. */
export interface VtCheckRun {
  /** the verification target id (check-run name) */
  name: string;
  /** GitHub's check-run status: queued | in_progress | completed */
  status: string;
  /** null until the run reaches a conclusion */
  conclusion: string | null;
  /**
   * Where the operator reads what this check actually reported.
   *
   * A failing target is where a completion refusal ends, so the name and the word
   * `failure` are not enough — the next question is always "failed how". GitHub
   * offers two links and either answers it: `html_url` is the check's own page,
   * `details_url` is wherever the reporting app points (for an Actions-reported
   * check, its job). The page is preferred because it is the check itself; the
   * app's link is the fallback. Null when the payload carried neither, which is
   * the only case a caller has to render as text.
   */
  detailsUrl: string | null;
}

/**
 * Per-target verdict.
 *
 * `unverified` means no result was ever reported and the step it maps to HAS been
 * delivered — something should have reported and did not. `not-built` means no result
 * was reported because the step has no merged deliverable yet, which is not a problem
 * with the target at all (GHI #231). Both are unmet and both keep completion refused;
 * they are separated because their remedies are opposites — one is "find out why the
 * verification did not report", the other is "build the step".
 *
 * They were one word until 2026-09-13, and the cost of that was an 8-step plan
 * stamping ~15 red check runs on its first deliverable, each telling the operator to
 * "fix the step and re-run the build" for a step nobody had dispatched.
 */
export type VtStatus = 'passing' | 'failing' | 'unverified' | 'not-built';

export interface VtTargetStatus {
  vtId: string;
  /** the MUST steps this target covers, in plan order (why it is load-bearing) */
  mustStepIds: string[];
  status: VtStatus;
  /** the latest run's conclusion; null when unverified or not yet concluded */
  conclusion: string | null;
  /**
   * The latest run's own page, carried through so the table that renders this
   * verdict can offer a way in. Null on an `unverified` target, which has no run
   * to open by definition — not a degraded link, an absent one.
   */
  detailsUrl: string | null;
}

/**
 * What has been BUILT, for the remedy sentence — not for the verdict, which is
 * unchanged by it (GHI #231).
 *
 * Every field here comes from reads the callers already perform:
 * `resolveVerifiedCommit` carries `deliveredStepIds` out of the deliverable listing it
 * fetches anyway, and the tracking issue is on the plan document the caller has
 * already parsed. So this costs no API call on any of the three paths that derive a
 * completion verdict — the panel, lifecycle gate L3, and the subject verifier — which
 * is what lets all three carry the SAME sentence instead of the panel alone getting
 * the good one.
 */
export interface DeliveryContext {
  /** steps with a merged deliverable, under any version of this workload's plan */
  deliveredStepIds: ReadonlySet<string>;
  /** stepId → the work item that tracks it (plan `tracking_issue`), so the remedy can
   *  name the thing the operator dispatches rather than the step id alone */
  trackingIssueByStepId: ReadonlyMap<string, number>;
}

/** Build a `DeliveryContext` from a plan and the delivered step ids — the one place
 *  the `tracking_issue` mapping is formed, so three callers cannot form it three ways. */
export function deliveryContext(plan: PlanDoc, deliveredStepIds: readonly string[]): DeliveryContext {
  const trackingIssueByStepId = new Map<string, number>();
  for (const step of plan.steps) {
    if (typeof step.tracking_issue === 'number') trackingIssueByStepId.set(step.id, step.tracking_issue);
  }
  return { deliveredStepIds: new Set(deliveredStepIds), trackingIssueByStepId };
}

export interface CompletionVerdict {
  /** FR-034: every MUST-mapped target passing (and no MUST step unmapped) */
  complete: boolean;
  /** every MUST-mapped target, first-appearance order over the MUST steps */
  targets: VtTargetStatus[];
  /** operator-facing unmet items, plan order — each actionable on its own */
  unmet: string[];
  /** attached even on a PASS: the vacuous-completion warning, else null */
  note: string | null;
}

// The `vt-` restriction is LOAD-BEARING, not cosmetic: plan-gate, and any other
// CI check the repo runs, live on this very SHA (the frozen tag points at the
// approval merge commit). A `plan-gate` success must never help satisfy L3, and
// a red unrelated check must never block a completion whose targets all passed —
// completion is a statement about verification targets only (FR-034).
const VT_NAME_RE = /^vt-/;

/** A candidate for "latest run of this name", with its ordering keys. */
interface RankedRun {
  run: VtCheckRun;
  /** started_at in ms, null when absent/unparseable */
  startedMs: number | null;
  /** check-run id, null when absent */
  id: number | null;
  /** position in the API's list response — the last-resort key */
  index: number;
}

/**
 * Total, deterministic "is a newer than b": `started_at` first (when both carry
 * one), then the monotonic check-run `id`, then list position. Explicit rather
 * than trusting the endpoint's ordering, which the contract does not pin; the
 * list-order fallback is sound because it is only reached when a payload carries
 * neither key, and GitHub always returns both for a real check run.
 */
function isNewer(a: RankedRun, b: RankedRun): boolean {
  if (a.startedMs !== null && b.startedMs !== null && a.startedMs !== b.startedMs) return a.startedMs > b.startedMs;
  if (a.id !== null && b.id !== null && a.id !== b.id) return a.id > b.id;
  return a.index > b.index;
}

/**
 * The LATEST `vt-*` check run per name on one commit SHA (FR-034's completion
 * read). Paginated: a plan may carry more than one page of verification targets,
 * and a silently truncated page would read as "unverified" — a wrong refusal.
 * Re-reported targets are normal (a re-run build reports the same name again),
 * so only the newest run per name counts.
 */
export async function listVtCheckRuns(gh: Octokit, repo: RepoRef, sha: string): Promise<Map<string, VtCheckRun>> {
  const listed = await gh.paginate(gh.checks.listForRef, { ...repo, ref: sha, per_page: 100 });
  const latest = new Map<string, RankedRun>();
  listed.forEach((raw, index) => {
    if (!VT_NAME_RE.test(raw.name)) return;
    const startedMs = raw.started_at ? Date.parse(raw.started_at) : Number.NaN;
    const candidate: RankedRun = {
      run: {
        name: raw.name,
        status: raw.status,
        conclusion: raw.conclusion ?? null,
        detailsUrl: raw.html_url ?? raw.details_url ?? null,
      },
      startedMs: Number.isNaN(startedMs) ? null : startedMs,
      id: typeof raw.id === 'number' ? raw.id : null,
      index,
    };
    const incumbent = latest.get(raw.name);
    if (!incumbent || isNewer(candidate, incumbent)) latest.set(raw.name, candidate);
  });
  return new Map([...latest.entries()].map(([name, ranked]) => [name, ranked.run]));
}

/** How a non-success run reads in a refusal: the conclusion, or why there is none. */
function conclusionLabel(run: VtCheckRun): string {
  return run.conclusion ?? `${run.status} (no conclusion yet)`;
}

/** The work items an operator dispatches for these steps, or the steps themselves when
 *  the plan binds no tracking issue (G17 makes that impossible on a frozen plan, but a
 *  sentence that says `undefined` is worse than one that names the step). */
function workItemsPhrase(stepIds: string[], delivery: DeliveryContext): string {
  return stepIds
    .map((id) => {
      const issue = delivery.trackingIssueByStepId.get(id);
      return issue === undefined ? `step '${id}'` : `work item #${issue} (${id})`;
    })
    .join(', ');
}

function stepsPhrase(mustStepIds: string[]): string {
  return `MUST step${mustStepIds.length > 1 ? 's' : ''} ${mustStepIds.map((id) => `'${id}'`).join(', ')}`;
}

/**
 * The completion verdict (FR-034/SC-002): every MUST-mapped verification
 * target's latest run on the frozen plan SHA concluded `success`.
 *
 * `scope: null` means NO FROZEN PLAN for the slug — reported as one unmet item
 * rather than treated as "nothing to check", which would let an unapproved
 * workload complete itself.
 */
export function deriveCompletionStatus(
  slug: string,
  scope: CommitmentScope | null,
  runs: ReadonlyMap<string, VtCheckRun>,
  /** which steps have been built, for the REMEDY only (GHI #231). Omitted, every
   *  target with no check run gets the older sentence, which is weaker but never
   *  wrong — the verdict itself does not depend on this argument at all. */
  delivery?: DeliveryContext,
): CompletionVerdict {
  if (scope === null) {
    return {
      complete: false,
      targets: [],
      unmet: [
        `no frozen plan for workload '${slug}' — no plan/${slug}/v* tag exists, so no MUST step has passed anything; get a plan version approved (and its targets reported) before declaring completion`,
      ],
      note: null,
    };
  }

  // First-appearance order over the MUST steps (plan order), targets in
  // verification_targets order within a step: one target may cover several MUST
  // steps, and the operator must see it once, naming every step it carries.
  const mustStepsByVt = new Map<string, string[]>();
  for (const { stepId, vtIds } of scope.coverage) {
    for (const vtId of vtIds) {
      const covered = mustStepsByVt.get(vtId);
      if (covered) covered.push(stepId);
      else mustStepsByVt.set(vtId, [stepId]);
    }
  }

  const targets: VtTargetStatus[] = [];
  const unmet: string[] = [];
  for (const [vtId, mustStepIds] of mustStepsByVt) {
    const run = runs.get(vtId);
    // DELIVERY IS ASKED FIRST, BEFORE ANY EXISTING CHECK RUN (Codex on PR #252, second
    // review). This test used to sit inside `if (!run)`, and that was a completion-
    // integrity hole of GHI #141's own family — a completion earned against code the
    // repository does not contain.
    //
    // Check runs are IMMUTABLE and they outlive the verifier that wrote them. The
    // pre-#231 verifier reported EVERY target of the plan on every merge, including
    // targets for steps nobody had built; install this version into a repository with an
    // in-progress plan and the newest merge commit still carries those runs. A legacy
    // `success` for an UNDELIVERED MUST target would then be read as `passing` — and
    // re-verifying could never clear it, because the new verifier deliberately emits no
    // replacement for a target whose step has not been delivered. A stale green with no
    // way to retract it is precisely what this product refuses.
    //
    // So the plan's own record of what was BUILT outranks any check run's claim about
    // it: an undelivered step's target is `not-built` whatever the history says.
    //
    // SCOPED TO A WORKLOAD THAT HAS ACTUALLY DELIVERED SOMETHING, and this is not a
    // softening — it is the difference between two records that look identical and mean
    // opposite things. When `deliveredStepIds` is EMPTY the workload has no merged
    // deliverable at all, so `resolveVerifiedCommit` is on the pre-US18 COMPATIBILITY
    // SHIM: the verified commit is the frozen tag's own, and any `vt-*` runs there were
    // written by a build that verified the FROZEN TREE, which is the legitimate record
    // for that cohort (FR-063's migration). Disregarding them would make every plan
    // frozen before 2026-08-24 permanently uncompletable — trading a stale-green hole
    // for a strictly larger one. An empty record is "I have nothing to say", not "nothing
    // was delivered", and it must not be read as the second.
    //
    // A post-US18 workload with nothing merged lands in the same branch and is unharmed:
    // it has no `vt-*` runs on the frozen commit either, because `build-publish` creates
    // nothing for a build with no deliverable.
    const recordIsAuthoritative = delivery !== undefined && delivery.deliveredStepIds.size > 0;
    const notBuilt = delivery === undefined ? [] : mustStepIds.filter((id) => !delivery.deliveredStepIds.has(id));
    // An EXISTING run is only disregarded when the record is authoritative; an ABSENT one
    // needs no such caution, because there is no stale green to weigh against. That split
    // is what lets GHI #231's "not built yet" survive on a workload with nothing merged
    // while the shim's legitimate frozen-tree results still count.
    if (notBuilt.length > 0 && (!run || recordIsAuthoritative)) {
      targets.push({ vtId, mustStepIds, status: 'not-built', conclusion: null, detailsUrl: null });
      unmet.push(
        `verification target '${vtId}' (${stepsPhrase(mustStepIds)}) has not been verified because ` +
          `${stepsPhrase(notBuilt)} ${notBuilt.length > 1 ? 'have' : 'has'} not been delivered yet — ` +
          `dispatch the build for ${workItemsPhrase(notBuilt, delivery!)}. This is not a failing target` +
          (run
            ? `. A ${vtId} check run exists on this commit and is DISREGARDED: it was written by a verifier that ` +
              'reported targets for undelivered steps, and a result about work the repository does not contain is ' +
              'not evidence about it'
            : ''),
      );
      continue;
    }
    if (!run) {
      // The step WAS delivered and nothing reported — a different fault from the one
      // above, wanting a different action: find out why the verification did not report.
      targets.push({ vtId, mustStepIds, status: 'unverified', conclusion: null, detailsUrl: null });
      unmet.push(
        `verification target '${vtId}' (${stepsPhrase(mustStepIds)}) is unverified — its ${stepsPhrase(mustStepIds)} ` +
          `${mustStepIds.length > 1 ? 'have' : 'has'} been delivered but no ${vtId} check run exists on the commit ` +
          'these results are read on; re-run the build so its result is reported',
      );
      continue;
    }
    // Anything short of a concluded `success` is not a pass — an in-flight or
    // neutral/skipped run included. Completion never passes open (the same
    // fail-closed stance as the gates' exit 3).
    if (run.conclusion === 'success') {
      targets.push({ vtId, mustStepIds, status: 'passing', conclusion: run.conclusion, detailsUrl: run.detailsUrl });
      continue;
    }
    targets.push({ vtId, mustStepIds, status: 'failing', conclusion: run.conclusion, detailsUrl: run.detailsUrl });
    unmet.push(
      // NOT "the frozen plan SHA" (GHI #231). Results are read on the MERGED
      // DELIVERABLE COMMIT since US18 — a different commit from the frozen tag's on
      // any plan that has produced a deliverable — and this sentence named the wrong
      // one while `resolveVerifiedCommit` had already moved the read. A remedy that
      // points at the wrong commit is a remedy an operator cannot follow.
      `verification target '${vtId}' (${stepsPhrase(mustStepIds)}) concluded '${conclusionLabel(run)}', not success — fix the step and re-run the build so a passing result lands on the commit these results are read on`,
    );
  }

  // Structurally impossible: plan-gate G3 blocks a MUST step with no target
  // (FR-012), and the plan read here is a FROZEN one, which passed G3. Named
  // rather than skipped, because passing silently here would complete a workload
  // whose committed work was never verifiable at all.
  for (const stepId of scope.unmappedMustStepIds) {
    unmet.push(
      `MUST step '${stepId}' has no verification target — the frozen plan cannot have passed plan-gate G3; re-open the plan (FR-008) and map a target before declaring completion`,
    );
  }

  // Vacuous pass (FR-034 read literally: no MUST step, nothing unmet). Passed,
  // but never silent: an operator must be able to see that a workload completed
  // without committing to anything. L8 sets `detail` on a pass for the same
  // reason — a report row that only says "pass" would hide the finding.
  const vacuous = scope.mustStepIds.length === 0;
  return {
    complete: unmet.length === 0,
    targets,
    unmet,
    note: vacuous && unmet.length === 0 ? 'no MUST steps in the frozen plan — nothing was committed' : null,
  };
}
