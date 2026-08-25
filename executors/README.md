# Executors

**The authority is [`contracts/build-executor.md`](../specs/001-sme-operator-oversight/contracts/build-executor.md), not this directory.**

This holds conformant executor *configurations*. The project ships one and requires
none: any executor runnable by GitHub Agentic Workflows that satisfies the contract is
a legitimate choice, and the deterministic writer (`build-publish`) and the gates
(`deliverable-gate` D1–D5) must not be able to tell which one produced a patch
(FR-059, SC-019).

`tracer-hello.yml` is an **example**. It is not a requirement, not a default anyone
has to keep, and not a dependency — the reference implementation lives in
`templates/workflows/build-template.md`, and this file only records the identity and
tier it reports.

## The shape

```
UNTRUSTED EXECUTOR (contents: read)     ARTIFACT             DETERMINISTIC WRITER (explicit scope)
───────────────────────────────────     ─────────────────    ────────────────────────────────────
build executor                     →    deliverable.patch →  build-publish.yml (contents + PR write)
```

An executor is swappable **by construction**, because the seam is a validated artifact
rather than an in-process call: nothing downstream can observe which harness produced
it.

## To add one

1. Satisfy the contract's inputs and outputs. The only output that reaches the
   repository is `deliverable.patch`, whose envelope is
   [`schemas/deliverable.schema.json`](../schemas/deliverable.schema.json).
2. Declare the config here, validated by
   [`schemas/executor.schema.json`](../schemas/executor.schema.json).
3. Hold **none** of the withheld capabilities: no repository write scope, no
   `checks: write`, no credentials in the agent shell, no unconstrained egress, no
   dispatch off the frozen tag.
4. For `tier: spawned`, declare a `guardrailed_runner` with non-empty binary and path
   allowlists. This is enforced at config load, not documented and hoped for (FR-066):
   an operator-supplied image carries none of the compiled tier's structural
   containment, and the gates cannot inspect inside it.

## What an executor may never build

The operator's own software — yes. The oversight machinery and the governance record
— never, whatever a plan's declared scope says. Those paths are reserved and refused
by `build-publish` before a branch exists and again by `deliverable-gate` **D5**
(FR-068). A change to the machinery is a pull request against the **product**
repository, released and re-installed by `npm run init`.
