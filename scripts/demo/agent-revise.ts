import type { Octokit } from '@octokit/rest';
import { createClient, repoFromEnv, type RepoRef } from '../../dashboard/lib/github/client';
import { getAndon } from '../../dashboard/lib/github/andon';
import { getCorrection } from '../../dashboard/lib/github/corrections';
import { readPlanFileAtRef } from '../../dashboard/lib/github/plans';
import { errorMessage } from '../../dashboard/lib/github/errors';

/**
 * Demo revision (T048, quickstart §4): simulates the agent's side of the
 * correction round-trip — reads the open correction, applies its single
 * instruction to the flagged boundary case on the plan branch, and commits
 * with the `addresses: correction #<n>` trailer that makes the item
 * re-judgeable (FR-004). In production the revision agent does this same
 * write through the deterministic publisher seam.
 */

export interface ReviseResult {
  planRef: string;
  itemId: string;
  commitMessage: string;
}

export async function agentRevise(
  gh: Octokit,
  repo: RepoRef,
  input: { correctionIssue: number },
): Promise<ReviseResult> {
  const correction = await getCorrection(gh, repo, input.correctionIssue);
  if (correction.state !== 'open') {
    throw new Error(`correction #${input.correctionIssue} is ${correction.state} — only an open correction can be revised against`);
  }
  const andon = await getAndon(gh, repo, correction.andonIssue);
  const planRef = andon.planRef;

  // Resolved, not hard-coded: the document lives at plans/<slug>/plan.json, with the
  // pre-#79 repo root as a guarded fallback for branches published before that.
  const file = await readPlanFileAtRef(gh, repo, planRef);
  const plan = JSON.parse(file.raw) as {
    boundary_cases?: { id: string; description: string }[];
  };
  // The publisher/re-open writers always land a schema-valid document, but this CLI
  // reads whatever is on the branch — parse it as untrusted (constitution).
  if (!Array.isArray(plan.boundary_cases)) {
    throw new Error(`${file.path} at ${planRef} has no boundary_cases array — not a published plan document`);
  }
  // A BREAK-LEVEL correction (itemId null — a US11 scope request, GHI #73 A1) names
  // no boundary case, so this demo revisor has nothing mechanical to rewrite: the
  // request is prose about the proposal as a whole, and turning prose into a plan
  // change is a judgment call this script deliberately does not make. Refused by
  // name so the operator routes it through the real revision path (or edits the plan
  // themselves on the live branch via the scope editor).
  if (correction.itemId === null) {
    throw new Error(
      `correction #${input.correctionIssue} is break-level (a scope/intent request about the whole proposal), ` +
        `not a boundary-case correction — this demo revisor only rewrites a flagged boundary case. Address it on ` +
        `the plan branch directly (the review page's scope editor) or with a real revision agent.`,
    );
  }
  const flagged = plan.boundary_cases.find((bc) => bc.id === correction.itemId);
  if (!flagged) {
    throw new Error(`correction #${input.correctionIssue} targets ${correction.itemId}, which is not a boundary case in ${planRef}`);
  }
  // The demo "agent" honors the single instruction verbatim: it becomes the
  // boundary case's corrected behavior description.
  flagged.description = correction.instruction;

  const commitMessage = `plan: revise ${planRef} per correction #${input.correctionIssue}\n\naddresses: correction #${input.correctionIssue}`;
  await gh.repos.createOrUpdateFileContents({
    ...repo,
    path: file.path,
    message: commitMessage,
    content: Buffer.from(JSON.stringify(plan, null, 2)).toString('base64'),
    branch: planRef,
    sha: file.sha,
  });

  return { planRef, itemId: correction.itemId, commitMessage };
}

const isMain = process.argv[1]?.endsWith('agent-revise.ts');
if (isMain) {
  const argv = process.argv.slice(2);
  const i = argv.indexOf('--correction');
  const correctionIssue = i >= 0 ? Number(argv[i + 1]) : NaN;
  if (!Number.isInteger(correctionIssue) || correctionIssue < 1) {
    console.error('usage: agent-revise --correction <issue#>');
    process.exit(2);
  }
  const gh = createClient();
  const repo = repoFromEnv();
  agentRevise(gh, repo, { correctionIssue })
    .then((r) => {
      console.log(`revised ${r.planRef} (${r.itemId}) — commit trailer: addresses: correction #${correctionIssue}`);
    })
    .catch((error) => {
      console.error(errorMessage(error));
      process.exit(1);
    });
}
