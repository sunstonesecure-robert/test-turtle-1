import { createHash } from 'node:crypto';
import type { Octokit } from '@octokit/rest';
import { z } from 'zod';
import type { RepoRef } from './client';
import { errorStatus } from './errors';
import { freezeApprovedPlan, parsePlanRef, readPlanFileAtRef, tagExists } from './plans';
import type { ReconciledChunk } from './chunks';
import { PlanDoc } from '../../../schemas/plan';
import { inertLogin } from '../actor-identity';

/**
 * WHO APPROVED A PLAN — decided by a person's review of the exact merged commit,
 * never by who merged (GHI #319, part B).
 *
 * The go-ahead is still the merge of the approval pull request. What changed is what
 * the freeze takes that merge to PROVE. `merged_by` names the owner of whatever
 * credential called the merge endpoint, and that endpoint needs only Contents write:
 * the dashboard's token, a workflow token and an administrator bypass can all merge.
 * So the freeze asks a different question — did a person with write access review
 * the commit that was merged? — and a merge with no such review freezes nothing.
 *
 * Two answers authorize, and only two:
 *
 *  1. SOMEONE OTHER THAN THE AUTHOR APPROVED IT. Their latest decisive review is an
 *     approval of the merged head. GitHub itself refuses an author's approving review,
 *     so this is always a second person.
 *
 *  2. THE AUTHOR, WORKING ALONE, RECORDED THEIR OWN DECISION — allowed only when the
 *     plan's own bytes at that commit say `second_human_review: deferred`. The receipt
 *     is the same one trial consent uses (scripts/agent-loop/authority.ts): the
 *     author's comment review of the exact head carrying the plan digest, plus a
 *     consent comment posted through the operator sign-in App. The App is what
 *     separates the person from a token that can act as their account: a comment
 *     written with a personal access token carries no App, and one written through
 *     another App carries a different id.
 *
 * A bot or App review is never a person's. `deferred` is recorded on the approval and
 * is never reported as a second person's review.
 *
 * NOT ENFORCED HERE: that the merge itself was allowed. A merge that should not have
 * happened still lands on main; only its effect — the frozen version every build and
 * gate reads — is refused.
 */

const DIGEST = /^[a-f0-9]{64}$/;
const positive = z.number().int().positive().safe();

/** The review body both forms of the operator's own decision carry. */
export const planApprovalBody = (planSha256: string): string => `Plan approval SHA256: ${planSha256}`;

/** SHA-256 of the plan document exactly as it is stored at the reviewed commit. */
export const planApprovalDigest = (raw: string): string => createHash('sha256').update(raw, 'utf8').digest('hex');

/** The consent comment the dashboard posts as the signed-in operator. */
export const PlanApprovalConsent = z
  .object({
    schema_version: z.literal(1),
    purpose: z.literal('plan_approval_consent'),
    plan_ref: z.string().regex(/^plan\/[a-z0-9][a-z0-9-]*\/v[1-9]\d*$/),
    plan_sha256: z.string().regex(DIGEST),
    head_sha: z.string().min(7).max(64),
    review_id: positive,
    second_human_review: z.literal('deferred'),
  })
  .strict();
export type PlanApprovalConsent = z.infer<typeof PlanApprovalConsent>;

export interface ApprovalActor {
  id: number;
  login: string;
  type: string;
}

export interface ApprovalAuthorityRecord {
  /** The person whose review of the exact commit authorizes the freeze. */
  approver: { id: number; login: string };
  /** When that decision was recorded — the review, or the consent that completes it. */
  approvedAt: string;
  basis: 'second_person_review' | 'single_operator_receipt';
  /** What the plan's own bytes say. `deferred` is not a second person's review. */
  secondHumanReview: 'required' | 'deferred';
  reviewId: number;
  reviewState: 'APPROVED' | 'COMMENTED';
  consentCommentId: number | null;
  planRef: string;
  headSha: string;
  planSha256: string;
  andonIssue: number;
  proposalAuthor: ApprovalActor | null;
  /** Who merged — a separate fact, and no part of the authorization. */
  mergedBy: string | null;
  mergedAt: string;
  mergeSha: string;
}

