import type { RepoRef } from './client';
import { AGENTIC_WORKFLOWS, DETERMINISTIC_WORKFLOWS } from '../../../scripts/gates/lib/readiness';

/**
 * github.com URLs the operator is sent TO — the human web UI, not the API the
 * rest of lib/github speaks. Separate module because they are the one place the
 * dashboard hands the operator off to somewhere it does not control, and every
 * such link has to land on the exact thing being talked about.
 */

export function repoUrl(repo: RepoRef): string {
  return `https://github.com/${repo.owner}/${repo.repo}`;
}

/** Every workflow the oversight framework installs, by its canonical name. */
export type OversightWorkflow =
  | (typeof AGENTIC_WORKFLOWS)[number]
  | (typeof DETERMINISTIC_WORKFLOWS)[number];

/**
 * The Run-workflow page for ONE workflow — where its `workflow_dispatch` form
 * lives.
 *
 * The backlog's Dispatch action used to point at `/actions`, the repo's whole
 * run history (live finding, 2026-08-17: "links to github but not a specific
 * action"). That is the wrong page in the most literal sense: the operator was
 * told to dispatch a build and handed a list of everything that ever ran, then
 * had to know which of seventeen workflows was meant and find it in the
 * sidebar. A dispatch link that does not name its workflow is barely a link.
 *
 * The `.lock.yml` / `.yml` split is not cosmetic — it is which engine compiles
 * the workflow (gh-aw-compiled agentic vs plain Actions YAML), and it is
 * already decided once in readiness.ts, whose OVERSIGHT_WORKFLOW_FILES the
 * `init --verify` check reads to assert these exact filenames exist in the
 * target repo. Deriving the URL from the same constants is what makes a link
 * here and a readiness check there incapable of disagreeing about a filename.
 *
* As far as the URL goes this is the end of the road, and BOTH halves of that were
 * tested rather than assumed. GitHub has no supported way to prefill
 * `workflow_dispatch` inputs from a query string, so the operator types the values
 * and callers must print them (`DispatchValues`).
 *
 * `?ref=` does not help either, and this is a recorded NEGATIVE result (tried and
 * reverted, 2026-08-23) so nobody spends the idea twice: the link lands on the
 * workflow's summary page, and the Run-workflow panel is opened by a button click
 * AFTER that — the panel builds its ref picker fresh, so a ref in the URL never
 * reaches it. Preselecting the dangerous field is not available from a link. What
 * covers it instead is the workflow's own first step, which refuses a non-tag
 * dispatch in two seconds, and preflight B8, which is the authority.
 */
export function workflowDispatchUrl(repo: RepoRef, workflow: OversightWorkflow): string {
  const agentic = (AGENTIC_WORKFLOWS as readonly string[]).includes(workflow);
  return `${repoUrl(repo)}/actions/workflows/${workflow}${agentic ? '.lock' : ''}.yml`;
}

/** One commit, on the web. */
export function commitUrl(repo: RepoRef, sha: string): string {
  return `${repoUrl(repo)}/commit/${sha}`;
}

/**
 * One file as it stands at one ref. The ref is a plan tag like
 * `plan/demo5/v1` — slashes and all — which is exactly what GitHub's blob URL
 * grammar expects, so it is NOT encoded; the path is, segment by segment, so a
 * path is never mistaken for more ref.
 */
export function blobUrl(repo: RepoRef, ref: string, path: string): string {
  const encoded = path.split('/').map(encodeURIComponent).join('/');
  return `${repoUrl(repo)}/blob/${ref}/${encoded}`;
}
