/**
 * The GitHub Environments `init` provisions and readiness asserts (I4, I9).
 *
 * A module of its own — rather than a pair of constants inside `readiness.ts` — because
 * the D6 content guards need `SUBJECT_DEPLOY_ENVIRONMENT` too (D6.6 requires a subject
 * workflow's OIDC job to name EXACTLY this environment, security review 2026-08-29), and
 * `checks-subject-workflow.ts` is a pure module: no Octokit, no network. Importing the
 * readiness module for one string would have dragged both in. `readiness.ts` re-exports
 * these so its existing importers are unchanged.
 *
 *   agent-build     the build executor's environment (readiness I4)
 *   subject-deploy  the operator's DEPLOY environment (readiness I9; T273, GHI #174).
 *                   `init` creates it with a deployment-branch policy pinned to the
 *                   default branch and, when it has none, adds the person running init as
 *                   its first REQUIRED REVIEWER (an App token cannot be one — then the UI
 *                   is the route, CONFIGURATION_GUIDE.md §7); readiness I9 reports unmet
 *                   until a reviewer exists — an environment with none approves nothing.
 */
export const AGENT_BUILD_ENVIRONMENT = 'agent-build';
export const SUBJECT_DEPLOY_ENVIRONMENT = 'subject-deploy';
export const PRODUCT_ENVIRONMENTS = [AGENT_BUILD_ENVIRONMENT, SUBJECT_DEPLOY_ENVIRONMENT] as const;