export type ApprovalRefusalCode =
  | 'not_merged'
  | 'merged_plan_differs'
  | 'approval_missing'
  | 'approval_stale'
  | 'approver_lacks_write'
  | 'second_human_required'
  | 'sign_in_app_unset'
  | 'consent_missing';

export type ApprovalAuthority =
  | { authorized: true; record: ApprovalAuthorityRecord }
  | {
      authorized: false;
      code: ApprovalRefusalCode;
      /** A clause that completes "…was merged, but ". Operator-visible. */
      reason: string;
      mergedBy: string | null;
      planRef: string;
      headSha: string;
      andonIssue: number | null;
    };

interface NativeReview {
  id: number;
  user?: { id: number; login: string; type?: string } | null;
  state: string;
  commit_id?: string | null;
  submitted_at?: string | null;
  body?: string | null;
}

interface NativeComment {
  id: number;
  user?: { id: number; login: string; type?: string } | null;
  body?: string | null;
  created_at: string;
  updated_at: string;
  performed_via_github_app?: { id: number } | null;
}

/** A person's account — never a bot, an App, or an organization. */
function person(user: { id: number; login: string; type?: string } | null | undefined): user is { id: number; login: string; type: string } {
  return !!user && user.type === 'User' && !user.login.endsWith('[bot]') && Number.isSafeInteger(user.id) && user.id > 0;
}

/**
 * Write access, read from GitHub — anyone can submit an approving review on a public
 * repository, and that review says nothing about whether they may decide here.
 * A 404 is GitHub's answer for an account that is not a collaborator; any other
 * failure propagates, so an outage stops the freeze instead of reading as "no".
 */
async function hasWriteAccess(gh: Octokit, repo: RepoRef, user: { id: number; login: string }): Promise<boolean> {
  try {
    const { data } = await gh.repos.getCollaboratorPermissionLevel({ ...repo, username: user.login });
    return data.user?.id === user.id && (data.permission === 'admin' || data.permission === 'write');
  } catch (error: unknown) {
    if (errorStatus(error) === 404) return false;
    throw error;
  }
}

const DECISIVE = new Set(['APPROVED', 'CHANGES_REQUESTED', 'DISMISSED']);
const short = (sha: string): string => sha.slice(0, 7);
const instant = (value: string | null | undefined): number => (value ? Date.parse(value) : Number.NaN);

/**
 * Read the approval of a merged approval pull request. Reads only; decides nothing
 * from `merged_by`, from a body-supplied name, or from a label.
 */
