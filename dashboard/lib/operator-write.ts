import { redirect } from 'next/navigation';
import { errorMessage, isRefusal } from './github/errors';
import { refusedPath } from './outcome';

/**
 * Every operator write goes through here (GHI #135, extended to the per-surface
 * actions by GHI #68).
 *
 * The two failure classes need opposite treatments, and before this wrapper existed
 * they got the same one: a thrown `Error`. A **refusal** is a decision this product
 * made on purpose — nothing was written, and the message names the conflicting record
 * and the way forward — so it belongs on the page the operator submitted from, beside
 * the form they can now correct. Thrown, it never gets there: Next.js does not send
 * server-action error text to the client in production, so the sentence is replaced by
 * a digest, and in development it arrives as a stack trace over a source frame. That is
 * what the operator met live on 2026-08-21: a correct, carefully worded duplicate
 * refusal, delivered as a crash page, right after a success that had announced nothing
 * at all.
 *
 * A **fault** — a bug, a 5xx, an unparseable document — keeps throwing, because the
 * honest response is an apology plus the digest that leads to the log, and
 * `app/error.tsx` renders exactly that.
 *
 * WHY IT MOVED HERE (GHI #68, 2026-08-27). It lived privately inside `app/actions.ts`,
 * so the migration that fixed it fixed only the surfaces in that one file. Three
 * per-surface action files — high-stakes flagging, work-item binding, and run
 * cancel/steer — kept throwing, and every refusal they raise redacted to a generic
 * error in a production build. Those are ten carefully written sentences, in a product
 * whose own issue for this says *the message **is** the deliverable*. The per-surface
 * split is deliberate and stays; what was wrong is that the SEAM was not shared.
 *
 * `write()` may return a destination or nothing:
 *   - a **string** is where to go and what to say, so a write that landed can never
 *     re-render the page in silence (`app/actions.ts`'s convention);
 *   - **void** leaves the caller's own `revalidatePath` as the success behaviour, which
 *     is what the per-surface actions already do. Their refusals are what this change
 *     is about; converting their successes to redirects is a separate question, left
 *     open deliberately rather than smuggled in behind a bug fix.
 */
export async function operatorWrite(
  page: string,
  write: () => Promise<string | void>,
  opts: { anchor?: string } = {},
): Promise<void> {
  let destination: string | null = null;
  try {
    const result = await write();
    destination = typeof result === 'string' ? result : null;
  } catch (error: unknown) {
    if (!isRefusal(error)) throw error;
    destination = refusedPath(page, errorMessage(error), opts);
  }
  // A `void` write has already done its own revalidatePath and has nowhere to send
  // the operator, so there is nothing left to do.
  if (destination === null) return;
  // OUTSIDE the try, always, and on its own line: `redirect()` works BY throwing, so
  // calling it inside would hand its control-flow signal to the catch above on every
  // success. The bare statement is also what `operator-outcome.test.ts` counts — there
  // must be exactly one redirect statement in the whole app, and it is this one.
  redirect(destination);
}
