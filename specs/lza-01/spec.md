# Agent Execution Specification: AWS GovCloud Foundation with AWS Control Tower and Landing Zone Accelerator — GitHub Actions and S3 Only

**Document purpose:** Input for a planning/coding LLM agent that will build a GitHub repository and automate a production-oriented, minimal-account AWS GovCloud (US) foundation. AWS Control Tower is the governance layer. Landing Zone Accelerator on AWS (LZA) is the security, platform, and configuration-extension layer.

**Supersedes:** `lza-govcloud-github-actions-agent-plan-s3-only.md`

**Target LZA release:** `v1.16.1`

**Pinned LZA upstream commit:** `8b43dc6e347b5fc1c477940c7f71ea595fbf19ab`

**Pinned AWS Control Tower landing-zone version:** `4.0`

**AWS partitions:** commercial `aws`; GovCloud `aws-us-gov`

**Commercial control Region:** `us-east-1`

**GovCloud home/global Region:** `us-gov-west-1`

**Multi-account governance model:** AWS Organizations + AWS Control Tower + LZA

**Minimum GovCloud accounts:** `Management`, `LogArchive`, and `Audit`

**Initial GovCloud OUs:** `Security` and `Infrastructure`; `Infrastructure` is intentionally empty until workload accounts are added later.

**Normal operator entry point after one-time OIDC bootstrap:** the delivered form of `09-deploy-platform.yml` — see Section 1.1 for the required filename prefix

**AWS-side source/configuration storage:** Amazon S3 only; no CodeCommit and no CodeConnections

**Human AWS console configuration:** prohibited except the documented first GovCloud account-pair signup boundary in Section 4.

---

## 1. Instruction priority and non-negotiable rules

Treat every numbered statement in this document as an implementation requirement. Interpret `MUST`, `MUST NOT`, `SHOULD`, and `MAY` as normative terms.

- **REQ-001:** The agent MUST produce executable repository content, not merely prose or console instructions.
- **REQ-002:** The agent MUST prefer AWS CLI, AWS API/SDK, CloudFormation, CDK, shell, and GitHub API calls over AWS console actions.
- **REQ-003:** The agent MUST NOT tell an operator to create, edit, approve, inspect, or delete an AWS resource in an AWS console unless the operation is explicitly identified in Section 4 as an unavoidable automation boundary.
- **REQ-004:** The agent MUST make every AWS create/update operation idempotent by reading current state before issuing a mutation.
- **REQ-005:** The agent MUST make every verification test executable by a non-interactive agent using CLI or API output and a nonzero exit code on failure.
- **REQ-006:** The agent MUST pin LZA to tag `v1.16.1` and commit `8b43dc6e347b5fc1c477940c7f71ea595fbf19ab` and fail if the tag resolves elsewhere.
- **REQ-007:** The agent MUST pin AWS Control Tower landing-zone version `4.0`; it MUST NOT silently adopt a later version merely because one is available.
- **REQ-008:** The agent MUST pin every third-party GitHub Action to a full 40-character commit SHA. Version tags alone are insufficient.
- **REQ-009:** The agent MUST NOT create or store a GitHub personal access token in AWS Secrets Manager for LZA source retrieval.
- **REQ-010:** The agent MUST NOT require AWS CodeConnections/CodeStar Connections to GitHub.
- **REQ-011:** The agent MUST place a versioned ZIP of the pinned LZA source in a KMS-encrypted S3 bucket in the GovCloud management account and `us-gov-west-1`, then configure the LZA installer to use that S3 source.
- **REQ-012:** The agent MUST keep the authoritative desired LZA configuration in GitHub, package the rendered six-file configuration as `aws-accelerator-config.zip`, and publish it to the LZA-managed S3 configuration object `zipped/aws-accelerator-config.zip`.
- **REQ-013:** The agent MUST NOT create or use CodeCommit for LZA source code, LZA configuration, Control Tower configuration, or any deployment mirror.
- **REQ-014:** The agent MUST deploy AWS Control Tower as the foundational GovCloud governance layer before deploying LZA.
- **REQ-015:** The agent MUST deploy LZA with installer parameter `ControlTowerEnabled=Yes` and LZA `global-config.yaml` semantics equivalent to `controlTower.enable: true`.
- **REQ-016:** The agent MUST use AWS Control Tower landing-zone APIs, baseline APIs, control APIs, Control Catalog APIs, and Organizations APIs rather than Control Tower console workflows.
- **REQ-017:** The agent MUST enable Control Tower centralized logging, AWS Config integration, and security roles using the existing `LogArchive` and `Audit` GovCloud accounts.
- **REQ-018:** The agent MUST enable account auto-enrollment by supplying `INHERITANCE_DRIFT` remediation in the landing-zone create/update request.
- **REQ-019:** The agent MUST create and register an empty `Infrastructure` OU with `AWSControlTowerBaseline` so future account moves can inherit governance through API-driven auto-enrollment.
- **REQ-020:** The agent MUST NOT use Control Tower Account Factory to create GovCloud accounts because GovCloud account creation is performed from the commercial partition with `CreateGovCloudAccount`.
- **REQ-021:** The agent MUST NOT create workload, shared-services, networking, or perimeter accounts in the initial implementation.
- **REQ-022:** The agent MUST NOT create application VPCs, Transit Gateways, Network Firewall resources, or workload resources in the initial LZA configuration.
- **REQ-023:** The agent MUST preserve the baseline logging and governance resources required by Control Tower and LZA; “minimal” means minimal accounts and workloads, not removal of foundational security controls.
- **REQ-024:** The agent MUST render and validate the Control Tower manifest, baseline/control declarations, ownership matrix, and all six mandatory LZA YAML files before mutating the production environment.
- **REQ-025:** The agent MUST prevent duplicate ownership of organization CloudTrail, AWS Config recorders/delivery channels/aggregators, Control Tower-managed SCPs, or Control Tower service roles.
- **REQ-026:** Control Tower MUST own its organization trail, Config integration, shared-account security roles, mandatory controls, baseline resources, and Control Tower StackSets.
- **REQ-027:** LZA MUST disable its organization-level CloudTrail deployment in this Control Tower environment and MUST NOT replace or mutate Control Tower-managed Config recorders, aggregators, controls, roles, or policies.
- **REQ-028:** The agent MUST never put an AWS access key, secret key, session token, GitHub OIDC JWT, password, root credential, or customer data in Git, a GitHub artifact, GitHub output, CloudFormation output, or unredacted log.
- **REQ-029:** The agent MUST produce a machine-readable deployment evidence file and validate it against a repository-owned JSON Schema before declaring success.
- **REQ-030:** The agent MUST stop rather than improvise when the discovered partition, account IDs, organization ownership, Control Tower landing zone, OUs, LZA source commit, GitHub OIDC subject, KMS key, source artifacts, or generated parameters do not match the expected state.
- **REQ-031:** The agent MUST NOT automatically delete an AWS account, leave an organization, close an account, disable termination protection, decommission Control Tower, or tear down LZA.
- **REQ-032:** Every Bash entry point MUST use `set -Eeuo pipefail`, `IFS=$'\n\t'`, and `AWS_PAGER=''`.
- **REQ-033:** All commercial Organizations operations MUST explicitly use `us-east-1`; all GovCloud global/control-plane operations MUST explicitly use `us-gov-west-1`.
- **REQ-034:** The agent MUST treat Control Tower metadata, AWS account names/emails, OU names, tags, GitHub logs, and artifacts as administrative metadata only and MUST NOT place export-controlled or workload content in them.
- **REQ-035:** The agent MUST treat a successful API request as an operation start, not completion. It MUST poll the exact returned operation identifier to a successful terminal state.
- **REQ-036:** Before the first `CreateLandingZone` call, the agent MUST create or verify all four AWS Control Tower API prerequisite service roles in the management account at IAM path `/service-role/`: `AWSControlTowerAdmin`, `AWSControlTowerCloudTrailRole`, `AWSControlTowerStackSetRole`, and `AWSControlTowerConfigAggregatorRoleForOrganizations`.
- **REQ-037:** Phase 3 is the only intended workflow phase that may create, update, or reset the Control Tower landing zone. Phase 4 MUST render the Control Tower state implied by `global-config.yaml` and prove it is semantically identical to the live Phase 3 landing zone before starting LZA.
- **REQ-038:** The LZA configuration MUST explicitly set `controlTower.landingZone.accountAutoEnrollment: true`; relying on an omitted/default value is prohibited because pinned LZA `v1.16.1` compares this property and can call `UpdateLandingZone` when it differs.
- **REQ-039:** Phase 4 MUST snapshot `ListLandingZoneOperations` before and after the LZA installer/core executions and fail if a new `CREATE`, `UPDATE`, or `RESET` landing-zone operation was initiated during the Phase 4 interval.

### 1.1 Governed-repository path constraints

*(Added 2026-09-01.)* This repository is governed by an agent-oversight system that vendors its own
toolchain into the target and treats those paths as **reserved**: an agent may not write the gates,
the workflows that judge it, or the governance record. Three directories this document originally
used are reserved, so the layout below is normative and replaces them. The constraint is not a
preference — a plan whose step scope names a reserved path is refused at approval, and a patch that
touches one is refused at delivery, whatever the plan declared.

- **REQ-040:** Shell entry points MUST live under `deploy/scripts/`, never `scripts/` (reserved: the
  vendored gate toolchain). Wherever this document writes `deploy/scripts/<name>.sh`, that is the
  literal path.
- **REQ-041:** Repository JSON Schemas MUST live under `deployment/schemas/`, never `schemas/`
  (reserved: the vendored schemas).
- **REQ-042:** The agent MUST NOT create composite actions under `.github/actions/`. That path is
  reserved, and a workflow referencing a local action (`uses: ./…`) is refused by the workflow
  content guards regardless. Setup logic MUST be inlined into each workflow or invoked as a script
  under `deploy/scripts/`.
- **REQ-043:** Every workflow this document names as `NN-name.yml` MUST be delivered as
  **`<workload-slug>_NN-name.yml`** inside `.github/workflows/`, where `<workload-slug>` is the slug
  of the oversight workload that delivers the file (kebab-case: `[a-z0-9][a-z0-9-]*`). That prefix is
  the only namespace an agent may write a workflow into; every other `.github/**` path is reserved.
  A phase delivered by workload `lza-phase1` therefore ships
  `.github/workflows/lza-phase1_04-phase1-vend-govcloud-accounts.yml`.
- **REQ-044:** The agent MUST NOT create or modify a root `package.json`, `package-lock.json`,
  `tsconfig.json`, or `tsconfig.base.json` (reserved toolchain manifests). Node and Yarn work happens
  inside the vendored `vendor/lza` checkout, which is unaffected.
- **REQ-045:** Any workflow job that mints a cloud credential (`id-token: write`) MUST name the
  `subject-deploy` GitHub Environment and run on a GitHub-hosted runner. That environment carries
  required reviewers, so **each phase pauses for a human approval before it touches an account**.
  This satisfies rather than violates REQ-003: the approval is a GitHub deployment gate, not an AWS
  console action, and no AWS resource is created, edited, or inspected through a console.
- **REQ-046:** Delivered workflow permissions MUST be drawn only from `contents: read`,
  `id-token: write`, `actions: read`, `packages: read`, and `deployments: write`. A workflow that
  needs a repository write scope is outside what an agent may deliver here and MUST be reported
  rather than attempted.
- **REQ-047:** `config/`, `control-tower/`, `deployment/`, `deploy/`, `infra/`, `policies/`,
  `tests/`, `build/`, `vendor/`, `lza.lock`, and `Makefile` are unreserved and unchanged by these
  constraints.

Two rules this oversight system already enforces coincide with rules stated above, and the agent
satisfies both at once: every third-party action pinned to a full 40-character commit SHA
(**REQ-008**), and every verification test executable with a nonzero exit status on failure
(**REQ-005**).

### 1.2 Phase 0 — the credential-free tracer

*(Added 2026-09-02.)* The offline repository validation gate of Section 7.1 is the one deliverable
in this document that the specification itself defines as runnable with no AWS credential. It is
therefore delivered **first, as its own phase — Phase 0 — and its own oversight workload**, before
any phase that touches an account. Phase 0 exercises the governed pipeline end to end (plan, review,
build, delivery, verification, completion, dispatch) with nothing to provision and nothing that can
mutate an account. Section 2.1 places it in the operating model; Section 26 states its gate.

- **REQ-048:** Phase 0 MUST be deliverable and runnable with no AWS credential, no OIDC role, no
  GitHub Environment and no deployment approval. Its workflow MUST request `contents: read` only,
  MUST NOT request `id-token: write`, and MUST NOT name the `subject-deploy` environment.
- **REQ-049:** Phase 0 delivers the offline gate as its own workflow,
  **`<workload-slug>_validate-offline.yml`** — for the tracer workload `lza-phase0`, the file is
  `.github/workflows/lza-phase0_validate-offline.yml`. It runs on `pull_request` and on `push` to
  `main` (with a `paths:` filter over the content it validates) and by `workflow_dispatch` with the
  inputs `plan_ref` and `commit`; it checks out the exact event SHA, checks out and verifies the
  pinned LZA source into `vendor/lza`, runs `deploy/scripts/validate-config-offline.sh`, and uploads
  the validation evidence and digests. Every check it runs is one of the eight in Section 7.1, each
  expressed as a command with a nonzero exit on failure (REQ-005) so that it can stand as a
  verification target.