export async function readApprovalAuthority(
  gh: Octokit,
  repo: RepoRef,
  prNumber: number,
  opts: { signInAppId: number | null },
): Promise<ApprovalAuthority> {
  const { data: pr } = await gh.pulls.get({ ...repo, pull_number: prNumber });
  const mergedBy = pr.merged_by?.login ?? null;
  const planRef = pr.head.ref;
  const headSha = pr.head.sha;
  let andonIssue: number | null = null;
  const refuse = (code: ApprovalRefusalCode, reason: string): ApprovalAuthority => ({
    authorized: false,
    code,
    reason,
    mergedBy,
    planRef,
    headSha,
    andonIssue,
  });
  if (!pr.merged_at || !pr.merge_commit_sha) return refuse('not_merged', 'it has not been merged');

  // The plan AS IT IS AT THE MERGED HEAD — the bytes a review of that commit judged.
  const file = await readPlanFileAtRef(gh, repo, planRef, headSha);
  const plan = PlanDoc.parse(JSON.parse(file.raw));
  andonIssue = plan.andon_issue;
  const planSha256 = planApprovalDigest(file.raw);
  const policy = plan.second_human_review ?? 'required';

  // THE TAG IS CUT AT THE MERGE COMMIT, AND A REVIEW IS OF THE HEAD. A merge commit
  // combines the reviewed head with the default branch, so a change to the same plan
  // file on the default branch that merges cleanly puts bytes into the frozen version
  // that no review covered — including, in either direction, the statement that a
  // second person's review is deferred. The approval is carried over to the merge
  // commit only when the plan document there is byte-for-byte the one reviewed. An
  // unreadable merge commit throws: that is a fault, neither "same" nor "different".
  const mergedFile = await readPlanFileAtRef(gh, repo, planRef, pr.merge_commit_sha);
  if (mergedFile.path !== file.path || planApprovalDigest(mergedFile.raw) !== planSha256) {
    return refuse(
      'merged_plan_differs',
      `the plan in the merge commit (${short(pr.merge_commit_sha)}) is not the plan at the commit that was open for review (${short(headSha)}) — the default branch changed the same file — so no review of that commit covers what was merged`,
    );
  }
  const author = person(pr.user) ? { id: pr.user.id, login: pr.user.login, type: pr.user.type } : null;
  const proposalAuthor: ApprovalActor | null = pr.user ? { id: pr.user.id, login: pr.user.login, type: pr.user.type ?? 'unknown' } : null;

  const reviews = (await gh.paginate(gh.pulls.listReviews, { ...repo, pull_number: prNumber, per_page: 100 })) as NativeReview[];
  const authorize = (
    record: Pick<ApprovalAuthorityRecord, 'approver' | 'approvedAt' | 'basis' | 'reviewId' | 'reviewState' | 'consentCommentId'>,
  ): ApprovalAuthority => ({
    authorized: true,
    record: {
      ...record,
      secondHumanReview: policy,
      planRef,
      headSha,
      planSha256,
      andonIssue: plan.andon_issue,
      proposalAuthor,
      mergedBy,
      mergedAt: pr.merged_at!,
      mergeSha: pr.merge_commit_sha!,
    },
  });

  // ---- 1. someone other than the author approved the exact commit ----
  // GitHub lists reviews oldest first; each person's LATEST decisive review is the
  // one that stands, so a later request for changes or a dismissal undoes an approval
  // and a later plain comment does not.
  const standing = new Map<number, NativeReview>();
  for (const review of reviews) {
    if (person(review.user) && DECISIVE.has(review.state)) standing.set(review.user.id, review);
  }
  const approvals = [...standing.values()].filter((r) => r.state === 'APPROVED' && r.user!.id !== pr.user?.id);
  const exact = approvals
    .filter((r) => r.commit_id === headSha && !Number.isNaN(instant(r.submitted_at)))
    .sort((a, b) => instant(b.submitted_at) - instant(a.submitted_at));
  let lacksWrite = false;
  for (const review of exact) {
    const user = review.user!;
    if (!(await hasWriteAccess(gh, repo, user))) {
      lacksWrite = true;
      continue;
    }
    return authorize({
      approver: { id: user.id, login: user.login },
      approvedAt: review.submitted_at!,
      basis: 'second_person_review',
      reviewId: review.id,
      reviewState: 'APPROVED',
      consentCommentId: null,
    });
  }

  // ---- 2. the author's own decision, when the plan defers the second review ----
  const ownDecisions = author
    ? reviews.filter(
        (r) =>
          r.user?.id === author.id &&
          r.state === 'COMMENTED' &&
          r.commit_id === headSha &&
          r.body === planApprovalBody(planSha256) &&
          !Number.isNaN(instant(r.submitted_at)),
      )
    : [];
  if (author && ownDecisions.length > 0) {
    if (policy !== 'deferred') {
      return refuse(
        'second_human_required',
        "its author recorded their own decision, and the plan does not say that a second person's review is deferred — so someone other than the author has to approve it",
      );
    }
    if (opts.signInAppId === null) {
      return refuse(
        'sign_in_app_unset',
        'its author recorded their own decision, and this repository has not been told which dashboard sign-in to trust (the OPERATOR_SIGN_IN_APP_ID variable is not set), so that decision cannot be checked',
      );
    }
    const comments = (await gh.paginate(gh.issues.listComments, { ...repo, issue_number: prNumber, per_page: 100 })) as NativeComment[];
    for (const comment of [...comments].reverse()) {
      if (comment.user?.id !== author.id || comment.performed_via_github_app?.id !== opts.signInAppId) continue;
      // An edited consent is not the consent that was given.
      if (comment.created_at !== comment.updated_at) continue;
      let consent: PlanApprovalConsent;
      try {
        consent = PlanApprovalConsent.parse(JSON.parse(comment.body ?? ''));
      } catch {
        continue;
      }
      if (consent.plan_ref !== planRef || consent.plan_sha256 !== planSha256 || consent.head_sha !== headSha) continue;
      const review = ownDecisions.find((r) => r.id === consent.review_id);
      if (!review || !(instant(review.submitted_at) <= instant(comment.created_at))) continue;
      if (!(await hasWriteAccess(gh, repo, author))) {
        lacksWrite = true;
        break;
      }
      return authorize({
        approver: { id: author.id, login: author.login },
        approvedAt: comment.created_at,
        basis: 'single_operator_receipt',
        reviewId: review.id,
        reviewState: 'COMMENTED',
        consentCommentId: comment.id,
      });
    }
    if (!lacksWrite) {
      return refuse(
        'consent_missing',
        `its author left a review of the merged commit (${short(headSha)}), and no matching consent recorded through the dashboard sign-in was found for it`,
      );
    }
  }

  if (lacksWrite) {
    return refuse('approver_lacks_write', `the approval of the merged commit (${short(headSha)}) came from an account without write access to this repository`);
  }
  if (approvals.length > 0) {
    return refuse('approval_stale', `the only approval on record is of an earlier commit, not the one that was merged (${short(headSha)})`);
  }
  return refuse('approval_missing', `nobody approved the exact commit that was merged (${short(headSha)})`);
}

