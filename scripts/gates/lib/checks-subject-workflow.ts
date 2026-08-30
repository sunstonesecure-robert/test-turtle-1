import { isAlias, isMap, isNode, isPair, isScalar, parseDocument, visit, type Scalar } from 'yaml';
import { isSubjectWorkflowPath } from '../../install-manifest';
import { SUBJECT_DEPLOY_ENVIRONMENT } from './environments';
import { isRepoRelative, normalizePath } from './globs';
import { scopeReachesReserved } from './reserved-paths';
import type { GateResult } from './runner';

/**
 * D6 — THE SUBJECT-WORKFLOW CONTENT GUARDS (T271, FR-069, GHI #174 option C′).
 *
 * WHY THIS EXISTS. A governed repo's `.github/workflows/` holds two kinds of thing
 * GitHub cannot tell apart and this product must: the MANAGEMENT action content
 * (the oversight workflows `init` installs — gates, writers, sweeps) and the
 * operator's own GOVERNED PRODUCT OUTPUT action content — their CI/CD for the
 * software the agents build (validate an LZA config, `cdk synth`, deploy via OIDC).
 * FR-068 reserved the directory wholesale, which kept the machinery safe and made the
 * deploy leg of the north star unreachable: an agent could never deliver the workflow
 * that deploys what it built (GHI #174). The namespace
 * `.github/workflows/subject_<name>.yml` (`SUBJECT_WORKFLOW_RE`, install-manifest)
 * is the carve-out, and THIS module is what makes the carve-out safe. D5 says WHERE an
 * agent may write; D6 says WHAT a file written there may do at runtime.
 *
 * THE PROPERTY THE GUARDS COMPOSE TO. With D6.3 holding, a subject workflow's only
 * write surface at runtime is the cloud, reached through OIDC into THE environment a
 * human approves — `subject-deploy`, by name, on a GitHub-hosted runner (D6.6).
 * Everything the management workflows can do to the repository — labels, comments,
 * check runs, statuses, branches, tags, dispatches, cancellations, every signal a
 * gate reads — a subject workflow cannot, and that is CHECKED here, not assumed. D6.2
 * keeps it from inserting itself into the oversight chain (no `issues`,
 * `workflow_run`, `pull_request_target`, no `plan/**`/`build/**` branches, no
 * `concurrency` group that would cancel an oversight run); D6.4 keeps it from reading
 * `ANTHROPIC_API_KEY` or the operator's PAT; D6.5 keeps unreviewed third-party ACTIONS
 * and IMAGES, and content the gate cannot see (reusable workflows, local actions under
 * the reserved `.github/actions`), out of it.
 *
 * WHAT D6.5 DOES NOT COVER, SAID PLAINLY. It pins `uses:` and container images. What a
 * `run:` step fetches at runtime — `npm ci`, `cdk deploy`, the operator's own
 * `deploy/lza.sh` — is unpinned code in any CI and is the operator's review
 * responsibility and the environment reviewer's, not this gate's. The one shape the
 * guard does refuse is the wholesale `curl … | sh`, because that is content nobody can
 * have read before it runs (security review 2026-08-29).
 *
 * DETERMINISTIC, AND WHY THE PARSER IS A DEPENDENCY. Every guard is a static read of
 * the YAML; no model interprets anything (constitution: Deterministic-First). The
 * file is parsed with the `yaml` package rather than a hand-rolled reader because a
 * hand-rolled parser over ADVERSARIAL YAML is exactly the bug class this gate exists
 * to prevent — a guard that reads `permissions: contents: read` where GitHub reads
 * `contents: write` (via an alias, a merge key, a duplicate key, a tag) has refused
 * nothing. So the guard must read exactly what GitHub runs: duplicate keys are a
 * parse error (`uniqueKeys`), D6.1 refuses anchors, aliases, tags and merge keys
 * outright rather than trying to resolve them the way GitHub would, and every string
 * guard (D6.4) runs over the PARSED scalar values, not the raw bytes — a double-quoted
 * `"${{ se\x63rets.X }}"` is `secrets.X` to GitHub's expression evaluator, and a
 * raw-text scan read bytes GitHub never sees (security review 2026-08-29).
 *
 * PURE. No network, no filesystem: the caller fetches file contents at the PR head
 * and injects the scanner runner (`ctx.scan`). That is what lets `deliverable-gate`,
 * `build-publish` and a unit test ask the SAME question of the SAME bytes. The one
 * non-static input — actionlint/zizmor — is injected, and when it is missing D6.5
 * FAILS: a scanner that did not run is not a scanner that found nothing (GHI #108,
 * absent ≠ success).
 *
 * D6.7 (a deliverable touching the namespace is ALWAYS operator-merged) is not a
 * content guard and does not live here — it is merge authority, decided by path class
 * in `checkpoint-paths.ts` and read by D3 (GHI #163 option 3).
 */

export interface SubjectWorkflowFile {
  /** repo-relative path, as the pull request lists it */
  path: string;
  /** the file's bytes at the PR head; `null` = the patch DELETES it */
  content: string | null;
}

export interface ScanFinding {
  tool: 'actionlint' | 'zizmor';
  path: string;
  message: string;
}

export interface SubjectGuardContext {
  /** the repository's default branch — the only branch a subject trigger may name */
  defaultBranch: string;
  /** the operator's own additional reserved areas (`withExtraReserved`, FR-068(d)) */
  extraReserved?: readonly string[];
  /** injected scanner runner over the files; `null`/absent = scanners unavailable,
   *  and D6.5 FAILS closed rather than passing unscanned content */
  scan?: ((files: SubjectWorkflowFile[]) => Promise<ScanFinding[]>) | null;
}