- **REQ-050:** Phase 0 MUST NOT create, read or mutate any AWS resource; MUST NOT deliver the
  Phase 1–4 workflows, `infra/`, or `policies/` content; and MUST NOT run or report the exact live
  LZA validator (Section 7.1's last paragraph). The live-validation step of `01-pr-validate.yml`
  (Section 21.2, step 5) is NOT part of Phase 0: `01-pr-validate.yml` is delivered with Phase 1 and
  MUST invoke the same `deploy/scripts/validate-config-offline.sh` rather than duplicate its checks.
  Anything that needs a credential belongs to a later phase and a later workload.

---

## 2. Target architecture and four-phase operating model

### 2.1 Four phases

The deployment MUST be implemented as a credential-free Phase 0 followed by these four ordered
AWS phases:

0. **Phase 0 — Offline repository validation.** Deliver the repository content that every later
   phase validates — `lza.lock`, the six mandatory LZA files, the Control Tower declarations, the
   repository schemas, `deploy/scripts/validate-config-offline.sh` with its Bats tests — and the
   workflow `<workload-slug>_validate-offline.yml` that runs the Section 7.1 gate with no AWS
   credential present (Section 1.2, REQ-048…REQ-050). Nothing in this phase touches an account.
1. **Phase 1 — Commercial bootstrap and GovCloud account-pair vending.** Establish the commercial Organization and commercial GitHub OIDC role, complete the sole first-pair signup boundary when required, discover the paired GovCloud management account, and create the `LogArchive` and `Audit` commercial/GovCloud account pairs by API.
2. **Phase 2 — GovCloud Organization and bootstrap access.** Establish GovCloud GitHub OIDC roles, create the GovCloud Organization, create `Security` and `Infrastructure` OUs, invite and accept the two standalone GovCloud member accounts, and place both shared accounts in `Security`.
3. **Phase 3 — AWS Control Tower governance.** Create/verify the four Control Tower API prerequisite service roles, create the Control Tower KMS key, render and deploy landing-zone version `4.0` through APIs, enable centralized logging/Config/security roles, enable auto-enrollment, register `Infrastructure` with `AWSControlTowerBaseline` version `5.0`, enable repository-declared supported controls, and verify drift and backing artifacts.
4. **Phase 4 — Landing Zone Accelerator.** Validate the six LZA files in the live organization context, prove the pinned LZA Control Tower projection is a no-op against the live Phase 3 landing zone, snapshot landing-zone operations, publish pinned LZA source and desired configuration to S3, synthesize/deploy the installer with `ControlTowerEnabled=Yes`, run exact installer/core pipeline executions, and verify both that Control Tower remains healthy/in sync and that LZA initiated no landing-zone mutation.

The phases are resumable. A phase MUST read evidence and live AWS state from prior phases and MUST never recreate a successful resource merely because a GitHub run was restarted.

### 2.2 Account and OU layout

The initial GovCloud organization MUST converge to:

```text
Root
├── Management
├── Security                         [Control Tower shared-account OU]
│   ├── LogArchive
│   └── Audit
└── Infrastructure                   [registered, initially empty]
```

- **ARC-001:** `Management` remains directly under Root.
- **ARC-002:** `Security` and `Infrastructure` MUST be direct children of Root.
- **ARC-003:** `LogArchive` and `Audit` MUST be in the same `Security` OU because Control Tower landing-zone version 4.0 requires service integration accounts to be in the same OU directly beneath Root.
- **ARC-004:** `Infrastructure` MUST be registered with `AWSControlTowerBaseline`, even while empty, to provide an API-governed destination for later accounts.
- **ARC-005:** No workload account is required to prove the foundational deployment.

### 2.3 Control Tower and LZA responsibilities

| Domain | Authoritative owner | Required behavior |
|---|---|---|
| Commercial/GovCloud account-pair creation | Phase 1 GitHub automation | Use commercial `CreateGovCloudAccount`; do not use Account Factory |
| GovCloud Organization, invitations, and OU placement | Phase 2 GitHub automation | Use Organizations and STS APIs |
| Landing-zone resource and manifest | Control Tower service; Phase 3 is the authoritative mutation/reconciliation path | Version `4.0`; `ACTIVE`; `IN_SYNC`; Phase 4 LZA projection must be an exact no-op |
| Control Tower API prerequisite service roles | Phase 3 GitHub automation | Create/verify the four documented `/service-role/` roles before `CreateLandingZone`; LZA must not replace them after the landing zone exists |
| Shared Log Archive integration and organization trail | Control Tower | LZA organization trail disabled |
| AWS Config recording and aggregator integration | Control Tower | LZA must not replace CT Config resources |
| Control Tower baselines, mandatory controls, CT-managed SCPs and hooks | Control Tower | Enable/reset through CT APIs; never edit backing artifacts directly |
| Elective Control Tower controls declared in `control-tower/controls.yaml` | Phase 3 workflow using Control Tower APIs | Resolve aliases/ARNs dynamically; verify GovCloud support and backing artifacts |
| LZA source and configuration transport | GitHub Actions + S3 | GitHub is authoritative; S3 is the AWS delivery mechanism |
| LZA pipelines and cross-account CDK deployment | LZA | GitHub starts/monitors exact executions; does not replace LZA orchestration |
| Additional security services, IAM configuration, future networking, custom policies | LZA | Add only after ownership-conflict tests pass |
| Deployment evidence | GitHub Actions | Record operation IDs, ARNs, hashes, versions, drift, and exact pipeline executions |

### 2.4 Why Control Tower is included

Control Tower adds a managed governance lifecycle that Organizations-only LZA does not expose as directly: landing-zone state, account/OU baselines, enrollment status, mandatory controls, control enablement operations, drift detection, baseline reset, control reset, and auto-enrollment when accounts move into governed OUs. AWS recommends using Control Tower as the foundational landing zone and LZA to extend it for regulated environments.

Control Tower does not replace LZA. LZA continues to provide the broader multi-service configuration and deployment framework. The plan therefore uses Control Tower for governance and LZA for platform extension, with an explicit ownership matrix to prevent duplicate organization trails, Config resources, and policies.

Official references:

- <https://docs.aws.amazon.com/solutions/latest/landing-zone-accelerator-on-aws/solution-overview.html>
- <https://docs.aws.amazon.com/controltower/latest/userguide/types-of-baselines.html>
- <https://docs.aws.amazon.com/controltower/latest/userguide/drift.html>
- <https://docs.aws.amazon.com/controltower/latest/userguide/configure-auto-enroll.html>

### 2.5 GovCloud limitations that shape the plan

- Control Tower cannot create accounts in GovCloud. Account pairs are created from commercial `us-east-1`, then GovCloud accounts are invited into the GovCloud Organization.
- Existing `Audit` and `LogArchive` accounts must be present in the GovCloud Organization before landing-zone creation.
- The Account Factory create-account function is unavailable in GovCloud; the plan does not depend on it.
- Some controls or underlying implementations are not available in all GovCloud contexts. Every elective control is checked with the Control Catalog and its actual backing artifact before success is declared.
- Control Tower metadata must not contain export-controlled content.

Official reference: <https://docs.aws.amazon.com/govcloud-us/latest/UserGuide/govcloud-controltower.html>

### 2.6 Why S3 remains the only AWS-side source mechanism

GitHub remains the source of truth. A versioned KMS-encrypted S3 object delivers the pinned LZA source to the installer, and the LZA-managed versioned S3 configuration object delivers the six configuration files to the core pipeline. CodeCommit and CodeConnections are unnecessary and prohibited for this design.

Official references:

- <https://docs.aws.amazon.com/solutions/latest/landing-zone-accelerator-on-aws/source-code-location.html>
- <https://docs.aws.amazon.com/solutions/latest/landing-zone-accelerator-on-aws/step-3.-update-the-configuration-files.html>

---

## 3. Required external inputs

The implementation MUST define these values in `deployment/inputs.example.yaml`. Real values are supplied through repository/environment variables or a protected, non-secret GitHub Environment configuration. Do not commit secrets.

```yaml
schemaVersion: 2
github:
  owner: REPLACE_ME
  repository: REPLACE_ME
  defaultBranch: main
  validationEnvironment: govcloud-validation
  deploymentEnvironment: govcloud-prod
aws:
  commercialManagementAccountId: "000000000000"
  commercialRegion: us-east-1
  govCloudManagementAccountId: "" # discovered after first pairing
  govCloudHomeRegion: us-gov-west-1
  organizationAccessRoleName: OrganizationAccountAccessRole
accounts:
  management:
    name: Management
    email: management+govcloud@example.com
  logArchive:
    name: LogArchive
    email: logarchive+govcloud@example.com
  audit:
    name: Audit
    email: audit+govcloud@example.com
organization:
  securityOuName: Security
  infrastructureOuName: Infrastructure
controlTower:
  landingZoneVersion: "4.0"
  governedRegions:
    - us-gov-west-1
  remediationTypes:
    - INHERITANCE_DRIFT
  accountAutoEnrollment: true
  accessManagementEnabled: false
  backupEnabled: false
  centralizedLoggingEnabled: true
  configEnabled: true
  securityRolesEnabled: true
  accessLogRetentionDays: 365
  loggingRetentionDays: 365
  kmsAlias: alias/govcloud-control-tower
  infrastructureBaselineVersion: "5.0"
  manageLandingZoneRegionDeny: false
lza:
  version: v1.16.1
  commit: 8b43dc6e347b5fc1c477940c7f71ea595fbf19ab
  acceleratorPrefix: AWSAccelerator
  controlTowerEnabled: true
  configurationLocation: s3
  configurationObjectKey: zipped/aws-accelerator-config.zip
  sourceBucketPrefix: organization-lza-source
  sourceObjectPrefix: release
```

- **IN-001:** The three account email addresses MUST be distinct and valid AWS account email addresses.
- **IN-002:** The `Management` email MUST correspond to the existing commercial/GovCloud management pair.
- **IN-003:** `LogArchive` and `Audit` emails MUST not be associated with unrelated accounts.
- **IN-004:** Account IDs MUST be exactly 12 decimal digits.
- **IN-005:** The GovCloud management account ID MUST be discovered with `GetGovCloudAccountInformation`, not copied from a console.
- **IN-006:** Organization IDs, root IDs, OU IDs, landing-zone ARN, Control Tower operation IDs, baseline/control ARNs, KMS ARN, pipeline names, stack IDs, bucket names, object version IDs, checksums, and OIDC subject claims MUST be discovered by APIs.
- **IN-007:** `governedRegions` MUST contain `us-gov-west-1`. Additional GovCloud Regions require an explicit reviewed input change and the identical region set in LZA `enabledRegions`.
- **IN-008:** `manageLandingZoneRegionDeny` MUST remain `false` in this fully automated baseline. The workflow MAY enable OU control `CT.MULTISERVICE.PV.1` through APIs instead.
- **IN-009:** Retention values MUST be integers of at least one day and MUST be approved as cost/compliance decisions rather than silently inherited from examples.
- **IN-010:** The agent MUST canonicalize the input YAML to JSON, calculate SHA-256, and record it in every phase evidence object.
- **IN-011:** `accountAutoEnrollment` MUST be `true` and `remediationTypes` MUST contain exactly `INHERITANCE_DRIFT` for the initial target; the renderer MUST reject inconsistent values before Phase 3 or Phase 4.

---

## 4. The only AWS portal exception and its documented basis

### 4.1 Exception: create the first commercial-to-GovCloud account pair

- **EXC-001:** The only planned AWS configuration action that requires the AWS web portal is the initial AWS GovCloud (US) signup that creates the first paired GovCloud management account.
- **EXC-002:** The agent MUST complete the commercial AWS Organization and commercial GitHub OIDC bootstrap before requesting this signup.
- **EXC-003:** The agent MUST emit a machine-readable blocked state named `BLOCKED_HUMAN_GOVCLOUD_SIGNUP` only when the commercial account does not yet have a paired GovCloud account.
- **EXC-004:** The blocked output MUST contain the following exact human task and no unrelated console work:
  1. Sign in to the existing commercial management account as its root user.
  2. Open the account page.
  3. Choose the AWS GovCloud link under the account's other settings.
  4. Accept the AWS GovCloud legal agreement and submit the eligibility information in the GovCloud signup portal.
  5. Stop after AWS completes the paired account creation; do not create IAM, Organizations, S3, CloudFormation, or LZA resources in a console.
- **EXC-005:** The agent MUST poll `GetGovCloudAccountInformation` until `AccountState` is `ACTIVE` after the signup is submitted.

### 4.2 Why this is a real automation boundary

AWS's current GovCloud signup documentation prescribes root-user navigation to the commercial account page and the AWS GovCloud signup portal for the first standalone pair. The same documentation says that subsequent account pairs can be created with `CreateGovCloudAccount`. The `CreateGovCloudAccount` API contract requires that the caller already have a GovCloud account paired with the commercial organization management account. Therefore, the documented API cannot create the first pair from the user's stated starting condition.

This is a capability-gap conclusion based on the two official contracts; AWS does not provide a separate CLI/API operation documented as “create the first GovCloud pair.”

Official references:

- First-pair portal workflow: <https://docs.aws.amazon.com/govcloud-us/latest/UserGuide/getting-started-sign-up.html>
- `CreateGovCloudAccount` prerequisites: <https://docs.aws.amazon.com/cli/latest/reference/organizations/create-gov-cloud-account.html>
- Verify linked account ID and state: <https://docs.aws.amazon.com/accounts/latest/APIReference/API_GetGovCloudAccountInformation.html>

### 4.3 Authentication is not console configuration

- **EXC-006:** For the initial commercial CLI bootstrap, the preferred authentication ceremony is `aws login --remote --profile commercial-bootstrap --region us-east-1` using AWS CLI v2.32.0 or later.
- **EXC-007:** The operator may have to authenticate in a browser, but the agent MUST perform every resource change through CLI/API calls after authentication.
- **EXC-008:** The agent MUST run `aws logout --profile commercial-bootstrap` after commercial OIDC bootstrap completes.
- **EXC-009:** For the initial GovCloud CLI bootstrap, the agent MUST use the access key and secret key supplied through the GovCloud onboarding process only long enough to create the GovCloud OIDC provider and deployment roles.
- **EXC-010:** After a GitHub workflow successfully assumes the GovCloud role, the agent MUST deactivate and then delete the onboarding access key with IAM API calls. Delete the onboarding IAM user only when another documented break-glass path exists and policy permits deletion.

Official references:

- AWS CLI console-credential login: <https://docs.aws.amazon.com/cli/latest/userguide/cli-configure-sign-in.html>
- GovCloud CLI onboarding credentials: <https://docs.aws.amazon.com/govcloud-us/latest/UserGuide/configure-using-cli.html>

---

## 5. Repository content that the implementation agent must create

The completed repository MUST contain at least this structure:

```text
.
├── .github/
│   └── workflows/                       [only the <workload-slug>_ namespace; REQ-042, REQ-043]
│       ├── <workload-slug>_validate-offline.yml   [Phase 0; REQ-049]
│       ├── <workload-slug>_00-discover-oidc-sub.yml
│       ├── <workload-slug>_01-pr-validate.yml
│       ├── <workload-slug>_02-test-commercial-oidc.yml
│       ├── <workload-slug>_03-test-govcloud-oidc.yml
│       ├── <workload-slug>_04-phase1-vend-govcloud-accounts.yml
│       ├── <workload-slug>_05-phase2-provision-govcloud-organization.yml
│       ├── <workload-slug>_06-phase3-deploy-control-tower.yml
│       ├── <workload-slug>_07-phase4-deploy-lza.yml
│       ├── <workload-slug>_08-verify-platform.yml
│       └── <workload-slug>_09-deploy-platform.yml
├── config/
│   ├── accounts-config.yaml
│   ├── global-config.yaml
│   ├── iam-config.yaml
│   ├── network-config.yaml
│   ├── organization-config.yaml
│   └── security-config.yaml
├── control-tower/
│   ├── landing-zone-manifest.template.json
│   ├── baselines.yaml
│   ├── controls.yaml
│   ├── control-exceptions.yaml
│   └── ownership-matrix.yaml
├── deployment/
│   ├── inputs.example.yaml
│   ├── render-map.example.json
│   ├── phase-state.example.json
│   └── state.example.json
├── infra/
│   ├── bootstrap/
│   │   ├── commercial-oidc-role.yaml
│   │   ├── govcloud-foundation-oidc-role.yaml
│   │   ├── govcloud-validation-oidc-role.yaml
│   │   ├── govcloud-lza-oidc-role.yaml
│   │   ├── govcloud-source-bucket.yaml
│   │   └── lza-cloudformation-execution-role.yaml
│   └── control-tower/
│       ├── control-tower-service-roles.yaml
│       └── control-tower-kms.yaml
├── policies/
│   ├── commercial-account-vending-role-policy.json
│   ├── govcloud-foundation-role-policy.json
│   ├── govcloud-validation-role-policy.json
│   ├── govcloud-lza-role-policy.json
│   └── lza-cloudformation-execution-policy.json
├── deployment/schemas/                  [NOT schemas/ — reserved; REQ-041]
│   ├── deployment-evidence.schema.json
│   ├── deployment-state.schema.json
│   ├── landing-zone-manifest.schema.json
│   ├── baselines.schema.json
│   ├── controls.schema.json
│   └── ownership-matrix.schema.json
├── deploy/scripts/                      [NOT scripts/ — reserved; REQ-040]
│   ├── common.sh
│   ├── assert-prerequisites.sh
│   ├── discover-oidc-sub.sh
│   ├── bootstrap-commercial-oidc.sh
│   ├── bootstrap-govcloud-oidc.sh
│   ├── ensure-commercial-organization.sh
│   ├── discover-govcloud-pair.sh
│   ├── create-govcloud-member-accounts.sh
│   ├── ensure-govcloud-organization.sh
│   ├── ensure-control-tower-service-roles.sh
│   ├── render-control-tower-manifest.sh
│   ├── ensure-control-tower-kms.sh
│   ├── deploy-control-tower.sh
│   ├── wait-control-tower-operation.sh
│   ├── ensure-control-tower-baselines.sh
│   ├── ensure-control-tower-controls.sh
│   ├── verify-control-tower.sh
│   ├── verify-ownership-boundaries.sh
│   ├── render-lza-control-tower-projection.sh
│   ├── snapshot-control-tower-operations.sh
│   ├── verify-lza-control-tower-noop.sh
│   ├── ensure-codebuild-quota.sh
│   ├── render-config.sh
│   ├── validate-config-offline.sh
│   ├── validate-config-live.sh
│   ├── discover-config-s3.sh
│   ├── publish-config-s3.sh
│   ├── package-lza-source.sh
│   ├── synth-installer.sh
│   ├── deploy-installer.sh
│   ├── wait-codepipeline.sh
│   ├── verify-lza.sh
│   ├── verify-platform.sh
│   └── collect-diagnostics.sh
├── tests/
│   ├── control-tower-manifest.bats
│   ├── controls.bats
│   ├── ownership.bats
│   ├── lza-control-tower-noop.bats
│   ├── config.bats
│   ├── idempotency.bats
│   ├── shell.bats
│   └── evidence.bats
├── .editorconfig
├── .gitignore
├── .yamllint.yml
├── CODEOWNERS
├── lza.lock
├── Makefile
└── README.md
```

- **REP-001:** `config/` MUST contain exactly the six mandatory LZA files; do not include `customizations-config.yaml` initially.
- **REP-002:** `control-tower/landing-zone-manifest.template.json` MUST contain placeholders only for values rendered from validated inputs or API-discovered account/key IDs.
- **REP-003:** The rendered landing-zone manifest MUST be generated into `build/`; do not commit real account IDs into the template.
- **REP-004:** `control-tower/baselines.yaml` and `control-tower/controls.yaml` MUST be declarative desired-state files and MUST validate against repository schemas.
- **REP-005:** `control-tower/ownership-matrix.yaml` MUST list every potentially overlapping domain and exactly one authoritative owner.
- **REP-006:** `govcloud-control-support.json` MUST be generated from the Control Catalog during Phase 3 and uploaded as evidence; it is not a hand-maintained assertion.
- **REP-007:** Generated deployment state is ignored by Git unless the repository intentionally stores signed, non-secret deployment records. GitHub artifacts are the default.
- **REP-008:** `.gitignore` MUST cover `.aws/`, credential files, `build/`, `cdk.out/`, `vendor/`, downloaded archives, rendered manifests with account IDs, generated evidence, `.env`, and token files.
- **REP-009:** `control-tower-service-roles.yaml` MUST define the four documented API prerequisite roles at `/service-role/`, and repository tests MUST compare their trust/policy semantics to the pinned implementation and current AWS documentation.

### 5.1 Required lock file

Create `lza.lock` with exactly:

```yaml
schemaVersion: 2
sourceRepository: https://github.com/awslabs/landing-zone-accelerator-on-aws.git
version: v1.16.1
commit: 8b43dc6e347b5fc1c477940c7f71ea595fbf19ab
nodeMajor: 22
yarnVersion: 1.22.22
partition: aws-us-gov
homeRegion: us-gov-west-1
controlTowerLandingZoneVersion: "4.0"
controlTowerOuBaselineVersion: "5.0"
```

- **REP-010:** Workflows MUST read version values from `lza.lock`; they MUST NOT duplicate a different LZA or landing-zone version.
- **REP-011:** The setup action MUST check out upstream into `vendor/lza`, resolve `v1.16.1^{commit}`, compare it to the locked commit, and fail before package scripts execute on mismatch.
- **REP-012:** Use Node 22 and Yarn `1.22.22` with the upstream frozen lockfile.
- **REP-013:** Changes to `lza.lock`, Control Tower version, controls, baselines, ownership matrix, or governed Regions MUST require CODEOWNERS review.

---

## 6. Rules for authoring Control Tower and LZA desired-state files

### 6.1 Canonical source and rendering

- **CFG-001:** `deployment/inputs.yaml` is the canonical non-secret value source.
- **CFG-002:** The Control Tower manifest and LZA configuration MUST be rendered from the same account IDs, account emails, OU names, governed Regions, retention values, and landing-zone version.
- **CFG-003:** A test MUST compare the Control Tower manifest to the LZA `controlTower` block and fail if version, Regions, logging intent, or identity intent diverges.
- **CFG-004:** The exact pinned LZA validator is authoritative for LZA schema compatibility.
- **CFG-005:** The agent MUST not invent LZA keys from memory. It must confirm keys against the exact release source or pass the exact release validator.
- **CFG-006:** The deployment itself MUST NOT be used as schema trial-and-error.

### 6.2 Control Tower landing-zone manifest

The rendered version-4.0 manifest MUST be semantically equivalent to:

```json
{
  "accessManagement": {
    "enabled": false
  },
  "backup": {
    "enabled": false
  },
  "centralizedLogging": {
    "enabled": true,
    "accountId": "${LOG_ARCHIVE_ACCOUNT_ID}",
    "configurations": {
      "accessLoggingBucket": {
        "retentionDays": 365
      },
      "loggingBucket": {
        "retentionDays": 365
      },
      "kmsKeyArn": "${CONTROL_TOWER_KMS_KEY_ARN}"
    }
  },
  "config": {
    "enabled": true,
    "accountId": "${AUDIT_ACCOUNT_ID}",
    "configurations": {
      "accessLoggingBucket": {
        "retentionDays": 365
      },
      "loggingBucket": {
        "retentionDays": 365
      },
      "kmsKeyArn": "${CONTROL_TOWER_KMS_KEY_ARN}"
    }
  },
  "governedRegions": [
    "us-gov-west-1"
  ],
  "securityRoles": {
    "enabled": true,
    "accountId": "${AUDIT_ACCOUNT_ID}"
  }
}
```

The actual retention values and region array MUST come from inputs.

- **CTCFG-001:** All version-4.0 `enabled` flags MUST be explicitly present.
- **CTCFG-002:** The `LogArchive` ID MUST be used for centralized logging.
- **CTCFG-003:** The `Audit` ID MUST be used for Config aggregation and security roles.
- **CTCFG-004:** The KMS ARN MUST be a symmetric, enabled, single-Region customer-managed key in the GovCloud management account and home Region.
- **CTCFG-005:** `accessManagement.enabled` defaults to `false` because no identity source/permission-set design was supplied. Enabling it later requires a separate identity architecture change.
- **CTCFG-006:** `backup.enabled` defaults to `false` because no backup administrator/central vault account design was supplied.
- **CTCFG-007:** The manifest MUST contain no organization structure because landing-zone version 4.0 removed `organizationStructure` from the manifest.
- **CTCFG-008:** The workflow MUST call Create/Update with `--remediation-types INHERITANCE_DRIFT`.
- **CTCFG-009:** The plan MUST NOT configure landing-zone-wide `AWS-GR_REGION_DENY`; the fully API-driven initial design uses OU-scoped `CT.MULTISERVICE.PV.1` instead.

### 6.3 Baseline declaration

`control-tower/baselines.yaml` MUST initially declare:

```yaml
schemaVersion: 1
baselines:
  - name: AWSControlTowerBaseline
    version: "5.0"
    targetOu: Infrastructure
    required: true
    includeChildrenVerification: true
```

- **CTCFG-020:** The agent MUST resolve the baseline ARN with `list-baselines`; it MUST NOT hard-code the opaque ARN.
- **CTCFG-020A:** For landing-zone version `4.0`, pin `AWSControlTowerBaseline` version `5.0`, which is the documented compatible OU baseline. Fail if the service no longer advertises or accepts that compatibility rather than substituting another version silently.
- **CTCFG-021:** The target identifier MUST be the partition-correct Organizations OU ARN for `Infrastructure`.
- **CTCFG-022:** Baseline enablement is asynchronous; record and poll `operationIdentifier` with `get-baseline-operation`.
- **CTCFG-023:** The enabled baseline MUST report `statusSummary.status=SUCCEEDED` and no inheritance drift.
- **CTCFG-024:** Inventory the service-managed shared-account baselines created by landing-zone version 4.0. Require `LogArchiveBaseline` for LogArchive and `CentralConfigBaseline` plus `CentralSecurityRolesBaseline` for Audit when their corresponding manifest integrations are enabled; do not call `EnableBaseline` for these service-managed baselines directly.

### 6.4 Control declaration

`control-tower/controls.yaml` MUST initially contain the OU-scoped Region-deny control for the empty Infrastructure OU:

```yaml
schemaVersion: 1
controls:
  - alias: CT.MULTISERVICE.PV.1
    enabled: true
    required: true
    targetOu: Infrastructure
    parameters:
      AllowedRegions:
        - us-gov-west-1
      ExemptedPrincipalArns: []
      ExemptedActions: []
```

- **CTCFG-030:** The workflow MUST resolve the control's current ARN/identifier with the AWS Control Catalog APIs.
- **CTCFG-031:** The workflow MUST inspect current Regions, behavior, implementation type, and parameter requirements before enablement.
- **CTCFG-032:** If a required control is unsupported in GovCloud, the workflow MUST fail with evidence; it MUST NOT silently report success.
- **CTCFG-033:** The workflow MUST not enable RCP-based controls in GovCloud unless the current official GovCloud feature matrix and Control Catalog both show support.
- **CTCFG-034:** The workflow MUST use `enable-control`, `update-enabled-control`, or `reset-enabled-control` as appropriate and poll the exact operation ID.
- **CTCFG-035:** The workflow MUST verify the underlying SCP, Config rule, or CloudFormation hook rather than trusting only the API operation status.
- **CTCFG-036:** Mandatory controls applied by `AWSControlTowerBaseline` MUST be inventoried as evidence but not duplicated in `controls.yaml`.

### 6.5 LZA `accounts-config.yaml`

- **LZACFG-010:** Define exactly `Management`, `LogArchive`, and `Audit` as mandatory accounts.
- **LZACFG-011:** Place `Management` in `Root`; place `LogArchive` and `Audit` in `Security`.
- **LZACFG-012:** Use exact input emails and preserve the mandatory logical names.
- **LZACFG-013:** Set `workloadAccounts: []`.

```yaml
mandatoryAccounts:
  - name: Management
    description: GovCloud organization management account
    email: ${MANAGEMENT_ACCOUNT_EMAIL}
    organizationalUnit: Root
  - name: LogArchive
    description: AWS Control Tower and platform log archive account
    email: ${LOG_ARCHIVE_ACCOUNT_EMAIL}
    organizationalUnit: Security
  - name: Audit
    description: AWS Control Tower security, Config aggregator, and audit account
    email: ${AUDIT_ACCOUNT_EMAIL}
    organizationalUnit: Security
workloadAccounts: []
```

### 6.6 LZA `organization-config.yaml`

- **LZACFG-020:** Set `enable: true`.
- **LZACFG-021:** Represent exactly the `Security` and `Infrastructure` OUs for the initial deployment.
- **LZACFG-022:** Define no custom SCP, RCP, tag, backup, chatbot, or declarative policy during the first release unless required empty arrays are needed by the schema.
- **LZACFG-023:** The LZA pipeline MUST not directly modify Control Tower-managed control SCPs.

Semantic target:

```yaml
enable: true
organizationalUnits:
  - name: Security
  - name: Infrastructure
serviceControlPolicies: []
```

### 6.7 LZA `global-config.yaml`

- **LZACFG-030:** Set `homeRegion: us-gov-west-1`.
- **LZACFG-031:** Set `enabledRegions` equal to the Control Tower `governedRegions` set.
- **LZACFG-032:** Set `managementAccountAccessRole: AWSControlTowerExecution`.
- **LZACFG-033:** Set `controlTower.enable: true` and `controlTower.landingZone.version: "4.0"`.
- **LZACFG-034:** Set Control Tower logging semantics to organization trail enabled and the same retention values used by the manifest.
- **LZACFG-035:** Set `controlTower.landingZone.accountAutoEnrollment: true` explicitly. Do not omit the field: pinned LZA `v1.16.1` treats it as desired landing-zone state and may call `UpdateLandingZone` when it differs from the live value.
- **LZACFG-036:** Set `controlTower.controls` to an empty list in LZA because Phase 3 scripts, not LZA, are the authoritative elective-control manager.
- **LZACFG-037:** Disable LZA organization CloudTrail creation: `logging.cloudtrail.enable: false` and `organizationTrail: false`, with all dependent organization-trail options disabled.
- **LZACFG-038:** Preserve LZA central-log configuration only for non-Control-Tower service logs and ensure bucket/resource names do not collide with Control Tower buckets.
- **LZACFG-039:** Enable termination protection and use version-2 stacks when supported by the pinned release.
- **LZACFG-040:** Do not enable IAM Identity Center in LZA while the Control Tower manifest has access management disabled.
- **LZACFG-041:** `render-lza-control-tower-projection.sh` MUST map `global-config.yaml` to the exact fields that pinned LZA sends to Control Tower: version, enabled/governed Regions, organization-trail flag, logging and access-log retention, Identity Center access flag, shared-account IDs, and account auto-enrollment. The projection MUST equal the live Phase 3 manifest semantics before any Phase 4 mutation.

Required semantic shape:

```yaml
homeRegion: us-gov-west-1
enabledRegions:
  - us-gov-west-1
managementAccountAccessRole: AWSControlTowerExecution
controlTower:
  enable: true
  landingZone:
    version: "4.0"
    accountAutoEnrollment: true
    logging:
      loggingBucketRetentionDays: 365
      accessLoggingBucketRetentionDays: 365
      organizationTrail: true
    security:
      enableIdentityCenterAccess: false
  controls: []
logging:
  cloudtrail:
    enable: false
    organizationTrail: false
```

The rendered retention values and governed Region list MUST come from validated deployment inputs; the values above show the required initial target.

Pinned reference semantics are demonstrated in the AWS LZA Universal Configuration, but the exact `v1.16.1` validator remains authoritative:

<https://github.com/aws/lza-universal-configuration/blob/6820809312685fac9f127a027570cec2a176ccf4/modules/base/default/global-config.yaml>

### 6.8 LZA `iam-config.yaml`

- **LZACFG-050:** Define no custom IAM users, access keys, groups, roles, permission sets, or Identity Center assignments initially.
- **LZACFG-051:** Do not redefine `AWSControlTowerExecution` or any Control Tower service-linked/service roles.

### 6.9 LZA `network-config.yaml`

- **LZACFG-060:** Define no VPCs, Transit Gateways, Direct Connect, Network Firewall, Resolver, or IPAM resources initially.
- **LZACFG-061:** Repository tests MUST assert all such resource lists are empty.

### 6.10 LZA `security-config.yaml`

- **LZACFG-070:** Do not create or replace the Control Tower Config aggregator, configuration recorders, or delivery channels.
- **LZACFG-071:** Do not create a duplicate organization CloudTrail.
- **LZACFG-072:** Target future security delegated administration to `Audit` and non-Control-Tower log aggregation to `LogArchive`.
- **LZACFG-073:** Disable optional high-cost security-service integrations during the first deployment unless required for validator compatibility.
- **LZACFG-074:** Do not enable Detective, Macie classification jobs, Audit Manager assessments, or custom Config rules initially.
- **LZACFG-075:** Before later enabling GuardDuty, Security Hub, Inspector, or Macie, add explicit ownership and delegated-administrator tests.

---

## 7. Validation gates

### 7.1 Offline repository validation

`deploy/scripts/validate-config-offline.sh` MUST run without AWS credentials and perform:

1. Exact LZA tag/commit verification.
2. Node/Yarn lock verification.
3. JSON/YAML syntax validation.
4. Repository JSON Schema validation for inputs, Control Tower manifest template, baselines, controls, ownership matrix, and evidence schemas.
5. Placeholder detection.
6. `actionlint`, `shellcheck`, `yamllint`, `cfn-lint`, and Bats tests.
7. Semantic ownership tests that reject duplicate CloudTrail/Config/control ownership.
8. Deterministic SHA-256 calculation for repository desired-state inputs.

The offline gate MUST NOT falsely claim that the exact LZA validator succeeded, because an Organizations-enabled LZA validation loads account IDs through AWS Organizations.

The offline gate is Phase 0's deliverable and runs from `<workload-slug>_validate-offline.yml` (Section 1.2, REQ-049; workflow specification in Section 21.9). The same script is invoked, unchanged, by `01-pr-validate.yml` step 3 and as the first step of every phase workflow — one implementation of the eight checks, never a second copy.

### 7.2 Live LZA validation

After GovCloud OIDC exists, `deploy/scripts/validate-config-live.sh` MUST assume the read-only `GitHubGovCloudConfigValidationRole` and run the exact pinned validator:

```bash
#!/usr/bin/env bash
set -Eeuo pipefail
IFS=$'\n\t'
export AWS_PAGER=''

ROOT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
LZA_DIR="${ROOT_DIR}/vendor/lza"
CONFIG_DIR="${1:-${ROOT_DIR}/config}"
EXPECTED_COMMIT='8b43dc6e347b5fc1c477940c7f71ea595fbf19ab'

actual_commit="$(git -C "${LZA_DIR}" rev-parse 'v1.16.1^{commit}')"
test "${actual_commit}" = "${EXPECTED_COMMIT}"

for file in accounts global iam network organization security; do
  test -s "${CONFIG_DIR}/${file}-config.yaml"
done
test ! -e "${CONFIG_DIR}/customizations-config.yaml"

if grep -RInE 'REPLACE_ME|<[^>]+>@example\.com|\$\{[A-Z0-9_]+\}' "${CONFIG_DIR}"; then
  echo 'Unresolved LZA configuration placeholder detected' >&2
  exit 1
fi

cd "${LZA_DIR}/source"
corepack enable
corepack prepare yarn@1.22.22 --activate
HUSKY=0 yarn install --frozen-lockfile
yarn build

PARTITION=aws-us-gov AWS_REGION=us-gov-west-1 ACCOUNT_ID="${GOVCLOUD_MANAGEMENT_ACCOUNT_ID}" ACCELERATOR_ENABLE_SINGLE_ACCOUNT_MODE=false yarn validate-config "${CONFIG_DIR}"
```

- **VAL-001:** Live validation MUST execute with temporary OIDC credentials that can read Organizations and STS state but cannot mutate AWS resources.
- **VAL-002:** The exact validator MUST return zero before Control Tower or LZA deployment can use a rendered LZA configuration.
- **VAL-003:** Pull requests from forks MUST never receive AWS credentials; a protected-branch or trusted-environment live validation run is required before deployment.

### 7.3 LZA-to-Control-Tower no-op validation

Before Phase 4 can deploy the installer, `deploy/scripts/verify-lza-control-tower-noop.sh` MUST:

1. Render `build/control-tower/lza-control-tower-projection.json` from the validated `global-config.yaml`, `accounts-config.yaml`, and API-resolved account IDs.
2. Read the live landing zone with `get-landing-zone` and canonicalize only the fields that pinned LZA `v1.16.1` manages.
3. Compare version, governed Regions, organization-trail enablement, log-retention values, Identity Center access, shared-account IDs, and account auto-enrollment.
4. Fail before installer synthesis/deployment if any value differs or if the live landing zone is not `ACTIVE` and `IN_SYNC`.
5. Calculate and record the projection SHA-256 and live comparable-state SHA-256.

- **VAL-004:** The projection MUST explicitly contain `accountAutoEnrollment: true`.
- **VAL-005:** The projection and live comparable-state digests MUST be equal.
- **VAL-006:** A difference MUST be remediated by a reviewed Phase 3 change; Phase 4 MUST NOT rely on LZA to update or reset the landing zone.

### 7.4 Control Tower manifest validation

- **VAL-010:** Render the manifest only after account IDs and KMS ARN are discovered.
- **VAL-011:** Validate with `jq -e`, repository schema, and explicit assertions for every required version-4.0 field.
- **VAL-012:** Canonicalize with `jq -S -c` and calculate SHA-256.
- **VAL-013:** Assert the `LogArchive` and `Audit` IDs differ from one another and the management ID.
- **VAL-014:** Assert every ARN uses partition `aws-us-gov` and Region `us-gov-west-1` where regional.
- **VAL-015:** AWS does not publish a formal manifest JSON schema by design; repository schema checks are preflight checks and the Control Tower API remains the authoritative service validation.

### 7.5 Deterministic digests

The workflow MUST record:

- input-set SHA-256;
- rendered Control Tower manifest SHA-256;
- baselines declaration SHA-256;
- controls declaration SHA-256;
- ownership matrix SHA-256;
- each LZA file SHA-256;
- aggregate LZA configuration SHA-256;
- LZA source archive SHA-256;
- synthesized installer template SHA-256;
- LZA Control Tower projection SHA-256;
- live comparable Control Tower state SHA-256;
- pre-Phase-4 and post-Phase-4 landing-zone-operation snapshot SHA-256 values.

---

## 8. GitHub OIDC subject discovery and trust creation

GitHub changed the default OIDC subject format for repositories created after July 15, 2026 to include immutable owner and repository IDs. The implementation MUST discover the actual token claim rather than construct a subject from a repository name.

Official reference: <https://docs.github.com/en/actions/reference/security/oidc#immutable-subject-claims>

### 8.1 `00-discover-oidc-sub.yml`

- **OIDC-001:** Trigger only with `workflow_dispatch`.
- **OIDC-002:** Set workflow permissions to `contents: read` and `id-token: write`; set all unspecified permissions to `none`.
- **OIDC-003:** Run the discovery job in the same GitHub Environment (`govcloud-prod`) and branch context that the deployment workflow will use.
- **OIDC-004:** Request a token with audience `sts.amazonaws.com` by calling the URL in `ACTIONS_ID_TOKEN_REQUEST_URL` with the bearer token in `ACTIONS_ID_TOKEN_REQUEST_TOKEN`.
- **OIDC-005:** Never print the raw JWT.
- **OIDC-006:** Decode the payload locally and emit only these claims to `build/oidc-claims.json`: `iss`, `aud`, `sub`, `repository`, `repository_id`, `repository_owner`, `repository_owner_id`, `ref`, `environment`, `workflow`, and `job_workflow_ref` when present.
- **OIDC-007:** Assert `iss` is `https://token.actions.githubusercontent.com`.
- **OIDC-008:** Assert `aud` is `sts.amazonaws.com`.
- **OIDC-009:** Upload `oidc-claims.json` as an artifact.
- **OIDC-010:** The local bootstrap scripts MUST consume the exact discovered `sub` value.

### 8.2 IAM OIDC provider

- **OIDC-020:** Create the IAM OIDC provider with URL `https://token.actions.githubusercontent.com` and client ID `sts.amazonaws.com` by IAM CLI/API.
- **OIDC-021:** The script MAY omit a thumbprint when creating the provider with CLI/API because IAM can retrieve it; after creation it SHOULD independently inspect and record the provider configuration.
- **OIDC-022:** Reuse an existing provider only when its URL and client ID match exactly.
- **OIDC-023:** Use partition-correct provider ARNs:
  - commercial: `arn:aws:iam::<ACCOUNT_ID>:oidc-provider/token.actions.githubusercontent.com`
  - GovCloud: `arn:aws-us-gov:iam::<ACCOUNT_ID>:oidc-provider/token.actions.githubusercontent.com`

Official references:

- <https://docs.aws.amazon.com/IAM/latest/UserGuide/id_roles_providers_create_oidc.html>
- <https://docs.aws.amazon.com/IAM/latest/UserGuide/id_roles_providers_create_oidc_verify-thumbprint.html>

### 8.3 Role trust policy

- **OIDC-030:** Trust only the exact provider ARN in the same account as the role.
- **OIDC-031:** Use `StringEquals` for both `token.actions.githubusercontent.com:aud` and the exact discovered `token.actions.githubusercontent.com:sub`.
- **OIDC-032:** Do not use a repository-wide wildcard in the production role trust policy.
- **OIDC-033:** If a separate pull-request validation role is later added, give it read-only AWS permissions and a separate exact subject pattern.
- **OIDC-034:** Set the role maximum session duration to no more than one hour unless the measured LZA deployment requires a longer orchestration session; CodePipeline continues independently after it starts.

Required trust-policy shape:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Principal": {
        "Federated": "${PARTITION_CORRECT_OIDC_PROVIDER_ARN}"
      },
      "Action": "sts:AssumeRoleWithWebIdentity",
      "Condition": {
        "StringEquals": {
          "token.actions.githubusercontent.com:aud": "sts.amazonaws.com",
          "token.actions.githubusercontent.com:sub": "${EXACT_DISCOVERED_SUB}"
        }
      }
    }
  ]
}
```

---

## 9. Phase 1 — Commercial bootstrap and GovCloud account-pair vending

### 9.1 Temporary commercial CLI authentication

- **P1-001:** Require current AWS CLI v2 and use:

```bash
aws login --remote --profile commercial-bootstrap --region us-east-1
aws sts get-caller-identity --profile commercial-bootstrap --region us-east-1
```

- **P1-002:** Verify the returned account is the declared commercial management/bootstrap account.
- **P1-003:** This browser authentication is an identity ceremony, not AWS console resource configuration.

### 9.2 Commercial Organization

`deploy/scripts/ensure-commercial-organization.sh` MUST:

- **P1-010:** Call `describe-organization` in `us-east-1`.
- **P1-011:** Create an all-features organization only if none exists.
- **P1-012:** Verify the caller is the management account and `FeatureSet=ALL`.
- **P1-013:** Never leave, replace, or restructure an existing organization automatically.

### 9.3 Commercial GitHub OIDC

`deploy/scripts/bootstrap-commercial-oidc.sh` MUST:

- **P1-020:** Consume the exact discovered GitHub OIDC `sub`.
- **P1-021:** Create/reuse the IAM OIDC provider.
- **P1-022:** Create `GitHubCommercialGovCloudAccountVendingRole` with only Organizations/account-read and `CreateGovCloudAccount` permissions.
- **P1-023:** Restrict trust with exact `aud` and exact `sub`.
- **P1-024:** Run `.github/workflows/<workload-slug>_02-test-commercial-oidc.yml` and require success before vending accounts.

### 9.4 First GovCloud management pair

- **P1-030:** Call `account get-gov-cloud-account-information` from the commercial management account.
- **P1-031:** If no pair exists, emit only the blocked human task in Section 4.
- **P1-032:** Poll until `AccountState=ACTIVE`, then record `GovCloudAccountId`.
- **P1-033:** Do not ask the operator to copy the GovCloud account ID from a portal.

### 9.5 Create `LogArchive` and `Audit` pairs

For each shared account:

- **P1-040:** Search existing commercial organization accounts by exact email/name and prior state before creating.
- **P1-041:** Never create a second account while a prior operation is `IN_PROGRESS` or `SUCCEEDED`.
- **P1-042:** Issue:

```bash
aws organizations create-gov-cloud-account \
  --email "${ACCOUNT_EMAIL}" \
  --account-name "${ACCOUNT_NAME}" \
  --role-name OrganizationAccountAccessRole \
  --iam-user-access-to-billing DENY \
  --tags \
    Key=ManagedBy,Value=GitHubActions \
    Key=Purpose,Value=GovCloudFoundation \
  --region us-east-1 \
  --output json
