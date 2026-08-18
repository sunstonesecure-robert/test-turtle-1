import type { Octokit } from '@octokit/rest';
import { createClient, repoFromEnv, type RepoRef } from '../../dashboard/lib/github/client';
import { commitPlanUpdate, maxPlanVersion, planBranch, readPlanAtRef, tagExists } from '../../dashboard/lib/github/plans';
import { createChunk } from '../../dashboard/lib/github/chunks';
import { errorMessage, errorStatus } from '../../dashboard/lib/github/errors';
import { checkG6HighStakesAuthority } from '../gates/lib/checks-highstakes';
import { confirmationPath, stepDigest } from '../gates/lib/checks-preflight';
import { printReport, reportResult, type GateReport, type GateResult } from '../gates/lib/runner';
import { buildPreflight } from '../gates/build-preflight';
import { ConfirmationRecord } from '../../schemas/confirmation';
import { proposeDemoPlan } from './propose-plan';

/**
 * Demo high-stakes loop (T110, quickstart §5): drives US6 end to end against a
 * governed target repo through the REAL gate functions — G6 from plan-gate and the
 * whole build-preflight set. Nothing here narrates an outcome it did not compute.
 *
 * It runs in TWO ACTS because the product works in two acts. Flagging a step
 * high-stakes is a REVIEW-time act on the live plan branch; the confirmation is a
 * POST-FREEZE act on the default branch, because FR-024 blocks the build "even on an
 * approved plan" and the frozen tag therefore cannot contain the record. The
 * operator's approval merge sits between the two, so this script reads the repo to
 * decide which act it is in and prints what to do next:
 *
 *   act 1 — plan/<slug>/vN exists and is NOT frozen: seed a proposal when the slug
 *     has none, flag --step with --authority through the same write seam the review
 *     page's scope editor uses, label the step's tracking issue, and run G6 on the
 *     result — and on the same plan with the route stripped out, so the teeth show.
 *   … you approve and merge the plan (quickstart §4.5); the freeze cuts the tag …
 *   act 2 — the tag exists: run build-preflight (B5 FAILS, no record), commit
 *     confirmations/<workload>/<step-id>.json to the default branch, run build-preflight again
 *     (green — same tag, same plan, no re-approval).
 *
 * In production the flag comes from the review page's high-stakes panel and the
 * confirmation from one of the operator confirmation skills; this seed writes through
 * the same seams they do. `confirmed:<authority>` is left to the confirm-record
 * workflow that act 2's commit triggers — the demo never applies it itself.
 */

const AUTHORITIES = ['customer', 'clinical', 'legal'] as const;
export type Authority = (typeof AUTHORITIES)[number];

export interface HighStakesOptions {
  slug?: string;
  stepId?: string;
  /** act 1 only — act 2 reads the route from the FROZEN plan, which is the record */
  authority?: Authority;
  confirmer?: string;
  contact?: string;
  at?: string;
}

export interface FlagResult {
  act: 'flag';
  /** true when this run seeded the proposal it then flagged */
  proposed: boolean;
  planRef: string;
  stepId: string;
  authority: Authority;
  /** the step's tracking issue, created and bound here when it had none */
  trackingIssue: number;
  /** true when this run created that tracking issue */
  chunkCreated: boolean;
  g6: GateResult;
  /** the same check on the same plan with the authority removed (FR-023's refusal) */
  g6Unrouted: GateResult;
}

export interface ConfirmResult {
  act: 'confirm';
  planRef: string;
  stepId: string;
  authority: Authority;
  branch: string;
  path: string;
  record: ConfirmationRecord;
  /** false when a valid record was already on the branch — nothing was overwritten */
  recorded: boolean;
  before: GateReport;
  after: GateReport | null;
  /** where confirm-record will apply `confirmed:<authority>`; null when the step
   *  carries no tracking issue, which is that workflow's "unlabeled" outcome */
  trackingIssue: number | null;
}

export type HighStakesResult = FlagResult | ConfirmResult;

/**
 * The authenticated operator — the identity the real workflows record via
 * github.actor. NO placeholder fallback: an unattributable confirmation is the
 * exact failure FR-024 exists to prevent (live PB-003 finding G).
 */
async function resolveActor(gh: Octokit): Promise<string> {
  try {
    return (await gh.users.getAuthenticated()).data.login;
  } catch {
    // /user is user-to-server only — an installation token (the Actions
    // GITHUB_TOKEN) 401/403s here; the runner exports the triggering identity.
  }
  const actor = process.env.GITHUB_ACTOR;
  if (!actor) {
    throw new Error(
      'cannot resolve an attributable operator identity: this token cannot call /user and GITHUB_ACTOR is unset',
    );
  }
  return actor;
}

