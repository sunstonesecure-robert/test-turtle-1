'use server';

import { revalidatePath } from 'next/cache';
import { github, operatorLogin } from '../lib/server';
import { introduceWorkload } from '../lib/github/workloads';
import { openAndon, judgeItem } from '../lib/github/andon';
import { openApprovalPr } from '../lib/github/approval';
import { checkReadiness, unmetItems } from '../../scripts/gates/lib/readiness';
import { lifecycleGate } from '../../scripts/gates/lifecycle-gate';
import { applyLifecycleTransition } from '../lib/github/workloads';

/** Intake — refused with the unmet readiness list until init --verify passes (FR-029). */
export async function introduceAction(formData: FormData): Promise<void> {
  const { gh, repo } = github();
  const readiness = await checkReadiness(gh, repo);
  const unmet = unmetItems(readiness);
  if (unmet.length > 0) throw new Error(`intake refused — system not ready: ${unmet.join(' · ')}`);
  const slug = String(formData.get('slug') ?? '').trim();
  const title = String(formData.get('title') ?? '').trim() || slug;
  await introduceWorkload(gh, repo, { slug, title, actor: operatorLogin(), at: new Date().toISOString() });
  revalidatePath('/workloads');
}

/**
 * Activate — in production this fires the workload-lifecycle repository
 * dispatch; the single-writer semantics are identical. The gate runs first
 * either way and a refusal performs nothing.
 */
export async function activateAction(formData: FormData): Promise<void> {
  const { gh, repo } = github();
  const slug = String(formData.get('slug') ?? '');
  const gate = await lifecycleGate(gh, repo, { slug, action: 'activate' });
  if (gate.result !== 'pass') {
    throw new Error(gate.gates.filter((g) => g.status === 'fail').map((g) => `${g.id}: ${g.detail}`).join(' · '));
  }
  await applyLifecycleTransition(gh, repo, { slug, action: 'activated', actor: operatorLogin(), at: new Date().toISOString() });
  revalidatePath('/workloads');
}

/** Open an Andon break: andon:open → andon:under-review (FR-003). */
export async function openAndonAction(formData: FormData): Promise<void> {
  const { gh, repo } = github();
  const issue = Number(formData.get('issue'));
  await openAndon(gh, repo, issue);
  revalidatePath(`/andon/${issue}`);
  revalidatePath('/');
}

/** Judge one item ✓ (FR-002). The ✗/correction path lands with the first expansion. */
export async function judgeAction(formData: FormData): Promise<void> {
  const { gh, repo } = github();
  const issue = Number(formData.get('issue'));
  await judgeItem(gh, repo, issue, String(formData.get('item')));
  revalidatePath(`/andon/${issue}`);
}

/** Commit for approval: open the PR; merging it (as yourself) is the go-ahead (FR-005/FR-006). */
export async function approveAction(formData: FormData): Promise<void> {
  const { gh, repo } = github();
  const slug = String(formData.get('slug'));
  const version = Number(formData.get('version'));
  await openApprovalPr(gh, repo, { slug, version });
  revalidatePath(`/andon/${formData.get('issue')}`);
}