```

- **P1-043:** Capture `CreateAccountStatus.Id` and poll `describe-create-account-status`.
- **P1-044:** On success, record both commercial and GovCloud account IDs.
- **P1-045:** On failure, report `FailureReason`; do not retry with another email.
- **P1-046:** The Phase 1 workflow MUST be `.github/workflows/<workload-slug>_04-phase1-vend-govcloud-accounts.yml`.

### 9.6 Phase 1 done gate

Phase 1 succeeds only when:

```text
commercial organization FeatureSet == ALL
commercial OIDC role test == succeeded
management GovCloud pair state == ACTIVE
LogArchive CreateGovCloudAccount status == SUCCEEDED
Audit CreateGovCloudAccount status == SUCCEEDED
all six account IDs (three commercial, three GovCloud) are recorded
```

---

## 10. Phase 2 — GovCloud Organization and bootstrap access

### 10.1 One-time GovCloud OIDC bootstrap

Using the initial access key and secret key provided in the AWS GovCloud onboarding email only long enough to establish OIDC:

- **P2-000:** Configure a temporary `govcloud-onboarding` CLI profile from the onboarding-email credentials without printing or persisting them beyond the bootstrap session; do not use the GovCloud console onboarding tool.
- **P2-001:** Verify `sts get-caller-identity` returns the discovered GovCloud management account and an `arn:aws-us-gov:` ARN.
- **P2-002:** Create/reuse the GitHub OIDC provider in the GovCloud management account.
- **P2-003:** Create three exact-subject roles:
  - `GitHubGovCloudFoundationRole` for Organizations, Control Tower, Control Catalog, the narrowly scoped CloudFormation/KMS operations for the Control Tower KMS stack, and foundation evidence;
  - `GitHubGovCloudConfigValidationRole` for read-only Organizations/STS validation;
  - `GitHubGovCloudLzaDeployRole` for S3, CloudFormation, CodePipeline, CodeBuild, logs, and LZA evidence.
- **P2-004:** Create `LzaCloudFormationExecutionRole`, trusted by CloudFormation, and limit `iam:PassRole` from the GitHub LZA role to exact approved service roles.
- **P2-005:** Run `.github/workflows/<workload-slug>_03-test-govcloud-oidc.yml` for all three roles.
- **P2-006:** Deactivate the onboarding access key, rerun OIDC tests, then delete the inactive key.
- **P2-007:** Remove local temporary credential material.

### 10.2 Create/reuse the GovCloud Organization

- **P2-010:** Call `describe-organization --region us-gov-west-1`.
- **P2-011:** Create `FeatureSet=ALL` only if no organization exists.
- **P2-012:** Verify the caller is the GovCloud management account.
- **P2-013:** Capture the organization ID and single root ID.

### 10.3 Create OUs

- **P2-020:** Create/reuse `Security` directly beneath Root.
- **P2-021:** Create/reuse `Infrastructure` directly beneath Root.
- **P2-022:** Fail if duplicate names exist under Root.
- **P2-023:** Fail on unexpected OUs during the initial strict deployment unless explicitly allow-listed in inputs.

### 10.4 Invite, accept, and place shared accounts

For each of `LogArchive` and `Audit`:

- **P2-030:** Detect existing active membership first.
- **P2-031:** If standalone, invite by account ID and capture the handshake ID.
- **P2-032:** Assume `arn:aws-us-gov:iam::<CHILD_ID>:role/OrganizationAccountAccessRole`.
- **P2-033:** Under child credentials, find the exact open invitation and call `accept-handshake`.
- **P2-034:** Poll until the account is an `ACTIVE` member.
- **P2-035:** Move it to the `Security` OU and verify exactly one parent.
- **P2-036:** Verify no Config recorder/delivery channel and no unrelated organization trail exists in the new shared accounts before Control Tower setup. Unexpected pre-existing resources MUST block automatic enrollment rather than be deleted silently.

### 10.5 Phase 2 workflow and gate

The workflow MUST be `.github/workflows/<workload-slug>_05-phase2-provision-govcloud-organization.yml`.

Phase 2 succeeds only when:

```text
GovCloud organization FeatureSet == ALL
Root count == 1
Security OU count == 1 and parent == Root
Infrastructure OU count == 1 and parent == Root
active accounts == {Management, LogArchive, Audit}
parent(Management) == Root
parent(LogArchive) == Security
parent(Audit) == Security
all GovCloud OIDC role tests == succeeded
no onboarding access key remains active
```

---

## 11. Phase 3 — Control Tower prerequisites and ownership preflight

### 11.1 Preflight state inspection

Before any Control Tower mutation, `deploy/scripts/verify-ownership-boundaries.sh` MUST inspect:

1. `list-landing-zones` in `us-gov-west-1`.
2. Existing Control Tower service roles in Management.
3. Existing organization CloudTrail trails and their owners.
4. Existing Config recorders, delivery channels, aggregators, and aggregation authorizations in every governed Region for Management, Audit, and LogArchive.
5. Existing Organizations delegated administrators and trusted service access.
6. Existing OUs, account parents, policies, and StackSets.
7. Existing KMS alias `alias/govcloud-control-tower`.

- **CTPRE-001:** A clean initial environment may have no landing zone and no Control Tower resources.
- **CTPRE-002:** If one landing zone exists, enter reconciliation mode rather than creation mode.
- **CTPRE-003:** More than one discovered landing-zone identifier, inconsistent home Region, or unrelated Control Tower resources MUST stop the workflow.
- **CTPRE-004:** Existing Config resources in shared accounts MUST block initial setup unless they match an explicitly supported adoption path.
- **CTPRE-005:** Existing non-Control-Tower organization trails MUST block deployment until an explicit ownership decision is committed. Do not auto-delete audit infrastructure.

### 11.2 Control Tower API prerequisite service roles

`infra/control-tower/control-tower-service-roles.yaml` and `deploy/scripts/ensure-control-tower-service-roles.sh` MUST create or verify these roles in the management account before `CreateLandingZone`:

```text
/service-role/AWSControlTowerAdmin
/service-role/AWSControlTowerCloudTrailRole
/service-role/AWSControlTowerStackSetRole
/service-role/AWSControlTowerConfigAggregatorRoleForOrganizations
```

- **CTROLE-001:** Use IAM path `/service-role/` exactly.
- **CTROLE-002:** `AWSControlTowerAdmin` MUST trust `controltower.amazonaws.com`, have the current AWS-managed `service-role/AWSControlTowerServiceRolePolicy`, and retain the required inline permission to describe Availability Zones when required by the pinned implementation.
- **CTROLE-003:** `AWSControlTowerCloudTrailRole` MUST trust `cloudtrail.amazonaws.com` and have the current AWS-managed `service-role/AWSControlTowerCloudTrailRolePolicy`.
- **CTROLE-004:** `AWSControlTowerStackSetRole` MUST trust `cloudformation.amazonaws.com` and permit assumption of partition-correct `arn:aws-us-gov:iam::*:role/AWSControlTowerExecution` roles.
- **CTROLE-005:** `AWSControlTowerConfigAggregatorRoleForOrganizations` MUST trust `config.amazonaws.com` and have the current AWS-managed `service-role/AWSConfigRoleForOrganizations` policy. Landing-zone version 4.0 uses a service-linked Config aggregator operationally, but AWS's landing-zone API prerequisite contract and pinned LZA `v1.16.1` still require/create this bootstrap service role.
- **CTROLE-006:** The ensure script MUST inspect path, trust policy, attached managed policies, inline policies, tags, and permission boundary before deciding to create or update.
- **CTROLE-007:** Existing roles with incompatible trust, unexpected external principals, a conflicting permissions boundary, or unapproved extra policies MUST stop the deployment; do not delete and recreate them automatically.
- **CTROLE-008:** Deploy/update the roles through CloudFormation API calls with `CAPABILITY_NAMED_IAM`; verify all four role ARNs and policy digests before landing-zone creation.
- **CTROLE-009:** Record role ARNs, role IDs, path, trust-policy SHA-256, attached-policy ARNs, inline-policy SHA-256, and CloudFormation stack ID in Phase 3 evidence.
- **CTROLE-010:** Apply `DeletionPolicy: Retain` and `UpdateReplacePolicy: Retain` to each role and enable stack termination protection after creation. The plan does not include automatic role deletion or replacement.

Required deployment command shape:

```bash
aws cloudformation deploy \
  --region us-gov-west-1 \
  --stack-name GovCloud-ControlTower-ApiPrerequisiteRoles \
  --template-file infra/control-tower/control-tower-service-roles.yaml \
  --capabilities CAPABILITY_NAMED_IAM \
  --no-fail-on-empty-changeset

