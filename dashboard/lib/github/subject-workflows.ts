import type { Octokit } from '@octokit/rest';
import { parse } from 'yaml';
import type { RepoRef } from './client';
import { errorMessage, errorStatus } from './errors';
import { isSubjectWorkflowPath } from '../../../scripts/install-manifest';

/**
 * THE COMPLETION → DISPATCH HOOK (T273, FR-070, GHI #174 §3).
 *
 * A subject workflow — the operator's own deploy, delivered by an agent into
 * `.github/workflows/subject_<name>.yml` and merged by the operator — never fires on
 * the automated path by itself. `build-merge` merges with `GITHUB_TOKEN`, and GitHub
 * emits no `push` event for a `GITHUB_TOKEN` write (the anti-recursion rule GHI #160
 * ran into). So the product owns one small piece regardless of who authored the
 * workflow: on a workload's `complete` transition, `workflow_dispatch` every subject
 * workflow that declares the two inputs the hook passes, with the official plan ref
 * and the verified merged commit.
 *
 * WHY `workflow_dispatch` AND NOT `push`. GitHub's anti-recursion rule explicitly
 * exempts `workflow_dispatch` (and `repository_dispatch`): a `GITHUB_TOKEN` with
 * `actions: write` may start a run that way even though it may not cause one through
 * `push`. Documented by GitHub; PB-017 verifies it live before anything relies on it,
 * because PB-002 showed `workflow_run` behaving differently from its documentation.
 *
 * WHY THE INPUTS ARE A CONTRACT. GitHub answers 422 for an input the workflow does
 * not declare, so the hook sends EXACTLY `plan_ref` and `commit` and dispatches only
 * a workflow that declares both (D6.2 requires a subject workflow with a
 * `workflow_dispatch` trigger to declare them). A workflow without them is SKIPPED
 * with the reason, never guessed at — and "nothing to dispatch" is reported as such
 * rather than as silence (GHI #108: absent ≠ success).
 *
 * This module is the READER + DISPATCHER only. It never writes to the workload issue
 * — the caller (`scripts/lifecycle-apply.ts`) records what happened, because the
 * record belongs next to the transition that caused it.
 */

/** The inputs the hook passes. A subject workflow declares these to be dispatched. */
export const SUBJECT_DISPATCH_INPUTS = ['plan_ref', 'commit'] as const;

export interface SubjectWorkflow {
  /** GitHub's workflow id — what `createWorkflowDispatch` keys on */
  id: number;
  /** `.github/workflows/subject_<name>.yml` */
  path: string;
  /** the workflow's `name:` (or its path when it has none), for the operator's record */
  name: string;
  /** GitHub's state: `active`, or one of the disabled states — a disabled workflow is
   *  listed and reported as SKIPPED, never silently dropped */
  state: string;
}

/**
 * Every workflow whose path is in the subject namespace — active or not.
 *
 * NOT filtered to `active` (correctness review 2026-08-29). The first version dropped
 * disabled workflows here, and the completion record then said "no subject workflows
 * exist in this repository" of a repository that had one the operator had switched off
 * in the Actions UI — a false statement on the workload issue. The operator's own
 * switch is the REASON the hook did not start it, and GHI #108 says the record states
 * what actually happened; so the dispatcher reports a disabled workflow as skipped,
 * with the state named. Paginated: a governed repo carries every installed oversight
 * workflow too, and those outnumber one page.
 */
export async function listSubjectWorkflows(gh: Octokit, repo: RepoRef): Promise<SubjectWorkflow[]> {
  const workflows = await gh.paginate(gh.actions.listRepoWorkflows, { ...repo, per_page: 100 });
  return workflows
    .filter((w) => isSubjectWorkflowPath(w.path))
    .map((w) => ({ id: w.id, path: w.path, name: w.name || w.path, state: w.state }));
}

/** Whether a workflow file declares the hook's inputs — and, when not, why not, in the
 *  words the completion record will carry. */
