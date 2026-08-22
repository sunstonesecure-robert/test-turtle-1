/**
 * What just happened, carried from a write action to the page that asked for it
 * (GHI #135).
 *
 * The defect this exists to fix had two halves that compounded. A **success was
 * silent**: recording an evidence batch committed a file and opened an issue, and
 * the page re-rendered with nothing to say so — the operator's own words, live on
 * 2026-08-21, were *"the page refreshed — I didn't 'get' anything obvious."* A
 * **refusal was a crash page**: the same submission repeated was correctly
 * refused, and the refusal arrived as a Next.js runtime error with a stack trace
 * and a source frame. So a success was followed by an error screen, and the
 * reasonable reading of the pair was "it failed twice" when in fact it succeeded
 * once and was correctly protected once.
 *
 * Why the message travels in the URL rather than in a thrown error: Next.js does
 * not send server-action error text to the client in production. A refusal that
 * reaches the operator by being thrown is a generic error with a digest — the
 * carefully written sentence, the one naming the conflicting record and the way
 * forward, is dropped at the boundary. Redirecting with the message keeps it, in
 * development and production alike, and lands the operator back on the page with
 * their form still in front of them. It is also the convention this dashboard
 * already uses for `?just=` (the read-after-write hint), so pages already read
 * their own search params.
 *
 * The text is UNTRUSTED on the way back in: anyone can hand the operator a URL
 * with any `?done=`/`?refused=` in it. So it is length-capped, stripped of
 * control characters, and rendered as plain text inside a banner that says it
 * describes the action just taken — never as markup, never as a link, and never
 * as a decision the system claims to have recorded.
 */

/** Long enough for the longest refusal copy in the product, short enough to keep
 *  a URL sane. Truncation is marked so a clipped sentence cannot read as the
 *  whole story. */
export const MAX_OUTCOME_CHARS = 400;

export type OutcomeKind = 'done' | 'refused';

export interface Outcome {
  kind: OutcomeKind;
  message: string;
}

/** One search-param value, whatever shape Next hands over. */
function firstValue(raw: string | string[] | undefined): string | undefined {
  const value = Array.isArray(raw) ? raw[0] : raw;
  return value === undefined || value.length === 0 ? undefined : value;
}

function sanitize(raw: string): string {
  // Control characters (newlines included) would let injected text impersonate
  // several lines of page copy; whitespace is collapsed for the same reason.
  const flat = raw.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim();
  return flat.length > MAX_OUTCOME_CHARS ? `${flat.slice(0, MAX_OUTCOME_CHARS)}…` : flat;
}

/**
 * The outcome a page should announce, or `null` when it was reached by plain
 * navigation. A refusal wins if both params somehow arrive: it is the one the
 * operator must not miss.
 */
export function parseOutcome(params: Record<string, string | string[] | undefined> | undefined): Outcome | null {
  const refused = firstValue(params?.refused);
  if (refused) {
    const message = sanitize(refused);
    return message ? { kind: 'refused', message } : null;
  }
  const done = firstValue(params?.done);
  if (done) {
    const message = sanitize(done);
    return message ? { kind: 'done', message } : null;
  }
  return null;
}

/**
 * The destination for a completed write: the page, what to say about it, and the
 * issue numbers the re-render has to re-read past GitHub's list lag (`just`).
 *
 * `anchor` keeps the operator at the record they acted on — the review page's
 * per-item forms already relied on that.
 */
export function outcomePath(
  page: string,
  outcome: Outcome,
  opts: { just?: (number | null | undefined)[]; anchor?: string } = {},
): string {
  const params = new URLSearchParams();
  params.set(outcome.kind, sanitize(outcome.message));
  for (const n of opts.just ?? []) {
    if (typeof n === 'number' && Number.isInteger(n) && n > 0) params.append('just', String(n));
  }
  const query = params.toString();
  return `${page}${query ? `?${query}` : ''}${opts.anchor ? `#${opts.anchor}` : ''}`;
}

/** `outcomePath` for the success half — reads as what it is at the call site. */
export function donePath(
  page: string,
  message: string,
  opts: { just?: (number | null | undefined)[]; anchor?: string } = {},
): string {
  return outcomePath(page, { kind: 'done', message }, opts);
}

/** `outcomePath` for a refusal. Nothing was written, so no `just` hint. */
export function refusedPath(page: string, message: string, opts: { anchor?: string } = {}): string {
  return outcomePath(page, { kind: 'refused', message }, opts);
}