aws cloudformation update-termination-protection \
  --region us-gov-west-1 \
  --stack-name GovCloud-ControlTower-ApiPrerequisiteRoles \
  --enable-termination-protection
```

After stack completion, the script MUST call `iam get-role`, `iam list-attached-role-policies`, and `iam list-role-policies`/`get-role-policy` for each exact role and compare canonical policy documents to repository expectations.

Official references:

- <https://docs.aws.amazon.com/controltower/latest/userguide/lz-api-prereques.html>
- <https://github.com/awslabs/landing-zone-accelerator-on-aws/blob/v1.16.1/source/packages/%40aws-lza/lib/control-tower/setup-landing-zone/prerequisites/iam-role.ts>

### 11.3 Control Tower KMS key

`infra/control-tower/control-tower-kms.yaml` and `deploy/scripts/ensure-control-tower-kms.sh` MUST:

- **CTKMS-001:** Create/reuse a symmetric single-Region customer-managed key in Management and `us-gov-west-1`.
- **CTKMS-002:** Create alias `alias/govcloud-control-tower`.
- **CTKMS-003:** Enable key rotation when supported.
- **CTKMS-004:** Add minimum AWS Config and CloudTrail service permissions using partition-correct ARNs and confused-deputy conditions.
- **CTKMS-005:** Preserve full management-account key administration through an approved role; do not grant wildcard external principals.
- **CTKMS-006:** Validate `KeyState=Enabled`, `KeySpec=SYMMETRIC_DEFAULT`, `MultiRegion=false`, correct account/Region, alias target, policy statements, and tags.
- **CTKMS-007:** Deploy/update the key through CloudFormation API calls from the foundation workflow; no KMS console steps.

Official reference: <https://docs.aws.amazon.com/controltower/latest/userguide/configure-kms-keys.html>

The alias MUST NOT begin with `alias/aws/`, because that namespace is reserved for AWS-managed KMS aliases.

### 11.4 Render the landing-zone manifest

`deploy/scripts/render-control-tower-manifest.sh` MUST:

- **CTMAN-001:** Read validated inputs and Phase 1/2 evidence.
- **CTMAN-002:** Resolve exact Management, LogArchive, and Audit GovCloud IDs.
- **CTMAN-003:** Resolve the KMS ARN from CloudFormation/KMS APIs.
- **CTMAN-004:** Render `build/control-tower/landing-zone-manifest.json` without unresolved placeholders.
- **CTMAN-005:** Sort and canonicalize JSON, validate it, and calculate SHA-256.
- **CTMAN-006:** Assert service integration accounts are both under the same direct-root `Security` OU.
- **CTMAN-007:** Assert the manifest has no export-controlled or workload content.

---

## 12. Phase 3 — Create, update, or reset the Control Tower landing zone

### 12.1 Create path

When `list-landing-zones` returns no landing zone:

```bash
response="$(
  aws controltower create-landing-zone \
    --landing-zone-version 4.0 \
    --manifest file://build/control-tower/landing-zone-manifest.json \
    --remediation-types INHERITANCE_DRIFT \
    --tags "{\"ManagedBy\":\"GitHubActions\",\"Repository\":\"${GITHUB_REPOSITORY}\"}" \
    --region us-gov-west-1 \
    --output json
)"