/** Blob sha of a file on a branch, or undefined when absent: the contents API needs
 *  it to OVERWRITE (the invalid-record case B5 reports) and rejects it on create. */
async function blobSha(gh: Octokit, repo: RepoRef, path: string, branch: string): Promise<string | undefined> {
  try {
    const { data } = await gh.repos.getContent({ ...repo, path, ref: branch });
    return Array.isArray(data) || !('sha' in data) ? undefined : data.sha;
  } catch (error: unknown) {
    if (errorStatus(error) === 404) return undefined;
    throw error;
  }
}

/** Act 1 — flag the step and route it, on the LIVE plan branch. */
async function flagStep(
  gh: Octokit,
  repo: RepoRef,
  input: { planRef: string; stepId: string; authority: Authority; actor: string; at: string; proposed: boolean },
): Promise<FlagResult> {
  const current = await readPlanAtRef(gh, repo, input.planRef);
  const target = current.steps.find((s) => s.id === input.stepId);
  if (!target) {
    throw new Error(
      `${input.planRef} has no step ${input.stepId} — its steps are: ${current.steps.map((s) => s.id).join(', ')}`,
    );
  }
  // BOTH high-stakes labels live on the step's TRACKING ISSUE — the review page's
  // panel puts `high-stakes:<authority>` there and confirm-record puts
  // `confirmed:<authority>` there — so an unbound step has nowhere to show its
  // routing. Checked and bound BEFORE the plan write so a mistyped step id cannot
  // leave an orphan chunk behind.
  const chunkCreated = target.tracking_issue == null;
  const trackingIssue = chunkCreated
    ? (await createChunk(gh, repo, { title: target.title })).issueNumber
    : target.tracking_issue!;

  // commitPlanUpdate is the review page's write seam: it refuses a frozen ref and
  // the merged-approval window, so this demo can never edit an official version.
  const updated = await commitPlanUpdate(gh, repo, {
    planRef: input.planRef,
    message: () =>
      `plan: flag ${input.stepId} high-stakes (${input.authority}) by @${input.actor} at ${input.at} (FR-023)`,
    mutate: (plan) => ({
      ...plan,
      steps: plan.steps.map((s) =>
        s.id === input.stepId ? { ...s, high_stakes: true, authority: input.authority, tracking_issue: trackingIssue } : s,
      ),
    }),
  });

  await gh.issues.addLabels({ ...repo, issue_number: trackingIssue, labels: [`high-stakes:${input.authority}`] });

  return {
    act: 'flag',
    proposed: input.proposed,
    planRef: input.planRef,
    stepId: input.stepId,
    authority: input.authority,
    trackingIssue,
    chunkCreated,
    g6: checkG6HighStakesAuthority(updated),
    // Run, not described: the same gate on the same document with the route taken
    // away is what an approval PR meets when a flag names no authority.
    g6Unrouted: checkG6HighStakesAuthority({
      ...updated,
      steps: updated.steps.map((s) => (s.id === input.stepId ? { ...s, authority: null } : s)),
    }),
  };
}

