import type { Octokit } from '@octokit/rest';
import type { RepoRef } from '../dashboard/lib/github/client';

/**
 * WHAT DID THE INDEPENDENT SAFETY CHECK DO ON THIS RUN? (GHI #316)
 *
 * Every agentic workflow compiles a `detection` job that reads what the agent produced
 * before the `safe_outputs` job applies any of it. The sources now ask for the blocking
 * mode (`safe-outputs.threat-detection.continue-on-error: false`), so a flagged run - or
 * a detector that could not run - FAILS that job, `safe_outputs` is skipped, and the run
 * concludes `failure` with nothing applied: no issue, no `plan.json`, no
 * `deliverable.patch`.
 *
 * The two deterministic publishers downstream each need to tell that ending apart from
 * "the agent did not finish", and they must read it the same way. This is the one place
 * that reads it.
 *
 * FIVE ANSWERS, not two (ADR-0007's unknown rule): a job listing that could not be read,
 * or a detection job still running, is `unknown` - never `passed`, and never `stopped`.
 * A caller that cannot tell says nothing about detection rather than guessing.
 *
 * `stopped` IS ONLY SAID WHEN THE AGENT IS SEEN TO HAVE FINISHED. The detection job is
 * compiled `if: always() && needs.agent.result != 'skipped'`, so it also runs after an
 * agent that FAILED. With no output to judge it never installs the checker, and in
 * blocking mode its closing step then fails for want of it (gh-aw v0.89.17,
 * conclude_threat_detection.sh). So "detection job: failure" alone is also what a plain
 * dead agent looks like, and reading it as a safety stop would put a false cause on the
 * operator's screen - the very thing this module exists to prevent. A failed detection
 * job beside a failed agent is `agent-failed`; beside no readable agent job, `unknown`.
 *
 * `passed` MEANS THE JOB SUCCEEDED, which includes "it had nothing to check". No caller
 * may use it as a clean verdict on a candidate; nothing here does.
 *
 * WHAT THIS CANNOT TELL APART: "detection flagged the output" from "detection itself
 * broke" (an API error, a timeout inside the step). Both end the job `failure`, and the
 * jobs API carries no reason. The copy built on `stopped` therefore names both and
 * points at the run; splitting them needs the detection artifact's own verdict, whose
 * shape has to be read off one real blocked run first.
 */
export type DetectionOutcome = 'stopped' | 'agent-failed' | 'passed' | 'not-run' | 'unknown';

/** The compiled job's key and display name - gh-aw emits it without a `name:`, so the
 *  jobs API reports the key. Pinned by tests/unit/workflow-detection-blocking.test.ts. */
export const DETECTION_JOB = 'detection';
/** The job whose output detection judges; same naming rule, same pin. */
export const AGENT_JOB = 'agent';

export interface JobConclusion {
  name: string;
  conclusion: string | null;
}

export function detectionOutcome(jobs: readonly JobConclusion[] | null): DetectionOutcome {
  if (jobs === null) return 'unknown';
  const detection = jobs.filter((job) => job.name === DETECTION_JOB);
  if (detection.length === 0) return 'not-run';
  // A re-run lists a job once per attempt only when asked for every attempt; with the
  // default (latest) there is one. Should there ever be several, any failure wins: a
  // run is only clear when nothing about its detection says otherwise.
  if (detection.some((job) => job.conclusion === 'failure' || job.conclusion === 'timed_out')) {
    const agent = jobs.filter((job) => job.name === AGENT_JOB);
    if (agent.length === 0 || agent.some((job) => job.conclusion === null)) return 'unknown';
    return agent.every((job) => job.conclusion === 'success') ? 'stopped' : 'agent-failed';
  }
  if (detection.some((job) => job.conclusion === null)) return 'unknown';
  if (detection.every((job) => job.conclusion === 'success')) return 'passed';
  return 'not-run';
}

/** The loader. Total: any read failure is `unknown`, because the callers are reporters
 *  that must never turn "could not ask" into a red job or a false sentence. */
export async function readDetectionOutcome(gh: Octokit, repo: RepoRef, runId: string): Promise<DetectionOutcome> {
  try {
    const jobs = await gh.paginate(gh.actions.listJobsForWorkflowRun, { ...repo, run_id: Number(runId), per_page: 100 });
    return detectionOutcome(jobs.map((job) => ({ name: job.name, conclusion: job.conclusion ?? null })));
  } catch {
    return 'unknown';
  }
}

/** A run's title and page, or nulls when it cannot be read. The title is the workflow's
 *  `run-name` - the only carrier of a dispatch's inputs a `workflow_run` consumer has. */
export async function readRunTitle(gh: Octokit, repo: RepoRef, runId: string): Promise<{ title: string | null; url: string | null }> {
  try {
    const { data } = await gh.actions.getWorkflowRun({ ...repo, run_id: Number(runId) });
    return { title: data.display_title ?? null, url: data.html_url ?? null };
  } catch {
    return { title: null, url: null };
  }
}

/**
 * The two sentences both publishers say, so the operator reads the same explanation on a
 * workload, a review and a work item. `what` names what did not happen in that place.
 */
export function detectionStoppedExplanation(input: { runUrl: string | null; notApplied: string }): string[] {
  const where = input.runUrl ? `[the run's page](${input.runUrl})` : `the run's page`;
  return [
    `**The independent safety check stopped this run.** Before anything an agent produces is used, a separate ` +
      `check reads it. On this run that check did not pass: either it flagged what the agent produced, or the ` +
      `check itself could not finish. Either way nothing the agent produced was applied — ${input.notApplied}.`,
    ``,
    `**What to do**: open ${where} and read the \`detection\` job. If the check could not finish (a service ` +
      `error or a timeout), run the agent again. If it flagged the output, read what it flagged before deciding ` +
      `whether to run the agent again.`,
  ];
}
