import type { Octokit } from '@octokit/rest';
import type { RepoRef } from './client';
import { PlanDoc } from '../../../schemas/plan';
import { errorMessage, errorStatus } from './errors';
import { createAndonIssue, dropLiveLabelsAndClose } from './andon';

/**
 * Plan module (T033 tracer surface): read the plan document from a ref, resolve
 * the official version (DERIVED: the newest frozen plan/<slug>/v* tag —
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

/**
 * Repo path of a workload's plan document — ONE DIRECTORY PER WORKLOAD.
 *
 * Every plan used to be written to the repo-root `plan.json`. Because approval
 * IS a merge to main (the FR-006 freeze mechanism), one shared path meant every
 * approval rewrote the one file every other in-flight plan branch also owns:
 * the moment any workload's approval merged, every other open approval PR
 * conflicted, and it compounded with each approval (live PB-003 finding F15,
 * GHI #79). Per-workload paths make approval merges conflict-free by
 * construction and give FR-044's parallel independence a structural basis at
 * the one step that matters most — the operator's go-ahead. Main then
 * accumulates one directory per workload, which is a better record besides.
 */
export function planPath(slug: string): string {
  return `plans/${slug}/plan.json`;
}

/**
 * Where the document lived before GHI #79 — a READ fallback only, never a write
 * target. Frozen tags are immutable (FR-042), so pre-migration refs keep the
 * document at the root forever and every reader must still resolve it there.
 */
export const LEGACY_PLAN_PATH = 'plan.json';

export interface PlanFile {
  /** the repo path the document was actually read from */
  path: string;
  /** raw file text, unparsed — callers decide how strictly to validate it */
  raw: string;
  /** blob sha, for a compare-and-swap write back to the same path */
  sha: string;
}

/** One file at one ref, or null when absent. Non-404 failures propagate. */
async function getFileAtRef(
  gh: Octokit,
  repo: RepoRef,
  path: string,
  ref: string,
): Promise<{ raw: string; sha: string } | null> {
  let data;
  try {
    ({ data } = await gh.repos.getContent({ ...repo, path, ref }));
  } catch (error: unknown) {
    if (errorStatus(error) === 404) return null;
    throw error;
  }
  if (Array.isArray(data) || data.type !== 'file' || !('content' in data)) {
    throw new Error(`${path} is not a file at ref ${ref}`);
  }
  return { raw: Buffer.from(data.content, 'base64').toString('utf8'), sha: data.sha };
}

export type LegacyPlanFileOutcome = 'absent' | 'unchanged' | 'aligned';

/**
 * Un-conflict an approval PR whose branch was published BEFORE the per-workload
 * path (GHI #79) — by aligning the branch's stale repo-root `plan.json` with the
 * base's copy of that same path.
 *
 * The live blocker (PB-003 finding F15, approval PR #31): a pre-migration branch
 * carries ITS plan at the repo root, `main` carries whichever workload approved
 * most recently at the SAME path, and both differ from the merge base — a textual
 * conflict on the one file the operator's go-ahead has to merge. Moving the
 * document to `plans/<slug>/plan.json` fixes every FUTURE branch, but a branch
 * whose history already contains a root write keeps conflicting, so those PRs
 * would each need hand-resolution in the web conflict editor.
 *
 * They don't. A three-way merge conflicts only when the two sides DISAGREE about
 * a path: make the branch's copy byte-identical to the base's and both sides
 * agree, so git merges it without a decision to make — whatever the merge base
 * held. That is a forward commit on the plan branch, not a history rewrite.
 *
 * Aligning to the BASE rather than reverting to the merge base is deliberate:
 * it takes one read instead of a merge-base computation, it works for the
 * add/add case as well as modify/modify, and it leaves `main`'s root file
 * exactly as it is — the vestige is removed once, later, for the whole repo
 * (GHI #81), not smuggled in through a plan approval.
 *
 * Ordering matters and is enforced by the caller: the canonical document must be
 * written FIRST. After alignment the branch's root copy holds another workload's
 * plan, which `readPlanFileAtRef` refuses for this slug — so if the canonical
 * write had not happened, reads would fail loudly rather than resolve to the
 * wrong plan.
 *
 * Never runs on a frozen version: the only caller publishes, and publishing
 * refuses when the version's tag exists (FR-007/FR-042).
 */
