import type { Octokit } from '@octokit/rest';
import { z } from 'zod';
import type { RepoRef } from './github/client';
import { ApprovalRefusal, submitPlanApprovalConsent } from './github/approval-authority';
import { cookieValue, SESSION_COOKIE, requireSameOrigin, authResponse } from './auth-http';
import { SignInFailure } from './github/auth';

/**
 * The plan approval decision, recorded AS THE SIGNED-IN PERSON (GHI #319).
 *
 * The browser sends only what it was shown — the pull request number, the commit and
 * the plan digest — and the action re-reads all three with that person's own client
 * before it writes. No repository, path, name or actor comes from the request body.
 * The dashboard's shared token is never used here: a decision written with it would
 * be indistinguishable from one the operator never made, which is the defect.
 */
const Input = z
  .object({
    pull_number: z.number().int().positive().safe(),
    head_sha: z.string().min(7).max(64),
    plan_sha256: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();

interface OperatorSession {
  asOperator<T>(session: string, action: (gh: Octokit, identity: { id: number }) => Promise<T>): Promise<T>;
}

export function planApprovalHandlers(auth: OperatorSession, repo: () => RepoRef) {
  return {
    async POST(request: Request): Promise<Response> {
      try {
        requireSameOrigin(request);
        const input = Input.parse(await request.json());
        const receipt = await auth.asOperator(cookieValue(request, SESSION_COOKIE), (gh, identity) =>
          submitPlanApprovalConsent(gh, repo(), input, identity.id),
        );
        return authResponse(receipt);
      } catch (error) {
        const code = error instanceof ApprovalRefusal || error instanceof SignInFailure ? error.code : 'plan_decision_unavailable';
        return authResponse({ code }, code === 'request_origin_refused' ? 403 : 400);
      }
    },
  };
}