// ---------------------------------------------------------------------------
// The freeze entry point
// ---------------------------------------------------------------------------

export type FreezeOutcome =
  | { outcome: 'not_an_approval'; detail: string }
  | {
      outcome: 'refused';
      code: ApprovalRefusalCode;
      reason: string;
      andonIssue: number | null;
      noted: boolean;
      /** The version's tag already exists from an earlier run. This run changed
       *  nothing, and "nothing was frozen" would be false — so it is not said. */
      alreadyFrozen: boolean;
    }
  | { outcome: 'frozen'; tagRef: string; reconciled: ReconciledChunk[]; record: ApprovalAuthorityRecord };

const refusalMarker = (prNumber: number, headSha: string, code: string): string =>
  `<!-- freeze-refused pr=${prNumber} head=${headSha} reason=${code} -->`;

/** What the review says when a merge froze nothing — the operator reads this. */
export function freezeRefusedComment(input: {
  prNumber: number;
  planRef: string;
  headSha: string;
  code: ApprovalRefusalCode;
  reason: string;
  mergedBy: string | null;
}): string {
  // A markdown comment on an issue: `inertLogin` keeps the handle from becoming a
  // live mention (GHI #245).
  const merger = input.mergedBy ? inertLogin(input.mergedBy) : 'an account GitHub did not report';
  return [
    refusalMarker(input.prNumber, input.headSha, input.code),
    `**Merged, but not frozen.** Approval pull request #${input.prNumber} for \`${input.planRef}\` was merged by ${merger}, but ${input.reason}.`,
    '',
    'A merge on its own does not approve a plan: it shows only that some credential was able to merge. Freezing needs a person with write access to have reviewed the exact commit. Nothing was frozen, so no build can start from this version.',
    '',
    ...(input.code === 'merged_plan_differs'
      ? [
          // No review can be added that covers a merge commit, so the usual way out
          // (record the approval, re-run) would send the operator round in a circle.
          'Recording an approval now will not finish this: the merge is already made, and its plan is not the one anybody could have reviewed. Re-open the plan as a new version, check what changed on the default branch, and approve that version.',
        ]
      : [
          `To finish, record the approval of commit \`${short(input.headSha)}\`, then re-run the \`plan-post-merge\` workflow for that pull request:`,
          '',
          '- someone other than the pull request author approves it, on GitHub or from the dashboard’s plan approval page; or',
          '- if you work alone and the plan says a second review is deferred, record your own decision from the dashboard’s plan approval page, signed in as yourself.',
        ]),
  ].join('\n');
}

