/**
 * The one implementation of the rule in `contracts/dashboard-github-api.md`
 * "Error & consistency contract": GitHub's LIST endpoints are not
 * read-after-write consistent, and its single-issue GET is.
 *
 * A page that writes and then re-renders itself asks GitHub for a list that may
 * not have caught up, so the row it just created can be missing and a row it just
 * changed can still carry the pre-write labels. Either way the operator sees the
 * page they had BEFORE their click and concludes the button did nothing — a
 * failure indistinguishable from a broken button, and one this repo has now met
 * live three times (a ✗ with no correction, 2026-08-16; a backlog chunk that
 * needed a browser refresh, PB-015; and the conditional-GET variant the client's
 * cache-busting handles).
 *
 * The fix is always the same three moves, which is why they live here rather than
 * in each list function: the action carries the numbers it wrote forward in the
 * URL, the page passes them down, and the list read re-reads exactly those
 * through the consistent GET.
 */

/**
 * What a direct read establishes about one hinted record.
 *
 * The three-way split is load-bearing, not ceremony. `null` and `'absent'` must
 * stay distinct so that an untrusted URL hint naming a record this list does not
 * own can never DELETE a row: only a read that positively establishes the record
 * has left this list is allowed to remove anything.
 */
export type RecheckVerdict<T> =
  /** authoritative row — replace the listed one in place, or append it */
  | { item: T }
  /** authoritatively NOT in this list any more — remove it if the list carries it */
  | 'absent'
  /** unknown, unreadable, or not this list's kind of record — leave the list untouched */
  | null;

/**
 * Merge authoritative single-issue reads over a possibly-stale list.
 *
 * - **Replace in place** when the list already carried the row (a STALE row: the
 *   write changed labels the list has not caught up with). Position is preserved
 *   so a re-render never reshuffles records under the operator's cursor.
 * - **Append** when it did not (a MISSING row: the write created it). Callers
 *   that present a sorted view sort afterwards.
 * - **Remove** on `'absent'` — the row is in the list only because the list is
 *   behind. Without this the helper could correct a row that was behind and add
 *   one that was missing, but not delete one that should be gone, and an
 *   authoritative "this record has left the list" was thrown away (GHI #122).
 *   That is the primary case wherever membership IS the record: a resolved
 *   cross-workload conflict whose label is gone, a chunk that has been closed.
 *   Note the polarity — a stale row here makes the page OVER-report, asserting
 *   outstanding work that no longer exists, which is worse than the absence every
 *   other instance of this bug produces.
 * - **Ignore** on `null`: a number naming nothing, naming the wrong kind of
 *   record, or belonging to someone else's workload (FR-046), and any read that
 *   throws — the list stays the only truth available.
 *
 * The listed rows are also deduplicated by issue number. Where a list is the
 * union of several label queries they run concurrently, so mid-transition the
 * same issue can answer more than one of them — one record rendered as two rows
 * under one React key.
 */
export async function mergeRecheck<T>(
  listed: readonly T[],
  recheck: readonly number[] | undefined,
  readOne: (issueNumber: number) => Promise<RecheckVerdict<T>>,
  issueNumberOf: (item: T) => number,
): Promise<T[]> {
  const merged = listed.filter(
    (item, i) => listed.findIndex((other) => issueNumberOf(other) === issueNumberOf(item)) === i,
  );
  for (const issueNumber of new Set(recheck ?? [])) {
    let verdict: RecheckVerdict<T>;
    try {
      verdict = await readOne(issueNumber);
    } catch {
      continue;
    }
    if (verdict === null) continue;
    const at = merged.findIndex((item) => issueNumberOf(item) === issueNumber);
    if (verdict === 'absent') {
      if (at >= 0) merged.splice(at, 1);
      continue;
    }
    if (at >= 0) merged[at] = verdict.item;
    else merged.push(verdict.item);
  }
  return merged;
}

/**
 * The untrusted URL hint, as a list of issue numbers. `?just=1&just=2` and a bare
 * `?just=1` both arrive here; anything that is not a positive integer is dropped
 * before it reaches a GitHub call.
 */
export function parseJustParam(just: string | string[] | undefined): number[] {
  return (Array.isArray(just) ? just : just === undefined ? [] : [just])
    .map(Number)
    .filter((n) => Number.isInteger(n) && n > 0);
}
