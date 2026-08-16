import type { Octokit } from '@octokit/rest';
import type { RepoRef } from './client';
import { PlanDoc } from '../../../schemas/plan';
import { errorMessage, errorStatus } from './errors';
import { createAndonIssue, dropLiveLabelsAndClose } from './andon';

/**
 * Plan module (T033 tracer surface): read plan.json from a ref, resolve the
 * official version (DERIVED: the newest frozen plan/<slug>/v* tag —
 * 2026-07-11, GHI #44), derive lifecycle state, perform the post-merge
 * freeze that the plan-post-merge single-writer workflow runs (T038 logic),
 * and commit the operator's scope edits back to a live plan branch
 * (T058/T059 write seam).
 */

export type PlanLifecycle = 'proposed' | 'under_review' | 'frozen' | 're_opened';

export function planBranch(slug: string, version: number): string {
  return `plan/${slug}/v${version}`;
}

/**
 * The inverse of `planBranch`: the workload slug a plan ref names, or null when the ref is
 * not a plan ref at all (a run triggered on `main` belongs to no workload, and asking is
 * not an error).
 *
 * The capture is anchored to SLUG_RE's shape — `[a-z0-9][a-z0-9-]*`, kebab-case with no
 * leading hyphen — so a ref can only resolve to a slug a workload could actually have, and
 * so one workload's refs can never read as another's: `plan/demo/v1` is `demo`, never
 * `demo2` (FR-044/FR-046, the same anchoring resolveCurrent and cancelWorkloadRuns rely on).
 *
 * Single implementation on purpose: this used to be duplicated in build-preflight with a
 * looser `[a-z0-9-]+` capture that accepted `plan/-foo/v1` as the slug `-foo`, which no
 * workload can be called. Two parsers for one ref grammar is how a gate and a view come to
 * disagree about which workload a run belongs to.
 */
export function slugFromPlanRef(ref: string | null | undefined): string | null {
  if (!ref) return null;
  return /^plan\/([a-z0-9][a-z0-9-]*)\/v\d+$/.exec(ref)?.[1] ?? null;
}

export async function readPlanAtRef(gh: Octokit, repo: RepoRef, ref: string): Promise<PlanDoc> {
  const { data } = await gh.repos.getContent({ ...repo, path: 'plan.json', ref });
  if (Array.isArray(data) || data.type !== 'file' || !('content' in data)) {
    throw new Error(`plan.json is not a file at ref ${ref}`);
  }
  const raw = Buffer.from(data.content, 'base64').toString('utf8');
  return PlanDoc.parse(JSON.parse(raw));
}