/** The `on:` keys a subject workflow may react to. Everything else — `issues`,
 *  `issue_comment`, `label`, `workflow_run`, `pull_request_target`, `schedule`,
 *  `repository_dispatch`, `create`/`delete` (freeze tags) — is a way into the
 *  oversight chain. */
const ALLOWED_TRIGGERS = new Set(['workflow_dispatch', 'push', 'pull_request']);
const ALLOWED_PR_TYPES = new Set(['opened', 'synchronize', 'reopened']);

/**
 * The permission scopes a subject workflow may hold, EXACTLY — key and value. Read
 * scopes for the code, packages and its own runs; `id-token: write` for OIDC (paired
 * with D6.6); `deployments: write` so the run can record a deployment against its
 * environment. Every other scope writes something a gate reads.
 */
const ALLOWED_PERMISSIONS: Readonly<Record<string, string>> = {
  contents: 'read',
  'id-token': 'write',
  actions: 'read',
  packages: 'read',
  deployments: 'write',
};

/** What each refused scope could FORGE — named in the refusal so the reader sees the
 *  capability, not just a denied key (GHI #127). Every value is a VERB PHRASE, because
 *  the template reads "with it the workflow could ${forges}" (consistency review
 *  2026-08-29: nine of twelve were noun phrases and the sentence did not parse). */
const SCOPE_FORGES: Readonly<Record<string, string>> = {
  contents: 'push branches and tags — the frozen plan tag and the governance record',
  issues: 'write labels and comments on work items — the signals the lifecycle gates read',
  'pull-requests': 'write labels, comments and merges on plan/** and build/** pull requests',
  checks: 'create check runs — plan-gate and deliverable-gate verdicts',
  statuses: 'set commit statuses — a required-check look-alike',
  actions: 'dispatch or cancel oversight runs',
  discussions: 'write discussion comments',
  pages: 'publish the site',
  'security-events': 'write code-scanning results',
  'repository-projects': 'edit project boards',
  attestations: 'write build attestations',
  models: 'run model inference from inside the workflow — a subject workflow is deterministic',
};

/** GitHub-HOSTED runner labels, by STRUCTURE: `ubuntu-latest`, `ubuntu-24.04`,
 *  `ubuntu-22.04-arm`, `ubuntu-slim`, `windows-latest`, `windows-2025`, `windows-11-arm`,
 *  `macos-latest`, `macos-15`, `macos-14-large`, `macos-15-intel`, `macos-latest-xlarge`.
 *  NOT `ubuntu-*` (Codex P1 on PR #175, 2026-08-30): a self-hosted runner carries whatever
 *  labels its owner typed, `ubuntu-prod` included, and the first version's prefix match
 *  called that hosted — so an agent's workflow could run on a machine with an instance
 *  profile without `id-token: write`, without `subject-deploy`, without anyone approving.
 *  Larger-runner labels are names an operator chooses and cannot be told from a
 *  self-hosted label by inspection; they are refused, and an allowlist read from the
 *  repository's runner list is the honest route if one is ever wanted. */
const HOSTED_RUNNER_RE = /^(?:ubuntu-(?:latest|slim|2[0-9]\.04)(?:-arm)?|windows-(?:latest|20[0-9]{2}|11-arm)|macos-(?:latest|1[0-9])(?:-intel|-large|-xlarge)?)$/;

/** The `curl … | sh` / `wget … | bash` shape: content nobody can have read before it
 *  runs. Deliberately narrow — see the module docblock on what D6.5 does not cover. */
const PIPE_TO_SHELL_RE = /\b(?:curl|wget)\b[^\n|]*\|\s*(?:sudo\s+(?:-\S+\s+)*)?(?:ba|z|da|k)?sh\b/;

/** GitHub filter grammar the plan-scope matcher does not speak (`[abc]` classes, `+`
 *  repetition). A `paths:` entry using them cannot be checked against the reserved
 *  set by `scopeReachesReserved`, so it is refused rather than misread. */
const FILTER_GRAMMAR_UNSUPPORTED_RE = /[[\]+]/;

/** A pinned action: `owner/repo(/path)?@<40 lowercase hex>`. A tag or branch after
 *  the `@` is content that can change after the human read it. */
const PINNED_ACTION_RE = /^[A-Za-z0-9-]+\/[A-Za-z0-9_.-]+(?:\/[^@\s]+)?@[0-9a-f]{40}$/;
/** A digest-pinned container: `docker://<image>@sha256:<64 hex>`. */
const PINNED_DOCKER_RE = /^docker:\/\/[^@\s]+@sha256:[0-9a-f]{64}$/;
/** An image reference elsewhere (`container.image`, `services.*.image`) with a digest. */
const DIGEST_IMAGE_RE = /^[^@\s]+@sha256:[0-9a-f]{64}$/;

type GuardId = 'D6.1' | 'D6.2' | 'D6.3' | 'D6.4' | 'D6.5' | 'D6.6';

interface Violation {
  guard: GuardId;
  path: string;
  /** what is wrong — quoting the offending key/value */
  what: string;
  /** why it is refused and the way out (GHI #127) */
  why: string;
}

/** The plain-object shape of a parsed document — a map, or not. */
type Rec = Record<string, unknown>;
const isRec = (v: unknown): v is Rec => typeof v === 'object' && v !== null && !Array.isArray(v);
const isStr = (v: unknown): v is string => typeof v === 'string';
const show = (v: unknown): string => JSON.stringify(v) ?? String(v);