export type DispatchInputsCheck = { declared: true } | { declared: false; why: string };

/**
 * Read `on.workflow_dispatch.inputs` of the workflow at `ref` and check for the two
 * hook inputs.
 *
 * Read from the REF THE DISPATCH TARGETS (the default branch), not from the listing:
 * `listRepoWorkflows` describes the default branch too, but the file content is what
 * GitHub validates the dispatch against, and reading it here turns a 422 nobody can
 * act on into a skip reason that names the missing input.
 *
 * A 404 at the ref is a skip reason (the listing and the branch disagree — a rename or
 * a deletion in flight); a YAML parse failure is a skip reason (GitHub would refuse the
 * dispatch of an unparsable workflow with its own error). Any other API failure is
 * rethrown — it is the caller's to report, and "could not read" must never become
 * "does not declare".
 */
export async function readDispatchInputs(gh: Octokit, repo: RepoRef, path: string, ref: string): Promise<DispatchInputsCheck> {
  let text: string;
  try {
    const { data } = await gh.repos.getContent({ ...repo, path, ref });
    if (Array.isArray(data) || data.type !== 'file' || typeof data.content !== 'string') {
      return { declared: false, why: `${path} at ${ref} is not a file` };
    }
    text = Buffer.from(data.content, 'base64').toString('utf8');
  } catch (error: unknown) {
    if (errorStatus(error) === 404) return { declared: false, why: `${path} does not exist at ${ref}` };
    throw error;
  }

  let doc: unknown;
  try {
    // `uniqueKeys` so a duplicated `inputs:` key is a refusal here as it is in D6.1 —
    // the hook must read exactly what GitHub runs, not the last of two spellings.
    doc = parse(text, { uniqueKeys: true });
  } catch (error: unknown) {
    return { declared: false, why: `${path} is not valid YAML: ${errorMessage(error)}` };
  }
  if (!isRecord(doc)) return { declared: false, why: `${path} is not a workflow (no top-level map)` };
  // `on` as the yaml 1.2 core schema reads it (a string key). A 1.1 reader would have
  // made it the boolean `true`; `yaml` v2 defaults to 1.2, which is also GitHub's reading.
  const on = doc['on'];
  if (!isRecord(on) || !('workflow_dispatch' in on)) {
    return { declared: false, why: `${path} declares no workflow_dispatch trigger, so the completion hook cannot start it` };
  }
  const dispatch = on['workflow_dispatch'];
  const inputs = isRecord(dispatch) ? dispatch['inputs'] : undefined;
  const missing = SUBJECT_DISPATCH_INPUTS.filter((name) => !isRecord(inputs) || !(name in inputs));
  if (missing.length > 0) {
    return {
      declared: false,
      why:
        `${path} declares no workflow_dispatch input${missing.length > 1 ? 's' : ''} ${missing.map((m) => `\`${m}\``).join(', ')} ` +
        `— the completion hook passes ${SUBJECT_DISPATCH_INPUTS.map((m) => `\`${m}\``).join(' and ')} and GitHub refuses undeclared inputs`,
    };
  }
  // The same rule D6.2 enforces at delivery, re-checked at the moment of use (a workflow
  // the operator wrote by hand never met D6): an extra input that is required and has no
  // default would make GitHub refuse the dispatch, so it is a skip with the reason, not
  // a 422 in a red run (Codex P2 on PR #175, 2026-08-30).
  if (isRecord(inputs)) {
    for (const [name, input] of Object.entries(inputs)) {
      if ((SUBJECT_DISPATCH_INPUTS as readonly string[]).includes(name)) continue;
      if (isRecord(input) && input['required'] !== undefined && input['required'] !== false && input['default'] === undefined) {
        return {
          declared: false,
          why: `${path} declares a required workflow_dispatch input \`${name}\` with no default — the completion hook supplies only \`plan_ref\` and \`commit\`, so GitHub would refuse the dispatch; give it a default or make it optional`,
        };
      }
    }
  }
  return { declared: true };
}

