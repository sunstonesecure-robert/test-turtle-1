import type { RepoRef } from './client';
import { AGENTIC_WORKFLOWS, DETERMINISTIC_WORKFLOWS } from '../../../scripts/gates/lib/readiness';

/**
 * github.com URLs the operator is sent TO — the human web UI, not the API the
 * rest of lib/github speaks. Separate module because they are the one place the
 * dashboard hands the operator off to somewhere it does not control, and every
 * such link has to land on the exact thing being talked about.
 *
 * ONE github.com URL in the dashboard is deliberately built elsewhere: the
 * confirmation-guide base in lib/server.ts. It addresses the FRAMEWORK's own
 * repository rather than the repository being governed, it has no `RepoRef` to
 * build from, and it is meant to be overridden by configuration — a helper here
 * could honour none of the three. That exemption is recorded at the literal
 * itself; every other github.com URL comes from this file.
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
 * The work items' Dispatch link used to point at `/actions`, the repo's whole
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

/**
 * The repository browsed at one ref — a whole tree, or one directory inside it.
 *
 * ONE helper serves a branch and a tag because GitHub gives them the same URL.
 * The two refs this product hands it are a deliverable branch
 * (`build/<slug>/v<N>/<step-id>`) and a plan tag (`plan/<slug>/v<N>`), and both
 * carry slashes: the ref is NOT encoded, for the same reason blobUrl records
 * above — GitHub's grammar expects those slashes raw. The optional path IS
 * encoded segment by segment, so a path is never mistaken for more ref.
 */
export function treeUrl(repo: RepoRef, ref: string, path?: string): string {
  const encoded = path ? `/${path.split('/').map(encodeURIComponent).join('/')}` : '';
  return `${repoUrl(repo)}/tree/${ref}${encoded}`;
}

/**
 * The diff between two refs. This is the question in front of an operator judging
 * a re-opened plan: a new version resets every judgment, and "what changed since
 * the version that is still official" is a page GitHub already serves for two
 * tags. Refs unencoded, same grammar and same reason as treeUrl.
 *
 * The caller must know both refs exist — a compare against a tag that was never
 * cut is a 404 and this helper cannot tell the difference.
 */
export function compareUrl(repo: RepoRef, base: string, head: string): string {
  return `${repoUrl(repo)}/compare/${base}...${head}`;
}

/**
 * The repository's whole Actions run history.
 *
 * Deliberately the LAST resort, and it exists for exactly one situation: a run
 * the product can name but not address. A monitor row goes `lost` when the run
 * list no longer holds anything for a plan version, and an unpublished break's
 * header may carry no run id at all — in both cases there is no run page to
 * build, and the copy had been telling the operator to go look in Actions while
 * handing them nothing to click. Everywhere a run id IS in hand, `runUrl` is the
 * right destination and this one is the wrong one: it is a list the operator then
 * has to search, which is the defect this whole module exists to end.
 */
export function actionsUrl(repo: RepoRef): string {
  return `${repoUrl(repo)}/actions`;
}

/**
 * One workflow run, on the web — where the operator watches a build the dashboard
 * dispatched (GHI #196). The dispatcher returns the run id once GitHub shows the
 * run; when it has not appeared yet the caller links the Runs page instead, so
 * this is only ever built from an id that was read back, never guessed.
 *
 * The id is taken as a number OR a string because its readers hold it in both
 * shapes — the runs API returns a number, an unpublished break's header carries
 * it as text — and a `Number()` at the call site would be pure ceremony: the id
 * is interpolated into a path either way.
 */
export function runUrl(repo: RepoRef, runId: number | string): string {
  return `${repoUrl(repo)}/actions/runs/${runId}`;
}

/**
 * One job inside a run — the page that holds that job's log and its steps.
 *
 * The run page is the wrong altitude for the question "what is it doing right
 * now": a run that has stalled has stalled inside a particular job, and the job
 * is where the steps and the output are. GitHub nests the job under its run, so
 * both ids are needed and neither can be derived from the other.
 */
export function jobUrl(repo: RepoRef, runId: number | string, jobId: number): string {
  return `${repoUrl(repo)}/actions/runs/${runId}/job/${jobId}`;
}

