import type { Octokit } from '@octokit/rest';
import { createClient, repoFromEnv, type RepoRef } from '../dashboard/lib/github/client';
import { ALL_LABELS } from '../dashboard/lib/github/labels';
import {
  checkReadiness,
  unmetItems,
  PLAN_RULESET,
  CURRENT_RULESET,
  MAIN_RULESET,
  EVIDENCE_RULESET,
  REQUIRED_CHECK_CONTEXTS,
  PRODUCT_ENVIRONMENTS,
  SUBJECT_DEPLOY_ENVIRONMENT,
  ACTIONS_CAN_OPEN_PRS_RECORD,
  formatCanOpenPrsRecord,
  parseCanOpenPrsRecord,
} from './gates/lib/readiness';
import { EVIDENCE_BRANCH, ensureEvidenceBranch } from '../dashboard/lib/github/evidence-store';
import { runGates, printReport } from './gates/lib/runner';
import { installOversightFiles } from './install';
import { apiMessage, errorMessage, errorStatus } from '../dashboard/lib/github/errors';

/** The slice of a GitHub ruleset `init` actually asserts. Not the whole payload:
 *  GitHub adds fields of its own to a stored ruleset, so comparing everything
 *  compares its formatting rather than our intent. */
interface RulesetShape {
  /** `active` | `evaluate` | `disabled`. **Compared, and this is not cosmetic**: a ruleset
   *  flipped to `evaluate` or `disabled` keeps its name, its rules and its registered
   *  contexts, so every check by NAME still passes while nothing is enforced at all. */
  enforcement?: string;
  /** `branch` | `tag` | `push`. Compared for the same reason as `conditions`: a rule
   *  set aimed at the wrong KIND of ref enforces nothing on the one we meant. */
  target?: string;
  /** WHICH refs it applies to. A same-named ruleset carrying our exact rules and
   *  contexts but conditioned on `refs/heads/plan/**` instead of `~DEFAULT_BRANCH`
   *  leaves the default branch completely unguarded, and comparing only the rules
   *  called that unchanged (Codex on PR #145). */
  conditions?: unknown;
  rules?: { type: string; parameters?: { required_status_checks?: { context: string }[] } }[];
  bypass_actors?: { actor_id: number; actor_type: string; bypass_mode: string }[];
}

/**
 * Day-1 `init` (T017/T126, FR-028/FR-030): reconcile the repository to the
 * desired oversight state — idempotent, reports `already_initialized` when a
 * re-run changes nothing, never destructive. `--verify` runs readiness I1–I9.
 */

export interface InitResult {
  changed: string[];
  /** reconcile targets waived on this repo (e.g. org-only push rules) — not counted as change */
  skipped: string[];
  alreadyInitialized: boolean;
}

