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
permissions:
  contents: read
  issues: read
  checks: read # agent job is read-only (gh-aw strict mode); vt-<id> check runs are
  #   emitted by the deterministic vt-report step from the uploaded results artifact
engine: claude
timeout-minutes: 30
# cost ceiling: $10 per run (constitution: Cost & Observability; enforced via timeout-minutes + engine limits)
environment: agent-build # platform-level backstop behind the preflight
safe-outputs:
  create-issue:
    title-prefix: "missing-data: "
  upload-artifact:
network: defaults
steps:
  - uses: actions/checkout@v4
    with:
      persist-credentials: false # never leak the git token into the agent job
  - uses: actions/setup-node@v4
    with:
      node-version: 20
  - run: npm ci
  - name: build-preflight (B1/B2/B7 — MUST be step 1, fails the run before any agent step)
    run: >-
      npx tsx scripts/gates/build-preflight.ts
      --plan-ref ${{ inputs.plan_ref }}
      --workload ${{ inputs.workload }}
      --repo ${{ github.repository }} --json
    env:
      GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
---

# build-template — dispatched agent build, gated by preflight

You are the build agent. You build ONLY from the frozen plan at tag `${{ inputs.plan_ref }}`
(checked out read-only) — never from a branch, never from a superseded version (FR-007). The
preflight above has already verified: B1 the tag exists and equals `plans/<slug>/CURRENT`,
B2 the plan re-validates against the schema, B7 the workload is `workload:active` (B3–B6 join
with US4/US5/US6).

For each verification target in the plan, run its single pass/fail check and upload the results
as a workflow artifact (`vt-results.json`: `[{ id, conclusion }]`) via the `upload-artifact`
safe output. A deterministic follow-up (not you — your job is read-only) turns that artifact
into `vt-<id>` check runs on the frozen tag's SHA — completion of the workload is later a
deterministic query over these (FR-034). If required data is missing, emit the `missing-data`
safe output (surfaced to the operator as Action Required) rather than guessing.
