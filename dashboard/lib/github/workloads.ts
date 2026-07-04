import type { Octokit } from '@octokit/rest';
import type { RepoRef } from './client';
import { errorStatus } from './errors';
import {
  parseWorkloadHeader,
  serializeWorkloadHeader,
  serializeWorkloadEvent,
  type WorkloadAction,
} from './markers';
import { WORKLOAD_TRANSITIONS, workloadState, type WorkloadState } from './labels';

/**
 * Workload module (T136 tracer surface): intake, listing, state derivation,
 * and the single-writer lifecycle transition the workload-lifecycle workflow performs.
 */

export interface Workload {
  issueNumber: number;
  slug: string;
  title: string;
  state: WorkloadState | null; // null = contract violation (not exactly one workload:* label)
}

export const SLUG_RE = /^[a-z0-9][a-z0-9-]*$/;

export async function listWorkloads(gh: Octokit, repo: RepoRef): Promise<Workload[]> {
  // Paginated: workload issues are never deleted (FR-042), so this list only
  // grows — a single page would silently drop older workloads (slug uniqueness,
  // lifecycle gate L0, portfolio) once the repo passes 100 issues+PRs.
  const data = await gh.paginate(gh.issues.listForRepo, { ...repo, state: 'all', per_page: 100 });
  return data
    .filter((issue) => !issue.pull_request) // the issues API returns PRs too — never workloads
    .map((issue) => {
      const header = parseWorkloadHeader(issue.body ?? '');
      if (!header) return null;
      const labels = (issue.labels ?? []).map((l) => (typeof l === 'string' ? l : (l.name ?? '')));
      return {
        issueNumber: issue.number,
        slug: header.id,
        title: issue.title,
        state: workloadState(labels),
      };
    })
    .filter((w): w is Workload => w !== null);
}

export async function getWorkload(gh: Octokit, repo: RepoRef, slug: string): Promise<Workload | null> {
  const all = await listWorkloads(gh, repo);
  return all.find((w) => w.slug === slug) ?? null;
}

/**
 * Read one workload by its issue number. The single-issue GET is read-after-write
 * consistent, while the LIST endpoint is not: a just-created issue can be missing
 * from `listForRepo` for a while (live-discovered in PB-003 — the seed introduced
 * a workload and the immediate activate couldn't find it). Callers that already
 * hold the issue number from a create MUST re-read through here, never via list.
 */
export async function getWorkloadByIssue(gh: Octokit, repo: RepoRef, issueNumber: number): Promise<Workload | null> {
  let issue;
  try {
    ({ data: issue } = await gh.issues.get({ ...repo, issue_number: issueNumber }));
  } catch (error: unknown) {
    // Same contract as getWorkload: absence is null, not a raw HTTP error.
    if (errorStatus(error) === 404) return null;
    throw error;
  }
  if (issue.pull_request) return null; // the issues API answers for PR numbers too — never workloads
  const header = parseWorkloadHeader(issue.body ?? '');
  if (!header) return null;
  const labels = (issue.labels ?? []).map((l) => (typeof l === 'string' ? l : (l.name ?? '')));
  return { issueNumber, slug: header.id, title: issue.title, state: workloadState(labels) };
}

/**
 * Operator intake (dashboard only, after readiness passes — FR-029/FR-031).
 * Title-only is valid; the slug is the identity everything else keys on.
 */
export async function introduceWorkload(
  gh: Octokit,
  repo: RepoRef,
  input: { slug: string; title: string; actor: string; at: string },
): Promise<Workload> {
  if (!SLUG_RE.test(input.slug)) throw new Error(`invalid workload slug: ${input.slug}`);
  const existing = await getWorkload(gh, repo, input.slug);
  if (existing) throw new Error(`workload slug already exists: ${input.slug} (issue #${existing.issueNumber})`);

  const { data: issue } = await gh.issues.create({
    ...repo,
    title: input.title,
    body: serializeWorkloadHeader({ id: input.slug }),
    labels: ['workload:proposed'],
  });
  await gh.issues.createComment({
    ...repo,
    issue_number: issue.number,
    body: serializeWorkloadEvent({ action: 'introduced', by: input.actor, at: input.at }),
  });
  return { issueNumber: issue.number, slug: input.slug, title: input.title, state: 'proposed' };
}

/**
 * Post-gate lifecycle transition — performed ONLY by the workload-lifecycle
 * workflow after lifecycle-gate passes (transition authority matrix).
 * Flips the workload:* label atomically and appends the event comment.
 */
export async function applyLifecycleTransition(
  gh: Octokit,
  repo: RepoRef,
  input: {
    slug: string;
    action: Exclude<WorkloadAction, 'introduced' | 'edited'>;
    actor: string;
    at: string;
    reason?: string;
    revisit?: string;
    /** Pass when the caller just created the workload: the list endpoint is not
     *  read-after-write consistent, so a fresh issue must be re-read by number. */
    issueNumber?: number;
  },
): Promise<Workload> {
  const workload =
    input.issueNumber !== undefined
      ? await getWorkloadByIssue(gh, repo, input.issueNumber)
      : await getWorkload(gh, repo, input.slug);
  if (!workload || workload.slug !== input.slug) throw new Error(`workload not found: ${input.slug}`);
  const transition = WORKLOAD_TRANSITIONS[normalizeAction(input.action)];
  if (!transition) throw new Error(`unknown lifecycle action: ${input.action}`);

  if (!workload.state || !transition.from.includes(workload.state)) {
    throw new Error(`illegal transition ${workload.state} → ${transition.to} for ${input.slug}`);
  }

  await gh.issues.removeLabel({ ...repo, issue_number: workload.issueNumber, name: `workload:${workload.state}` });
  await gh.issues.addLabels({ ...repo, issue_number: workload.issueNumber, labels: [`workload:${transition.to}`] });
  await gh.issues.createComment({
    ...repo,
    issue_number: workload.issueNumber,
    body: serializeWorkloadEvent({
      action: input.action,
      by: input.actor,
      at: input.at,
      ...(input.reason !== undefined ? { reason: input.reason } : {}),
      ...(input.revisit !== undefined ? { revisit: input.revisit } : {}),
    }),
  });
  if (transition.to === 'archived') {
    await gh.issues.update({ ...repo, issue_number: workload.issueNumber, state: 'closed' });
    await gh.issues.lock({ ...repo, issue_number: workload.issueNumber });
  }
  return { ...workload, state: transition.to };
}

/** Map past-tense event actions to the transition table's imperative keys. */
function normalizeAction(action: string): string {
  const map: Record<string, string> = {
    activated: 'activate',
    completed: 'complete',
    canceled: 'cancel',
    deferred: 'defer',
    reactivated: 'reactivate',
    archived: 'archive',
  };
  return map[action] ?? action;
}