/**
 * Which of these paths are subject workflows — the ones D6 reads.
 *
 * Deliberately NOT "which are under `.github/workflows/`": a `.github/**` path outside
 * the namespace is reserved and is D5's refusal, phrased by D5 with the namespace
 * route. This function never returns it, so D6 and D5 cannot disagree about a file.
 */
export function subjectWorkflowPaths(paths: readonly string[]): string[] {
  return paths.filter((p) => isRepoRelative(p) && isSubjectWorkflowPath(normalizePath(p)));
}

/**
 * D6 — every guard, on every file, and every violation named.
 *
 * Runs ALL the guards rather than stopping at the first refusal, because the reader
 * of a refused build fixes the file once: a refusal that names one problem and then a
 * second on resubmission teaches the author that the gate is a wall to be probed.
 * `detail` on failure is every violation as `D6.n <file>: <what> — <why>` joined by
 * `; ` — and no guard sentence of this module's own contains `; `, so a reader may
 * split on the separator (only a scanner's quoted message could carry one); on pass it
 * says how many files passed which guards, so a green report is not mistakable for a
 * report that checked nothing.
 */
export async function checkD6SubjectWorkflowContent(
  files: SubjectWorkflowFile[],
  ctx: SubjectGuardContext,
): Promise<GateResult> {
  const base = { id: 'D6', requirement: 'FR-069' } as const;
  if (files.length === 0) {
    // Not a pass: nothing was checked. The CLI reports this through the catalogue's
    // `skip` with the same reason; here it is stated for a direct caller (GHI #108).
    return { ...base, status: 'not-applicable', detail: 'no subject workflow in this patch' };
  }

  const violations: Violation[] = [];
  const live: SubjectWorkflowFile[] = [];
  let deleted = 0;

  for (const file of files) {
    const path = normalizePath(file.path);
    // D6.1 — the namespace. A file handed to D6 that is not a subject workflow is a
    // caller error as much as a content error, and it is refused rather than judged:
    // judging it would imply the guards make a reserved path acceptable.
    if (!isRepoRelative(file.path) || !isSubjectWorkflowPath(path)) {
      violations.push({
        guard: 'D6.1',
        path: file.path,
        what: 'is not inside the subject-workflow namespace',
        why: 'an operator deploy workflow must be named `.github/workflows/subject_<name>.yml` (lowercase, digits and hyphens) — every other `.github/**` path is reserved (FR-068)',
      });
      continue;
    }
    if (file.content === null) {
      // A deletion has no content to judge. Removing a subject workflow is within the
      // namespace's licence; D6.1 is the only guard that applies.
      deleted += 1;
      continue;
    }
    live.push({ path, content: file.content });
    violations.push(...guardFile(path, file.content, ctx));
  }

  // D6.5, second half — the scanners. Over every live file, even ones the static
  // guards already refused: the report should name everything wrong with the file.
  if (live.length > 0) violations.push(...(await runScanners(live, ctx.scan)));

  if (violations.length > 0) {
    return {
      ...base,
      status: 'fail',
      detail: violations.map((v) => `${v.guard} ${v.path}: ${v.what} — ${v.why}`).join('; '),
    };
  }
  const parts = [`${live.length} subject workflow file(s) passed D6.1–D6.6 (namespace, triggers, permissions, secrets, supply chain incl. actionlint+zizmor, environment)`];
  if (deleted > 0) parts.push(`${deleted} deleted file(s) passed D6.1 (namespace) — nothing to read`);
  return { ...base, status: 'pass', detail: parts.join('; ') };
}

/* ------------------------------------------------------------------------- *
 * The per-file guards
 * ------------------------------------------------------------------------- */