/** Act 2 — show B5 blocking the frozen plan, record the confirmation, show it pass. */
async function confirmStep(
  gh: Octokit,
  repo: RepoRef,
  input: {
    slug: string;
    planRef: string;
    stepId: string;
    actor: string;
    at: string;
    authority?: Authority;
    confirmer?: string;
    contact?: string;
  },
): Promise<ConfirmResult> {
  const plan = await readPlanAtRef(gh, repo, input.planRef);
  const step = plan.steps.find((s) => s.id === input.stepId);
  if (!step) {
    throw new Error(
      `the frozen plan ${input.planRef} has no step ${input.stepId} — its steps are: ${plan.steps.map((s) => s.id).join(', ')}`,
    );
  }
  if (!step.high_stakes) {
    throw new Error(
      `${input.stepId} is not high-stakes in ${input.planRef}, and that plan is frozen — flagging is a review-time act ` +
        `(FR-007 makes the frozen document immutable). Run this demo on a fresh slug (--slug <new-slug>) so the flag ` +
        `lands before approval, or re-open the plan and flag v${plan.version + 1}.`,
    );
  }
  // The route of record is the one the OPERATOR approved, not one this CLI supplies:
  // a record from another authority is exactly what B5's third failure cause catches.
  const authority = step.authority as Authority;
  if (input.authority !== undefined && input.authority !== authority) {
    throw new Error(
      `--authority ${input.authority} contradicts the frozen plan: ${input.stepId} routes to ${authority} (FR-023)`,
    );
  }

  const { data: repoInfo } = await gh.repos.get({ ...repo });
  const branch = repoInfo.default_branch;
  const path = confirmationPath(input.slug, step.id);
  // Validated here, exactly as B5 will validate it after the write — a demo that
  // committed a record its own gate rejects would be teaching the wrong shape.
  const record = ConfirmationRecord.parse({
    step_id: step.id,
    // The binding (GHI #95): which workload, and a fingerprint of the step as
    // frozen. Derived from the plan the demo just read, which is the same source
    // B5 recomputes from — so a demo record stays valid exactly as long as the
    // step it confirms is unchanged, which is the behaviour being demonstrated.
    workload: input.slug,
    step_digest: stepDigest(step),
    authority,
    confirmer: {
      // Named as a stand-in when the demo has no real external authority to ask:
      // "@operator standing in for customer" is attributable and honest; a bare
      // placeholder is the unattributable record FR-024 refuses to accept.
      name: input.confirmer ?? `@${input.actor} (demo stand-in for the ${authority} authority)`,
      contact: input.contact ?? `https://github.com/${input.actor}`,
    },
    confirmed_at: input.at,
    scope: `Confirmed outcome for ${step.id} ("${step.title}"): ${step.acceptance}`,
  });

  // The real preflight, scoped to this step with the repeatable --step argument.
  const preflight = () => buildPreflight(gh, repo, { planRef: input.planRef, workload: input.slug, steps: [step.id] });
  const before = await preflight();
  if (before.gates.find((g) => g.id === 'B5')?.status === 'pass') {
    // A re-run: a valid record is already on the branch. Say so rather than
    // committing a second copy over what may be the operator's real confirmation.
    return { act: 'confirm', planRef: input.planRef, stepId: step.id, authority, branch, path, record, recorded: false, before, after: null, trackingIssue: step.tracking_issue ?? null };
  }

  const sha = await blobSha(gh, repo, path, branch);
  await gh.repos.createOrUpdateFileContents({
    ...repo,
    path,
    branch,
    message: `confirmation: ${step.id} confirmed by the ${authority} authority, committed by @${input.actor} at ${input.at} (FR-024)`,
    content: Buffer.from(`${JSON.stringify(record, null, 2)}\n`).toString('base64'),
    ...(sha !== undefined ? { sha } : {}),
  });
  const after = await preflight();

  // `confirmed:<authority>` is NOT applied here. It belongs to the confirm-record
  // workflow, which this commit to the default branch triggers — and that workflow
  // re-validates before labelling. A second writer with its own rule is how a board
  // signal comes to claim an authority answered a question it never saw.
  return { act: 'confirm', planRef: input.planRef, stepId: step.id, authority, branch, path, record, recorded: true, before, after, trackingIssue: step.tracking_issue ?? null };
}

export async function demoHighStakes(gh: Octokit, repo: RepoRef, opts: HighStakesOptions = {}): Promise<HighStakesResult> {
  const slug = opts.slug ?? 'demo';
  const stepId = opts.stepId ?? 'step-hello';
  const actor = await resolveActor(gh);
  const at = opts.at ?? new Date().toISOString();

  // Highest version the slug ever used — branches counted, so an abandoned
  // proposal is never re-flagged as if it were new (FR-058). Nothing at all means
  // a fresh slug, and the demo seeds its own proposal to have something to flag.
  let version = await maxPlanVersion(gh, repo, slug);
  const proposed = version === 0;
  if (proposed) {
    await proposeDemoPlan(gh, repo, { slug, actor, at });
    version = 1;
  }
  const planRef = planBranch(slug, version);

  // The tag is the fork in the road: an unfrozen ref is still in review (flag it),
  // a frozen one is an official version (confirm against it).
  return (await tagExists(gh, repo, planRef))
    ? confirmStep(gh, repo, {
        slug,
        planRef,
        stepId,
        actor,
        at,
        ...(opts.authority !== undefined ? { authority: opts.authority } : {}),
        ...(opts.confirmer !== undefined ? { confirmer: opts.confirmer } : {}),
        ...(opts.contact !== undefined ? { contact: opts.contact } : {}),
      })
    : flagStep(gh, repo, { planRef, stepId, authority: opts.authority ?? 'customer', actor, at, proposed });
}

/** `--name value` and `--name=value` both, '' for a value-less spelling: every
 *  argument here is optional with a default, so an unrecognized form would
 *  otherwise fall through SILENTLY and demo the wrong step (propose-plan's --slug
 *  lesson). '' fails the validators below, which is the point. */
