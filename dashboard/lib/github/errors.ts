/**
 * Safe accessors for unknown catch values. `error` in a catch block can be
 * null/undefined or a non-object; direct casts like `(error as Error).message`
 * throw a TypeError on exactly the failures you're trying to report.
 */

export function errorStatus(error: unknown): number | undefined {
  if (error && typeof error === 'object' && 'status' in error) {
    const status = (error as { status: unknown }).status;
    return typeof status === 'number' ? status : undefined;
  }
  return undefined;
}

export function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

/**
 * errorMessage without octokit's trailing " - https://docs.github.com/..."
 * suffix. Splitting on the full " - https://" prefix (not " - ") keeps API
 * messages that themselves contain spaced hyphens intact.
 */
export function apiMessage(error: unknown): string {
  return errorMessage(error).split(' - https://')[0]!;
}

/**
 * A **refusal**: the operator asked for something the oversight model does not
 * permit, and this message IS the operator-facing explanation — it names what
 * was refused and the way forward.
 *
 * The type exists because the two failure classes need opposite treatments and
 * are otherwise indistinguishable at the boundary (GHI #135). A refusal is
 * EXPECTED: nothing was written, the copy is the product, and the operator must
 * read it. A fault is unexpected — a bug, a 500, a broken document — and the
 * honest response is an apology plus the digest that leads to the log, not a
 * sentence pretending the system decided something.
 *
 * `dashboard/app/actions.ts` catches refusals and carries the message to the
 * page the operator submitted from; anything else keeps throwing and reaches the
 * error boundary as a fault. That is why a deliberate refusal MUST be thrown as
 * this class: a plain `Error` from a write path renders as "something went
 * wrong" and its carefully written sentence never arrives
 * (`tests/unit/refusal-typing.test.ts` guards the write modules against it).
 */
export class Refusal extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'Refusal';
  }
}

/**
 * `instanceof` first, `name` as the fallback. Both are needed: a bundler that
 * loads this module twice (server + route-handler graphs) gives the same class
 * two identities, and a refusal that fails its own type check would surface as a
 * crash page — exactly the defect the class exists to fix.
 */
export function isRefusal(error: unknown): error is Refusal {
  if (error instanceof Refusal) return true;
  return error instanceof Error && error.name === 'Refusal';
}

/**
 * A 403 that means "this credential lacks a permission" — GitHub's own wording for a
 * fine-grained PAT ("…by personal access token") and for an App installation token
 * ("…by integration"). GitHub also answers 403 for an exhausted rate limit and for an
 * Actions policy block; neither is about the token's scope, and "edit the token" would be
 * the wrong remedy for both (Codex P2 on PR #221) — so callers must test THIS, never a
 * bare status === 403, before turning a 403 into a refusal.
 */
export function isPermissionDenied(error: unknown): boolean {
  return errorStatus(error) === 403 && /Resource not accessible by (personal access token|integration)/i.test(apiMessage(error));
}

/**
 * The permission list GitHub attaches to a permission-denied response
 * (`x-accepted-github-permissions`, e.g. `contents=write; workflows=write`), or null when
 * absent. Quoted in a refusal it names the EXACT scope the token lacks — the afternoon of
 * 2026-09-11 was spent inferring "Workflows" from a docs table when GitHub had said so in
 * the header of the very response the operator was shown.
 */
export function acceptedPermissions(error: unknown): string | null {
  const headers = (error as { response?: { headers?: Record<string, unknown> } } | null)?.response?.headers;
  const value = headers?.['x-accepted-github-permissions'];
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

/** "GitHub said: …" with the accepted-permissions header appended when GitHub sent one. */
export function githubSaid(error: unknown): string {
  const accepted = acceptedPermissions(error);
  return `GitHub said: ${apiMessage(error)}${accepted ? ` (permissions it accepts for this call: ${accepted})` : ''}`;
}

/**
 * The remedy sentence for a permission refusal, by credential type — GitHub's wording
 * tells them apart. A fine-grained PAT's permissions are edited on the token; a GitHub App
 * installation token's are NOT: they come from the App, so the fix is to grant the
 * permission on the App, approve the updated permissions on the installation, and issue a
 * new token (Codex P2 on PR #227 — telling App users to "edit the token" sent them to a
 * control that does not exist).
 */
export function credentialRemedy(error: unknown, permission: string): string {
  return /by integration/i.test(apiMessage(error))
    ? `this credential is a GitHub App installation token, so grant ${permission} on the App itself, approve the updated permissions on this repository's installation, then issue a new token`
    : `edit the token's repository permissions to add ${permission}`;
}