landing_zone_arn="$(jq -r '.arn' <<<"${response}")"
operation_id="$(jq -r '.operationIdentifier' <<<"${response}")"
```

- **CTLZ-001:** Record both ARN and operation ID before polling.
- **CTLZ-002:** Poll `get-landing-zone-operation --operation-identifier` until `SUCCEEDED` or `FAILED`.
- **CTLZ-003:** On failure, preserve operation status/message and all discoverable StackSet/CloudFormation diagnostics.

### 12.2 Existing landing-zone path

When one landing zone exists:

- **CTLZ-010:** Call `get-landing-zone` and record version, status, latest available version, drift status, remediation types, and manifest.
- **CTLZ-011:** If status is `PROCESSING`, find and poll the active operation; do not issue a conflicting mutation.
- **CTLZ-012:** If deployed version differs from locked `4.0`, stop unless a reviewed migration change explicitly authorizes update.
- **CTLZ-013:** Canonicalize the returned manifest and compare semantic values to the desired rendered manifest.
- **CTLZ-014:** If manifest differs while state is otherwise healthy, call `update-landing-zone` with version `4.0`, the rendered manifest, and `INHERITANCE_DRIFT`.
- **CTLZ-015:** If drift status is `DRIFTED` and desired manifest/version already match, call `reset-landing-zone` and poll its operation.
- **CTLZ-016:** Never call `delete-landing-zone` automatically.

### 12.3 Landing-zone verification

After create/update/reset:

```bash
LZ_ARN="$(
  aws controltower list-landing-zones \
    --region us-gov-west-1 \
    --query 'landingZones[0].arn' \
    --output text
)"

test -n "${LZ_ARN}"
test "${LZ_ARN}" != "None"

test "$(
  aws controltower get-landing-zone \
    --landing-zone-identifier "${LZ_ARN}" \
    --region us-gov-west-1 \
    --query 'landingZone.status' \
    --output text
)" = "ACTIVE"

test "$(
  aws controltower get-landing-zone \
    --landing-zone-identifier "${LZ_ARN}" \
    --region us-gov-west-1 \
    --query 'landingZone.driftStatus.status' \
    --output text
)" = "IN_SYNC"
```

- **CTLZ-020:** Verify version equals `4.0`.
- **CTLZ-021:** Verify remediation types contain `INHERITANCE_DRIFT`.
- **CTLZ-022:** Verify returned manifest account IDs, KMS ARN, flags, Regions, and retention values equal desired inputs.
- **CTLZ-023:** Verify `AWSControlTowerExecution` exists in shared accounts after setup.
- **CTLZ-024:** Verify expected Control Tower service roles and StackSets exist and are not failed.
- **CTLZ-025:** Verify exactly one intended organization-level CloudTrail owned by Control Tower is logging to the intended Log Archive destination.
- **CTLZ-026:** Verify the expected Config aggregator/security integration exists in Audit and recorders are active in governed Regions.
- **CTLZ-027:** Verify no duplicate organization trail, Config aggregator, recorder, or delivery channel was introduced.
- **CTLZ-028:** For landing-zone version 4.0, verify the Audit account contains the expected service-linked Config aggregator and that obsolete per-account aggregation authorizations are not being created by the OU baseline.
- **CTLZ-029:** Verify the expected `LogArchiveBaseline`, `CentralConfigBaseline`, and `CentralSecurityRolesBaseline` are present and healthy on the service-integration accounts.

Official references:

- <https://docs.aws.amazon.com/controltower/latest/userguide/lz-api-prereques.html>
- <https://docs.aws.amazon.com/controltower/latest/APIReference/API_CreateLandingZone.html>
- <https://docs.aws.amazon.com/controltower/latest/userguide/lz-api-launch.html>
- <https://docs.aws.amazon.com/controltower/latest/userguide/lz-api-update.html>
- <https://docs.aws.amazon.com/cli/latest/reference/controltower/get-landing-zone.html>

---

## 13. Phase 3 — Baselines, controls, and governance verification

### 13.1 Register `Infrastructure` with `AWSControlTowerBaseline`

`deploy/scripts/ensure-control-tower-baselines.sh` MUST:

- **CTBASE-001:** Resolve the `Infrastructure` OU ARN as `arn:aws-us-gov:organizations::<MANAGEMENT_ID>:ou/<ORG_ID>/<OU_ID>`.
- **CTBASE-002:** Resolve the `AWSControlTowerBaseline` ARN with `list-baselines` by exact name.
- **CTBASE-003:** Read `list-enabled-baselines` filtered to the target OU before mutation.
- **CTBASE-004:** If absent, call `enable-baseline` with locked baseline version `5.0` and the OU ARN.
- **CTBASE-005:** If present and healthy at the desired version, perform no mutation.
- **CTBASE-006:** If drifted, call `reset-enabled-baseline`; if version/parameters require change, use `update-enabled-baseline` where supported.
- **CTBASE-007:** Poll the exact `get-baseline-operation` ID to `SUCCEEDED`.
- **CTBASE-008:** Verify the parent enabled baseline and `includeChildren` reporting contain no failed or inheritance-drifted child.
- **CTBASE-009:** Inventory the landing-zone-managed `LogArchiveBaseline`, `CentralConfigBaseline`, and `CentralSecurityRolesBaseline`; require successful status and the intended shared-account targets.

### 13.2 Resolve GovCloud control support

`deploy/scripts/ensure-control-tower-controls.sh` MUST first generate `build/control-tower/govcloud-control-support.json` by using Control Catalog `list-controls`/`get-control` and current Control Tower APIs.

For each declared control, record:

```text
alias
control ARN/identifier
behavior
implementation type(s)
guidance
supported Regions
parameter schema/current parameter requirements
GovCloud support decision
reason/evidence
```

- **CTCTRL-001:** Control aliases are human-readable desired-state keys; opaque identifiers are discovered at runtime.
- **CTCTRL-002:** A required control without current GovCloud support is a deployment failure.
- **CTCTRL-003:** A control operation reported as successful but lacking an expected backing artifact is a deployment failure.
- **CTCTRL-004:** Preventive controls require the expected Organizations policy attachment.
- **CTCTRL-005:** Detective controls require expected Config rules and active recording in each governed Region.
- **CTCTRL-006:** Proactive controls require the expected service-linked CloudFormation hook configuration.

### 13.3 Enable/update/reset declared controls

For each desired control:

- **CTCTRL-010:** Find an existing enabled control for the exact target OU and control identifier.
- **CTCTRL-011:** If absent, call `enable-control` with parameters rendered as JSON.
- **CTCTRL-012:** If parameters differ and the control is not drifted, call `update-enabled-control`.
- **CTCTRL-013:** If drifted, call `reset-enabled-control` instead of update.
- **CTCTRL-014:** Poll `get-control-operation` by exact operation ID.
- **CTCTRL-015:** Verify `list-enabled-controls` reports `SUCCEEDED` and non-drifted state.

### 13.4 Control Tower governance done checks

Phase 3 MUST fail unless:

```text
landing zone count == 1
landing zone version == 4.0
landing zone status == ACTIVE
landing zone drift == IN_SYNC
landing zone remediation types includes INHERITANCE_DRIFT
manifest semantic digest == desired manifest semantic digest
four Control Tower prerequisite service roles == present at /service-role/ with expected trust/policies
Control Tower KMS key == enabled, symmetric, single-Region, correct alias/policy
Infrastructure AWSControlTowerBaseline status == SUCCEEDED
Infrastructure baseline inheritance drift != DRIFTED
all required controls status == SUCCEEDED
all required controls backing artifacts verified
shared accounts remain under Security
organization trail count/owner/destination == expected
Config integration/aggregator/recorders == expected
no duplicate CT/LZA ownership exists
```

The Phase 3 workflow MUST be `.github/workflows/<workload-slug>_06-phase3-deploy-control-tower.yml`.

---

## 14. Automate the LZA CodeBuild concurrency prerequisite

AWS's LZA prerequisites require the CodeBuild “Concurrently running builds for Linux/Large environment” quota to be at least `3`.

Official reference: <https://docs.aws.amazon.com/solutions/latest/landing-zone-accelerator-on-aws/prerequisites.html>

`deploy/scripts/ensure-codebuild-quota.sh` MUST:

- **QUO-001:** Call `service-quotas list-service-quotas --service-code codebuild --region us-gov-west-1`.
- **QUO-002:** Select the quota by exact quota name, not a hard-coded quota code unless the code is also verified from the API.
- **QUO-003:** If the applied value is at least `3`, record success and make no request.
- **QUO-004:** If the value is below `3` and `Adjustable=true`, call `request-service-quota-increase` for value `3`.
- **QUO-005:** Poll `get-requested-service-quota-change` until approved, denied, or a defined workflow timeout is reached.
- **QUO-006:** If denied or non-adjustable, fail with the API response and a precise blocker; do not direct the operator to a console.
- **QUO-007:** Do not begin the installer deployment until the applied quota is at least `3`.

---

## 15. Phase 4 — Prove LZA will not mutate the Control Tower landing zone

Pinned LZA `v1.16.1` contains a Control Tower setup module that can create, update, or reset a landing zone. Because this plan deliberately creates and reconciles the landing zone in Phase 3, Phase 4 MUST prove that LZA's landing-zone desired state is identical and will be a no-op.

### 15.1 Render and compare the LZA Control Tower projection

`deploy/scripts/render-lza-control-tower-projection.sh` and `deploy/scripts/verify-lza-control-tower-noop.sh` MUST:

- **LZACT-001:** Parse the exact rendered `config/global-config.yaml` that will be packaged, not a separate hand-maintained manifest.
- **LZACT-002:** Require `controlTower.enable: true`, landing-zone version `4.0`, `accountAutoEnrollment: true`, Identity Center access disabled, organization trail enabled, and retention/governed-Region values identical to Phase 3.
- **LZACT-003:** Resolve Management, LogArchive, and Audit by the exact account emails in `accounts-config.yaml` and compare the resulting IDs to the live manifest. Derive live `accountAutoEnrollment` as `true` only when the landing zone remediation types contain `INHERITANCE_DRIFT`.
- **LZACT-004:** Canonicalize the LZA-managed projection and the corresponding live landing-zone state with `jq -S -c`; require byte-equivalent semantic JSON and equal SHA-256 digests.
- **LZACT-005:** Fail before the installer stack is deployed if the live landing zone is `PROCESSING`, `FAILED`, `DRIFTED`, not version `4.0`, or differs from the projection.
- **LZACT-006:** Do not permit a Phase 4 override that says “allow LZA to repair Control Tower.” Any difference is returned to Phase 3 as a reviewed governance change.

### 15.2 Snapshot landing-zone operations

`deploy/scripts/snapshot-control-tower-operations.sh` MUST call `list-landing-zone-operations` with pagination and save a canonical snapshot before any Phase 4 CloudFormation or CodePipeline mutation.

```bash
aws controltower list-landing-zone-operations \
  --region us-gov-west-1 \
  --max-results 100 \
  --output json \
  > build/control-tower/landing-zone-operations.pre-lza.json
