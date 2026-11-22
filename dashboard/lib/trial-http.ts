import { createHash } from 'node:crypto';
import type { Octokit } from '@octokit/rest';
import { z } from 'zod';
import { AuthorityRepository, ProposalBinding, TrialAuthorization } from '../../schemas/agent-loop-authority';
import { brokerDigest } from '../../scripts/control-plane/broker';
import { submitTrialConsent } from '../../scripts/agent-loop/authority';
import { StateRefusal } from '../../scripts/agent-loop/ledger';
import { cookieValue, SESSION_COOKIE, requireSameOrigin, authResponse } from './auth-http';
import { DeviceSignIn, SignInFailure } from './github/auth';

export const TrialReviewConfig = z.object({ control: AuthorityRepository, state: AuthorityRepository, audit: AuthorityRepository,
  governed: AuthorityRepository, proposal_path: ProposalBinding.shape.path }).strict();
const Input = z.object({ pull_number: z.number().int().positive().safe(), head_sha: z.string().regex(/^[a-f0-9]{40}$/),
  base_sha: z.string().regex(/^[a-f0-9]{40}$/), proposal_sha256: z.string().regex(/^[a-f0-9]{64}$/) }).strict();
const fact: (value: unknown, code: string) => asserts value = (value, code) => { if (!value) throw new StateRefusal(code); };
/** Display and action use the same fixed repository/path and native loader.
 * Browser supplies only displayed digests and PR number, never a target URL. */
export async function readTrialReview(gh: Octokit, rawConfig: unknown, pullNumber: number) {
  const config = TrialReviewConfig.parse(rawConfig), [owner, repo] = config.governed.full_name.split('/') as [string, string];
  const headers = { 'cache-control': 'no-cache' };
  const pull = z.object({ number: z.literal(pullNumber), state: z.literal('open'), draft: z.literal(false), merged: z.literal(false),
    user: z.object({ id: z.number().int().positive().safe(), login: z.string().min(1).max(100) }),
    head: z.object({ sha: Input.shape.head_sha, repo: z.object({ id: z.literal(config.governed.id), full_name: z.literal(config.governed.full_name) }) }),
    base: z.object({ sha: Input.shape.base_sha, ref: z.literal('main'), repo: z.object({ id: z.literal(config.governed.id), full_name: z.literal(config.governed.full_name) }) }) })
    .parse((await gh.request('GET /repos/{owner}/{repo}/pulls/{pull_number}', { owner, repo, pull_number: pullNumber, headers })).data);
  const file = z.object({ type: z.literal('file'), path: z.literal(config.proposal_path), encoding: z.literal('base64'),
    sha: z.string().regex(/^[a-f0-9]{40}$/), size: z.number().int().positive().max(65536), content: z.string().max(100000) })
    .parse((await gh.request('GET /repos/{owner}/{repo}/contents/{path}', { owner, repo, path: config.proposal_path, ref: pull.head.sha, headers })).data);
  const encoded = file.content.replace(/\s/g, ''), bytes = Buffer.from(encoded, 'base64');
  fact(bytes.length === file.size && bytes.toString('base64') === encoded && createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex') === file.sha, 'approval_proposal_bytes_invalid');
  const proposal = TrialAuthorization.parse(JSON.parse(bytes.toString('utf8')));
  for (const [key, actual] of [['control', proposal.control_repository], ['state', proposal.state_repository],
    ['audit', proposal.audit_repository], ['governed', proposal.governed_repository]] as const) fact(brokerDigest(config[key]) === brokerDigest(actual), 'authority_repository_mismatch');
  const binding = ProposalBinding.parse({ repository: config.governed, pull_number: pullNumber, path: config.proposal_path, head_sha: pull.head.sha, base_sha: pull.base.sha });
  // The author is shown because GitHub refuses an author's approval of their own
  // pull request: who opened it decides which native receipt can be recorded.
  return { binding, proposal, proposal_sha256: brokerDigest(proposal), author: { id: pull.user.id, login: pull.user.login },
    second_human_review: proposal.second_human_review ?? 'required' as const };
}
export function trialHandlers(auth: DeviceSignIn, config: unknown, now: () => string = () => new Date().toISOString()) {
  return { async POST(request: Request) {
    try {
      requireSameOrigin(request);
      const input = Input.parse(await request.json());
      const receipt = await auth.asOperator(cookieValue(request, SESSION_COOKIE), async (gh, identity) => {
        const current = await readTrialReview(gh, config, input.pull_number);
        fact(current.binding.head_sha === input.head_sha && current.binding.base_sha === input.base_sha &&
          current.proposal_sha256 === input.proposal_sha256, 'approval_changed_reload');
        fact(Date.parse(current.proposal.expires_at) > Date.parse(z.string().datetime().parse(now())), 'trial_expired');
        return submitTrialConsent(gh, current.binding, current.proposal, identity.id);
      });
      return authResponse(receipt);
    } catch (error) {
      const code = error instanceof StateRefusal || error instanceof SignInFailure ? error.code : 'trial_decision_unavailable';
      return authResponse({ code }, code === 'request_origin_refused' ? 403 : 400);
    }
  } };
}
