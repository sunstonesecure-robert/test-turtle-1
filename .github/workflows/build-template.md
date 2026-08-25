---
on:
  workflow_dispatch:
    inputs:
      plan_ref:
        description: "Frozen plan tag (plan/<slug>/v<N>) — the ONLY ref a build may use"
        required: true
      workload:
        description: "Workload slug (must be workload:active — preflight B7)"
        required: true
      chunk:
        description: "Chunk issue number the build works on (preflight B3/B6; required for unattended runs)"
        required: false
      unattended:
        description: "true = no operator watching — requires the chunk's intent:confirmed record (preflight B4, FR-018)"
        required: false
        default: "false"
      gates_ref:
        description: "Ref to run the PREFLIGHT GATES from — a pinned gates release, or blank for the default branch. Never the frozen plan tag (GHI #107)"
        required: false
        default: ""
permissions:
  contents: read
  issues: read
  checks: read # agent job is read-only (gh-aw strict mode); vt-<id> check runs are
  #   emitted by templates/workflows/vt-report.yml — a SEPARATE deterministic
  #   workflow_run workflow, not a step in this job: a step here would need
  #   checks: write, which is the capability the substrate split withholds (T154)
engine: claude
timeout-minutes: 30
# EXECUTOR IDENTITY (FR-059/FR-065) — the reference executor, and explicitly not a
# requirement. `engine:` above is gh-aw's compile-time selection, so a different
# engine means a different compiled lock file; the constitution's standing
# multi-engine constraint is satisfied by that being a per-workflow choice, not by
# this file naming one. `executors/` carries the conformant configurations; this
# workflow is the in-sandbox reference implementation of the same contract.
#
# LITERAL, not `vars.BUILD_EXECUTOR_ID` — gh-aw's expression allowlist forbids
# `vars.*` in a compiled workflow, and that restriction turns out to be the right
# shape anyway: an executor's identity belongs to the executor, and swapping
# executors means a DIFFERENT workflow file (the engine is a compile-time choice, so
# it could never have been one file with a variable). `executors/tracer-hello.yml`
# carries the same values as the config an operator reads.
env:
  EXECUTOR_ID: tracer-hello
  EXECUTOR_TIER: in-sandbox
  EXECUTOR_ENGINE: claude
# cost ceiling: $10 per run (constitution: Cost & Observability; enforced via timeout-minutes + engine limits)
# timeout-minutes compiles to a STEP-level cap only (gh-aw v0.81.6 has no job-level knob for the
# agent/detection jobs) — a hung sandboxed CLI outlives it and runs to GitHub's 360-min job default
# (#39, PB-004: ~6h). After EVERY compile run scripts/enforce-job-timeouts.ts to inject the
# job-level backstop into the .lock.yml; tests/unit/workflow-timeouts.test.ts guards it.
environment: agent-build # platform-level backstop behind the preflight
safe-outputs:
  create-issue:
    title-prefix: "missing-data: "
  upload-artifact:
