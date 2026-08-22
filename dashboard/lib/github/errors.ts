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