/**
 * One check run — where a verification target's result says what it actually
 * reported.
 *
 * The path is `/runs/<id>` and NOT `/actions/runs/<id>`: those are two different
 * objects that both call themselves a run, and the second one is a workflow run.
 * Where the API's own `html_url` for the check is already in hand, callers prefer
 * that — it is what GitHub said, and re-deriving it here could only ever agree or
 * be wrong.
 */
export function checkRunUrl(repo: RepoRef, checkRunId: number): string {
  return `${repoUrl(repo)}/runs/${checkRunId}`;
}

/**
 * One issue.
 *
 * The product's central object is an issue — a workload, a plan review, a work
 * item, a correction and an evidence batch are all issues — and the absence of
 * this helper is why call sites had grown their own `/issues/${n}` concatenation
 * and why everywhere else left the number as inert text.
 */
export function issueUrl(repo: RepoRef, issueNumber: number): string {
  return `${repoUrl(repo)}/issues/${issueNumber}`;
}

/**
 * One pull request, for the callers holding only its number.
 *
 * Note `/pull/` singular — GitHub's web path for one pull request, not the
 * `/pulls` list. Where the API's `html_url` is already in hand (a deliverable
 * pull request view, the approval pull request) callers keep using that for the
 * same reason checkRunUrl gives: GitHub already answered.
 */
export function pullUrl(repo: RepoRef, prNumber: number): string {
  return `${repoUrl(repo)}/pull/${prNumber}`;
}

/**
 * The repository's Actions variables page.
 *
 * This is the destination the product's copy already names in words when a merge
 * authority reads as unknown and the operator is told to check that the token can
 * read this repository's variables, and it is where the variables those readers
 * query are set. It takes only the RepoRef because it addresses the repository's
 * own settings rather than any object inside it.
 */
export function repoVariablesUrl(repo: RepoRef): string {
  return `${repoUrl(repo)}/settings/variables/actions`;
}

/**
 * GitHub's grammar for a user login: alphanumerics with interior single hyphens,
 * at most 39 characters. A login that matches contains nothing a URL path would
 * have to escape, which is why userUrl does no encoding.
 */
const PLAIN_LOGIN = /^[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}$/;

/**
 * A person's GitHub profile — for the two logins that carry accountability: who
 * approved a frozen plan version, and whose confirmation authorizes a build to
 * run unattended.
 *
 * The only helper here that takes no RepoRef, because a login is not a thing
 * inside the governed repository. It belongs in this module anyway: it is still a
 * github.com URL the operator is handed, and the alternative is the same string
 * inlined at every accountability site.
 *
 * RETURNS NULL FOR A LOGIN THAT IS NOT A PLAIN PROFILE PATH rather than encoding
 * it. A recorded actor can be an App — `github-actions[bot]` — whose page is
 * `/apps/<name>`, not `/<login>`; percent-encoding the brackets yields a URL that
 * is well-formed and 404s, which is worse than no link at all. Callers render the
 * login as text when this returns null.
 *
 * IT DOES NOT FILTER THIS PRODUCT'S PLACEHOLDER LOGINS, and that is a decision
 * rather than an oversight — recorded here so the next reader does not "fix" it in
 * this file. The dashboard writes `operator` when OPERATOR_LOGIN is unset and
 * `unknown` when GitHub reports no merger for an approval. Both are plain logins,
 * both match the pattern above, and both resolve to live github.com accounts
 * (`operator` is an Organization, `unknown` a personal User) — so the URL this
 * returns for either is correct as URL grammar and wrong as a record. What makes
 * them unrenderable is PROVENANCE, not shape: they came out of `operatorLogin()`
 * and out of `getApprovalRecord`'s fallback, which this helper cannot see, and
 * whose population — every login the product will ever hand it — is not the
 * population those two strings are safe to match against. The guard therefore
 * lives one layer up, in `ActorLogin` in app/flow.tsx, over
 * lib/actor-identity.ts.
 */
export function userUrl(login: string): string | null {
  return PLAIN_LOGIN.test(login) ? `https://github.com/${login}` : null;
}