network: defaults
steps:
  # THE WORKTREE AND THE RULES ARE CHECKED OUT SEPARATELY, and only one of them is
  # historical (GHI #107). The gates run FIRST, out of a CURRENT checkout; the frozen
  # tag is then checked out over it for the agent. Freezing the plan document is
  # FR-007; freezing the policy that enforces it is not — it pins governance to the
  # rules of the approval date and weakens it with every gate added since. Live
  # evidence: run 32074383640 built plan/demo6/v1 (frozen 2026-07-10) under a
  # three-gate preflight, because B3/B4/B5/B6/B8 did not exist in that tag's copy of
  # the gate code. B5 is the alarming one — the whole US6 high-stakes block was inert.
  #
  # Ordering, not a second path: the preflight reads the plan through the API
  # (tryReadPlanAtRef), never the worktree, so it needs no checkout of its own. Running
  # it before the frozen checkout keeps it step 1 of the job AND leaves the agent the
  # clean frozen worktree it expects — no vendored gates directory sitting in the tree
  # for the agent to trip over.
  # THE DISPATCH REF IS CHECKED FIRST, in two seconds, before anything installs
  # (operator finding, 2026-08-23).
  #
  # Preflight B8 already refuses a build dispatched on anything but the frozen tag,
  # and it stays the authority. What it cannot be is FAST: it runs after two
  # checkouts and an npm ci, so the answer to "you picked the wrong entry in a
  # dropdown" arrived forty seconds and a page of log later. This asks the same
  # question in the cheapest place there is.
  #
  # SHAPE ONLY, deliberately: is this a tag at all? WHICH tag is B8's business,
  # because that comparison needs the dispatch input and the plan document — so the
  # two cannot disagree. Anything this step passes, B8 still judges.
  #
  # The message names the trap that produced it. The plan BRANCH and the frozen TAG
  # carry the same name (`plan/<slug>/v<N>`), so GitHub's picker lists both and
  # branches come first: picking the obvious entry is wrong. Live evidence — run
  # 32658276993 was dispatched on refs/heads/plan/demo7/v1 by an operator who had
  # just been told, correctly, to select plan/demo7/v1.
  - name: refuse a dispatch that is not on a tag (FR-007, before anything installs)
    env:
      DISPATCH_REF: ${{ github.ref }}
    run: |
      case "$DISPATCH_REF" in
        refs/tags/*) ;;
        *)
          echo "::error::This build was dispatched on '$DISPATCH_REF', which is not a tag. A build may run ONLY from the frozen plan TAG (FR-007) — dispatched elsewhere the agent checks out code the operator never approved, the results cannot be bound to the build, and a cancel of the workload would not find the run. WATCH FOR THIS: the plan branch and the frozen tag have the SAME NAME, so the name alone is ambiguous. IN THE UI: re-run, open the 'Use workflow from' dropdown, switch to the Tags tab, and pick the tag — the picker lists branches first, so the obvious entry is the wrong one. ON THE CLI: pass the ref fully qualified, 'gh workflow run build-template.lock.yml --ref refs/tags/<plan-ref>' — a bare '--ref <plan-ref>' resolves the ambiguous name to the BRANCH silently, with nothing to tell you a choice was made."
          exit 1
          ;;
      esac
  # CAN THIS KEY PAY FOR THE RUN? Asked in one second, before any container pull
  # (operator ask, 2026-08-23, after run 32658500322 died at "Credit balance is too
  # low" — at the Claude CLI step, having already spent two checkouts, an npm ci, a
  # CLI install and a container pull).
  #
  # There is NO balance endpoint to check against a threshold: the Anthropic API
  # exposes no remaining-credit figure, and the Admin API's cost reports need an
  # admin-scoped key and report SPEND, not balance. So this asks the only question
  # that is actually answerable — can the key buy one token right now — with the
  # cheapest possible request (1 max_token, cheapest model). Fractions of a cent.
  #
  # FAILS ONLY ON WHAT IT CAME FOR: an exhausted balance or a rejected key. Anything
  # else — an unavailable model, a network blip, a 5xx — passes with a note, because
  # a pre-check that invents new ways for a build to die is worse than no pre-check.
  # gh-aw's own daily AIC guardrail is a different thing (a spend CAP per day, in the
  # activation job) and does not detect this.
  - name: refuse a run the API key cannot pay for (before any container pull)
    env:
      PROBE_KEY: ${{ secrets.ANTHROPIC_API_KEY }}
    run: |
      set -uo pipefail
      if [ -z "$PROBE_KEY" ]; then
        echo "::error::ANTHROPIC_API_KEY is not set on this repository, so no agent step can run. Add it under Settings → Secrets and variables → Actions."
        exit 1
      fi
      status="$(curl -sS -o /tmp/credit-probe.json -w '%{http_code}' \
        --max-time 20 https://api.anthropic.com/v1/messages \
        -H "x-api-key: $PROBE_KEY" \
        -H 'anthropic-version: 2023-06-01' \
        -H 'content-type: application/json' \
        -d '{"model":"claude-haiku-4-5-20251001","max_tokens":1,"messages":[{"role":"user","content":"."}]}' || echo 000)"
      body="$(head -c 600 /tmp/credit-probe.json 2>/dev/null || true)"
      case "$status" in
        200)
          echo "API key answers — the run can pay for itself." ;;
        400|402|429)
          if printf '%s' "$body" | grep -qi 'credit balance'; then
            echo "::error::The Anthropic API refuses this key: credit balance is too low. Every agent step would fail after several minutes of setup, so this run stops here. Top up the account (or switch the ANTHROPIC_API_KEY secret to a funded one) and re-dispatch — nothing has been built and no results were written."
            exit 1
          fi
          echo "::warning::API probe returned $status without a credit-balance error; continuing. Body: $body" ;;
        401|403)
          echo "::error::The Anthropic API rejected this key ($status). Every agent step would fail, so this run stops here. Check the ANTHROPIC_API_KEY secret."
          exit 1 ;;
        *)
          echo "::warning::API probe was inconclusive (status $status) — continuing, because a pre-check must not become a new way for a build to fail." ;;
      esac
  # gates_ref is caller-supplied and this job EXECUTES code from it, so it is
  # checked BEFORE anything runs — the preflight cannot police it, because by
  # then the ref's own gate code is the thing doing the checking (PR #111 review).
  #
  # The value that must never be accepted is a frozen plan tag. It is the exact
  # bypass this change exists to close, it is sitting in the adjacent input box
  # ready to be pasted twice, and it fails SILENTLY: an old tag's build-preflight
  # has never heard of --gates-ref, its arg parser ignores unknown arguments, and
  # the run would report whatever three gates that copy happens to contain. No
  # other ref can be judged from here — anyone able to dispatch this workflow can
  # also push gate code to a branch — so this refuses the one ref that is
  # guaranteed stale rather than pretending to validate trust.
  - name: refuse a gates ref that would re-freeze the gate set (GHI 107)
    env:
      GATES_REF: ${{ inputs.gates_ref }}
    run: |
      if printf '%s' "$GATES_REF" | grep -Eq '(^|/)plan/[a-z0-9][a-z0-9-]*/v[0-9]+$'; then
        echo "::error::gates_ref '$GATES_REF' is a frozen plan tag. The preflight must never run from a frozen ref — every gate added since that plan was approved would be silently absent, which is the defect this input exists alongside, not one it may recreate. Leave gates_ref blank to use the default branch, or name a pinned gates release."
        exit 1
      fi
  - name: current gate code, NOT the frozen copy (GHI 107)
    uses: actions/checkout@v4
    with:
      # A pinned gates release when the dispatch names one, else the default branch.
      # Deliberately never inputs.plan_ref: that is the defect this exists to remove.
      ref: ${{ inputs.gates_ref || github.event.repository.default_branch }}
      persist-credentials: false
  - uses: actions/setup-node@v4
    with:
      node-version: 20
  - run: npm ci
  - name: resolve the gate set (reported, so an absent gate cannot read as a passing one)
    id: gates
    run: |
      echo "ref=${GATES_REF:-${{ github.event.repository.default_branch }}}" >> "$GITHUB_OUTPUT"
      echo "sha=$(git rev-parse HEAD)" >> "$GITHUB_OUTPUT"
    env:
      GATES_REF: ${{ inputs.gates_ref }}
  - name: build-preflight (B1–B8 as applicable — MUST be step 1, fails the run before any agent step)
    run: >-
      npx tsx scripts/gates/build-preflight.ts
      --plan-ref ${{ inputs.plan_ref }}
      --workload ${{ inputs.workload }}
      ${{ inputs.chunk && format('--chunk {0}', inputs.chunk) || '' }}
      ${{ inputs.unattended == 'true' && '--unattended' || '' }}
      --gates-ref ${{ steps.gates.outputs.ref }}
      --gates-sha ${{ steps.gates.outputs.sha }}
      --repo ${{ github.repository }} --json
    env:
      GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
  - uses: actions/checkout@v4
    with:
      # The FROZEN TAG, not the dispatch ref (FR-007). Without this the worktree is
      # whatever `main` is at dispatch time, so the agent verifies its targets against
      # code the operator never approved, while vt-report stamps those conclusions onto
      # the frozen commit — a completion (L3) resting on untested code. build-preflight
      # validates the tag through the API; only this line makes the worktree match it.
      #
      # This runs AFTER the preflight and replaces the gates checkout entirely
      # (actions/checkout cleans the workspace), so what the agent sees below is the
      # frozen commit and nothing else.
      ref: ${{ inputs.plan_ref }}
      persist-credentials: false # never leak the git token into the agent job
  # Reinstalled from the FROZEN lockfile: actions/checkout cleans the workspace, so
  # the gates checkout's node_modules went with it — and the agent must build against
  # the dependencies the approved commit pins, not the gate set's.
  - run: npm ci
