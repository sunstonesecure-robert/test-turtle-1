# lza-phase0-0 — Landing Zone Accelerator desired-state repository

This repository holds the **desired-state** configuration for deploying the AWS
[Landing Zone Accelerator](https://github.com/awslabs/landing-zone-accelerator-on-aws)
(LZA) on top of AWS Control Tower in an AWS GovCloud (US) partition. Phase 0 is
credential-free: it delivers the configuration, the Control Tower declarations,
the repository schemas, and the offline validation gate that proves the
repository is internally consistent before any AWS resource exists.

## Layout

| Path | What it holds |
|---|---|
| `lza.lock` | The single hand-maintained provenance lock: which upstream LZA release and toolchain this repository is built from. Every script and workflow reads its values at run time (never restates them). |
| `config/` | The six mandatory LZA configuration files (`accounts`, `global`, `iam`, `network`, `organization`, `security`). |
| `control-tower/` | Control Tower desired state: landing-zone manifest template, baselines, controls, control exceptions, and the ownership matrix. |
| `deployment/` | Example inputs and state, plus the repository JSON Schemas under `deployment/schemas/`. |
| `deploy/scripts/` | `common.sh` (the single `lza.lock` reader) and `validate-config-offline.sh` (the offline gate). |
| `tests/` | The Bats suites the offline gate runs. |
| `.github/workflows/` | The Phase 0 workflow `lza-phase0-5-1_validate-offline.yml`. |

## The provenance lock

`lza.lock` is the one place a version, commit, partition, or Region literal may
live. `deploy/scripts/common.sh` reads it once and exports the derived shell
variables; every other script sources `common.sh` rather than restating a
literal. A repository test fails if any committed file other than `lza.lock`
and `deployment/inputs.example.yaml` contains an LZA version, commit, or Yarn
version string. To bump the upstream release, change `lza.lock` — that one
reviewed change flows everywhere.

## Validating locally

The offline gate runs without AWS credentials and performs exact
tag/commit verification, Node/Yarn lock verification, JSON/YAML syntax and
JSON Schema validation, placeholder detection, `actionlint`/`shellcheck`/
`yamllint`/`cfn-lint`/Bats, semantic ownership checks, and deterministic
SHA-256 digest calculation.

```bash
make validate-offline   # run the offline gate
make test               # run the Bats suites under tests/
```

The same script (`deploy/scripts/validate-config-offline.sh`) runs unchanged in
CI via `.github/workflows/lza-phase0-5-1_validate-offline.yml` on pull requests
and on pushes to `main`.

## Review protection

`CODEOWNERS` at the repository root requires owner review for changes to
`lza.lock`, `config/**`, `control-tower/**`, and `deployment/schemas/**`, so the
first change to any pinned value or desired-state declaration is reviewed.

## Scope

Phase 0 delivers configuration and the offline gate only — no AWS resource, no
OIDC, and no later-phase workflows. Live validation and deployment belong to
subsequent phases.

## Misc

Add misc instructions here if needed.