export async function init(gh: Octokit, repo: RepoRef): Promise<InitResult> {
  const changed: string[] = [];
  const skipped: string[] = [];

  // Labels — create only the missing ones (idempotent).
  const { data: existing } = await gh.issues.listLabelsForRepo({ ...repo, per_page: 100 });
  const have = new Set(existing.map((l) => l.name));
  for (const name of ALL_LABELS) {
    if (!have.has(name)) {
      await gh.issues.createLabel({ ...repo, name, color: labelColor(name) });
      changed.push(`label ${name}`);
    }
  }

  // Protection rulesets: plan/** branches, plan-gate required on main. (The
  // plans/**/CURRENT push ruleset is GONE — the official version is derived
  // from frozen tags since 2026-07-11, GHI #44; a stale one is deleted below.)
  // 403 here = plan limitation (rulesets/environments need GitHub Pro or a paid org plan on
  // private repos) — refuse with the remedy instead of a raw API error.
  const planLimited = (error: unknown): never => {
    throw new Error(
      'this repository plan does not support rulesets/environments on private repos — ' +
        'upgrade to GitHub Pro / a paid org plan or make the repository public, then re-run init ' +
        `(${apiMessage(error)})`,
    );
  };
  const { data: rulesets } = await gh
    .request('GET /repos/{owner}/{repo}/rulesets', { ...repo })
    .catch((error: unknown) => (errorStatus(error) === 403 ? planLimited(error) : Promise.reject(error)));
  const rulesetList = rulesets as { id: number; name: string }[];
  const rulesetNames = new Set(rulesetList.map((r) => r.name));
  const rulesetsByName = new Map(rulesetList.map((r) => [r.name, r]));
  // Reconcile away the pre-2026-07-11 CURRENT push ruleset where it exists
  // (org repos only — user-owned repos never could create it): the file it
  // protected no longer exists, and a stale push rule would block nothing real
  // while confusing the readiness report.
  const staleCurrent = rulesetList.find((r) => r.name === CURRENT_RULESET);
  if (staleCurrent) {
    await gh.request('DELETE /repos/{owner}/{repo}/rulesets/{ruleset_id}', { ...repo, ruleset_id: staleCurrent.id });
    changed.push(`ruleset ${CURRENT_RULESET} deleted (obsolete: CURRENT derived from tags, GHI #44)`);
  }
  const wanted: { name: string; payload: Record<string, unknown> }[] = [
    {
      name: PLAN_RULESET,
      payload: {
        name: PLAN_RULESET,
        target: 'branch',
        enforcement: 'active',
        conditions: { ref_name: { include: ['refs/heads/plan/**'], exclude: [] } },
        rules: [{ type: 'non_fast_forward' }, { type: 'deletion' }],
      },
    },
    {
      name: MAIN_RULESET,
      payload: {
        name: MAIN_RULESET,
        target: 'branch',
        enforcement: 'active',
        conditions: { ref_name: { include: ['~DEFAULT_BRANCH'], exclude: [] } },
        // Required checks gate ALL pushes to main, not just PR merges. The
        // ONLY bypass is the repo-admin role (bootstrap/ops): since the
        // official version is derived from frozen tags (2026-07-11, GHI #44)
        // the post-merge writer never pushes to main, so no machine credential
        // carries a bypass on any repo type. 5 = repository admin role.
        //
        // `build-merge` performs the pre-authorized deliverable merge as
        // github-actions[bot] and is deliberately NOT given a bypass: it merges a
        // pull request whose required checks are green, which is the ordinary path
        // these rules exist to permit. A bypass there would mean automation could
        // land work the gates refused.
        bypass_actors: [{ actor_id: 5, actor_type: 'RepositoryRole', bypass_mode: 'always' }],
        rules: [
          {
            type: 'required_status_checks',
            // TWO CONTEXTS, and the second is half of the gate (T208(d), FR-068).
            // `deliverable-gate` running on a build PR without being REGISTERED AS
            // REQUIRED reports its verdict and blocks nothing: D2 scope containment
            // and D5 the subject boundary become advisory, silently, on a
            // green-looking PR. Registered from REQUIRED_CHECK_CONTEXTS rather than
            // spelled here so readiness item I7 asserts the same list this writes —
            // two hand-maintained copies is how a gate comes to run and block
            // nothing.
            parameters: {
              required_status_checks: REQUIRED_CHECK_CONTEXTS.map((context) => ({ context })),
              strict_required_status_checks_policy: false,
            },
          },
        ],
      },
    },
    {
      name: EVIDENCE_RULESET,
      payload: {
        name: EVIDENCE_RULESET,
        target: 'branch',
        enforcement: 'active',
        conditions: { ref_name: { include: [`refs/heads/${EVIDENCE_BRANCH}`], exclude: [] } },
        // The same two rules the plan branches carry, for the same reason: an
        // evidence batch is an append-only record, so its branch may only ever
        // grow. No bypass actor — nobody has a reason to rewrite a record, and
        // the records live here precisely BECAUSE the default branch's
        // required-check rule refused every machine write (GHI #134).
        rules: [{ type: 'non_fast_forward' }, { type: 'deletion' }],
      },
    },
  ];
  const missingContentsScope = (error: unknown): never => {
    throw new Error(
      'the credential cannot write to this repository — creating the evidence record store needs a ' +
        `token with "Contents: Read and write" (quickstart §0). API said: ${apiMessage(error)}`,
    );
  };
  const missingAdminScope = (error: unknown): never => {
    throw new Error(
      'the credential cannot administer this repository — init needs a token with ' +
        '"Administration: Read and write" (quickstart §0: use a separate admin-scoped PAT for ' +
        `init only). API said: ${apiMessage(error)}`,
    );
  };
  // The evidence record store (GHI #134). Created BEFORE its ruleset so the
  // protection lands on a branch that exists. Idempotent: an existing branch is
  // left exactly as it is — this never touches a record.
  const evidenceBranch = await ensureEvidenceBranch(gh, repo).catch((error: unknown) =>
    errorStatus(error) === 403 ? missingContentsScope(error) : Promise.reject(error),
  );
  if (evidenceBranch.created) changed.push(`branch ${EVIDENCE_BRANCH} (the evidence record store)`);

  for (const { name, payload } of wanted) {
    if (!rulesetNames.has(name)) {
      try {
        await gh.request('POST /repos/{owner}/{repo}/rulesets', { ...repo, ...payload } as never);
        changed.push(`ruleset ${name}`);
      } catch (error: unknown) {
        if (errorStatus(error) === 403) missingAdminScope(error);
        throw error;
      }
      continue;
    }
    // RECONCILE AN EXISTING RULESET, not just create a missing one (2026-08-24).
    //
    // `init` is specified as idempotent reconciliation to a desired state (FR-028),
    // and for rulesets it was only ever create-if-absent. That gap has teeth: adding
    // `deliverable-gate` to the required-check list changes nothing on any repo
    // initialized before the change, so the gate would run and block nothing —
    // silently, on a green-looking pull request, which is the exact absent-≠-success
    // failure the required-check registration exists to prevent (GHI #108). An
    // operator re-running `npm run init` has every reason to expect the rules to
    // catch up, and nothing told them otherwise.
    //
    // Compared on the RULES rather than the whole payload: name, target and
    // conditions are what identify the ruleset, and rewriting those on every run
    // would make the reconcile itself a change. Bypass actors are compared too —
    // dropping the machine bypass (GHI #44) is precisely the kind of tightening that
    // must reach an already-initialized repo.
    const existing = rulesetsByName.get(name);
    if (!existing) continue;
    try {
      const { data: full } = await gh.request('GET /repos/{owner}/{repo}/rulesets/{ruleset_id}', {
        ...repo,
        ruleset_id: existing.id,
      });
      // COMPARED ON SEMANTICS, NOT ON THE PAYLOAD BYTES (found live, 2026-08-25).
      //
      // A deep JSON compare against what we sent is always unequal: GitHub
      // normalizes a ruleset it stores and adds fields of its own — a
      // required_status_checks rule comes back carrying
      // `do_not_enforce_on_create: false`, which we never sent. So `init` reported
      // "rules reconciled" on every single re-run and issued a pointless PUT,
      // breaking the one property FR-030 promises: a no-op re-run says
      // `already_initialized` and changes nothing.
      //
      // What we actually assert is narrower than the payload anyway: that the same
      // rule TYPES are present, that the required-check contexts are exactly the set
      // we demand, and that the bypass actors match. Comparing that is comparing the
      // thing we care about; comparing the JSON was comparing GitHub's formatting.
      const semantics = (r: RulesetShape): string => {
        // ENFORCEMENT IS PART OF THE SEMANTICS, and leaving it out was a hole big enough
        // to swallow every gate (found reviewing this wave, 2026-08-25). A ruleset can be
        // flipped to `evaluate` (dry run) or `disabled` from Settings → Rules in one click.
        // It keeps its name, its rule types and its required-check contexts — so `init`'s
        // reconcile saw no difference, and readiness, which checks the ruleset by NAME and
        // reads the contexts back, reported every item green. Meanwhile `plan-gate` and
        // `deliverable-gate` enforced nothing: they ran, reported, and blocked no merge.
        //
        // That is precisely the failure this project refuses everywhere else — a control
        // that is present, reporting, and inert (GHI #108) — reached from the one direction
        // nothing was looking at. Comparing it here means `init` puts it back; asserting it
        // in readiness means an operator finds out before a deliverable lands ungated.
        const enforcement = r.enforcement ?? 'active';
        // TARGET AND CONDITIONS TOO (Codex on PR #145). Name, rules, contexts and
        // bypass actors can all match while the ruleset points at the wrong refs — and
        // `init` would then call it unchanged and readiness would find the contexts it
        // expects, with the default branch guarded by nothing. Identity is not just
        // "what rules" but "applied where".
        const target = r.target ?? 'branch';
        const conditions = JSON.stringify(r.conditions ?? {});
        const types = (r.rules ?? []).map((rule) => rule.type).sort();
        const contexts = (r.rules ?? [])
          .flatMap((rule) => rule.parameters?.required_status_checks ?? [])
          .map((c) => c.context)
          .sort();
        const bypass = (r.bypass_actors ?? [])
          .map((a) => `${a.actor_type}:${a.actor_id}:${a.bypass_mode}`)
          .sort();
        return JSON.stringify({ enforcement, target, conditions, types, contexts, bypass });
      };
      const same = semantics(full as RulesetShape) === semantics(payload as RulesetShape);
      if (!same) {
        await gh.request('PUT /repos/{owner}/{repo}/rulesets/{ruleset_id}', {
          ...repo,
          ruleset_id: existing.id,
          ...payload,
        } as never);
        changed.push(`ruleset ${name} (rules reconciled)`);
      }
    } catch (error: unknown) {
      if (errorStatus(error) === 403) missingAdminScope(error);
      throw error;
    }
  }

  // ACTIONS MUST BE ALLOWED TO OPEN PULL REQUESTS (found live, 2026-08-25).
  //
  // `build-publish` is the only writer of a deliverable pull request, and on a repo
  // where this setting is off it gets as far as creating the branch and the commit
  // before `POST /pulls` returns 403 "GitHub Actions is not permitted to create or
  // approve pull requests". The whole deliverable path is then permanently dead in
  // that target, and nothing before the first paid agent run says so.
  //
  // Set, not merely checked: `init`'s contract is to reconcile to a desired state
  // (FR-028), and this is part of the desired state. Idempotent — only reported as a
  // change when it was actually off.
  //
  // NOTE the endpoint's field name is `can_approve_pull_request_reviews`, which reads
  // as being about REVIEWS. It is not: it is GitHub's single switch for "create and
  // approve", and creation is what we need. Approval remains impossible for a
  // different reason — the App token can never be `merged_by` (SC-003), and no gate
  // accepts a review from the actor that produced the work.
  try {
    const { data: current } = await gh.request('GET /repos/{owner}/{repo}/actions/permissions/workflow', { ...repo });
    if ((current as { can_approve_pull_request_reviews?: boolean }).can_approve_pull_request_reviews !== true) {
      await gh.request('PUT /repos/{owner}/{repo}/actions/permissions/workflow', {
        ...repo,
        default_workflow_permissions: (current as { default_workflow_permissions?: 'read' | 'write' }).default_workflow_permissions ?? 'read',
        can_approve_pull_request_reviews: true,
      });
      changed.push('Actions permitted to create pull requests (the deliverable path needs it)');
    }
  } catch (error: unknown) {
    if (errorStatus(error) === 403) missingAdminScope(error);
    throw error;
  }

  // RECORD WHAT WAS JUST VERIFIED, for the readers that cannot look (T278, operator
  // finding 2026-08-30). Reaching this line means the setting is ON: the block above
  // either found it true or PUT it true, and every failure there throws. `init` is the
  // only run that can see this setting at all — it holds the admin-scoped bootstrap
  // token — so it is the only place the answer can be captured for `/workloads` and for
  // `npm run init -- --verify` on the ordinary credential, both of which get a 403 from
  // the endpoint itself. Readiness I7 reads the record ONLY when the live read fails,
  // and reports it as a record with its date, never as a live check.
  //
  // THE TIMESTAMP IS REFRESHED ON EVERY RUN, and that is deliberate: "last verified"
  // means the last time init actually looked, not the first. It is NOT reported in
  // `changed`, because `alreadyInitialized` describes the governed repo's desired
  // STATE and a verification date is not part of it — a re-run that changes nothing
  // still reports `already_initialized`, which is the contract T178 pinned.
  try {
    let recorded: { value: boolean; at: string | null } | null = null;
    // EXISTS and PARSES are different questions (Codex P2 on PR #176). Collapsing them
    // meant a variable holding a value this did not write — a hand-edit, or a future
    // format — took the create branch, GitHub answered 409, and `init` ABORTED. Which
    // made readiness's own prescribed remedy for a malformed record ("re-run init")
    // the one thing that could not work.
    let exists = false;
    try {
      const { data } = await gh.actions.getRepoVariable({ ...repo, name: ACTIONS_CAN_OPEN_PRS_RECORD });
      exists = true;
      recorded = parseCanOpenPrsRecord(data.value);
    } catch (error: unknown) {
      if (errorStatus(error) !== 404) throw error; // 404 = never recorded, the first-run case
    }
    const value = formatCanOpenPrsRecord(true, new Date().toISOString());
    if (exists) await gh.actions.updateRepoVariable({ ...repo, name: ACTIONS_CAN_OPEN_PRS_RECORD, value });
    else await gh.actions.createRepoVariable({ ...repo, name: ACTIONS_CAN_OPEN_PRS_RECORD, value });
    if (recorded?.value !== true) {
      changed.push(`recorded that Actions may create pull requests (${ACTIONS_CAN_OPEN_PRS_RECORD}) — readiness reads it when a credential cannot see the setting`);
    }
  } catch (error: unknown) {
    // WAIVED, NOT FATAL, and not silent. Repository variables are a SEPARATE
    // fine-grained permission from Administration, so a bootstrap token scoped exactly
    // as DEPLOY.md §2 described before today can set the permission and still not be
    // able to record it. Failing init over the record would be worse than the gap it
    // closes — everything else init does is unaffected — so it is reported as a waived
    // target with the remedy, and readiness says the item is unverifiable until it is
    // done. Anything that is not an authorization answer still throws.
    // A 404 from the WRITE path is a different answer from the 404 the read treats as
    // "never recorded": the endpoint itself is not there (Codex P2 on PR #176 — a GHES
    // target reached through `GITHUB_API_URL` whose variables API is unsupported, and
    // any case where the repository moved mid-run). Waived for the same reason as the
    // 403: an optional record must not be able to fail the whole of `init`, whose other
    // targets are unaffected. Everything else still throws.
    const status = errorStatus(error);
    if (status !== 403 && status !== 404) throw error;
    skipped.push(
      status === 403
        ? `could not record the Actions-can-open-pull-requests verification (${ACTIONS_CAN_OPEN_PRS_RECORD}): the bootstrap ` +
            'token lacks **Variables: rw**. Grant it and re-run — until then readiness I7 reports that half as unverifiable ' +
            'for every credential that cannot read the setting directly'
        : `could not record the Actions-can-open-pull-requests verification (${ACTIONS_CAN_OPEN_PRS_RECORD}): the repository ` +
            'variables API answered 404 — it is unavailable at this API base (a GHES target reached through `GITHUB_API_URL` ' +
            'may not support it). Everything else initialized; readiness I7 reports that half as unverifiable for every ' +
            'credential that cannot read the setting directly',
    );
  }

  // The two GitHub Environments the product needs (PUT is idempotent, but only report a
  // change when something was absent):
  //   agent-build     the build executor's environment (readiness I4)
  //   subject-deploy  the operator's DEPLOY environment (readiness I9; T273, GHI #174).
  //                   A subject workflow's OIDC job must name exactly this environment
  //                   (D6.6) — its required reviewers are the per-deploy human approval,
  //                   and its name is the OIDC subject the cloud role's trust policy pins
  //                   to (`repo:<org>/<repo>:environment:subject-deploy`,
  //                   CONFIGURATION_GUIDE.md §7).
  //
  // THE DEPLOY ENVIRONMENT IS NOT CREATED EMPTY (security review 2026-08-29). GitHub
  // applies an environment's protections only where they are configured, and a fresh
  // environment has none — so until the operator finished §7 by hand, a `pull_request`
  // run of an agent's unmerged workflow could mint `environment:subject-deploy` OIDC
  // from a `build/**` branch: the exact subject the trust policy is told to pin to,
  // minted from output no human had read. The API CAN set the half that is a policy:
  // `init` PUTs `deployment_branch_policy: custom` and adds the default branch as the
  // one allowed deployment branch, so a deploy can only run from code that landed
  // through the gates. Only the REVIEWERS genuinely need the UI, and readiness I9
  // reports the environment unmet until they exist. A target initialized before
  // 2026-08-29 gains the environment on re-run; one initialized between then and this
  // fix gains the policy on re-run (reconciled, FR-030).
  const { data: repository } = await gh.repos.get({ ...repo });
  const defaultBranch = repository.default_branch;
  for (const environment of PRODUCT_ENVIRONMENTS) {
    type EnvironmentView = {
      deployment_branch_policy?: { custom_branch_policies?: boolean } | null;
      protection_rules?: {
        type?: string;
        wait_timer?: number;
        prevent_self_review?: boolean;
        reviewers?: { type?: string; reviewer?: { id?: number; login?: string; type?: string } }[];
      }[];
    } | null;
    let existing: EnvironmentView = null;
    let hasEnv = true;
    try {
      const { data } = await gh.request('GET /repos/{owner}/{repo}/environments/{environment_name}', {
        ...repo,
        environment_name: environment,
      });
      existing = data as EnvironmentView;
    } catch (error: unknown) {
      const status = errorStatus(error);
      if (status === 404) hasEnv = false;
      else if (status === 403) planLimited(error);
      else throw error;
    }
    const isDeploy = environment === SUBJECT_DEPLOY_ENVIRONMENT;
    const needsPolicy = isDeploy && existing?.deployment_branch_policy?.custom_branch_policies !== true;
    // WHAT A PUT REPLACES (2026-08-29, follow-up to the security review). GitHub's
    // "create or update an environment" writes the WHOLE protection configuration: a
    // rule the request omits is a rule the environment loses. So the re-run that adds
    // the branch policy to an environment the operator had already given reviewers
    // would silently strip those reviewers — the deploy leg's only human approval,
    // removed by an idempotency pass that reported one harmless line. Every PUT below
    // therefore re-sends what the GET returned (reviewers, wait timer, the self-review
    // rule), and `init` adds exactly ONE thing of its own: when the deploy environment
    // has NO reviewer, the person running init — the bootstrap PAT's owner — becomes
    // the first one, so a fresh target is `ready` the moment init finishes instead of
    // red on I9 until somebody visits the UI. An App installation token is not a
    // person and cannot review a deployment (GET /user answers 403), so on that path
    // nothing is added and readiness I9 keeps naming the UI step. Teammates are always
    // added in the UI; init never removes a reviewer.
    const rules = existing?.protection_rules ?? [];
    const reviewerRule = rules.find((r) => r.type === 'required_reviewers');
    const reviewers: { type: 'User' | 'Team'; id: number }[] = (reviewerRule?.reviewers ?? []).flatMap((r) => {
      const id = r.reviewer?.id;
      if (typeof id !== 'number') return [];
      const type = (r.type ?? r.reviewer?.type) === 'Team' ? 'Team' : 'User';
      return [{ type, id }];
    });
    const waitTimer = rules.find((r) => r.type === 'wait_timer')?.wait_timer;
    const preventSelfReview = reviewerRule?.prevent_self_review;
    let addedReviewer: string | null = null;
    if (isDeploy && reviewers.length === 0) {
      try {
        const { data: me } = await gh.users.getAuthenticated();
        if (me.type === 'User' && typeof me.id === 'number') {
          reviewers.push({ type: 'User', id: me.id });
          addedReviewer = me.login;
        }
      } catch (error: unknown) {
        if (errorStatus(error) !== 403) throw error; // 403 = an installation token, not a person
      }
    }
    if (!hasEnv || needsPolicy || addedReviewer !== null) {
      await gh
        .request('PUT /repos/{owner}/{repo}/environments/{environment_name}', {
          ...repo,
          environment_name: environment,
          ...(isDeploy
            ? {
                deployment_branch_policy: { protected_branches: false, custom_branch_policies: true },
                reviewers,
                ...(waitTimer !== undefined ? { wait_timer: waitTimer } : {}),
                ...(preventSelfReview !== undefined ? { prevent_self_review: preventSelfReview } : {}),
              }
            : {}),
        })
        .catch((error: unknown) => (errorStatus(error) === 403 ? missingAdminScope(error) : Promise.reject(error)));
      if (!hasEnv) changed.push(`environment ${environment}`);
      else if (needsPolicy) changed.push(`deployment branch policy on environment ${environment}`);
      if (addedReviewer !== null) {
        changed.push(
          `environment ${environment}: @${addedReviewer} added as its first required reviewer (you — add teammates under Settings → Environments)`,
        );
      }
    }
    if (isDeploy) {
      const { data: policies } = await gh.request('GET /repos/{owner}/{repo}/environments/{environment_name}/deployment-branch-policies', {
        ...repo,
        environment_name: environment,
      });
      const list = (policies as { branch_policies?: { id: number; name: string; type?: string }[] }).branch_policies ?? [];
      const isDefault = (p: { name: string; type?: string }): boolean => p.name === defaultBranch && p.type !== 'tag';
      if (!list.some(isDefault)) {
        await gh
          .request('POST /repos/{owner}/{repo}/environments/{environment_name}/deployment-branch-policies', {
            ...repo,
            environment_name: environment,
            name: defaultBranch,
            type: 'branch',
          })
          .catch((error: unknown) => (errorStatus(error) === 403 ? missingAdminScope(error) : Promise.reject(error)));
        changed.push(`environment ${environment} deploys from ${defaultBranch} only`);
      }
      // "ONLY" MEANS ONLY (Codex P1 on PR #175, 2026-08-30). The first version made sure the
      // default-branch policy EXISTED and reported the environment pinned — while a
      // pre-existing policy such as `build/**` (the branch every deliverable is built on)
      // stayed in force, so a deploy could run from unmerged output under a message
      // that said otherwise. Reconciling a list means the list, not one entry: every
      // policy that is not the default branch is removed, tag policies included. This is
      // configuration, not a record — FR-042's never-delete is about the governance
      // record, and an environment rule that widens the deploy surface is the opposite
      // of one.
      for (const extra of list.filter((p) => !isDefault(p))) {
        await gh
          .request('DELETE /repos/{owner}/{repo}/environments/{environment_name}/deployment-branch-policies/{branch_policy_id}', {
            ...repo,
            environment_name: environment,
            branch_policy_id: extra.id,
          })
          .catch((error: unknown) => (errorStatus(error) === 403 ? missingAdminScope(error) : Promise.reject(error)));
        changed.push(`environment ${environment}: removed deployment-branch policy \`${extra.name}\`${extra.type === 'tag' ? ' (tag)' : ''} — deploys from ${defaultBranch} only`);
      }
    }
  }

  // Install/update the governed-repo files (templates + gate toolchain) as one
  // git-tree commit — idempotent: unchanged content produces no commit (T178).
  // Writing .github/workflows/ files needs the "workflows" permission (quickstart §0).
  try {
    const install = await installOversightFiles(gh, repo);
    if (install.committed) {
      changed.push(`installed oversight files (${install.fileCount} files, ${install.commitSha})`);
    }
  } catch (error: unknown) {
    const status = errorStatus(error);
    if (status === 403 || status === 422) {
      // GitHub returns the same opaque 403 whether Contents or Workflows is missing —
      // name the full required set, and the usual trap (a stale day-to-day token in the shell).
      throw new Error(
        'installing oversight files into the target failed — the install commit needs BOTH ' +
          '"Contents: Read and write" AND "Workflows: Read and write" on the credential ' +
          '(quickstart §0: the bootstrap PAT is Option A\'s permissions PLUS Administration + Workflows). ' +
          'If you exported the day-to-day token earlier (e.g. via `source dashboard/.env.local`), it is ' +
          `still in your shell — pass the bootstrap PAT inline: GITHUB_TOKEN=<bootstrap-pat> npm run init. API said: ${apiMessage(error)}`,
      );
    }
    throw error;
  }

  return { changed, skipped, alreadyInitialized: changed.length === 0 };
}

