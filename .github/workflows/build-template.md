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
  - uses: actions/checkout@v4
    with:
      # The FROZEN TAG, not the dispatch ref (FR-007). Without this the worktree is
      # whatever `main` is at dispatch time, so the agent verifies its targets against
      # code the operator never approved, while vt-report stamps those conclusions onto
      # the frozen commit — a completion (L3) resting on untested code. build-preflight
      # validates the tag through the API; only this line makes the worktree match it.
      ref: ${{ inputs.plan_ref }}
      persist-credentials: false # never leak the git token into the agent job
  - uses: actions/setup-node@v4
    with:
      node-version: 20
  - run: npm ci
  - name: build-preflight (B1–B8 as applicable — MUST be step 1, fails the run before any agent step)
    run: >-
      npx tsx scripts/gates/build-preflight.ts
      --plan-ref ${{ inputs.plan_ref }}
      --workload ${{ inputs.workload }}
      ${{ inputs.chunk && format('--chunk {0}', inputs.chunk) || '' }}
      ${{ inputs.unattended == 'true' && '--unattended' || '' }}
      --repo ${{ github.repository }} --json
    env:
      GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
---

# build-template — dispatched agent build, gated by preflight

You are the build agent. You build ONLY from the frozen plan at tag `${{ inputs.plan_ref }}`
(checked out read-only) — never from a branch, never from a superseded version (FR-007). The
preflight above has already verified: B1 the tag exists and is the derived official version
(the newest frozen `plan/<slug>/v*` tag),
B2 the plan re-validates against the schema, B7 the workload is `workload:active` (B3–B6 join
with US4/US5/US6).

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