/** Untrusted-input variant for gates: returns issues instead of throwing on schema failure. */
export async function tryReadPlanAtRef(
  gh: Octokit,
  repo: RepoRef,
  ref: string,
): Promise<{ plan: PlanDoc | null; errors: string[] }> {
  try {
    const { data } = await gh.repos.getContent({ ...repo, path: 'plan.json', ref });
    if (Array.isArray(data) || !('content' in data)) return { plan: null, errors: ['plan.json is not a file'] };
    const parsed = PlanDoc.safeParse(JSON.parse(Buffer.from(data.content, 'base64').toString('utf8')));
    if (!parsed.success) {
      return { plan: null, errors: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`) };
    }
    return { plan: parsed.data, errors: [] };
  } catch (error: unknown) {
    return { plan: null, errors: [errorMessage(error)] };
  }
}

/**
 * Scope-commitment write seam (T058/T059, FR-009/FR-011): commit a mutated
 * plan.json back to the plan BRANCH. Legal as an ordinary contents commit —
 * the plan/** ruleset blocks only non-fast-forward pushes and deletion
 * (scripts/setup-repo.ts). Refused once the version is frozen: the
 * plan/<slug>/v<N> TAG existing IS frozen, and a frozen plan is immutable
 * (FR-007) — callers additionally require a live break (open/under-review),
 * this guard is the seam-level backstop. The mutated doc is re-validated
 * before the write so an edit that would fail G1 never lands, and the
 * GET-sha → PUT pair is a compare-and-swap: a commit racing in between 409s
 * instead of being silently overwritten. `message` is computed from the
 * mutated doc because it may name an id the mutation derived (the vt id).
 */
export async function commitPlanUpdate(
  gh: Octokit,
  repo: RepoRef,
  input: { planRef: string; message: (updated: PlanDoc) => string; mutate: (plan: PlanDoc) => PlanDoc },
): Promise<PlanDoc> {
  if (!/^plan\/[a-z0-9-]+\/v\d+$/.test(input.planRef)) {
    throw new Error(`refusing to write: "${input.planRef}" is not a plan branch`);
  }
  if (await tagExists(gh, repo, input.planRef)) {
    throw new Error(
      `refusing to write: ${input.planRef} is frozen — genuine change is an open re-open, not an edit (FR-007/FR-008)`,
    );
  }
  // The go-ahead window (US2 wave review, PR #53): after the approval PR merges but
  // before the post-merge freeze cuts the tag, the break still carries live
  // labels and the tag does not exist — yet the freeze will tag the merge SHA.
  // An edit landing in that window would live on the branch but in no official
  // version, silently diverging branch head from frozen tag under the same
  // plan/<slug>/v<N> ref name (FR-007). A merged approval PR from this head IS
  // the go-ahead, so it closes the seam regardless of label/tag timing.
  const { data: closedPrs } = await gh.pulls.list({
    ...repo,
    state: 'closed',
    head: `${repo.owner}:${input.planRef}`,
  });
  if (closedPrs.some((pr) => pr.merged_at !== null)) {
    throw new Error(
      `refusing to write: the approval PR for ${input.planRef} is merged — the go-ahead happened and the freeze is imminent; an edit now would not be part of the official version (FR-007)`,
    );
  }
  const { data } = await gh.repos.getContent({ ...repo, path: 'plan.json', ref: input.planRef });
  if (Array.isArray(data) || data.type !== 'file' || !('content' in data)) {
    throw new Error(`plan.json is not a file at ref ${input.planRef}`);
  }
  const current = PlanDoc.parse(JSON.parse(Buffer.from(data.content, 'base64').toString('utf8')));
  const updated = PlanDoc.parse(input.mutate(current));
  await gh.repos.createOrUpdateFileContents({
    ...repo,
    path: 'plan.json',
    message: input.message(updated),
    content: Buffer.from(JSON.stringify(updated, null, 2)).toString('base64'),
    branch: input.planRef,
    sha: data.sha,
  });
  return updated;
}

/**
 * Deterministic id for an operator-added verification target (T059): vt- +
 * the check's first five slugified words ("vt-target" when nothing survives
 * slugification), numeric-suffixed on collision — always matches the schema's
 * ^vt-[a-z0-9-]+$ and never reuses an existing id. Derived inside the write
 * seam's mutate (against the plan the commit actually lands on), so a racing
 * add cannot mint a duplicate.
 */
export function deriveVtId(plan: PlanDoc, check: string): string {
  const slug = check
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .split('-')
    .slice(0, 5)
    .join('-');
  const base = slug.length > 0 ? `vt-${slug}` : 'vt-target';
  const existing = new Set(plan.verification_targets.map((vt) => vt.id));
  if (!existing.has(base)) return base;
  let n = 2;
  while (existing.has(`${base}-${n}`)) n += 1;
  return `${base}-${n}`;
}

/**
 * The official plan version for a slug — DERIVED: the newest frozen
 * `plan/<slug>/v*` TAG; null when nothing is frozen yet. Sound because tags
 * have one writer (the post-merge freeze), versions are monotonic (G9/FR-027,
 * never reused FR-058), and no delete operation exists — so "newest tag" can
 * never disagree with "officially approved". Replaces the plans/<slug>/CURRENT
 * pointer file (2026-07-11, GHI #44): stored state required a machine
 * credential to bypass the main ruleset, which user-owned repos cannot grant.
 */
export async function resolveCurrent(gh: Octokit, repo: RepoRef, slug: string): Promise<string | null> {
  let max = 0;
  // Slug-anchored, not the generic [a-z0-9-]+: the trailing-slash prefix filter
  // already guarantees isolation (plan/demo/ never matches plan/demo2/v1), but
  // anchoring makes that true locally without trusting the API's prefix
  // semantics. Slugs are SLUG_RE-validated kebab-case — no regex metacharacters.
  const versionRe = new RegExp(`^refs/tags/plan/${slug}/v(\\d+)$`);
  try {
    const { data } = await gh.git.listMatchingRefs({ ...repo, ref: `tags/plan/${slug}/` });
    for (const ref of data) {
      const m = versionRe.exec(ref.ref);
      if (m) max = Math.max(max, Number(m[1]));
    }
  } catch (error: unknown) {
    if (errorStatus(error) !== 404) throw error;
  }
  return max > 0 ? planBranch(slug, max) : null;
}

export async function tagExists(gh: Octokit, repo: RepoRef, tagRef: string): Promise<boolean> {
  try {
    await gh.git.getRef({ ...repo, ref: `tags/${tagRef}` });
    return true;
  } catch (error: unknown) {
    if (errorStatus(error) === 404) return false;
    throw error;
  }
}

/**
 * Highest version a slug has ever used: frozen `plan/<slug>/v*` TAGS ∪ existing
 * `plan/<slug>/v*` BRANCHES. Branches count because abandoned (published but
 * never frozen) versions are never reused (FR-058). `excludeRef` lets callers
 * gating a plan skip the plan's OWN branch — otherwise every proposal would
 * fail its own monotonicity check the moment its branch exists.
 */
export async function maxPlanVersion(
  gh: Octokit,
  repo: RepoRef,
  slug: string,
  opts: { excludeRef?: string } = {},
): Promise<number> {
  let max = 0;
  // Slug-anchored for the same reason as resolveCurrent: G9's monotonicity and
  // FR-058's no-reuse rule key on this count — cross-slug leakage here would
  // corrupt version numbering, so it must be impossible locally, not just by
  // API prefix semantics.
  const versionRe = new RegExp(`^refs/(?:tags|heads)/(plan/${slug}/v(\\d+))$`);
  for (const kind of ['tags', 'heads'] as const) {
    try {
      const { data } = await gh.git.listMatchingRefs({ ...repo, ref: `${kind}/plan/${slug}/` });
      for (const ref of data) {
        const m = versionRe.exec(ref.ref);
        if (m && m[1] !== opts.excludeRef) max = Math.max(max, Number(m[2]));
      }
    } catch (error: unknown) {
      if (errorStatus(error) !== 404) throw error;
    }
  }
  return max;
}

/**
 * Commit SHA a plan tag ultimately points at (dereferencing the annotated tag);
 * null when the tag is absent.
 *
 * Exported because verification-target results are bound to the FROZEN SHA
 * (data-model.md "Verification Target Result"), so lifecycle-gate L3 needs the
 * same tag→commit resolution the freeze and the re-open already use — the
 * annotated-tag dereference exists exactly once (`git.getRef` answers with the
 * TAG object's sha for an annotated tag, never the commit's, and freezes are
 * always annotated: reading `object.sha` blindly would compare a tag sha against
 * check-run head SHAs and never match).
 */
export async function tagTargetSha(gh: Octokit, repo: RepoRef, tagRef: string): Promise<string | null> {
  try {
    const { data } = await gh.git.getRef({ ...repo, ref: `tags/${tagRef}` });
    if (data.object.type !== 'tag') return data.object.sha;
    const { data: tag } = await gh.git.getTag({ ...repo, tag_sha: data.object.sha });
    return tag.object.sha;
  } catch (error: unknown) {
    if (errorStatus(error) === 404) return null;
    throw error;
  }
}

/**
 * Post-merge freeze (single writer, FR-006/FR-007/FR-027):
 * 1. annotated tag plan/<slug>/vN at the merge SHA — first writer wins: exactly
 *    one official version (SC-008). A tag already at THIS merge SHA is our own
 *    earlier partial freeze and is resumed, never raced against.
 * 2. andon:resolved on the Andon issue + close it (FR-006: closed, not locked —
 *    the break stays a searchable record; closure is never deletion)
 * The tag IS the official version (derived, 2026-07-11 GHI #44) — the freeze
 * never pushes to main, so it needs no ruleset bypass on any repo type.
 * Every step is idempotent, so a partially-applied freeze can always be re-run.
 */
export async function freezeApprovedPlan(
  gh: Octokit,
  repo: RepoRef,
  input: { slug: string; version: number; mergeSha: string; andonIssue: number; approver: string; approvedAt: string },
): Promise<{ tagRef: string }> {
  const tagRef = planBranch(input.slug, input.version);

  const existingTarget = await tagTargetSha(gh, repo, tagRef);
  if (existingTarget === null) {
    const { data: tag } = await gh.git.createTag({
      ...repo,
      tag: tagRef,
      message: `Frozen plan ${tagRef} approved by @${input.approver} at ${input.approvedAt}`,
      object: input.mergeSha,
      type: 'commit',
    });
    try {
      // Atomic: createRef 422s if refs/tags/<tagRef> appeared since the check.
      await gh.git.createRef({ ...repo, ref: `refs/tags/${tagRef}`, sha: tag.sha });
    } catch (error: unknown) {
      // Lost a live race — only the writer freezing this same merge may continue.
      if (errorStatus(error) !== 422 || (await tagTargetSha(gh, repo, tagRef)) !== input.mergeSha) throw error;
    }
  } else if (existingTarget !== input.mergeSha) {
    throw new Error(
      `refusing to freeze ${tagRef}: tag already exists at ${existingTarget}, not merge ${input.mergeSha} — exactly one official version (SC-008)`,
    );
  }

  // Terminal label BEFORE the live ones are dropped (GHI #48, the
  // withdrawProposal ordering): a partial failure never leaves the break with
  // no andon:* label, and the re-runnable freeze converges from any point.
  await gh.issues.addLabels({ ...repo, issue_number: input.andonIssue, labels: ['andon:resolved'] });
  await dropLiveLabelsAndClose(gh, repo, input.andonIssue);

  return { tagRef };
}

export interface ReopenResult {
  planRef: string;
  andonIssue: number;
  version: number;
}

/**
 * Open re-open of a frozen plan (T046, FR-008): a new branch plan/<slug>/v<N+1>
 * cut from the newest frozen tag, carrying the frozen plan as the revision seed
 * with `supersedes` set — plus a fresh Andon break with every judgment reset.
 * The prior tag is untouched and remains the derived official version: nothing
 * supersedes it until the new one earns a fresh approval. In production the
 * dashboard action dispatches the revision agent against this branch; the
 * correction round-trip then drives the actual changes.
 */
export async function reopenPlan(
  gh: Octokit,
  repo: RepoRef,
  input: { slug: string; actor: string; at: string },
): Promise<ReopenResult> {
  const current = await resolveCurrent(gh, repo, input.slug);
  if (!current) {
    throw new Error(`nothing to re-open: no frozen plan for "${input.slug}" (no plan/${input.slug}/v* tag exists)`);
  }
  // Derived refs are well-formed by construction; the parse is an invariant guard.
  const m = /^plan\/[a-z0-9-]+\/v(\d+)$/.exec(current);
  if (!m) throw new Error(`derived official ref is malformed: "${current}"`);
  const currentVersion = Number(m[1]);

  // One review at a time: a plan ref newer than the official version is an
  // in-flight proposal — judge it or withdraw it; a second re-open would fork
  // the review.
  const maxExisting = await maxPlanVersion(gh, repo, input.slug);
  if (maxExisting > currentVersion) {
    throw new Error(`already re-opened: ${planBranch(input.slug, maxExisting)} is awaiting review — judge or withdraw it first`);
  }
  const version = maxExisting + 1;
  const planRef = planBranch(input.slug, version);

  const frozenSha = await tagTargetSha(gh, repo, current);
  if (!frozenSha) throw new Error(`official version ${current} resolved but its tag vanished — refusing to re-open against it`);
  const prior = await readPlanAtRef(gh, repo, current);

  try {
    await gh.git.createRef({ ...repo, ref: `refs/heads/${planRef}`, sha: frozenSha });
  } catch (error: unknown) {
    // TOCTOU with the in-flight check above: a concurrent re-open won.
    if (errorStatus(error) !== 422) throw error;
    throw new Error(`already re-opened: branch ${planRef} exists`);
  }

  const seed: PlanDoc = {
    ...prior,
    version,
    supersedes: currentVersion,
    run_id: `reopen-of-${input.slug}-v${currentVersion}`,
  };
  const andonIssue = await createAndonIssue(gh, repo, { slug: input.slug, plan: seed, planRef });
  const plan: PlanDoc = { ...seed, andon_issue: andonIssue };

  // The branch inherits the frozen plan.json from the tag — overwriting needs its blob sha.
  const { data } = await gh.repos.getContent({ ...repo, path: 'plan.json', ref: planRef });
  const inheritedSha = !Array.isArray(data) && 'sha' in data ? data.sha : undefined;
  await gh.repos.createOrUpdateFileContents({
    ...repo,
    path: 'plan.json',
    message: `plan: re-open ${current} as ${planRef} by @${input.actor} at ${input.at}`,
    content: Buffer.from(JSON.stringify(plan, null, 2)).toString('base64'),
    branch: planRef,
    ...(inheritedSha ? { sha: inheritedSha } : {}),
  });

  return { planRef, andonIssue, version };
}