/**
 * Freeze the plan a merged approval pull request approved — or refuse, and say why on
 * the plan's review.
 *
 * THE ONLY PRODUCTION CALLER OF `freezeApprovedPlan`. That function still takes an
 * approver by name, because it is the idempotent writer every suite drives directly;
 * this is the one place a name is allowed to come from, and it comes from
 * `readApprovalAuthority`.
 */
export async function freezeMergedApproval(
  gh: Octokit,
  repo: RepoRef,
  prNumber: number,
  opts: { signInAppId: number | null },
): Promise<FreezeOutcome> {
  const { data: pr } = await gh.pulls.get({ ...repo, pull_number: prNumber });
  // ONE parser for the ref grammar (T279) — see `parsePlanRef`. A looser capture here
  // once read `plan/-demo/v1` as the slug `-demo`.
  const parsed = parsePlanRef(pr.head.ref);
  if (!parsed || !pr.merged_at) {
    return { outcome: 'not_an_approval', detail: `head=${pr.head.ref}, merged=${Boolean(pr.merged_at)}` };
  }
  const authority = await readApprovalAuthority(gh, repo, prNumber, opts);
  if (!authority.authorized) {
    let noted = false;
    // A REFUSED RE-RUN OF A VERSION THAT IS ALREADY FROZEN — a plan frozen before this
    // check existed, or one whose approval was dismissed afterwards. The tag stands
    // and builds read it; the note below says "nothing was frozen, so no build can
    // start", which would be untrue there, so it is not written.
    const alreadyFrozen = await tagExists(gh, repo, authority.planRef);
    if (authority.andonIssue !== null && !alreadyFrozen) {
      const marker = refusalMarker(prNumber, authority.headSha, authority.code);
      const existing = (await gh.paginate(gh.issues.listComments, { ...repo, issue_number: authority.andonIssue, per_page: 100 })) as {
        body?: string | null;
      }[];
      // Said once per reason: a re-run that is refused for the same reason must not
      // stack a second copy on a record nothing ever deletes.
      if (!existing.some((c) => c.body?.includes(marker))) {
        await gh.issues.createComment({
          ...repo,
          issue_number: authority.andonIssue,
          body: freezeRefusedComment({ prNumber, planRef: authority.planRef, headSha: authority.headSha, code: authority.code, reason: authority.reason, mergedBy: authority.mergedBy }),
        });
      }
      noted = true;
    }
    return { outcome: 'refused', code: authority.code, reason: authority.reason, andonIssue: authority.andonIssue, noted, alreadyFrozen };
  }
  const { record } = authority;
  const { tagRef, reconciled } = await freezeApprovedPlan(gh, repo, {
    slug: parsed.slug,
    version: parsed.version,
    mergeSha: record.mergeSha,
    andonIssue: record.andonIssue,
    approver: record.approver.login,
    approvedAt: record.approvedAt,
    mergedBy: record.mergedBy,
    basis:
      record.basis === 'second_person_review'
        ? `approving review ${record.reviewId} of commit ${short(record.headSha)}`
        : `own decision, review ${record.reviewId} of commit ${short(record.headSha)}; second person's review deferred`,
  });
  return { outcome: 'frozen', tagRef, reconciled, record };
}

// ---------------------------------------------------------------------------
// Recording the decision — the dashboard, as the signed-in operator
// ---------------------------------------------------------------------------

/** A refusal with a stable code; nothing was written when one is thrown before a write. */
export class ApprovalRefusal extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}

export interface PlanApprovalReview {
  pull_number: number;
  url: string;
  plan_ref: string;
  head_sha: string;
  plan_sha256: string;
  author: { id: number; login: string } | null;
  second_human_review: 'required' | 'deferred';
  merged: boolean;
  open: boolean;
  steps: { id: string; title: string; priority: string }[];
}