export async function alignLegacyPlanFileWithBase(
  gh: Octokit,
  repo: RepoRef,
  input: { planRef: string; base: string; actor?: string },
): Promise<LegacyPlanFileOutcome> {
  if (!/^plan\/[a-z0-9-]+\/v\d+$/.test(input.planRef)) {
    throw new Error(`refusing to write: "${input.planRef}" is not a plan branch`);
  }
  const onBranch = await getFileAtRef(gh, repo, LEGACY_PLAN_PATH, input.planRef);
  // Every branch published after #79 leaves the root path alone — one 404 and done.
  if (!onBranch) return 'absent';

  const onBase = await getFileAtRef(gh, repo, LEGACY_PLAN_PATH, input.base);
  // Base has no copy of this path, so the branch's is a one-sided add: git takes
  // it, no conflict. (Only reachable on a repo where no pre-#79 approval ever
  // merged — which is also a repo whose branches carry no root document at all.)
  if (!onBase) return 'unchanged';
  if (onBase.raw === onBranch.raw) return 'unchanged';

  await gh.repos.createOrUpdateFileContents({
    ...repo,
    path: LEGACY_PLAN_PATH,
    message:
      `plan: align the superseded root ${LEGACY_PLAN_PATH} with ${input.base} (GHI #79)\n\n` +
      `This branch predates the per-workload plan path; its plan now lives at the ` +
      `plans/<slug>/ path and this file is a leftover. Matching ${input.base} byte for byte ` +
      `is what lets the approval merge go through without a hand-resolved conflict — ` +
      `both sides of the merge now agree about this path, and ${input.base}'s copy is untouched.`,
    content: Buffer.from(onBase.raw).toString('base64'),
    branch: input.planRef,
    sha: onBranch.sha,
  });
  return 'aligned';
}

/** The `feature` a raw document declares; null when it is not readable JSON. */
function declaredFeature(raw: string): string | null {
  try {
    const doc: unknown = JSON.parse(raw);
    const feature = (doc as { feature?: unknown } | null)?.feature;
    return typeof feature === 'string' ? feature : null;
  } catch {
    return null;
  }
}

/**
 * Locate the plan document at a ref: canonical `plans/<slug>/plan.json` first,
 * then the pre-#79 root `plan.json`.
 *
 * The fallback is GUARDED by `feature`. Post-migration, main's root `plan.json`
 * is a vestige of whichever workload merged last, and every branch cut from main
 * inherits it — so an unguarded fallback would silently hand a caller ANOTHER
 * workload's plan whenever the canonical path was missing. Wrong-plan-silently
 * is exactly the failure mode #79 exists to remove, so a root document that
 * names a different feature is treated as absent, not as this plan.
 * A root document whose JSON is unreadable is NOT rejected here — it is returned
 * so the caller's schema parse reports the real defect instead of "not found".
 */
export async function readPlanFileAtRef(gh: Octokit, repo: RepoRef, ref: string): Promise<PlanFile> {
  const slug = slugFromPlanRef(ref);
  if (slug !== null) {
    const canonical = await getFileAtRef(gh, repo, planPath(slug), ref);
    if (canonical) return { path: planPath(slug), ...canonical };
  }
  const legacy = await getFileAtRef(gh, repo, LEGACY_PLAN_PATH, ref);
  if (legacy && (slug === null || (declaredFeature(legacy.raw) ?? slug) === slug)) {
    return { path: LEGACY_PLAN_PATH, ...legacy };
  }
  if (slug === null) throw new Error(`no plan document at ref ${ref}: ${LEGACY_PLAN_PATH} is absent`);
  throw new Error(
    `no plan document at ref ${ref}: ${planPath(slug)} is absent and the root ${LEGACY_PLAN_PATH} ` +
      (legacy
        ? `belongs to "${declaredFeature(legacy.raw)}", not "${slug}"`
        : 'is absent too'),
  );
}

export async function readPlanAtRef(gh: Octokit, repo: RepoRef, ref: string): Promise<PlanDoc> {
  const file = await readPlanFileAtRef(gh, repo, ref);
  return PlanDoc.parse(JSON.parse(file.raw));
}

/**
 * Untrusted-input variant for gates: returns issues instead of throwing on schema failure.
 *
 * `path` is the repo path the document was actually resolved at — canonical or
 * the pre-#79 root — and null only when no document was found at all. Callers
 * that want to LINK an operator to the plan they are being asked to reason
 * about need it: the two paths are both live (frozen tags are immutable), so a
 * link built from `planPath(slug)` alone would 404 on exactly the older plans
 * whose documents are hardest to find by hand.
 */