function labelColor(name: string): string {
  if (name.startsWith('andon:')) return 'd93f0b';
  if (name.startsWith('correction:')) return 'fbca04';
  if (name.startsWith('workload:')) return '0e8a16';
  if (name.startsWith('chunk:')) return 'c5def5';
  if (name.startsWith('high-stakes:')) return 'b60205';
  if (name.startsWith('confirmed:')) return '0052cc';
  if (name.startsWith('plan:')) return '5319e7';
  return 'ededed';
}

const isMain = process.argv[1]?.endsWith('setup-repo.ts');
if (isMain) {
  const gh = createClient();
  const repo = repoFromEnv();
  const verify = process.argv.includes('--verify');
  const json = process.argv.includes('--json');
  (async () => {
    if (verify) {
      const results = await checkReadiness(gh, repo);
      const report = await runGates(`${repo.owner}/${repo.repo}`, results.map((r) => () => r));
      printReport(report, json);
      if (report.result !== 'pass') {
        console.error(`not ready — unmet: ${unmetItems(results).join(' · ')}`);
        process.exit(1);
      }
      console.log('ready');
      return;
    }
    const result = await init(gh, repo);
    if (result.alreadyInitialized) console.log('already_initialized');
    else console.log(`initialized: ${result.changed.join(', ')}`);
    for (const s of result.skipped) console.log(`skipped: ${s}`);
  })().catch((error) => {
    console.error(errorMessage(error));
    process.exit(2);
  });
}