export interface DispatchSubjectWorkflowsOptions {
  /** the workload this dispatch is on behalf of — for the caller's record; GitHub does
   *  not receive it (the input set is closed: `plan_ref` and `commit`, D6.2) */
  slug: string;
  /** the official plan ref (`plan/<slug>/v<n>`) — `inputs.plan_ref` */
  planRef: string;
  /** the verified merged commit sha — `inputs.commit` */
  commit: string;
  /** the git ref to run the workflow FROM — the default branch, where the merged
   *  deliverable now lives */
  ref: string;
}

export interface DispatchSubjectWorkflowsResult {
  /** started, in listing order */
  dispatched: { path: string; id: number }[];
  /** present but not started, each with the reason the record carries */
  skipped: { path: string; why: string }[];
  /** true when the repository has NO subject workflow at all, active OR disabled — said
   *  explicitly so the completion record can say "nothing to dispatch" rather than
   *  nothing (GHI #108); a disabled one exists and is reported in `skipped` */
  none: boolean;
  /** attempted and refused by the API, each with GitHub's answer — recorded rather than
   *  thrown, so the successful prefix and the exact failure both reach the workload
   *  issue (Codex P2 on PR #175, 2026-08-30); the caller decides the exit code */
  failed: { path: string; id: number; why: string }[];
}

/**
 * Dispatch every qualifying subject workflow with `{ plan_ref, commit }` on `ref`.
 *
 * Sequential and in listing order, so a partial failure leaves a legible prefix: the
 * workflows before the failing one ran, the ones after did not. API errors from the
 * dispatch itself are RETHROWN, not folded into `skipped` — a skip is a property of the
 * workflow file the operator can fix; a 403/5xx is a property of the run, and the
 * caller reports it and exits red (the transition already happened; the red run is
 * the signal).
 */
export async function dispatchSubjectWorkflows(
  gh: Octokit,
  repo: RepoRef,
  opts: DispatchSubjectWorkflowsOptions,
): Promise<DispatchSubjectWorkflowsResult> {
  const workflows = await listSubjectWorkflows(gh, repo);
  // `none` is computed over the UNFILTERED namespace: a disabled workflow exists.
  const result: DispatchSubjectWorkflowsResult = { dispatched: [], skipped: [], none: workflows.length === 0, failed: [] };
  for (const w of workflows) {
    if (w.state !== 'active') {
      // The operator's own switch. GitHub would answer 422 to the dispatch; the record
      // says why it was not attempted, in the operator's terms.
      result.skipped.push({
        path: w.path,
        why: `${w.path} is disabled in the Actions UI (state: ${w.state}), so the completion hook did not start it — re-enable it under Actions → the workflow → Enable workflow if it should deploy`,
      });
      continue;
    }
    const check = await readDispatchInputs(gh, repo, w.path, opts.ref);
    if (!check.declared) {
      result.skipped.push({ path: w.path, why: check.why });
      continue;
    }
    try {
      await gh.actions.createWorkflowDispatch({
        ...repo,
        workflow_id: w.id,
        ref: opts.ref,
        inputs: { plan_ref: opts.planRef, commit: opts.commit },
      });
      result.dispatched.push({ path: w.path, id: w.id });
    } catch (error: unknown) {
      // NOT RETHROWN MID-LIST (Codex P2 on PR #175). A throw here discarded the prefix
      // that had already started and never named the workflow that stopped it, and the
      // completed transition cannot be re-run — so the operator was left to reconstruct
      // progress from the Actions tab. Each workflow is independent: record this one's
      // refusal with GitHub's own words, try the rest, and let the caller go red.
      result.failed.push({ path: w.path, id: w.id, why: errorMessage(error) });
    }
  }
  return result;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