/**
 * What the plan approval page shows, and what the action re-reads before it writes:
 * the pull request's current head, the plan bytes at that commit and their digest.
 * The browser supplies a pull request number and the values it was shown — never a
 * repository, a path or a name.
 */
export async function readPlanApprovalReview(gh: Octokit, repo: RepoRef, pullNumber: number): Promise<PlanApprovalReview> {
  const { data: pr } = await gh.pulls.get({ ...repo, pull_number: pullNumber, headers: { 'cache-control': 'no-cache' } });
  if (!parsePlanRef(pr.head.ref) || pr.base.ref !== 'main') throw new ApprovalRefusal('not_a_plan_approval');
  const file = await readPlanFileAtRef(gh, repo, pr.head.ref, pr.head.sha);
  const plan = PlanDoc.parse(JSON.parse(file.raw));
  return {
    pull_number: pr.number,
    url: pr.html_url,
    plan_ref: pr.head.ref,
    head_sha: pr.head.sha,
    plan_sha256: planApprovalDigest(file.raw),
    author: pr.user ? { id: pr.user.id, login: pr.user.login } : null,
    second_human_review: plan.second_human_review ?? 'required',
    merged: Boolean(pr.merged_at),
    open: pr.state === 'open',
    steps: plan.steps.map((s) => ({ id: s.id, title: s.title, priority: s.priority })),
  };
}

/**
 * Record the signed-in person's decision on the exact commit they were shown.
 *
 * `gh` MUST be that person's own client (DeviceSignIn.asOperator) — the consent
 * comment is trusted because GitHub attributes it to the sign-in App, which a shared
 * token cannot produce. The author of the pull request cannot approve it, so their
 * decision is a comment review plus the consent, and only when the plan itself defers
 * the second review; anyone else's is an ordinary approving review.
 *
 * Allowed after the merge as well as before: the commit is named exactly either way,
 * and a merge that froze nothing has no other way to be completed.
 */
export async function submitPlanApprovalConsent(
  gh: Octokit,
  repo: RepoRef,
  input: { pull_number: number; head_sha: string; plan_sha256: string },
  expectedHumanId: number,
): Promise<{
  review_id: number;
  review_state: 'APPROVED' | 'COMMENTED';
  comment_id: number | null;
  receipt_url: string;
  second_human_review: 'required' | 'deferred';
}> {
  const { data: user } = await gh.users.getAuthenticated();
  if (!person(user) || user.id !== expectedHumanId) throw new ApprovalRefusal('operator_identity_changed');
  const current = await readPlanApprovalReview(gh, repo, input.pull_number);
  if (current.head_sha !== input.head_sha || current.plan_sha256 !== input.plan_sha256) throw new ApprovalRefusal('approval_changed_reload');
  const selfAuthored = current.author?.id === user.id;
  if (selfAuthored && current.second_human_review !== 'deferred') throw new ApprovalRefusal('approval_second_human_required');
  const { data: review } = await gh.pulls.createReview({
    ...repo,
    pull_number: input.pull_number,
    commit_id: current.head_sha,
    event: selfAuthored ? 'COMMENT' : 'APPROVE',
    body: planApprovalBody(current.plan_sha256),
  });
  if (!selfAuthored) {
    return { review_id: review.id, review_state: 'APPROVED', comment_id: null, receipt_url: review.html_url, second_human_review: current.second_human_review };
  }
  const consent = PlanApprovalConsent.parse({
    schema_version: 1,
    purpose: 'plan_approval_consent',
    plan_ref: current.plan_ref,
    plan_sha256: current.plan_sha256,
    head_sha: current.head_sha,
    review_id: review.id,
    second_human_review: 'deferred',
  });
  const { data: comment } = await gh.issues.createComment({ ...repo, issue_number: input.pull_number, body: JSON.stringify(consent) });
  return { review_id: review.id, review_state: 'COMMENTED', comment_id: comment.id, receipt_url: comment.html_url, second_human_review: 'deferred' };
}