---

# build-template — dispatched agent build, gated by preflight

You are the build agent. You build ONLY from the frozen plan at tag `${{ inputs.plan_ref }}`
(checked out read-only) — never from a branch, never from a superseded version (FR-007).

The preflight above has already verified, as applicable to this dispatch: **B1** the tag is the
derived official version (the newest frozen `plan/<slug>/v*` tag), **B2** the plan re-validates
against the schema, **B3** the chunk carries a full testable requirement and exactly one step of
this plan delivers it, **B4** its intent is confirmed (unattended runs only), **B5** every
high-stakes step this build covers has its external confirmation on record, **B6** the chunk
carries no contradicting-evidence flag, **B7** the workload is `workload:active`, and **B8** the
run was dispatched ON the frozen tag. A gate that did not apply to this dispatch says so in the
report by name; none of them is ever silently absent.

**Your executor identity**, for the provenance the deliverable records (FR-065):
`executor_id` = `tracer-hello`, tier `in-sandbox`, engine `claude`. None of that is required by
the system — it describes THIS executor, and any executor satisfying
`contracts/build-executor.md` is a legitimate replacement.

**Build the step the chunk names, and nothing else.** When this run was given a chunk, exactly one
plan step delivers it, and the high-stakes gate was scoped to that step alone (GHI #87) — so work
that strays into another step is work no authority was asked about. If the chunk turns out to need
a change to a different step, emit `missing-data` and stop rather than widening the build.

Those gates ran from the CURRENT gate code, not the copy frozen into this tag, and the report
names the ref and commit they came from (GHI #107). **The gate set is not frozen with the plan;
the plan is.**

## What you produce: the DELIVERABLE

Write the actual work — the operator's own software — into the worktree, then upload it as a
workflow artifact named `deliverable.patch` via the `upload-artifact` safe output. That artifact is
the ONLY channel by which your work reaches the repository: you hold `contents: read` and cannot
commit, push, open a pull request, or move a label. A deterministic workflow (`build-publish`)
validates the artifact and does the writing.

`deliverable.patch` is a JSON document in exactly this shape (`schemas/deliverable.schema.json`):

```json
{
  "plan_ref": "plan/<slug>/v<N>",
  "step_id": "step-<the step this chunk names>",
  "executor_id": "<the EXECUTOR_ID env var>",
  "executor": { "tier": "in-sandbox", "engine": "<ENGINE>", "model": "<MODEL>" },
  "files": [{ "path": "docs/index.html", "content": "<the WHOLE file>" }],
  "deletions": [],
  "summary": "one line for the commit message and PR title"
}
```

- `plan_ref` MUST be `${{ inputs.plan_ref }}` verbatim — the frozen tag you built from. It is
  carried in the artifact because that artifact is the only channel to the deterministic
  follow-up, and the follow-up cannot see the inputs this run was dispatched with.
- `step_id` MUST be the one step the chunk names — the step whose `tracking_issue` is this work
  item. Exactly one step claims it; preflight B3 already proved that.
- `files[].content` is the **WHOLE FILE**, not a diff hunk. Whole files are what let the gates
  answer "which paths does this touch?" as a fact rather than a parse, and it is why there is no
  unified-diff form of this artifact.
- `files[].path` is repo-relative with forward slashes. `../`, absolute paths and drive letters are
  refused outright, never repaired.
- Set `encoding: "base64"` on a file only when it is genuinely binary.
- Include the tests you wrote for the deliverable in `files` too, when the step's scope covers them.

**Stay inside the step's declared `scope`.** Read it from the step in `plans/<slug>/plan.json` at
the frozen tag. Every path you write or delete must match one of those globs. A straying path is
refused with the path named — by `build-publish` before any branch exists, and again by
`deliverable-gate` **D2**. If the step declares no `scope` (a plan frozen before the field
existed), keep to the narrowest set of paths the step's `intent` and `acceptance` actually require.

## What your work must NOT be ABOUT (FR-068)

The subject of your build is **the operator's own software**. It is never the oversight machinery
and never the governance record.

This repository contains both, and that is the trap. Initialization vendored the machinery *here*:
`.github/workflows/**`, `.github/ISSUE_TEMPLATE/**`, the gate toolchain in `scripts/**`,
`schemas/**` and `dashboard/lib/**`, and the manifests `package.json`, `package-lock.json`,
`tsconfig.json`, `tsconfig.base.json`, `dashboard/package.json`, `dashboard/tsconfig.json`. The
governance record lives here too: `plans/**`, `confirmations/**`, `evidence/**`, `runs/**`. **All of
those paths are reserved.** A patch touching any of them is refused with the paths named, by
`build-publish` and again by `deliverable-gate` **D5** — and D5 refuses it even if the step's
declared scope named those paths, because a boundary a plan can widen is not a boundary.

**A broken thing in the machinery is NOT yours to fix, however tempting.** A failing `tsc`, a
deprecated action pin, a broken vendored import, a gate that looks wrong: report it and stay inside
your step. Say so in your `missing-data` output, or note it and move on — but do not edit it. A
build that "fixes its own gate" is an agent editing the controls that judge it, which is the single
thing this whole contract exists to prevent.

**If the work item itself asks for a change to the machinery**, emit `missing-data` and stop. That
change is a pull request against the PRODUCT repository, released and re-installed by
`npm run init` — never an agent build inside a governed repo.

## What you do NOT produce: verification results

**Do not emit `vt-results.json`, and do not attempt to verify your own work.** This changed
deliberately (FR-063): verification runs AFTER your deliverable is merged, against the merged
commit, in the separate `build-verify` workflow, and `vt-report` records the `vt-<id>` check runs
there.

The reason is worth knowing, because it is the most consequential bug this system has had. A build
that reports its own verification is reporting on code the repository does not contain: the work
lives in a throwaway worktree that dies with the runner. Live evidence — run 32658500322 reported
three green targets for `dashboard/lib/current-time.ts`, a file that has never existed at the
commit those check runs were written on, and completion was one click away from certifying it
(GHI #141). Your job is to build. Judging what you built is somebody else's, on code that exists.

If required data is missing, emit the `missing-data` safe output (surfaced to the operator as
Action Required) rather than guessing.