```

- **LZACT-010:** Record every returned operation identifier, type, and status; hash the canonical snapshot.
- **LZACT-011:** Refuse to start Phase 4 while a landing-zone operation is `IN_PROGRESS`.
- **LZACT-012:** After the final core execution, capture a second paginated snapshot and calculate the set difference by operation identifier.
- **LZACT-013:** Require zero new `CREATE`, `UPDATE`, or `RESET` operations during the Phase 4 interval. Any new operation is an ownership-boundary violation and fails the run even when it ends `SUCCEEDED`.
- **LZACT-014:** Record the pre/post snapshots, hashes, comparison window, and `unexpectedLzaLandingZoneMutations: 0` in evidence.

Official references:

- <https://docs.aws.amazon.com/controltower/latest/APIReference/API_ListLandingZoneOperations.html>
- <https://github.com/awslabs/landing-zone-accelerator-on-aws/blob/v1.16.1/source/packages/%40aws-lza/lib/control-tower/setup-landing-zone/index.ts>
- <https://github.com/awslabs/landing-zone-accelerator-on-aws/blob/v1.16.1/source/packages/%40aws-lza/lib/control-tower/setup-landing-zone/functions.ts>
- <https://github.com/awslabs/landing-zone-accelerator-on-aws/blob/v1.16.1/source/packages/%40aws-lza/interfaces/control-tower/setup-landing-zone.ts>

---

## 16. Phase 4 — Define and execute the LZA S3 configuration bootstrap sequence

AWS documents S3 as a supported LZA configuration location. For an S3-backed deployment, the configuration is stored as a ZIP archive at `zipped/aws-accelerator-config.zip`, and the six mandatory YAML files must be located at the root of that ZIP archive. This section defines the full sequence, but the desired configuration upload MUST occur only after the installer and bootstrap core execution create and validate the LZA-managed configuration bucket and pipeline.

Official references:

- <https://docs.aws.amazon.com/solutions/latest/landing-zone-accelerator-on-aws/step-3.-update-the-configuration-files.html>
- <https://docs.aws.amazon.com/solutions/latest/landing-zone-accelerator-on-aws/customizing-the-solution.html>
- <https://docs.aws.amazon.com/solutions/latest/landing-zone-accelerator-on-aws/problem-configuration-file-not-found-issue.html>

### 16.1 Required installer mode

The installer template MUST be synthesized and deployed with the following configuration-repository settings:

```text
ConfigurationRepositoryLocation=s3
UseExistingConfigRepo=No
```

- **S3C-001:** Do not pass `ExistingConfigRepositoryName`, `ExistingConfigRepositoryBranchName`, `ExistingConfigRepositoryOwner`, or `ConfigCodeConnectionArn` with non-empty values.
- **S3C-002:** Inspect the synthesized template and fail before deployment if `ConfigurationRepositoryLocation` does not allow `s3`.
- **S3C-003:** Inspect the synthesized template's CloudFormation rules and fail if the S3 rule does not require `UseExistingConfigRepo=No` and empty existing-repository parameters.
- **S3C-004:** Do not pre-create a bucket using the expected LZA configuration-bucket name. LZA owns creation and lifecycle of its configuration bucket in this deployment mode.
- **S3C-005:** Do not create a CodeCommit repository, CodeConnection, GitHub PAT secret, or Git-based AWS-side configuration mirror.

The locked LZA v1.16.1 installer source explicitly permits `s3` for `ConfigurationRepositoryLocation` and rejects existing-repository parameters when S3 is selected:

- <https://github.com/awslabs/landing-zone-accelerator-on-aws/blob/v1.16.1/source/packages/%40aws-accelerator/installer/lib/installer-stack.ts>

### 16.2 Bootstrap sequencing constraint

LZA v1.16.1 does not accept an operator-supplied existing S3 configuration bucket through the standard installer. The installer creates the configuration bucket, writes an initial minimal configuration, creates the core pipeline, and normally starts an initial core execution.

The workflow MUST therefore use this deterministic two-core-execution sequence:

1. Deploy or update the installer stack with S3 selected for both source code and configuration.
2. Start or correlate the exact installer-pipeline execution and wait for it to succeed.
3. Discover and correlate the initial core-pipeline execution started by the installer.
4. Wait for that bootstrap core execution to reach `Succeeded` before changing the S3 configuration object.
5. Discover the S3 configuration bucket and object key from the deployed core pipeline.
6. Upload the GitHub-controlled configuration ZIP as a new S3 object version.
7. Start a second, exact core-pipeline execution for that S3 version.
8. Wait for the second execution to reach `Succeeded`; this second execution is the authoritative deployment execution recorded as the final core execution.

- **S3C-010:** Capture `list-pipeline-executions` before the installer run so an agent can distinguish pre-existing executions from the bootstrap execution.
- **S3C-011:** Do not overwrite the configuration object while any core-pipeline execution is `InProgress`.
- **S3C-012:** Record the bootstrap core execution ID and status separately from the final desired-configuration execution ID and status.
- **S3C-013:** A failed bootstrap core execution is a deployment failure. Do not conceal it by uploading another configuration and declaring only the second run successful.
- **S3C-014:** The final desired-configuration execution MUST consume the exact S3 object version selected by the current GitHub deployment, whether newly written or idempotently reused. Verify its source revision through CodePipeline execution/action metadata where the provider exposes the S3 version or revision identifier. On a true no-change run, a previously successful execution for that exact object version may be reused as evidence instead of starting another execution.

### 16.3 Discover the LZA configuration S3 location

`deploy/scripts/discover-config-s3.sh` MUST:

- **S3C-020:** Call `aws codepipeline get-pipeline --name AWSAccelerator-Pipeline --region us-gov-west-1` after the installer pipeline has created the core pipeline.
- **S3C-021:** Locate the source action whose action type category is `Source`, provider is `S3`, and purpose is the LZA configuration input. Prefer an action named `Configuration`; otherwise identify it by the `zipped/aws-accelerator-config.zip` object key. Do not confuse it with the separate S3 source-code action and do not assume an action array position.
- **S3C-022:** Read the configuration action's S3 bucket and object-key fields from the API response.
- **S3C-023:** Require the object key to equal `zipped/aws-accelerator-config.zip` unless the locked LZA release demonstrably uses another key; record any locked-release exception in code and tests.
- **S3C-024:** Verify the caller account is the GovCloud management account, verify the bucket Region with `get-bucket-location`, and verify the bucket physical ID is present in the expected LZA CloudFormation stack resources in that account. Do not infer ownership merely because the caller can read the bucket.
- **S3C-025:** Verify S3 Block Public Access, bucket versioning, and default encryption through `get-public-access-block`, `get-bucket-versioning`, and `get-bucket-encryption`.
- **S3C-026:** Treat a bucket name matching `aws-accelerator-config-<ACCOUNT_ID>-<REGION>` as a sanity check, not as the primary discovery mechanism.
- **S3C-027:** Record the discovered bucket, object key, KMS key identifier when available, and current object version ID in deployment state.

### 16.4 Package and publish the configuration archive

`deploy/scripts/publish-config-s3.sh` MUST:

- **S3C-030:** Rerun the exact pinned LZA configuration validator immediately before packaging.
- **S3C-031:** Copy exactly the six mandatory YAML files into a clean staging directory; do not include a parent `config/` directory in the ZIP.
- **S3C-032:** Fail if `customizations-config.yaml`, hidden files, editor swap files, credentials, generated state, or any undeclared file is present in the staging directory.
- **S3C-033:** Normalize staged file modification times to a fixed ZIP-safe timestamp, sort paths under `LC_ALL=C`, and create `build/aws-accelerator-config.zip` with ZIP metadata suppression such as `zip -X`; repeated packaging of identical bytes MUST produce the same archive SHA-256.
- **S3C-034:** List the ZIP contents and require these six root entries and no others:

```text
accounts-config.yaml
global-config.yaml
iam-config.yaml
network-config.yaml
organization-config.yaml
security-config.yaml
```

- **S3C-035:** Compute and record both the aggregate six-file configuration digest and the ZIP archive SHA-256.
- **S3C-036:** Read the current S3 object's metadata and version. Reuse the existing object version when `lza-commit`, `config-sha256`, and `archive-sha256` match the current desired bytes, even if the current GitHub commit differs because of documentation or workflow-only changes. Record the current GitHub commit in deployment evidence as a reference to the reused immutable object version.
- **S3C-037:** Otherwise upload with `aws s3api put-object` to the discovered bucket and `zipped/aws-accelerator-config.zip` key, relying on or explicitly using the bucket's approved KMS encryption.
- **S3C-038:** On a newly created object version, set non-secret metadata including `origin-github-sha`, `origin-github-run-id`, `lza-version`, `lza-commit`, `config-sha256`, and `archive-sha256`. Do not create a replacement version solely to refresh origin metadata.
- **S3C-039:** Request or provide an S3 SHA-256 checksum and record the returned `VersionId`, `ETag`, and checksum.
- **S3C-040:** Call `head-object --checksum-mode ENABLED` for the exact returned version and verify its metadata and checksum.
- **S3C-041:** Download that exact object version, verify the archive SHA-256, inspect the root entries, extract it into a clean directory, and recompute the aggregate six-file digest.
- **S3C-042:** Capture the core pipeline execution list immediately before the upload. After publication, wait a bounded correlation window for an automatically triggered execution whose S3 source revision matches the selected object version.
- **S3C-043:** If exactly one matching automatic execution appears, adopt and poll that exact execution ID. If none appears, call `start-pipeline-execution` once and record its returned execution ID. If multiple matching executions appear, fail and collect diagnostics rather than guessing.
- **S3C-044:** Include the exact configuration object version ID and correlated final core execution ID in deployment evidence and in the final GitHub job summary.

---

## 17. Phase 4 — Build and publish the pinned LZA source to GovCloud S3

AWS supports placing LZA source in a versioned S3 bucket in the same account and Region as the deployment and synthesizing the installer with `use-s3-source=true`.

Official reference: <https://docs.aws.amazon.com/solutions/latest/landing-zone-accelerator-on-aws/source-code-location.html>

### 17.1 Source bucket

- **SRC-001:** Create a globally unique bucket name using the configured prefix, GovCloud management account ID, and Region.
- **SRC-002:** Create it in `us-gov-west-1`.
- **SRC-003:** Enable S3 Block Public Access at bucket and account level where supported.
- **SRC-004:** Enable versioning.
- **SRC-005:** Encrypt with a customer-managed symmetric KMS key and an alias such as `alias/lza-source`.
- **SRC-006:** Deny non-TLS requests.
- **SRC-007:** Deny public ACLs and policies.
- **SRC-008:** Grant the LZA installer/pipeline roles only the required read/decrypt access.
- **SRC-009:** Enable CloudTrail data-event logging later through the LZA/security baseline when applicable; do not block initial deployment on custom trails that LZA will manage.

### 17.2 Package exact source

`deploy/scripts/package-lza-source.sh` MUST:

- **SRC-020:** Fetch `v1.16.1` into `vendor/lza`.
- **SRC-021:** Verify the exact commit.
- **SRC-022:** Generate a manifest containing every archived path and its SHA-256 digest.
- **SRC-023:** Create the ZIP from the contents inside the repository root, not from a parent directory that would add a top-level folder.
- **SRC-024:** Exclude `.git`, local build output, credentials, and workflow evidence.
- **SRC-025:** Run `zip -T` or equivalent integrity validation.
- **SRC-026:** Compute the ZIP SHA-256.
- **SRC-027:** Upload to an immutable content-addressed key, for example:

```text
release/v1.16.1/8b43dc6e347b5fc1c477940c7f71ea595fbf19ab/<ZIP_SHA256>.zip
```

- **SRC-028:** Capture the S3 object version ID and ETag.
- **SRC-029:** Download the exact object version to a temporary path and verify its SHA-256 before using it in the installer.

---

## 18. Phase 4 — Synthesize the LZA installer template

`deploy/scripts/synth-installer.sh` MUST run from the locked source and use Node/Yarn versions from `lza.lock`.

Required command shape:

```bash
cd vendor/lza/source
corepack enable
corepack prepare yarn@1.22.22 --activate
HUSKY=0 yarn install --frozen-lockfile
yarn build

cd packages/@aws-accelerator/installer
yarn cdk synth \
  --context use-s3-source=true \
  --context s3-source-kms-key-arn="${LZA_SOURCE_KMS_KEY_ARN}" \
  --output "${GITHUB_WORKSPACE}/build/cdk.out"
```

- **SYN-001:** Use the template `build/cdk.out/AWSAccelerator-InstallerStack.template.json`.
- **SYN-002:** Run `aws cloudformation validate-template` on it in GovCloud.
- **SYN-003:** Run `cfn-lint` locally.
- **SYN-004:** Enumerate `.Parameters | keys[]` with `jq` and save the result.
- **SYN-005:** Assert every intended parameter exists before passing it to CloudFormation.
- **SYN-006:** Do not blindly pass a parameter copied from an older LZA release.
- **SYN-007:** Record the synthesized template SHA-256.

The locked installer source defines the `use-s3-source` context and the S3 bucket/object parameters. Source references:

- <https://github.com/awslabs/landing-zone-accelerator-on-aws/blob/v1.16.1/source/packages/%40aws-accelerator/installer/bin/installer.ts>
- <https://github.com/awslabs/landing-zone-accelerator-on-aws/blob/v1.16.1/source/packages/%40aws-accelerator/installer/lib/installer-stack.ts>

---

## 19. Phase 4 — Deploy or update the LZA installer stack by CLI

`deploy/scripts/deploy-installer.sh` MUST use `aws cloudformation deploy`, not a console stack launch.

### 19.1 Expected parameters

The agent MUST inspect the synthesized template and use these values when the corresponding parameters are present:

```text
RepositorySource=s3
RepositoryBucketName=<GovCloud source bucket>
RepositoryBucketObject=<immutable S3 object key>
RepositoryBucketKmsKeyArn=<source bucket KMS key ARN when present>
ManagementAccountEmail=<management email>
LogArchiveAccountEmail=<log archive email>
AuditAccountEmail=<audit email>
ControlTowerEnabled=Yes
AcceleratorPrefix=AWSAccelerator
ConfigurationRepositoryLocation=s3
UseExistingConfigRepo=No
EnableApprovalStage=No
EnableDiagnosticsPack=Yes
```

- **DEP-001:** Use stack name `AWSAccelerator-Installer` unless the synthesized template or official locked release requires `AWSAccelerator-InstallerStack`; discover and consistently record the actual deployed stack name.
- **DEP-002:** Use `CAPABILITY_NAMED_IAM`.
- **DEP-003:** Pass `--role-arn` for the dedicated CloudFormation execution role.
- **DEP-004:** Use `--no-fail-on-empty-changeset` for idempotent re-runs.
- **DEP-005:** Tag the stack with `ManagedBy=GitHubActions`, GitHub repository, GitHub run ID, LZA version, and LZA commit.
- **DEP-006:** Poll the stack by stack ID until `CREATE_COMPLETE` or `UPDATE_COMPLETE`.
- **DEP-007:** Treat rollback, failed, import rollback, and update rollback terminal states as failure.
- **DEP-008:** On failure, collect stack events in chronological order and upload them as evidence.
- **DEP-009:** Do not automatically delete a failed stack; preserve it for diagnostics.

Example command shape:

```bash
aws cloudformation deploy \
  --region us-gov-west-1 \
  --stack-name AWSAccelerator-Installer \
  --template-file build/cdk.out/AWSAccelerator-InstallerStack.template.json \
  --role-arn "${LZA_CLOUDFORMATION_EXECUTION_ROLE_ARN}" \
  --capabilities CAPABILITY_NAMED_IAM \
  --no-fail-on-empty-changeset \
  --parameter-overrides \
    RepositorySource=s3 \
    RepositoryBucketName="${LZA_SOURCE_BUCKET}" \
    RepositoryBucketObject="${LZA_SOURCE_OBJECT_KEY}" \
    RepositoryBucketKmsKeyArn="${LZA_SOURCE_KMS_KEY_ARN}" \
    ManagementAccountEmail="${MANAGEMENT_ACCOUNT_EMAIL}" \
    LogArchiveAccountEmail="${LOG_ARCHIVE_ACCOUNT_EMAIL}" \
    AuditAccountEmail="${AUDIT_ACCOUNT_EMAIL}" \
    ControlTowerEnabled=Yes \
    AcceleratorPrefix=AWSAccelerator \
    ConfigurationRepositoryLocation=s3 \
    UseExistingConfigRepo=No \
    EnableApprovalStage=No \
    EnableDiagnosticsPack=Yes
