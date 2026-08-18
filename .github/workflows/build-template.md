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

**Build the step the chunk names, and nothing else.** When this run was given a chunk, exactly one
plan step delivers it, and the high-stakes gate was scoped to that step alone (GHI #87) — so work
that strays into another step is work no authority was asked about. If the chunk turns out to need
a change to a different step, emit `missing-data` and stop rather than widening the build.

Those gates ran from the CURRENT gate code, not the copy frozen into this tag, and the report
names the ref and commit they came from (GHI #107). **The gate set is not frozen with the plan;
the plan is.**

For each verification target in the plan, run its single pass/fail check and upload the results
as a workflow artifact named `vt-results.json` via the `upload-artifact` safe output, in exactly
this shape:

```json
{
  "plan_ref": "plan/<slug>/v<N>",
  "results": [{ "id": "vt-<target-id>", "conclusion": "success" }]
}
```

- `plan_ref` MUST be `${{ inputs.plan_ref }}` verbatim — the frozen tag you built from. It is
  carried in the artifact because the artifact is the only channel to the deterministic
  follow-up: that follow-up is triggered by this run's completion and cannot see the inputs this
  run was dispatched with, so without it there is no way to know which frozen SHA the results
  belong to.
- Every `id` MUST be a verification target the plan at that ref actually defines. Report each
  target at most once.
- `conclusion` MUST be one of GitHub's check-run conclusions: `success`, `failure`, `neutral`,
  `cancelled`, `skipped`, `timed_out`, `action_required`, `stale`.
- No other keys. The results are validated as untrusted input and the whole report is refused —
  nothing is recorded — if any of the above does not hold.

A deterministic follow-up (not you — your job is read-only) turns that artifact into `vt-<id>`
check runs on the frozen tag's SHA: `templates/workflows/vt-report.yml`, triggered on this
workflow's completion, holds the `checks: write` scope your job deliberately does not.
Completion of the workload is later a deterministic query over those check runs (FR-034).
If required data is missing, emit the `missing-data` safe output (surfaced to the operator as
Action Required) rather than guessing.