export async function tryReadPlanAtRef(
  gh: Octokit,
  repo: RepoRef,
  ref: string,
): Promise<{ plan: PlanDoc | null; errors: string[]; path: string | null }> {
  try {
    const file = await readPlanFileAtRef(gh, repo, ref);
    const parsed = PlanDoc.safeParse(JSON.parse(file.raw));
    if (!parsed.success) {
      return {
        plan: null,
        errors: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`),
        path: file.path,
      };
    }
    return { plan: parsed.data, errors: [], path: file.path };
  } catch (error: unknown) {
    return { plan: null, errors: [errorMessage(error)], path: null };
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
  // Written back to the path it was READ from, not unconditionally to the
  // canonical one: a branch published before GHI #79 carries its document at the
  // root, and an operator edit is not the right moment to move it. Migrating a
  // legacy branch is the PUBLISHER's job — it writes the canonical document and
  // then aligns the leftover root copy (alignLegacyPlanFileWithBase), in that
  // order. After that runs, "the path it was read from" IS the canonical one, so
  // this seam follows the branch forward without needing to know which era it
  // belongs to.
  const file = await readPlanFileAtRef(gh, repo, input.planRef);
  const current = PlanDoc.parse(JSON.parse(file.raw));
  const updated = PlanDoc.parse(input.mutate(current));
  await gh.repos.createOrUpdateFileContents({
    ...repo,
    path: file.path,
    message: input.message(updated),
    content: Buffer.from(JSON.stringify(updated, null, 2)).toString('base64'),
    branch: input.planRef,
    sha: file.sha,
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

/**
 * A workload's OFFICIAL plan, flattened for the surfaces that have to talk
 * about it — where to read it, and what its steps are called.
 *
 * Exists because more than one page needs the same three-step derivation
 * (resolveCurrent → read the document → its steps) in order to print something
 * the operator can act on: the evidence page lists the step ids evidence may be
 * recorded against, the backlog page resolves the frozen tag and workload slug a
 * build must be dispatched with. Written twice, the two would eventually
 * disagree about which version is official — and both are telling the operator
 * what to type into a gate that will check it.
 *
 * Never rejects, and every failure is a value: nothing frozen yet
 * (`planRef: null`) and a frozen plan that no longer parses (`unreadable`) are
 * both ordinary states a page must render, not errors that should blank it.
 */
export interface OfficialPlan {
  slug: string;
  /** the newest frozen version, or null when this workload has approved none */
  planRef: string | null;
  /** repo path the document resolved at — canonical, or the pre-#79 root */
  path: string | null;
  /** the review where that version was judged */
  andonIssue: number | null;
  steps: { id: string; title: string; trackingIssue: number | null }[];
  /** frozen, but the document no longer parses as a plan */
  unreadable: boolean;
}

export async function readOfficialPlan(gh: Octokit, repo: RepoRef, slug: string): Promise<OfficialPlan> {
  const planRef = await resolveCurrent(gh, repo, slug);
  if (planRef === null) {
    return { slug, planRef: null, path: null, andonIssue: null, steps: [], unreadable: false };
  }
  const { plan, path } = await tryReadPlanAtRef(gh, repo, planRef);
  if (!plan) return { slug, planRef, path, andonIssue: null, steps: [], unreadable: true };
  return {
    slug,
    planRef,
    path,
    andonIssue: plan.andon_issue,
    steps: plan.steps.map((s) => ({ id: s.id, title: s.title, trackingIssue: s.tracking_issue ?? null })),
    unreadable: false,
  };
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

  // The branch inherits the frozen document from the tag — overwriting needs its
  // blob sha. A tag frozen before GHI #79 carries it at the ROOT instead, so the
  // canonical path is absent there and this write creates it; that stale root
  // copy is left exactly where it is (the tag is immutable, FR-042, and the
  // guarded fallback still resolves it AT the tag) — never rewritten, because
  // rewriting the shared root path is the collision this change removes.
  const path = planPath(input.slug);
  const inherited = await getFileAtRef(gh, repo, path, planRef);
  await gh.repos.createOrUpdateFileContents({
    ...repo,
    path,
    message: `plan: re-open ${current} as ${planRef} by @${input.actor} at ${input.at}`,
    content: Buffer.from(JSON.stringify(plan, null, 2)).toString('base64'),
    branch: planRef,
    ...(inherited ? { sha: inherited.sha } : {}),
  });

  return { planRef, andonIssue, version };
}