```

The script MUST build the actual parameter list dynamically after inspecting the template so a defaulted/renamed parameter does not cause an opaque deployment failure.

---

## 20. Phase 4 — Start and verify the LZA pipelines

### 20.1 Correlate exact executions

`deploy/scripts/wait-codepipeline.sh` MUST:

- **PIP-001:** Accept a pipeline name and an exact execution ID.
- **PIP-002:** Poll `get-pipeline-execution`, not merely the first item returned by `list-pipeline-executions`.
- **PIP-003:** Stop successfully only on `Succeeded`.
- **PIP-004:** Stop unsuccessfully on `Failed`, `Stopped`, `Superseded`, or a defined timeout.
- **PIP-005:** On failure, enumerate failed stage/action executions and retrieve associated CodeBuild build IDs and CloudWatch logs.
- **PIP-006:** Mask credentials and tokens from logs.

### 20.2 Installer pipeline

- **PIP-010:** After installer stack completion, discover the installer pipeline by exact stack outputs/resources or expected locked-release naming.
- **PIP-011:** Detect whether a new execution was automatically started by the stack update.
- **PIP-012:** Correlate an automatic execution by start time later than the stack update and expected source revision.
- **PIP-013:** If no correlated execution exists, call `start-pipeline-execution` by API.
- **PIP-014:** Record and poll the exact execution ID.

### 20.3 Bootstrap and final core-pipeline executions

- **PIP-020:** Discover the core pipeline from stack resources or the expected name `AWSAccelerator-Pipeline`.
- **PIP-021:** Correlate the bootstrap core execution invoked by the successful installer execution using the pre-installer execution baseline, start time, source revision, and installer timing.
- **PIP-022:** If the installer did not start a bootstrap core execution, start one through `start-pipeline-execution` before publishing the GitHub-controlled configuration.
- **PIP-023:** Record and poll the exact bootstrap core execution ID until `Succeeded`.
- **PIP-024:** After bootstrap success, discover the S3 configuration source and publish or idempotently reuse the exact desired configuration object version. Correlate an automatic source-triggered execution for that version; only when none appears within the bounded correlation window may the workflow call `start-pipeline-execution` once.
- **PIP-025:** Record and poll the correlated or explicitly started execution as the final desired-configuration core execution.
- **PIP-026:** Verify the final execution's S3 configuration source revision corresponds to the object version recorded by `publish-config-s3.sh` where CodePipeline exposes that revision.
- **PIP-027:** Do not declare the deployment complete when only the installer pipeline or only the bootstrap core execution succeeds.
- **PIP-028:** Do not publish a new configuration object version while any core execution is in progress.
- **PIP-029:** Preserve both core execution IDs and statuses in evidence.

AWS documents that the core pipeline validates configuration and uses CodeBuild/CDK to deploy stacks across managed accounts and Regions:

- <https://docs.aws.amazon.com/solutions/latest/landing-zone-accelerator-on-aws/awsaccelerator-pipeline.html>
- <https://docs.aws.amazon.com/solutions/latest/landing-zone-accelerator-on-aws/update-the-solution.html>

---

### 20.4 Control Tower post-LZA health and no-mutation check

After the final desired-configuration core execution succeeds:

- **PIP-030:** Re-run the complete Phase 3 read-only Control Tower verification.
- **PIP-031:** Require landing zone `ACTIVE` and `IN_SYNC`.
- **PIP-032:** Require the same landing-zone ARN, version, manifest semantics, baselines, and required controls.
- **PIP-033:** Require the Control Tower organization trail and Config resources to remain the sole owners of those domains.
- **PIP-034:** Fail if LZA created a duplicate organization trail or replaced Control Tower-managed Config resources.
- **PIP-035:** Capture the post-LZA `ListLandingZoneOperations` snapshot and compare it to the pre-LZA snapshot by operation identifier.
- **PIP-036:** Require zero new `CREATE`, `UPDATE`, or `RESET` operations during Phase 4 and record `unexpectedLzaLandingZoneMutations: 0`.
- **PIP-037:** Re-render the LZA Control Tower projection after packaging and require it still equals live state; this detects packaging/render drift between preflight and the exact deployed configuration object.

---

## 21. GitHub workflow specifications

### 21.1 Shared workflow security

- **WF-001:** Default permissions are `contents: read`; grant `id-token: write` only to AWS jobs.
- **WF-002:** Use exact GitHub Environments so OIDC subjects are stable and discoverable.
- **WF-003:** Use concurrency group `govcloud-foundation-prod` with `cancel-in-progress: false` for mutating workflows.
- **WF-004:** Never provide AWS credentials to untrusted fork pull requests.
- **WF-005:** Set explicit timeouts and upload redacted diagnostics with `if: always()`.
- **WF-006:** GitHub-hosted runners may process only non-export-controlled administrative metadata. Use an approved self-hosted runner when organization policy requires a US-person or boundary-controlled runner.
- **WF-007:** No account email, OU name, tag, commit message, artifact, or log may contain export-controlled or workload content.

### 21.2 `01-pr-validate.yml`

Delivered with Phase 1. Step 3 invokes the Phase 0 script (Section 21.9); step 5 is the only step that needs a credential, and it is what separates this workflow from Phase 0's.

Job order:

1. Check out the exact event SHA.
2. Check out and verify pinned LZA source.
3. Run offline repository validation.
4. Render templates with synthetic test IDs and validate schemas/ownership tests.
5. On trusted branches/environments after OIDC bootstrap, assume the read-only validation role and run the exact live LZA validator.
6. Upload validation evidence and digests.

### 21.3 `04-phase1-vend-govcloud-accounts.yml`

1. Run offline validation.
2. Assume commercial account-vending OIDC role.
3. Verify commercial identity/Organization.
4. Verify active management GovCloud pair.
5. Create or resume `LogArchive` and `Audit` pair operations.
6. Poll exact account operation IDs.
7. Produce Phase 1 evidence.

### 21.4 `05-phase2-provision-govcloud-organization.yml`

1. Validate Phase 1 evidence against live commercial mapping.
2. Assume GovCloud foundation role.
3. Create/verify GovCloud Organization.
4. Create/verify Security and Infrastructure OUs.
5. Invite/accept/place LogArchive and Audit.
6. Verify pre-Control-Tower resource cleanliness and ownership.
7. Produce Phase 2 evidence.

### 21.5 `06-phase3-deploy-control-tower.yml`

1. Validate repository and Phase 1/2 evidence.
2. Assume GovCloud foundation role.
3. Run Control Tower/CloudTrail/Config/Organizations preflight.
4. Deploy/verify the four Control Tower API prerequisite service roles.
5. Deploy/verify Control Tower KMS stack.
6. Render and validate the version-4.0 manifest.
7. Create/update/reset landing zone as needed; poll exact operation.
8. Register/update/reset Infrastructure baseline; poll exact operation.
9. Resolve current GovCloud control support.
10. Enable/update/reset declared controls; poll exact operations.
11. Verify backing artifacts, landing-zone drift, logging, Config, service roles, and ownership.
12. Produce Phase 3 evidence.

### 21.6 `07-phase4-deploy-lza.yml`

1. Validate Phase 3 evidence against live Control Tower state.
2. Run offline and live LZA validation.
3. Render the LZA Control Tower projection and require exact equality with live Phase 3 state.
4. Snapshot and hash all landing-zone operations; require no operation in progress.
5. Verify/request CodeBuild quota; stop until applied quota is at least three.
6. Create/verify the LZA source KMS key/bucket.
7. Package/publish/verify exact pinned LZA source.
8. Synthesize/validate installer with S3 source and configuration.
9. Assert installer parameter `ControlTowerEnabled=Yes`.
10. Deploy/update installer stack through CloudFormation API.
11. Correlate/poll installer pipeline.
12. Correlate/poll bootstrap core pipeline.
13. Discover LZA-managed configuration S3 source.
14. Publish the desired six-file configuration object version.
15. Correlate an automatic final core execution for the selected S3 version, or start it once when no automatic execution appears; then poll the exact ID.
16. Capture the post-LZA operation snapshot and require zero new landing-zone create/update/reset operations.
17. Re-verify Control Tower health, projection equality, and ownership.
18. Produce Phase 4 and aggregate evidence.

### 21.7 `08-verify-platform.yml`

- Default mode is read-only.
- Verify all four phase gates, Control Tower drift, baselines/controls, ownership, S3 artifacts, stack health, and exact last approved pipeline executions.
- Scheduled failure MUST create/update a GitHub issue through GitHub API.
- Repair operations require explicit `repair=true` and still may not delete/decommission resources.

### 21.8 `09-deploy-platform.yml`

This is the normal operator entry point after OIDC bootstrap.

- Trigger by `workflow_dispatch` and optionally protected default-branch changes.
- Invoke Phase 1, Phase 2, Phase 3, Phase 4, then verification in order.
- Pass phase evidence as artifacts/outputs and independently revalidate live AWS state at each boundary.
- Do not start a later phase if an earlier gate is incomplete.
- A config-only change may skip account/Organization mutations but MUST rerun Phase 3 read-only checks before Phase 4.

### 21.9 `validate-offline.yml` — Phase 0

*(Added 2026-09-02; listed last to keep the numbering above stable. Delivered first.)* The Phase 0
workflow, `<workload-slug>_validate-offline.yml` (REQ-049).

- Triggers: `pull_request`; `push` to `main` with a `paths:` filter over `lza.lock`, `config/**`,
  `control-tower/**`, `deployment/**`, `deploy/**`, `tests/**` and the workflow file itself;
  `workflow_dispatch` with inputs `plan_ref` and `commit` and no other required input without a
  default.
- Permissions: `contents: read` and nothing else (REQ-048). No `id-token: write`, no environment,
  no secret beyond `GITHUB_TOKEN`.
- Job order: check out the exact event SHA; check out upstream LZA into `vendor/lza` and verify
  `v1.16.1^{commit}` against `lza.lock` (REP-011); run `deploy/scripts/validate-config-offline.sh`;
  upload the validation evidence and the Section 7.5 digests that are computable offline
  (input-set, baselines, controls, ownership matrix, each LZA file and the aggregate LZA
  configuration).
- Concurrency: a literal group beginning with the file's own name, never `cancel-in-progress`
  (WF-003 names the production group; Phase 0 mutates nothing and uses its own).
- It MUST exit nonzero if any of the eight Section 7.1 checks fails, and MUST NOT claim the exact
  live LZA validator ran (REQ-050).

---

## 22. Machine-verifiable definition of done

The platform is **done** only when every applicable check below passes in `09-deploy-platform.yml` and again in `08-verify-platform.yml`.

### 22.1 Repository and provenance

- **DONE-001:** `lza.lock` contains LZA `v1.16.1`, exact commit, Node/Yarn versions, and Control Tower version `4.0`.
- **DONE-002:** The upstream LZA tag resolves to the locked commit.
- **DONE-003:** All required files in Section 5 exist.
- **DONE-004:** Exactly six LZA configuration files exist and no customization file exists.
- **DONE-005:** Control Tower manifest, baseline/control files, ownership matrix, and evidence validate against repository schemas.
- **DONE-006:** No unresolved placeholder exists in a rendered production input.
- **DONE-007:** Offline validation and exact live LZA validation both exit zero.
- **DONE-008:** Every third-party Action reference is a full commit SHA.
- **DONE-009:** Secret scanning finds no static AWS key, GitHub PAT, OIDC JWT, or password.
- **DONE-010:** Desired-state digests are recorded and match the deployed evidence.

### 22.2 Phase 1 commercial/account-pair checks

- **DONE-020:** Commercial OIDC identity equals the expected commercial management account in partition `aws`.
- **DONE-021:** Commercial Organization exists with `FeatureSet=ALL` and the caller is its management account.
- **DONE-022:** Management GovCloud pair is `ACTIVE` and its GovCloud ID matches Phase 2 caller identity.
- **DONE-023:** `LogArchive` and `Audit` account-pair operations are `SUCCEEDED`.
- **DONE-024:** All paired commercial/GovCloud IDs and operation IDs are recorded.

### 22.3 Phase 2 GovCloud Organization checks

- **DONE-030:** GovCloud caller is the expected management account in partition `aws-us-gov`.
- **DONE-031:** GovCloud Organization exists with all features and exactly one root.
- **DONE-032:** `Security` and `Infrastructure` each exist exactly once directly beneath Root.
- **DONE-033:** Active GovCloud accounts are exactly Management, LogArchive, and Audit for the strict initial deployment.
- **DONE-034:** Management parent is Root; shared-account parent is Security.
- **DONE-035:** No active onboarding access key remains.
- **DONE-036:** The three GovCloud OIDC roles can be assumed only from their exact intended GitHub subjects.

### 22.4 Phase 3 Control Tower checks

- **DONE-040:** Exactly one landing-zone ARN is returned in `us-gov-west-1`.
- **DONE-041:** Landing-zone version is `4.0`, status is `ACTIVE`, and drift is `IN_SYNC`.
- **DONE-042:** Landing-zone remediation types include `INHERITANCE_DRIFT`.
- **DONE-043:** Returned manifest semantic values equal the desired manifest and its digest is recorded.
- **DONE-044:** Centralized logging uses LogArchive; Config and security roles use Audit.
- **DONE-045:** Control Tower KMS key is enabled, symmetric, single-Region, correctly aliased, and policy-validated.
- **DONE-046:** All four Control Tower API prerequisite roles exist at path `/service-role/` with expected trust and policy semantics, and their ARNs/policy digests are recorded.
- **DONE-047:** `AWSControlTowerExecution` exists as expected in Control Tower-managed accounts.
- **DONE-048:** Infrastructure has `AWSControlTowerBaseline` version `5.0`, status `SUCCEEDED`, and no inheritance drift.
- **DONE-049:** Every required control is enabled on the intended OU, has `SUCCEEDED` status, is not drifted, and has its backing artifact.
- **DONE-050:** GovCloud control-support evidence was generated from current APIs.
- **DONE-051:** Exactly one intended Control Tower organization trail is logging to the expected destination with expected KMS encryption.
- **DONE-052:** Expected Config integration and aggregator are active, with no duplicate recorders/delivery channels/aggregators.
- **DONE-053:** No Control Tower managed policy, role, StackSet, Config resource, or trail has been directly modified by LZA/custom automation.
- **DONE-054:** `LogArchiveBaseline`, `CentralConfigBaseline`, and `CentralSecurityRolesBaseline` are present on the intended shared accounts and report successful, non-drifted state.
- **DONE-055:** The Audit account uses the expected landing-zone-4.0 service-linked Config aggregator; no obsolete aggregation authorizations or duplicate customer-managed aggregators exist.

### 22.5 Phase 4 LZA source/configuration checks

- **DONE-060:** Source bucket is in Management/us-gov-west-1, versioned, KMS-encrypted, blocked from public access, and TLS-only.
- **DONE-061:** Exact pinned source archive SHA-256, key, version ID, ETag, and manifest are recorded and reverified after download.
- **DONE-062:** Configuration ZIP contains exactly the six root YAML files.
- **DONE-063:** Configuration S3 bucket/key were discovered from the core pipeline rather than guessed.
- **DONE-064:** Exact configuration object version, checksum, metadata, archive digest, and six-file digest match GitHub desired state.
- **DONE-065:** The pre-deployment LZA Control Tower projection equals live Phase 3 state, contains `accountAutoEnrollment: true`, and both canonical digests are recorded.
- **DONE-066:** Pre/post Phase 4 landing-zone-operation snapshots show zero new `CREATE`, `UPDATE`, or `RESET` operations.

### 22.6 Installer and pipeline checks

- **DONE-070:** Synthesized installer template digest is recorded and validation/lint succeeds.
- **DONE-071:** Installer parameters show `RepositorySource=s3`, `ConfigurationRepositoryLocation=s3`, and `ControlTowerEnabled=Yes`.
- **DONE-072:** Installer stack is `CREATE_COMPLETE` or `UPDATE_COMPLETE` with termination protection as designed.
- **DONE-073:** Exact correlated installer pipeline execution is `Succeeded`.
- **DONE-074:** Exact bootstrap core execution is `Succeeded`.
- **DONE-075:** Exact final desired-configuration core execution is `Succeeded` and references the recorded configuration revision where exposed.
- **DONE-076:** No failed `AWSAccelerator-*` stack remains from the current deployment.
- **DONE-077:** Post-LZA Control Tower verification still reports `ACTIVE` and `IN_SYNC` with no ownership collision.
- **DONE-078:** Post-LZA projection equality still holds and evidence reports `unexpectedLzaLandingZoneMutations: 0`.

### 22.7 Evidence checks

`build/deployment-evidence.json` MUST include at least:

```json
{
  "schemaVersion": 2,
  "github": {
    "repository": "owner/repo",
    "sha": "...",
    "runId": "...",
    "workflow": "09-deploy-platform.yml"
  },
  "commercial": {
    "managementAccountId": "...",
    "organizationId": "..."
  },
  "govCloud": {
    "managementAccountId": "...",
    "organizationId": "...",
    "rootId": "...",
    "securityOuId": "...",
    "infrastructureOuId": "..."
  },
  "accounts": {
    "logArchive": {"commercialId": "...", "govCloudId": "..."},
    "audit": {"commercialId": "...", "govCloudId": "..."}
  },
  "controlTower": {
    "landingZoneArn": "...",
    "version": "4.0",
    "status": "ACTIVE",
    "driftStatus": "IN_SYNC",
    "manifestSha256": "...",
    "lastOperationId": "...",
    "kmsKeyArn": "...",
    "prerequisiteServiceRoles": [],
    "preLzaOperationsSnapshotSha256": "...",
    "postLzaOperationsSnapshotSha256": "...",
    "unexpectedLzaLandingZoneMutations": 0,
    "baselines": [],
    "controls": [],
    "organizationTrail": {},
    "configIntegration": {"aggregatorType": "SERVICE_LINKED", "aggregationAuthorizations": 0},
    "sharedAccountBaselines": []
  },
  "lza": {
    "version": "v1.16.1",
    "commit": "8b43dc6e347b5fc1c477940c7f71ea595fbf19ab",
    "controlTowerProjectionSha256": "...",
    "liveControlTowerComparableStateSha256": "...",
    "sourceArtifact": {},
    "configurationArtifact": {},
    "installerStack": {},
    "installerExecutionId": "...",
    "bootstrapCoreExecutionId": "...",
    "finalCoreExecutionId": "..."
  },
  "ownershipVerification": {
    "duplicateOrganizationTrails": 0,
    "duplicateConfigAggregators": 0,
    "duplicateConfigRecorders": 0,
    "violations": []
  }
}
```

- **DONE-080:** Evidence validates against `deployment/schemas/deployment-evidence.schema.json`.
- **DONE-081:** Evidence contains no secrets, raw JWTs, temporary credentials, or customer workload data.
- **DONE-082:** Evidence hashes and live AWS verification agree.

---

### 22.8 Phase 0 offline checks

*(Added 2026-09-02.)* These are the checks Gate 0 (Section 26) is judged on. Each is one command
with a nonzero exit on failure, run in `<workload-slug>_validate-offline.yml` on a runner holding no
AWS credential.

- **DONE-083:** The upstream LZA tag `v1.16.1` resolves to the commit in `lza.lock`, and `lza.lock`
  matches Section 5.1 exactly (DONE-001, DONE-002 evaluated offline).
- **DONE-084:** The Node major and Yarn version in `lza.lock` match the pinned upstream lockfile.
- **DONE-085:** Every JSON and YAML file under `config/`, `control-tower/` and `deployment/` parses.
- **DONE-086:** `deployment/inputs.example.yaml`, the Control Tower manifest template, baselines,
  controls, ownership matrix and evidence examples validate against `deployment/schemas/`.
- **DONE-087:** No unresolved placeholder token exists outside the manifest template's declared
  placeholder set.
- **DONE-088:** `actionlint`, `shellcheck`, `yamllint`, `cfn-lint` and every Bats test under
  `tests/` exit zero.
- **DONE-089:** The ownership tests reject duplicate CloudTrail, Config and control ownership
  (`tests/ownership.bats` exits zero against `control-tower/ownership-matrix.yaml`).
- **DONE-090:** The SHA-256 digests of the desired-state inputs are recorded in the uploaded
  evidence and are identical across two runs on the same commit.
- **DONE-091:** The workflow run's permissions are `contents: read` only, it names no environment,
  and no step assumed an AWS role (REQ-048).

## 23. Idempotency and error-handling requirements

- **IDEM-001:** Every ensure script MUST implement read/compare/create-or-update/verify behavior.
- **IDEM-002:** Never retry account creation with a new email after a terminal failure.
- **IDEM-003:** Never start a second Control Tower, baseline, control, CloudFormation, or CodePipeline mutation while a conflicting operation is active.
- **IDEM-004:** Poll exact operation IDs, not merely the newest listed operation.
- **IDEM-005:** Use bounded exponential backoff with jitter for throttling/eventual consistency.
- **IDEM-006:** A no-change run MUST succeed without creating a new landing-zone operation, baseline operation, control operation, source object version, config object version, or pipeline execution unless explicit replay is requested. It MUST prove that the previously successful exact source/configuration revisions remain deployed.
- **IDEM-007:** Drift repair MUST use Control Tower reset APIs; never edit Control Tower backing artifacts directly.
- **IDEM-008:** Config-only LZA changes may reuse the pinned source and installer, but must revalidate Control Tower and run an exact final core execution.
- **IDEM-009:** LZA version changes require source repackaging, installer synthesis/deployment, installer pipeline, and core pipeline.
- **IDEM-010:** Landing-zone version changes require a dedicated reviewed migration; do not combine them casually with unrelated LZA configuration changes.
- **IDEM-011:** Do not cancel in-progress account, Control Tower, baseline/control, or LZA operations because a newer GitHub commit appears.
- **IDEM-012:** Preserve failed resources and operation identifiers for diagnostics; do not auto-delete the failed stack/landing zone.
- **IDEM-013:** A Phase 4 no-change or deployment run that creates a Control Tower landing-zone operation MUST fail as an ownership violation and require correction of the LZA projection in a reviewed Phase 3 change.

---

## 24. Diagnostics that must be collected automatically

On any failure, `deploy/scripts/collect-diagnostics.sh` MUST collect, redact, and upload:

1. GitHub SHA/run/workflow/job/event and desired-state digests.
2. Locked LZA and Control Tower versions.
3. Commercial and GovCloud caller identity summaries.
4. Account-creation status and failure reasons.
5. GovCloud Organization/OUs/account parents/handshakes.
6. Control Tower landing-zone details, pre/post Phase 4 operation snapshots, and exact operation results.
7. Control Tower prerequisite service-role paths, role IDs, trust-policy digests, and attached/inline policy summaries.
8. Baseline/control operation details and enabled-resource drift summaries.
9. Control Catalog support resolution for every declared control.
10. KMS key metadata and a redacted key-policy validation summary.
11. CloudTrail trail inventory/status/destination and Config recorder/aggregator inventory.
12. Control Tower StackSet and related CloudFormation failure details.
13. LZA validator output, config digests, and Control Tower projection comparison.
14. Installer/core CloudFormation events.
15. Exact CodePipeline execution/action data and failed CodeBuild/CloudWatch excerpts.
16. Source/configuration S3 object metadata, versions, checksums, and encryption/public-access state.
17. Redacted OIDC provider/trust-policy summaries; never JWTs.
18. LZA diagnostics-pack output when available.

- **DIAG-001:** Diagnostics are best-effort and MUST preserve the original failure exit code.
- **DIAG-002:** Artifacts MUST have a documented retention period.
- **DIAG-003:** Diagnostic artifacts MUST contain no export-controlled content, workload data, secrets, or credentials.

---

## 25. Prohibited shortcuts

- **NO-001:** Do not ask the operator to launch or edit CloudFormation in a console.
- **NO-002:** Do not ask the operator to create/invite/move accounts or OUs in a console.
- **NO-003:** Do not ask the operator to set up Control Tower through its console wizard.
- **NO-004:** Do not ask the operator to register an OU, enable a control, release a pipeline, or repair drift in a console.
- **NO-005:** Do not ask the operator to request CodeBuild quota through a console.
- **NO-006:** Do not ask the operator to create IAM OIDC providers, roles, or KMS keys through a console.
- **NO-007:** Do not use CodeCommit or CodeConnections.
- **NO-008:** Do not use mutable LZA branches or `latest` archives.
- **NO-009:** Do not trust the tag without commit verification.
- **NO-010:** Do not use a GitHub PAT for LZA source.
- **NO-011:** Do not use Control Tower Account Factory to create GovCloud accounts.
- **NO-012:** Do not enable landing-zone-wide `AWS-GR_REGION_DENY` in this no-console baseline. Use an API-manageable OU control when required.
- **NO-013:** Do not modify Control Tower-managed SCPs, Config rules, recorders, delivery channels, trails, roles, hooks, or StackSets directly.
- **NO-014:** Do not let LZA create a second organization trail or Config aggregator.
- **NO-015:** Do not declare success from a successful Control Tower operation without checking drift and backing artifacts.
- **NO-016:** Do not declare success from a green installer stack without exact pipeline success.
- **NO-017:** Do not use the newest pipeline status unless it is the exact execution correlated to the deployment.
- **NO-018:** Do not run normal production deployment from a developer laptop after OIDC bootstrap.
- **NO-019:** Do not retain onboarding credentials after OIDC tests pass.
- **NO-020:** Do not automatically remove, close, or decommission unexpected resources; stop and report drift.
- **NO-021:** Do not omit `accountAutoEnrollment` from LZA global configuration when Phase 3 enabled `INHERITANCE_DRIFT`.
- **NO-022:** Do not allow Phase 4 LZA to create, update, or reset the Control Tower landing zone; projection mismatch is a Phase 3 blocker.

---

## 26. Phase 0 and the four implementation phases, with completion gates

### Phase 0 — Offline repository validation (credential-free tracer)

Deliver `lza.lock` exactly as Section 5.1; the six mandatory LZA files under `config/` and nothing else there (REP-001); the Control Tower declarations under `control-tower/` with placeholders only; `deployment/inputs.example.yaml` and the repository schemas under `deployment/schemas/`; `deploy/scripts/validate-config-offline.sh` and the Bats tests under `tests/` it runs; the supporting files the gate needs (`.yamllint.yml`, `.gitignore`, `Makefile`); and the workflow `<workload-slug>_validate-offline.yml` (Section 21.9). No AWS resource, no OIDC, no Phase 1–4 workflow, no `infra/` or `policies/` content (REQ-050).

**Gate 0:** `<workload-slug>_validate-offline.yml` exits zero in GitHub Actions on the merged commit with no AWS credential present, every check in Section 22.8 passes, and the recorded digests validate. Phase 0 is the first workload of this program and is complete on Gate 0 alone.

### Phase 1 — Commercial bootstrap and account-pair vending

Building on the Phase 0 scaffold, deliver `01-pr-validate.yml` and the OIDC bootstrap content, the commercial Organization/OIDC, first-pair discovery/signup boundary, and `LogArchive`/`Audit` pair creation.

**Gate 1:** Every Phase 1 check in Section 22.2 passes and Phase 1 evidence validates.

### Phase 2 — GovCloud Organization and OIDC

Create/test GovCloud roles, remove onboarding keys, establish all-features GovCloud Organization, create direct-root `Security`/`Infrastructure` OUs, invite/accept/place shared accounts, and verify a clean Control Tower prerequisite state.

**Gate 2:** Every Phase 2 check in Section 22.3 passes and Phase 2 evidence validates.

### Phase 3 — Control Tower governance

Deploy and verify the four Control Tower API prerequisite service roles and KMS key, render/deploy landing-zone version 4.0 via API, enable auto-enrollment, register Infrastructure baseline, enable supported declared controls, and verify drift, CloudTrail, Config, roles, policies, and backing artifacts.

**Gate 3:** Every Phase 3 check in Section 22.4 passes and Phase 3 evidence validates.

### Phase 4 — LZA extension

Run exact live LZA validation, prove the LZA Control Tower projection is an exact no-op, snapshot landing-zone operations, publish source/config to S3, synthesize/deploy installer with `ControlTowerEnabled=Yes`, run exact installer/bootstrap/final core executions, and prove LZA neither mutated nor damaged/duplicated Control Tower governance.

**Gate 4:** Every Phase 4 check in Sections 22.5–22.7 passes and aggregate evidence validates.

### Continuous operation

- Every merged Control Tower desired-state change runs Phase 3 and Phase 4 verification.
- Every merged LZA configuration change reruns Phase 3 read-only checks, then Phase 4 deployment.
- Every LZA version change updates `lza.lock` in a reviewed commit.
- Every landing-zone version change is a separate reviewed migration.
- Scheduled `08-verify-platform.yml` must remain green or create/update a GitHub issue.

---

## 27. Final acceptance statement for the planning agent

Do not report the project complete until the following statement is true and supported by API evidence:

> The commercial management account has an active paired GovCloud management account; the commercial and GovCloud Organizations have all features enabled; the GovCloud organization contains Management at Root, LogArchive and Audit in the direct-root Security OU, and an empty direct-root Infrastructure OU; AWS Control Tower landing-zone version 4.0 was created or reconciled by the repository's own GitHub Actions through APIs after the four documented `/service-role/` prerequisite roles were verified, uses LogArchive for centralized logging and Audit for Config/security roles, is ACTIVE and IN_SYNC, has auto-enrollment enabled, has a successful AWSControlTowerBaseline version 5.0 on Infrastructure, and has every required supported control plus its backing artifact; the GitHub repository contains and validates the six mandatory LZA files against pinned LZA v1.16.1 commit `8b43dc6e347b5fc1c477940c7f71ea595fbf19ab`; GitHub Actions published the exact desired configuration to the LZA-managed versioned S3 configuration object, published exact pinned source to a separate versioned KMS-encrypted S3 source object, proved the LZA-derived Control Tower projection exactly matched live state with `accountAutoEnrollment: true`, deployed the installer with `ControlTowerEnabled=Yes`, and obtained `Succeeded` for the exact correlated installer, bootstrap core, and final desired-configuration core pipeline executions; pre/post operation snapshots prove LZA initiated zero landing-zone create/update/reset operations; post-LZA verification still reports Control Tower ACTIVE/IN_SYNC with no duplicate organization trail, Config aggregator, recorder, delivery channel, policy owner, or unresolved drift; and no active onboarding key, GitHub PAT, CodeCommit repository, CodeConnection, unresolved placeholder, failed current-deployment stack, or unverified operation remains.

---

## 28. Primary official references

1. AWS GovCloud first-pair signup: <https://docs.aws.amazon.com/govcloud-us/latest/UserGuide/getting-started-sign-up.html>
2. GovCloud onboarding credentials and CLI setup: <https://docs.aws.amazon.com/govcloud-us/latest/UserGuide/configure-using-cli.html>
3. `CreateGovCloudAccount`: <https://docs.aws.amazon.com/cli/latest/reference/organizations/create-gov-cloud-account.html>
4. `GetGovCloudAccountInformation`: <https://docs.aws.amazon.com/accounts/latest/APIReference/API_GetGovCloudAccountInformation.html>
5. AWS Control Tower in GovCloud: <https://docs.aws.amazon.com/govcloud-us/latest/UserGuide/govcloud-controltower.html>
6. Control Tower API landing-zone launch/version-4.0 manifest: <https://docs.aws.amazon.com/controltower/latest/userguide/lz-api-launch.html>
7. `CreateLandingZone`: <https://docs.aws.amazon.com/controltower/latest/APIReference/API_CreateLandingZone.html>
8. `UpdateLandingZone`: <https://docs.aws.amazon.com/controltower/latest/APIReference/API_UpdateLandingZone.html>
9. `GetLandingZone`: <https://docs.aws.amazon.com/cli/latest/reference/controltower/get-landing-zone.html>
10. Control Tower baselines: <https://docs.aws.amazon.com/controltower/latest/userguide/types-of-baselines.html>
11. Baseline and landing-zone compatibility: <https://docs.aws.amazon.com/controltower/latest/userguide/table-of-baselines.html>
12. `EnableBaseline`: <https://docs.aws.amazon.com/controltower/latest/APIReference/API_EnableBaseline.html>
13. `ListEnabledBaselines`: <https://docs.aws.amazon.com/cli/latest/reference/controltower/list-enabled-baselines.html>
14. Control Tower control behavior: <https://docs.aws.amazon.com/controltower/latest/controlreference/control-behavior.html>
15. OU Region deny control and parameter names: <https://docs.aws.amazon.com/controltower/latest/controlreference/ou-region-deny.html>
16. `EnableControl`: <https://docs.aws.amazon.com/controltower/latest/APIReference/API_EnableControl.html>
17. Control limitations and Control Catalog support checks: <https://docs.aws.amazon.com/controltower/latest/userguide/control-limitations.html>
18. Control Tower drift and repair: <https://docs.aws.amazon.com/controltower/latest/userguide/drift.html>
19. Auto-enrollment: <https://docs.aws.amazon.com/controltower/latest/userguide/account-auto-enrollment.html>
20. Control Tower KMS key requirements: <https://docs.aws.amazon.com/controltower/latest/userguide/configure-kms-keys.html>
21. `AWSControlTowerExecution`: <https://docs.aws.amazon.com/controltower/latest/userguide/awscontroltowerexecution.html>
22. Existing-account enrollment prerequisites: <https://docs.aws.amazon.com/controltower/latest/userguide/enrollment-prerequisites.html>
23. LZA overview/recommendation for Control Tower: <https://docs.aws.amazon.com/solutions/latest/landing-zone-accelerator-on-aws/solution-overview.html>
24. LZA prerequisites and Control Tower integration: <https://docs.aws.amazon.com/solutions/latest/landing-zone-accelerator-on-aws/prerequisites.html>
25. LZA mandatory accounts: <https://docs.aws.amazon.com/solutions/latest/landing-zone-accelerator-on-aws/mandatory-accounts.html>
26. LZA configuration files: <https://docs.aws.amazon.com/solutions/latest/landing-zone-accelerator-on-aws/using-configuration-files.html>
27. LZA S3 source pattern: <https://docs.aws.amazon.com/solutions/latest/landing-zone-accelerator-on-aws/source-code-location.html>
28. LZA S3 configuration update: <https://docs.aws.amazon.com/solutions/latest/landing-zone-accelerator-on-aws/step-3.-update-the-configuration-files.html>
29. LZA core pipeline: <https://docs.aws.amazon.com/solutions/latest/landing-zone-accelerator-on-aws/awsaccelerator-pipeline.html>
30. LZA `v1.16.1` package/runtime and validator: <https://github.com/awslabs/landing-zone-accelerator-on-aws/blob/v1.16.1/source/package.json>
31. LZA validator source: <https://github.com/awslabs/landing-zone-accelerator-on-aws/blob/v1.16.1/source/packages/%40aws-accelerator/accelerator/lib/config-validator.ts>
32. LZA installer source: <https://github.com/awslabs/landing-zone-accelerator-on-aws/blob/v1.16.1/source/packages/%40aws-accelerator/installer/lib/installer-stack.ts>
33. GitHub immutable OIDC subject claims: <https://docs.github.com/en/actions/reference/security/oidc#immutable-subject-claims>
34. AWS IAM OIDC provider creation: <https://docs.aws.amazon.com/IAM/latest/UserGuide/id_roles_providers_create_oidc.html>
35. GovCloud CLI configuration: <https://docs.aws.amazon.com/govcloud-us/latest/UserGuide/configure-using-cli.html>
36. AWS CLI `aws login`: <https://docs.aws.amazon.com/cli/latest/userguide/cli-configure-sign-in.html>
37. Control Tower API pre-launch prerequisites and four service roles: <https://docs.aws.amazon.com/controltower/latest/userguide/lz-api-prereques.html>
38. `ListLandingZoneOperations`: <https://docs.aws.amazon.com/controltower/latest/APIReference/API_ListLandingZoneOperations.html>
39. Pinned LZA Control Tower setup module: <https://github.com/awslabs/landing-zone-accelerator-on-aws/blob/v1.16.1/source/packages/%40aws-lza/lib/control-tower/setup-landing-zone/index.ts>
40. Pinned LZA landing-zone comparison/manifest logic: <https://github.com/awslabs/landing-zone-accelerator-on-aws/blob/v1.16.1/source/packages/%40aws-lza/lib/control-tower/setup-landing-zone/functions.ts>
41. Pinned LZA Control Tower module input, including account auto-enrollment: <https://github.com/awslabs/landing-zone-accelerator-on-aws/blob/v1.16.1/source/packages/%40aws-lza/interfaces/control-tower/setup-landing-zone.ts>
42. Pinned LZA Control Tower prerequisite role implementation: <https://github.com/awslabs/landing-zone-accelerator-on-aws/blob/v1.16.1/source/packages/%40aws-lza/lib/control-tower/setup-landing-zone/prerequisites/iam-role.ts>