function guardFile(path: string, content: string, ctx: SubjectGuardContext): Violation[] {
  const out: Violation[] = [];
  const v = (guard: GuardId, what: string, why: string): void => {
    out.push({ guard, path, what, why });
  };

  // ---- D6.1 — read exactly what GitHub runs -------------------------------------
  // `keepSourceTokens` so a double-quoted scalar's RAW spelling is inspectable: the
  // escape check below needs the bytes as written, the value checks need the value.
  const doc = parseDocument(content, { uniqueKeys: true, keepSourceTokens: true });
  const problems = [...doc.errors, ...doc.warnings];
  if (problems.length > 0) {
    v(
      'D6.1',
      `YAML does not parse cleanly: ${problems.map((p) => `${p.code}: ${p.message.split('\n')[0]}`).join(', ')}`,
      'the guard must read exactly what GitHub runs, and a document with a parse error or a duplicate key may run as something other than what it reads as',
    );
    return out;
  }
  const indirection = findIndirection(doc);
  if (indirection.length > 0) {
    v(
      'D6.1',
      `uses YAML indirection (${indirection.join(', ')})`,
      'anchors (`&`), aliases (`*`), explicit tags (`!!`) and merge keys (`<<`) are refused so the guard reads exactly what GitHub runs — write every key and value out in full',
    );
    return out;
  }
  // Every scalar VALUE as GitHub will see it — the input to every string guard below
  // (D6.4). Collected once from the AST rather than re-derived from `toJS()`, so a
  // value nested anywhere (an `env` map, a `with` input, a `run` script, a `name`) is
  // scanned wherever it sits.
  const scalars = collectScalars(doc);
  // A double-quoted scalar whose raw spelling escapes part of a `${{ }}` expression
  // (`"${{ se\x63rets.X }}"`, `"secrets"`, an escaped line break) reads one way
  // and runs another. The parsed-value scan below would catch the secret anyway; this
  // refusal is the belt to that brace, and it names the technique (security review
  // 2026-08-29).
  const escaped = scalars.filter((s) => s.raw !== null && s.raw.startsWith('"') && /\\/.test(s.raw) && /\$\{\{/.test(s.raw));
  if (escaped.length > 0) {
    v(
      'D6.1',
      `uses backslash escapes inside a \`\${{ }}\` expression (${escaped.map((s) => show(s.raw)).join(', ')})`,
      'a double-quoted YAML scalar with `\\x`, `\\u` or an escaped line break inside an expression reads one way and runs another — the guard must read exactly what GitHub runs, so write the expression plainly (single quotes or a block scalar)',
    );
    return out;
  }
  const wf: unknown = doc.toJS();
  if (!isRec(wf)) {
    v('D6.1', 'is not a workflow: the top level is not a map', 'a GitHub Actions workflow is a map with `on` and `jobs`');
    return out;
  }
  const on = wf['on'];
  const jobs = wf['jobs'];
  if (on === undefined) v('D6.1', 'has no `on`', 'a workflow with no trigger is not a workflow, and the guard refuses what it cannot classify');
  if (!isRec(jobs) || Object.keys(jobs).length === 0) {
    v('D6.1', 'has no `jobs` map', 'a workflow with no jobs is not a workflow, and the guard refuses what it cannot classify');
  }
  if (out.length > 0) return out;
  const jobMap = jobs as Rec;

  // ---- D6.2 — triggers -------------------------------------------------------------
  guardTriggers(on, ctx, v);
  // …and concurrency, which is a trigger's evil twin: it does not start a run, it
  // STOPS one, and GitHub's concurrency groups are repository-wide across workflows.
  const basename = path.replace(/^.*\//, '').replace(/\.ya?ml$/, '');
  guardConcurrency('concurrency', wf['concurrency'], basename, v);

  // ---- D6.3 — permissions, resolved per job -------------------------------------------
  const workflowPerms = wf['permissions'];
  /** job id → the map that resolved, for D6.6 (null = did not resolve to a map) */
  const resolved = new Map<string, Rec | null>();
  for (const [jobId, job] of Object.entries(jobMap)) {
    if (!isRec(job)) {
      v('D6.1', `job \`${jobId}\` is not a map`, 'a job is a map of `runs-on`, `permissions`, `steps`…');
      resolved.set(jobId, null);
      continue;
    }
    resolved.set(jobId, guardPermissions(jobId, job['permissions'], workflowPerms, v));
    guardConcurrency(`jobs.${jobId}.concurrency`, job['concurrency'], basename, v);
  }

  // ---- D6.4 — secrets, over the PARSED values (and the raw text as a second net) -------
  guardSecrets(scalars.map((s) => s.value), content, v);

  // ---- D6.5 — supply chain, static half ----------------------------------------------
  for (const [jobId, job] of Object.entries(jobMap)) {
    if (!isRec(job)) continue;
    guardSupplyChain(jobId, job, v);
  }

  // ---- D6.6 — where the job runs, and behind which approval --------------------------
  const firesOnPullRequest = isRec(on) && 'pull_request' in on;
  for (const [jobId, job] of Object.entries(jobMap)) {
    if (!isRec(job)) continue;
    // Every job, whatever its permissions: a self-hosted runner carries ambient cloud
    // credentials that need no `id-token` at all, so keying this on the permission
    // would leave `run: aws s3 rm --recursive` on an instance profile unguarded
    // (security review 2026-08-29). A subject workflow runs only where its only
    // credential is the OIDC token.
    // (A reusable-workflow call has no `runs-on` of its own — D6.5 refuses the call.)
    if (job['uses'] === undefined) guardRunsOn(jobId, job['runs-on'], v);
    const perms = resolved.get(jobId);
    if (!perms || perms['id-token'] !== 'write') continue;
    if (firesOnPullRequest) {
      // GitHub runs a workflow file ADDED in a same-repo pull request on that PR's own
      // `pull_request` event — i.e. the agent's unmerged output, before any human read
      // it. A PR-time job validates; it does not deploy.
      v(
        'D6.6',
        `job \`${jobId}\` has \`id-token: write\` in a workflow that fires on \`pull_request\``,
        'a `pull_request` run executes the pull request\'s own head — agent output no human has merged — so it may not mint a cloud token. A pull-request job validates and a deploy job runs on `push` to the default branch or on `workflow_dispatch`. Drop `id-token: write` from this job or drop the `pull_request` trigger',
      );
    }
    const env = job['environment'];
    const nameValue = isStr(env) ? env : isRec(env) ? env['name'] : undefined;
    const name = isStr(nameValue) ? nameValue.trim() : '';
    const why =
      `the environment IS the approval gate: its required reviewers are the per-deploy human approval and \`repo:<org>/<repo>:environment:${SUBJECT_DEPLOY_ENVIRONMENT}\` is the OIDC subject the cloud role's trust policy pins to. ` +
      'A name the guard cannot read, or one `init` did not provision, is an environment GitHub creates on first use with NO reviewers — a token with no human behind it. ' +
      `Declare \`environment: ${SUBJECT_DEPLOY_ENVIRONMENT}\` (init provisions it, you add its reviewers)`;
    if (name.length === 0) {
      v('D6.6', `job \`${jobId}\` has \`id-token: write\` and no \`environment\``, why);
    } else if (/\$\{\{/.test(name)) {
      v('D6.6', `job \`${jobId}\` has \`environment: ${show(nameValue)}\`, an expression`, why);
    } else if (name !== SUBJECT_DEPLOY_ENVIRONMENT) {
      v('D6.6', `job \`${jobId}\` has \`environment: ${show(name)}\`, not \`${SUBJECT_DEPLOY_ENVIRONMENT}\``, why);
    }
  }
  return out;
}

/** Every scalar in the document: its parsed value (what GitHub sees) and, where the
 *  parser kept it, its raw spelling (what the human read). */
function collectScalars(doc: ReturnType<typeof parseDocument>): { value: string; raw: string | null }[] {
  const out: { value: string; raw: string | null }[] = [];
  visit(doc, {
    Scalar(_key, node: Scalar) {
      if (typeof node.value !== 'string') return;
      const src = (node as { srcToken?: { source?: unknown } }).srcToken?.source;
      out.push({ value: node.value, raw: typeof src === 'string' ? src : null });
    },
  });
  return out;
}

/** `runs-on` must be a GitHub-hosted label (or a list of them). */
function guardRunsOn(jobId: string, runsOn: unknown, v: (g: GuardId, what: string, why: string) => void): void {
  const why =
    'a subject workflow runs only on a GitHub-hosted runner, where its only credential is the OIDC token the environment reviewer approved — a self-hosted or custom-labelled runner carries whatever credentials its machine has (an instance profile, a mounted key), and nothing here approves those. Use `ubuntu-latest` or another GitHub-hosted label — `ubuntu-<version>`, `windows-<version>`, `macos-<version>`, with their `-arm`/`-intel`/`-large`/`-xlarge` variants — a custom or larger-runner label is refused because it cannot be told from a self-hosted one';
  const labels = isStr(runsOn) ? [runsOn] : Array.isArray(runsOn) ? runsOn : null;
  if (runsOn === undefined) {
    v('D6.6', `job \`${jobId}\` has no \`runs-on\``, why);
    return;
  }
  if (!labels || labels.length === 0 || !labels.every((l) => isStr(l) && HOSTED_RUNNER_RE.test(l.trim()))) {
    v('D6.6', `job \`${jobId}\` has \`runs-on: ${show(runsOn)}\`, which is not a GitHub-hosted runner label`, why);
  }
}

/** A `concurrency` key may only name the workflow's OWN group, and may cancel nothing.
 *  GitHub concurrency groups are repository-wide: a subject workflow naming
 *  `deliverable-gate-<n>` or `build-merge-sweep` with `cancel-in-progress: true`
 *  cancels that oversight run mid-flight, and needs no `actions: write` to do it
 *  (security review 2026-08-29). */
function guardConcurrency(where: string, value: unknown, basename: string, v: (g: GuardId, what: string, why: string) => void): void {
  if (value === undefined) return;
  const why =
    `concurrency groups are repository-wide across workflows, so naming an oversight group cancels its run — a subject workflow may only serialize itself: a literal \`group\` starting with its own file name (\`${basename}\`), and no \`cancel-in-progress: true\` (a subject workflow cancels nothing)`;
  const group = isStr(value) ? value : isRec(value) ? value['group'] : undefined;
  if (!isStr(group) || group.trim().length === 0) {
    v('D6.2', `\`${where}\` has no literal \`group\` (${show(value)})`, why);
    return;
  }
  if (/\$\{\{/.test(group)) {
    v('D6.2', `\`${where}.group: ${show(group)}\` is an expression`, why);
  } else if (!group.trim().startsWith(basename)) {
    v('D6.2', `\`${where}.group: ${show(group)}\` does not start with \`${basename}\``, why);
  }
  if (isRec(value) && value['cancel-in-progress'] !== undefined && value['cancel-in-progress'] !== false) {
    v('D6.2', `\`${where}.cancel-in-progress: ${show(value['cancel-in-progress'])}\``, why);
  }
}

/** Anchors, aliases, explicit tags and merge keys, found in the document AST — the
 *  four ways a YAML file reads differently from how it resolves. */
function findIndirection(doc: ReturnType<typeof parseDocument>): string[] {
  const found = new Set<string>();
  visit(doc, {
    Alias() {
      found.add('alias `*`');
    },
    Node(_key, node) {
      if (isAlias(node)) return;
      if (isNode(node) && node.anchor) found.add(`anchor \`&${node.anchor}\``);
      if (isNode(node) && node.tag) found.add(`tag \`${node.tag}\``);
    },
    Pair(_key, pair) {
      if (isPair(pair) && isScalar(pair.key) && pair.key.value === '<<') found.add('merge key `<<`');
      if (isPair(pair) && isMap(pair.key)) found.add('a map used as a key');
    },
  });
  return [...found];
}

function guardTriggers(on: unknown, ctx: SubjectGuardContext, v: (g: GuardId, what: string, why: string) => void): void {
  if (!isRec(on)) {
    // `on: push` / `on: [push, pull_request]` — no filters at all, so the workflow
    // would fire on every branch, including `plan/**` and `build/**`.
    v(
      'D6.2',
      `\`on: ${show(on)}\` is the shorthand form`,
      `the shorthand carries no \`branches\`/\`paths\` filters, so it fires on every branch including plan/** and build/** — write \`on:\` as a map with \`branches: [${ctx.defaultBranch}]\` and a \`paths:\` filter`,
    );
    return;
  }
  for (const [event, spec] of Object.entries(on)) {
    if (!ALLOWED_TRIGGERS.has(event)) {
      v(
        'D6.2',
        `\`on.${event}\` is not an allowed trigger`,
        'a subject workflow may react only to `workflow_dispatch`, `push` and `pull_request` (filtered) — any other event is a way into the oversight chain (issues, comments, labels, other workflows\' runs, freeze tags, schedules)',
      );
      continue;
    }
    if (event === 'workflow_dispatch') {
      guardDispatchInputs(spec, v);
      continue;
    }
    // push / pull_request
    if (!isRec(spec)) {
      v(
        'D6.2',
        `\`on.${event}\` declares no filters`,
        `without \`branches: [${ctx.defaultBranch}]\` and a \`paths:\` filter it fires on every branch, including plan/** and build/**`,
      );
      continue;
    }
    for (const forbidden of ['tags', 'tags-ignore', 'branches-ignore', 'paths-ignore']) {
      if (forbidden in spec) {
        v(
          'D6.2',
          `\`on.${event}.${forbidden}\` is present`,
          forbidden.startsWith('tags')
            ? 'a tag filter lets the workflow fire on the freeze tags the oversight machinery pushes — subject workflows fire on the default branch only'
            : 'ignore-lists widen by omission — state the branches and paths the workflow fires on positively',
        );
      }
    }
    const branches = spec['branches'];
    const branchList = isStr(branches) ? [branches] : Array.isArray(branches) ? branches : null;
    if (!branchList || branchList.length !== 1 || branchList[0] !== ctx.defaultBranch) {
      v(
        'D6.2',
        `\`on.${event}.branches\` is ${branches === undefined ? 'missing' : show(branches)}`,
        `it must be exactly [${ctx.defaultBranch}] — the default branch — because any other pattern can match plan/** or build/** and run agent output before a human has merged it`,
      );
    }
    const paths = spec['paths'];
    if (!Array.isArray(paths) || paths.length === 0 || !paths.every(isStr)) {
      v(
        'D6.2',
        `\`on.${event}.paths\` is ${paths === undefined ? 'missing' : show(paths)}`,
        'a subject workflow fires only on the subject paths it deploys — declare a non-empty `paths:` list (e.g. `config/**`, `cdk/**`)',
      );
    } else {
      for (const entry of paths) {
        if (entry.trim().startsWith('!')) {
          v('D6.2', `\`on.${event}.paths\` entry ${show(entry)} is a negation`, 'the guard reads positive path filters only — list the paths the workflow fires on');
          continue;
        }
        // GitHub's filter grammar is wider than the plan-scope grammar the reserved-set
        // matcher speaks: `[pq]lans/**` is `plans/**` to GitHub and a literal to the
        // matcher, and `**/*.yml` swallows `plan-gate.yml` while matching no
        // representative reserved path. The guard reads only path filters it can PROVE
        // stay inside the subject (security review 2026-08-29).
        const trimmed = normalizePath(entry);
        if (FILTER_GRAMMAR_UNSUPPORTED_RE.test(trimmed)) {
          v(
            'D6.2',
            `\`on.${event}.paths\` entry ${show(entry)} uses filter syntax the guard cannot read`,
            'the guard reads only path filters it can prove stay inside the subject — `[abc]` character classes and `+` repetition are refused, so spell the directory out (`config/**`, `cdk/**`)',
          );
          continue;
        }
        const firstSegment = trimmed.split('/')[0] ?? '';
        if (/[*?]/.test(firstSegment)) {
          v(
            'D6.2',
            `\`on.${event}.paths\` entry ${show(entry)} starts with a wildcard`,
            'a filter whose first segment is a wildcard (`**/*.yml`, `*.md`) can match the oversight machinery and the governance record wherever they sit — the guard reads only path filters it can prove stay inside the subject, so start the filter with a literal top-level directory (`config/**`, `cdk/**`) or name the subject-workflow namespace itself',
          );
          continue;
        }
        const reaches = scopeReachesReserved([entry], ctx.extraReserved ?? []);
        if (reaches.length > 0) {
          v(
            'D6.2',
            `\`on.${event}.paths\` entry ${show(entry)} reaches the reserved set`,
            'a path filter that covers the oversight machinery or the governance record makes the workflow fire when the machinery changes — scope it to the subject paths (`config/**`, `cdk/**`, or the subject-workflow namespace itself)',
          );
        }
      }
    }
    if (event === 'pull_request' && spec['types'] !== undefined) {
      const types = spec['types'];
      const list = Array.isArray(types) ? types : [types];
      const bad = list.filter((t) => !isStr(t) || !ALLOWED_PR_TYPES.has(t));
      if (bad.length > 0) {
        v(
          'D6.2',
          `\`on.pull_request.types\` includes ${bad.map(show).join(', ')}`,
          'only `opened`, `synchronize` and `reopened` are allowed — `labeled`, `unlabeled`, `closed` and the rest react to the signals the lifecycle gates write',
        );
      }
    }
  }
}

/** `workflow_dispatch` MUST declare `inputs.plan_ref` and `inputs.commit`: the
 *  completion→dispatch hook passes exactly those (FR-070), and a workflow without them
 *  is skipped by the hook — so a file that declares the trigger and not the inputs is
 *  a deploy that never fires on the automated path. */
function guardDispatchInputs(spec: unknown, v: (g: GuardId, what: string, why: string) => void): void {
  const inputs = isRec(spec) ? spec['inputs'] : undefined;
  const why =
    'the completion hook dispatches every subject workflow with `plan_ref` (the official plan ref) and `commit` (the verified merged commit) — declare both under `on.workflow_dispatch.inputs` as optional string inputs';
  if (!isRec(inputs)) {
    v('D6.2', '`on.workflow_dispatch` declares no `inputs`', why);
    return;
  }
  for (const name of ['plan_ref', 'commit']) {
    const input = inputs[name];
    if (input === undefined) {
      v('D6.2', `\`on.workflow_dispatch.inputs.${name}\` is missing`, why);
      continue;
    }
    if (input !== null && !isRec(input)) {
      v('D6.2', `\`on.workflow_dispatch.inputs.${name}\` is ${show(input)}`, why);
      continue;
    }
    if (input && input['type'] !== undefined && input['type'] !== 'string') {
      v('D6.2', `\`on.workflow_dispatch.inputs.${name}.type\` is ${show(input['type'])}`, `${why} (type \`string\` or no type)`);
    }
    if (input && input['required'] !== undefined && input['required'] !== false) {
      v(
        'D6.2',
        `\`on.workflow_dispatch.inputs.${name}.required\` is ${show(input['required'])}`,
        `${why} — not required, so a human can also dispatch the workflow by hand without inventing values`,
      );
    }
  }
  // EVERY OTHER INPUT MUST BE SATISFIABLE WITH NOBODY WATCHING (Codex P2 on PR #175,
  // 2026-08-30). The hook sends exactly `plan_ref` and `commit`; a third input with
  // `required: true` and no `default` makes GitHub refuse every automated dispatch —
  // after the workload completed, which is precisely when no human is at the keyboard.
  for (const [name, input] of Object.entries(inputs)) {
    if (name === 'plan_ref' || name === 'commit') continue;
    if (isRec(input) && input['required'] !== undefined && input['required'] !== false && input['default'] === undefined) {
      v(
        'D6.2',
        `\`on.workflow_dispatch.inputs.${name}\` is required and has no default`,
        'the completion hook supplies only `plan_ref` and `commit`, so GitHub would refuse every automated dispatch of this workflow — give the input a `default` or make it optional',
      );
    }
  }
}

/** Resolve a job's permissions (job-level, else workflow-level) and refuse anything
 *  outside the allowed exact pairs. Returns the resolved map when it is one. */
function guardPermissions(
  jobId: string,
  jobPerms: unknown,
  workflowPerms: unknown,
  v: (g: GuardId, what: string, why: string) => void,
): Rec | null {
  const where = jobPerms !== undefined ? `jobs.${jobId}.permissions` : 'permissions';
  const perms = jobPerms !== undefined ? jobPerms : workflowPerms;
  if (perms === undefined) {
    v(
      'D6.3',
      `job \`${jobId}\` has no resolvable \`permissions\` (neither job-level nor workflow-level)`,
      'without a permissions map the job inherits the repository default, which may include write scopes over issues, pull requests and checks — declare `permissions: { contents: read, id-token: write }`',
    );
    return null;
  }
  if (isStr(perms)) {
    v(
      'D6.3',
      `\`${where}: ${perms}\` is a blanket grant`,
      `\`${perms}\` grants every scope at once${perms === 'write-all' ? ' — labels, comments, check runs, branches, merges: every signal a gate reads' : ''} — declare each scope explicitly from the allowed set (contents: read, id-token: write, actions: read, packages: read, deployments: write)`,
    );
    return null;
  }
  if (!isRec(perms)) {
    v('D6.3', `\`${where}\` is ${show(perms)}`, 'permissions must be a map of scope → access level');
    return null;
  }
  for (const [scope, level] of Object.entries(perms)) {
    if (ALLOWED_PERMISSIONS[scope] === level) continue;
    // Explicitly granting nothing is always fine — `issues: none` is a scope the job
    // does NOT hold. Stated in the docs as the one addition to the five allowed pairs.
    if (level === 'none') continue;
    const forges = SCOPE_FORGES[scope];
    v(
      'D6.3',
      `\`${where}.${scope}: ${show(level)}\` is outside the allowed set`,
      forges
        ? `with it the workflow could ${forges} — a subject workflow writes nothing to GitHub: only \`contents: read\`, \`id-token: write\`, \`actions: read\`, \`packages: read\` and \`deployments: write\` are allowed`
        : 'only `contents: read`, `id-token: write`, `actions: read`, `packages: read` and `deployments: write` are allowed — a subject workflow writes nothing to GitHub',
    );
  }
  return perms;
}

/**
 * `secrets.*` inside `${{ }}` (only `GITHUB_TOKEN` allowed), the bare `secrets`
 * context (`toJSON(secrets)`, `secrets[...]`), and `secrets: inherit`.
 *
 * Over the PARSED scalar values first — that is what GitHub's expression evaluator
 * sees, after YAML has decoded `\x63`, `s` and escaped line breaks — and over the
 * raw text as a second net. CASE-INSENSITIVE, because the runner's expression SDK
 * resolves context names and properties with OrdinalIgnoreCase: `SECRETS.X` and
 * `Secrets.x` are `secrets.X` to it (security review 2026-08-29).
 */
function guardSecrets(values: readonly string[], content: string, v: (g: GuardId, what: string, why: string) => void): void {
  const why =
    'a subject workflow reads no repository secret — that is how it cannot reach `ANTHROPIC_API_KEY` or the operator\'s PAT. OIDC needs none (the role ARN and region come from `vars.*`), and `secrets.GITHUB_TOKEN` is the one exception';
  const seen = new Set<string>();
  for (const text of [...values, content]) {
    for (const m of text.matchAll(/\$\{\{([\s\S]*?)\}\}/g)) {
      const expr = m[1] ?? '';
      for (const ref of expr.matchAll(/\bsecrets\b(\.[A-Za-z0-9_-]+|\s*\[[^\]]*\])?/gi)) {
        const full = ref[0].trim();
        if (full.toLowerCase() === 'secrets.github_token') continue;
        seen.add(full);
      }
    }
  }
  for (const ref of seen) v('D6.4', `references \`${ref}\``, why);
  if (/^\s*secrets:\s*inherit\s*$/m.test(content)) {
    v('D6.4', 'uses `secrets: inherit`', `${why} — and \`inherit\` hands every secret to a reusable workflow the gate cannot see`);
  }
}

/** Every `uses:` pinned to a full SHA or a digest; no local actions, no reusable
 *  workflows, no digest-less container images. */
function guardSupplyChain(jobId: string, job: Rec, v: (g: GuardId, what: string, why: string) => void): void {
  if (job['uses'] !== undefined) {
    v(
      'D6.5',
      `\`jobs.${jobId}.uses: ${show(job['uses'])}\` calls a reusable workflow`,
      'a reusable workflow runs with the caller\'s permissions and its content is not in this patch, so the gate cannot read it — inline the steps',
    );
  }
  const imageAt = (where: string, image: unknown): void => {
    if (image === undefined) return;
    if (!isStr(image) || !DIGEST_IMAGE_RE.test(image)) {
      v('D6.5', `\`${where}: ${show(image)}\` is not pinned to a digest`, 'a container image without `@sha256:<digest>` can change after a human read the file — pin it');
    }
  };
  const container = job['container'];
  if (isStr(container)) imageAt(`jobs.${jobId}.container`, container);
  else if (isRec(container)) imageAt(`jobs.${jobId}.container.image`, container['image']);
  const services = job['services'];
  if (isRec(services)) {
    for (const [name, svc] of Object.entries(services)) {
      if (isStr(svc)) imageAt(`jobs.${jobId}.services.${name}`, svc);
      else if (isRec(svc)) imageAt(`jobs.${jobId}.services.${name}.image`, svc['image']);
    }
  }

  const steps = job['steps'];
  if (job['uses'] === undefined && (!Array.isArray(steps) || steps.length === 0)) {
    v('D6.1', `job \`${jobId}\` has no \`steps\``, 'a job with no steps does not run, and the guard refuses what it cannot classify');
    return;
  }
  if (!Array.isArray(steps)) return;
  steps.forEach((step, i) => {
    if (!isRec(step)) return;
    const run = step['run'];
    if (isStr(run) && PIPE_TO_SHELL_RE.test(run)) {
      v(
        'D6.5',
        `\`jobs.${jobId}.steps[${i}].run\` pipes a download into a shell`,
        '`curl … | sh` runs content that can change after a human read the file and that no scanner saw — download it, check it against a recorded hash, then run it (or vendor the script into the repository)',
      );
    }
    const uses = step['uses'];
    if (uses === undefined) return;
    const where = `jobs.${jobId}.steps[${i}].uses`;
    if (!isStr(uses)) {
      v('D6.5', `\`${where}: ${show(uses)}\``, 'must be a string');
      return;
    }
    if (uses.startsWith('./') || uses.startsWith('.\\')) {
      v(
        'D6.5',
        `\`${where}: ${uses}\` is a local action`,
        'local actions live under `.github/actions`, which is reserved — a subject workflow cannot deliver one and must not depend on one — use a SHA-pinned published action',
      );
      return;
    }
    if (uses.startsWith('docker://')) {
      if (!PINNED_DOCKER_RE.test(uses)) {
        v('D6.5', `\`${where}: ${uses}\` has no digest`, 'a `docker://` action must be `docker://<image>@sha256:<64 hex>` so the content a human read is the content that runs');
      }
      return;
    }
    if (!PINNED_ACTION_RE.test(uses)) {
      v(
        'D6.5',
        `\`${where}: ${uses}\` is not pinned to a commit SHA`,
        'a tag or branch (`@v4`, `@main`) is content that can change after a human read the file — pin `owner/repo@<40-hex commit sha>` and note the version in a comment',
      );
    }
  });
}

/** D6.5, second half. `null`/absent runner = the scanners are not installed where the
 *  gate runs — which FAILS, because "did not scan" and "scanned clean" must never read
 *  the same (GHI #108). A runner that throws fails the same way. */
async function runScanners(files: SubjectWorkflowFile[], scan: SubjectGuardContext['scan']): Promise<Violation[]> {
  if (!scan) {
    return files.map((f) => ({
      guard: 'D6.5',
      path: f.path,
      what: 'scanners unavailable — refusing rather than passing unscanned',
      why: 'actionlint and zizmor must run over every subject workflow — the gate runner installs both (see templates/workflows/deliverable-gate.yml) and a missing binary is a gate failure, not a pass',
    }));
  }
  let findings: ScanFinding[];
  try {
    findings = await scan(files);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return files.map((f) => ({
      guard: 'D6.5',
      path: f.path,
      what: `scanner run failed: ${msg}`,
      why: 'a scanner that did not finish is not a scanner that found nothing — the gate refuses until it runs clean',
    }));
  }
  return findings.map((f) => ({
    guard: 'D6.5',
    path: normalizePath(f.path),
    what: `${f.tool}: ${f.message}`,
    why: 'every actionlint and zizmor (regular persona) finding is refused — fix the file so both scanners run clean',
  }));
}
