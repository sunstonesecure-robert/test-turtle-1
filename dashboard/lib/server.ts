import { createClient, type RepoRef } from './github/client';
import type { Octokit } from '@octokit/rest';

/**
 * Server-side GitHub access for pages and server actions. Tokens never reach
 * the browser: pages are server components and writes go through server
 * actions, both running with this module's client (GitOps-Native, SC-003 —
 * the approval merge itself is a deep-link the operator performs as themselves).
 */
export function github(): { gh: Octokit; repo: RepoRef } {
  const owner = process.env.OWNER ?? '';
  const repo = process.env.REPO ?? '';
  if (!owner || !repo) throw new Error('Set OWNER and REPO in dashboard/.env.local');
  return { gh: createClient(), repo: { owner, repo } };
}

export function operatorLogin(): string {
  return process.env.OPERATOR_LOGIN ?? 'operator';
}