function arg(argv: string[], name: string): string | undefined {
  const eq = `--${name}=`;
  const i = argv.findIndex((a) => a === `--${name}` || a.startsWith(eq));
  if (i < 0) return undefined;
  if (argv[i]!.startsWith(eq)) return argv[i]!.slice(eq.length);
  const next = argv[i + 1];
  return next === undefined || next.startsWith('--') ? '' : next;
}

const isMain = process.argv[1]?.endsWith('flag-high-stakes.ts');
if (isMain) {
  const argv = process.argv.slice(2);
  const slug = arg(argv, 'slug');
  const stepId = arg(argv, 'step');
  const authority = arg(argv, 'authority');
  const confirmer = arg(argv, 'confirmer');
  const contact = arg(argv, 'contact');
  const invalid =
    (slug !== undefined && !/^[a-z0-9][a-z0-9-]*$/.test(slug)) ||
    (stepId !== undefined && !/^step-[a-z0-9-]+$/.test(stepId)) ||
    (authority !== undefined && !(AUTHORITIES as readonly string[]).includes(authority)) ||
    (confirmer !== undefined && confirmer.trim().length === 0) ||
    (contact !== undefined && contact.trim().length === 0);
  if (invalid) {
    console.error(
      'usage: flag-high-stakes [--slug <kebab-case-slug>] [--step <step-id>] [--authority customer|clinical|legal]\n' +
        '                        [--confirmer "<name, role, org>"] [--contact <email-or-url>]\n' +
        '  defaults: --slug demo --step step-hello --authority customer',
    );
    process.exit(2);
  }
  const gh = createClient();
  const repo = repoFromEnv();
  demoHighStakes(gh, repo, {
    ...(slug !== undefined ? { slug } : {}),
    ...(stepId !== undefined ? { stepId } : {}),
    ...(authority !== undefined ? { authority: authority as Authority } : {}),
    ...(confirmer !== undefined ? { confirmer } : {}),
    ...(contact !== undefined ? { contact } : {}),
  })
    .then((r) => {
      if (r.act === 'flag') {
        if (r.proposed) console.log(`proposed     ${r.planRef} (demo seed — this slug had no plan yet)`);
        console.log(`plan branch  ${r.planRef} — live, so the flag lands before approval`);
        console.log(`flagged      ${r.stepId} high-stakes, routed to the ${r.authority} authority`);
        console.log(
          `labeled      high-stakes:${r.authority} on #${r.trackingIssue}` +
            (r.chunkCreated ? ' (chunk created and bound — the step had no tracking issue)' : ''),
        );
        console.log('');
        console.log('plan-gate G6 on the flagged plan:');
        printReport({ plan: r.planRef, result: reportResult([r.g6]), gates: [r.g6] }, false);
        console.log('');
        console.log('plan-gate G6 on the same plan with the authority removed — what FR-023 refuses:');
        printReport({ plan: r.planRef, result: reportResult([r.g6Unrouted]), gates: [r.g6Unrouted] }, false);
        console.log('');
        console.log(`next         approve and merge ${r.planRef} (quickstart §4.5), then re-run this command —`);
        console.log('             the freeze cuts the tag, and the build half of US6 runs against it');
        return;
      }
      console.log(`frozen plan  ${r.planRef}`);
      console.log(`step         ${r.stepId} — high-stakes, routed to the ${r.authority} authority`);
      console.log('');
      console.log(
        r.recorded
          ? 'build-preflight with no confirmation on record:'
          : 'build-preflight against the record already on the branch:',
      );
      printReport(r.before, false);
      console.log(
        `             same check by hand: npm run gate:preflight -- --plan-ref ${r.planRef} --repo ${repo.owner}/${repo.repo} --step ${r.stepId}`,
      );
      if (!r.recorded) {
        console.log('');
        console.log(`unchanged    ${r.path} already holds a valid record on ${r.branch} — B5 was green, so nothing was written`);
        process.exit(r.before.result === 'pass' ? 0 : 1);
      }
      console.log('');
      console.log(`recorded     ${r.path} on ${r.branch} — confirmed by ${r.record.confirmer.name}`);
      console.log('');
      console.log('build-preflight with the confirmation on record:');
      printReport(r.after!, false);
      console.log(
        r.trackingIssue === null
          ? '             confirmed:<authority> is unlabeled — the step carries no tracking issue to put it on'
          : `             confirm-record labels confirmed:${r.authority} on #${r.trackingIssue} when this commit lands on ${r.branch}`,
      );
      process.exit(r.after!.result === 'pass' ? 0 : 1);
    })
    .catch((error) => {
      console.error(errorMessage(error));
      process.exit(1);
    });
}
