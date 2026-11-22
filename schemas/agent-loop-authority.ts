import { z } from 'zod';

const id = z.number().int().positive().safe(), digest = z.string().regex(/^[a-f0-9]{64}$/), sha = z.string().regex(/^[a-f0-9]{40}$/);
const text = z.string().min(1).max(256), instant = z.string().datetime();
export const SignInApp = z.object({ app_id: id, client_id: z.string().regex(/^[A-Za-z0-9_.-]+$/),
  slug: z.string().regex(/^[a-z0-9-]+$/) }).strict();
export const AuthorityRepository = z.object({ id, full_name: z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/) }).strict();
export const AllowedProducer = z.object({ repository_id: id, repository: AuthorityRepository.shape.full_name,
  source_sha: sha, workflow_path: z.string().regex(/^\.github\/workflows\/[A-Za-z0-9_.-]+\.ya?ml$/) }).strict();
/** Whether this trial needs a second person. Absent reads as `required`.
 * `deferred` is the operator's recorded single-operator policy: the consenting
 * human may also be the proposal's author. It is part of the consented bytes and
 * of every authority record. It never stands for a second person's review. */
export const SecondHumanReview = z.enum(['required', 'deferred']);
export type SecondHumanReview = z.infer<typeof SecondHumanReview>;
export const TrialAuthorization = z.object({ schema_version: z.literal(1), purpose: z.literal('trial'), trial_id: text,
  sandbox: z.literal(true), governed_repository: AuthorityRepository, state_repository: AuthorityRepository,
  audit_repository: AuthorityRepository, control_repository: AuthorityRepository,
  workload: z.string().regex(/^[a-z0-9][a-z0-9-]*$/), work_item: id, plan_ref: z.string().regex(/^refs\/tags\/plan\/[a-z0-9-]+\/v[1-9]\d*$/), plan_sha: sha,
  engine: z.enum(['copilot', 'claude', 'codex']), writer: z.object({ principal_id: id, source_sha: sha }).strict(),
  components: z.object({ generator: z.number().int().positive().safe(), detector: z.number().int().positive().safe(),
    critic: z.number().int().nonnegative().safe().optional(), probe: z.number().int().nonnegative().safe().optional() }).strict(),
  total_cap_aic: id, maximum_generations: id,
  operations: z.array(z.enum(['reserve', 'consume', 'record', 'stop', 'receipt'])).min(1).max(5),
  subjects: z.array(digest).min(1).max(100), producers: z.array(AllowedProducer).min(1).max(10),
  capabilities: z.object({ primitive_sha256: digest, sandbox_sha256: digest, detector_sha256: digest }).strict(),
  unproven_seam: z.literal('w0_closure'), expires_at: instant, second_human_review: SecondHumanReview.optional(),
}).strict().superRefine((value, context) => {
  const repositories = [value.governed_repository, value.state_repository, value.audit_repository, value.control_repository];
  if (new Set(repositories.map(r => r.id)).size !== 4 || new Set(repositories.map(r => r.full_name.toLowerCase())).size !== 4 ||
      Object.values(value.components).reduce((sum, n) => sum + n, 0) * value.maximum_generations !== value.total_cap_aic ||
      !Number.isSafeInteger(value.total_cap_aic) || new Set(value.operations).size !== value.operations.length ||
      new Set(value.subjects).size !== value.subjects.length || value.producers.some(p => p.repository_id !== value.governed_repository.id || p.repository !== value.governed_repository.full_name)) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'Exact isolated repositories, producers and complete bounded trial envelope required.' });
  }
});
export type TrialAuthorization = z.infer<typeof TrialAuthorization>;
export const ProposalBinding = z.object({ repository: AuthorityRepository, pull_number: id,
  path: z.string().min(1).max(256).regex(/^[A-Za-z0-9_-]+\/[A-Za-z0-9_./-]+\.json$/).refine(p => !p.split('/').some(s => s === '..' || s === '.')),
  head_sha: sha, base_sha: sha }).strict();
export const TrialConsent = z.object({ schema_version: z.literal(1), purpose: z.literal('trial_consent'),
  proposal_sha256: digest, head_sha: sha, base_sha: sha, source_sha: sha, expires_at: instant, review_id: id }).strict();
export const AuthorityRecord = z.object({ schema_version: z.literal(1), purpose: z.literal('trial'),
  proposal_sha256: digest, proposal: TrialAuthorization, source_sha: sha, binding: ProposalBinding,
  human: z.object({ id, login: z.string().regex(/^[A-Za-z0-9-]+$/), permission: z.enum(['admin', 'maintain', 'write']) }).strict(),
  /** The proposal's own policy. `deferred` is not a pass of any second-human check. */
  second_human_review: SecondHumanReview,
  native: z.object({ review_id: id, comment_id: id, consent_url: z.string().url(), sign_in_app_id: id,
    review_at: instant, consent_at: instant, consent: TrialConsent,
    /** What GitHub recorded. An author cannot approve their own pull request, so a
     * self-authored proposal carries the author's exact-head comment review. */
    review_state: z.enum(['APPROVED', 'COMMENTED']),
    proposal_author: z.object({ id, login: z.string().min(1).max(100), type: z.enum(['User', 'Bot']) }).strict() }).strict(),
  expires_at: instant, enrollment: z.literal('off'),
}).strict();
export type AuthorityRecord = z.infer<typeof AuthorityRecord>;
