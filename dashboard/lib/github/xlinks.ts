import type { Octokit } from '@octokit/rest';
import type { RepoRef } from './client';
import { errorStatus, Refusal } from './errors';
// The flag name comes from the taxonomy module, so the writer here and the reader in
// portfolio.ts cannot drift apart from it or from each other (issue-tracker-contract.md).
import { CONFLICT_LABEL } from './labels';
import { parseXLink, parseXLinkResolution, serializeXLink, type XLinkMarker, type XLinkType } from './markers';
import { listWorkloads, type Workload } from './workloads';

/**
 * Cross-workload links module (T146, FR-047): the operator records a
 * `depends-on | conflicts-with | overlaps` relationship between two workloads as a
 * PAIRED `xlink:v1` comment on both workload issues, and while a `conflicts-with`
 * link is open, deterministic propagation carries `conflict:open` on every affected
 * step/chunk issue in BOTH workloads until the operator records the resolution.
 *
 * Design points that callers depend on:
 *
 * - **Paired, mirrored records.** The same link is written to both workload issues so
 *   each workload's record is self-contained and readable on its own timeline (audit
 *   locality — research.md "Cross-workload links & portfolio view"). The two comments
 *   carry the SAME type, items and status; only `with:` differs, because the contract
 *   defines it as *the other* workload's slug — a byte-identical copy would read as a
 *   self-link on one end and could not be resolved from that end.
 * - **Link identity is `(type, with-slug)`.** The documented `xlink:v1` grammar has no
 *   id field, so a resolution matches the open link of the same type between the same
 *   pair of workloads. Two links of DIFFERENT types between one pair therefore coexist
 *   independently (a `depends-on` survives its pair's `conflicts-with` resolution), but two
 *   `conflicts-with` links between one pair CANNOT: the second supersedes the first. That is
 *   why an open conflict's item set may be widened and never narrowed (droppedConflictItems)
 *   — narrowing would clear flags with no resolution recorded anywhere, which FR-047 forbids.
 * - **Flagging is scoped to conflicts.** `depends-on` and `overlaps` are recorded
 *   relationships that flag nothing — FR-047 scopes `conflict:open` to `conflicts-with`.
 * - **An archived end is a FROZEN mirror.** An archived workload issue is closed AND LOCKED
 *   (FR-043), so nothing can ever be written to its timeline again. A resolution therefore
 *   lands on the writable end(s) only, and propagation treats the frozen end's `open` record
 *   as superseded by it (justifyingLinks) — otherwise archiving one end of an open conflict
 *   would strand `conflict:open` on the survivor's live work items with no way to clear it.
 * - **Nothing here is per-workload blocking (FR-046).** Every WRITE is keyed by slug and
 *   touches only the two named workloads' issues plus the items they name; one workload's
 *   open conflict never gates another's runs, plans, or gates. The flag verdict READS every
 *   workload's link records, because any pair's open conflict justifies `conflict:open` on
 *   the items it names — but removal only ever touches items the named slugs' own history
 *   names (propagateConflictFlags' jurisdiction).
 *
 * Writes live here (not in an agent) per the substrate split: agents are read-only, and
 * deterministic code shared by dashboard and workflow performs the mutations.
 */

export interface XLink extends XLinkMarker {
  /** the workload whose issue carries THIS record (`with` names the other end) */
  slug: string;
  /** the workload issue the record lives on */
  issueNumber: number;
  /** the operator's recorded resolution text; present only on a resolved link */
  resolution?: string;
}

/** Link identity — see the module header: (type, with-slug), no id in the grammar. */
function identityOf(link: { type: XLinkType; with: string }): string {
  return `${link.type}|${link.with}`;
}

/** The same identity seen from OUTSIDE either end: (type, unordered pair). The two mirrored
 *  records of one relationship collapse onto this key, which is what lets propagation tell
 *  that a resolution recorded on one timeline is about the open record on the other. */
function pairKeyOf(link: { type: XLinkType; slug: string; with: string }): string {
  return [link.type, ...[link.slug, link.with].sort()].join('|');
}

/** Deterministic order for every XLink[] this module returns: owning slug, partner, type.
 *  Comment order would leak write history into a value callers render and compare. */
function sortLinks(links: XLink[]): XLink[] {
  const key = (link: XLink) => `${link.slug}|${link.with}|${link.type}`;
  return links.sort((a, b) => key(a).localeCompare(key(b)));
}

/**
 * Fold one workload issue's comment history into its CURRENT link state, plus every item
 * ref that history has EVER named.
 *
 * Comments are chronological, so the last marker for an identity is the truth: a
 * `status:resolved` comment supersedes the earlier open one, and a fresh open comment
 * after a resolution re-opens the link — a conflict between two long-lived workloads can
 * recur, and FR-047 records the relationship rather than a one-shot event.
 *
 * `everItems` exists because the fold DISCARDS superseded markers: when the operator
 * amends a link's scope, the item they dropped falls out of every current link, and a
 * jurisdiction computed from the fold alone would never look at it again — leaving
 * `conflict:open` on work the operator just said is not in dispute, permanently and with
 * no remedy. Flag reconciliation therefore uses the history, not the fold (see
 * propagateConflictFlags).
 */
async function readIssueLinks(
  gh: Octokit,
  repo: RepoRef,
  workload: Workload,
): Promise<{ current: XLink[]; everItems: number[] }> {
  const comments = await gh.paginate(gh.issues.listComments, {
    ...repo,
    issue_number: workload.issueNumber,
    per_page: 100,
  });
  const current = new Map<string, XLink>();
  const everItems: number[] = [];
  for (const comment of comments) {
    const body = comment.body ?? '';
    const marker = parseXLink(body);
    if (!marker) continue;
    everItems.push(...marker.items);
    const resolution = parseXLinkResolution(body);
    current.set(identityOf(marker), {
      ...marker,
      slug: workload.slug,
      issueNumber: workload.issueNumber,
      ...(resolution !== '' ? { resolution } : {}),
    });
  }
  return { current: [...current.values()], everItems };
}

/** Current link state only — what the record/resolve paths compare against. */
async function foldIssueLinks(gh: Octokit, repo: RepoRef, workload: Workload): Promise<XLink[]> {
  return (await readIssueLinks(gh, repo, workload)).current;
}

/** One workload listing shared by every multi-slug operation below: listWorkloads
 *  paginates the whole issue list, so calling it per slug would re-read the repo N times. */
async function loadWorkloads(gh: Octokit, repo: RepoRef): Promise<Map<string, Workload>> {
  return new Map((await listWorkloads(gh, repo)).map((w) => [w.slug, w]));
}

/** One workload's link record: its current fold, every item its history has ever named, and
 *  whether that record is FROZEN (an archived issue is closed and locked, FR-043 — nothing
 *  can be appended to it again, so its markers can never be updated to agree with a peer). */
interface LinkHistory {
  slug: string;
  archived: boolean;
  links: XLink[];
  everItems: number[];
}

/** Reads are per workload issue and independent of each other (FR-046), hence concurrent. */
async function readHistories(gh: Octokit, repo: RepoRef, workloads: Workload[]): Promise<LinkHistory[]> {
  return Promise.all(
    workloads.map(async (workload) => {
      const { current, everItems } = await readIssueLinks(gh, repo, workload);
      return { slug: workload.slug, archived: workload.state === 'archived', links: current, everItems };
    }),
  );
}

/** The given slugs' workloads, in the caller's order, skipping slugs with no workload issue:
 *  a reconciliation pass over a stale slug list must not crash (recordXLink is where a bad
 *  slug is refused). */
function workloadsOf(workloads: Map<string, Workload>, slugs: string[]): Workload[] {
  return [...new Set(slugs)].map((slug) => workloads.get(slug)).filter((w): w is Workload => w !== undefined);
}

async function collectLinks(gh: Octokit, repo: RepoRef, slugs: string[]): Promise<XLink[]> {
  const workloads = await loadWorkloads(gh, repo);
  const histories = await readHistories(gh, repo, workloadsOf(workloads, slugs));
  return sortLinks(histories.flatMap((history) => history.links));
}

/**
 * Every current cross-workload link recorded on one workload's issue (FR-047), open and
 * resolved alike — the portfolio and workload-detail views render both. An unknown slug
 * has no links: a read is not where a typo surfaces.
 */
export async function listXLinks(gh: Octokit, repo: RepoRef, slug: string): Promise<XLink[]> {
  return collectLinks(gh, repo, [slug]);
}

/** Item refs are operator input: a zero, a negative, or a fractional issue number would be
 *  written into the marker and then silently fail every propagation attempt against it. */
function validateItems(items: number[]): number[] {
  for (const item of items) {
    if (!Number.isInteger(item) || item <= 0) throw new Refusal(`invalid item reference: ${item} (issue numbers are positive integers)`);
  }
  return [...new Set(items)].sort((a, b) => a - b);
}

/** Both ends of a link must name a real workload — a typo'd slug is refused at the write,
 *  never silently half-recorded. */
function requireEnd(workloads: Map<string, Workload>, slug: string): Workload {
  const workload = workloads.get(slug);
  if (!workload) throw new Refusal(`workload not found: ${slug}`);
  return workload;
}

/** RECORDING additionally needs a writable end. Archived workload issues are closed AND
 *  LOCKED (FR-043) — a paired comment cannot land on one, and a half-written pair is worse
 *  than a refusal because the two timelines would then disagree about the link's status.
 *  (Resolution is deliberately NOT refused here: see resolveXLink — a link whose peer was
 *  archived while it was open still has to be resolvable, or its flags strand forever.) */
function requireWritableEnd(workloads: Map<string, Workload>, slug: string): Workload {
  const workload = requireEnd(workloads, slug);
  if (workload.state === 'archived') {
    throw new Refusal(`workload ${slug} is archived (locked read-only) — a cross-workload link cannot be recorded on it`);
  }
  return workload;
}

/**
 * The items an OPEN `conflicts-with` link names that this re-record would DROP — i.e. the
 * flags it would silently clear.
 *
 * Link identity is (type, with-slug) and the fold takes the last marker, so a second
 * `conflicts-with` between one pair SUPERSEDES the first instead of coexisting with it: the
 * items only the earlier record named lose `conflict:open` with no resolution recorded
 * anywhere on either timeline, the operator is never told, and the earlier dispute is gone
 * from the UI (which keys the list on the same identity) while still being unresolved.
 * FR-047 lets the flag clear only when the operator's resolution is recorded, so widening an
 * open conflict's scope is fine and narrowing it is refused until the dispute is resolved.
 *
 * `depends-on` and `overlaps` flag nothing, so amending their scope loses nothing and stays
 * a plain append; the same goes for a RESOLVED conflict, where re-recording re-opens the
 * dispute over whatever items the operator now names.
 */
function droppedConflictItems(existing: XLink | undefined, items: number[]): number[] {
  if (existing === undefined || existing.type !== 'conflicts-with' || existing.status !== 'open') return [];
  const kept = new Set(items);
  return existing.items.filter((item) => !kept.has(item));
}

/**
 * Record a cross-workload relationship (FR-047). Writes the paired comment to BOTH
 * workload issues, then reconciles `conflict:open` across the pair.
 *
 * Retry-safe: an end that already carries this exact open link (same type, same partner,
 * same item set) is left alone, so a re-run after a partial failure completes the pair
 * instead of duplicating a record on the timeline that already has it. Re-recording with a
 * WIDER item set does append — that is the operator amending the link's scope, and the fold
 * takes the latest. A resolved link re-recorded re-opens it (see foldIssueLinks).
 *
 * Refused (FR-047): a re-record that would DROP items from an open `conflicts-with`, because
 * the superseding marker would clear their `conflict:open` with no resolution recorded — see
 * droppedConflictItems. Both ends are inspected BEFORE anything is written, so the refusal
 * cannot leave a half-written pair behind.
 *
 * Returns both of the pair's current records, in this module's single ordering rule
 * (`sortLinks`) rather than argument order — the relationship is symmetric, so which end
 * the operator started from must not change the value callers render.
 */
export async function recordXLink(
  gh: Octokit,
  repo: RepoRef,
  input: { fromSlug: string; toSlug: string; type: XLinkType; items: number[] },
): Promise<XLink[]> {
  if (input.fromSlug === input.toSlug) {
    throw new Refusal(`self-link refused: ${input.fromSlug} — a cross-workload link relates two DIFFERENT workloads (FR-047)`);
  }
  const items = validateItems(input.items);
  const workloads = await loadWorkloads(gh, repo);
  const from = requireWritableEnd(workloads, input.fromSlug);
  const to = requireWritableEnd(workloads, input.toSlug);

  // Mirrored markers: each end names the OTHER workload (see the module header).
  const ends: { workload: Workload; marker: XLinkMarker }[] = [
    { workload: from, marker: { type: input.type, with: input.toSlug, items, status: 'open' } },
    { workload: to, marker: { type: input.type, with: input.fromSlug, items, status: 'open' } },
  ];

  // Read BOTH ends before writing EITHER: the refusal below is a property of the pair, and
  // discovering it after the first comment landed would leave the two timelines disagreeing
  // — the same reason requireWritableEnd refuses an archived end up front.
  const existingByEnd = await Promise.all(
    ends.map(async (end) =>
      (await foldIssueLinks(gh, repo, end.workload)).find((link) => identityOf(link) === identityOf(end.marker)),
    ),
  );
  const dropped = [...new Set(existingByEnd.flatMap((existing) => droppedConflictItems(existing, items)))].sort(
    (a, b) => a - b,
  );
  if (dropped.length > 0) {
    throw new Refusal(
      `the open conflicts-with between ${input.fromSlug} and ${input.toSlug} names ${dropped.map((n) => `#${n}`).join(', ')}, ` +
        `which this record drops — record the resolution first (FR-047: conflict:open clears only when the operator's ` +
        `resolution is recorded), then record the new conflict`,
    );
  }

  const recorded: XLink[] = [];
  for (const [index, end] of ends.entries()) {
    const existing = existingByEnd[index];
    const alreadyRecorded =
      existing?.status === 'open' &&
      existing.items.length === end.marker.items.length &&
      existing.items.every((item, i) => item === end.marker.items[i]);
    if (!alreadyRecorded) {
      await gh.issues.createComment({ ...repo, issue_number: end.workload.issueNumber, body: serializeXLink(end.marker) });
    }
    // The marker just written (or the identical one already present) is by construction
    // the LAST for this identity, so it IS what foldIssueLinks would now return — no
    // re-read needed to answer honestly.
    recorded.push({ ...end.marker, slug: end.workload.slug, issueNumber: end.workload.issueNumber });
  }

  await propagateConflictFlags(gh, repo, [input.fromSlug, input.toSlug]);
  return sortLinks(recorded);
}

/**
 * Record the operator's resolution of a link and clear its flags (FR-047). Appends the
 * paired `status:resolved` comment — carrying the resolution text and the SAME item set as
 * the open link, so each timeline stays self-contained — to both issues, then re-propagates.
 *
 * Idempotent by design: an end where the link is absent or already resolved is skipped
 * (never re-resolved, so the first recorded resolution is never overwritten), and
 * propagation still runs, which is how a run that crashed between the comment and the label
 * work converges. Resolving a link that exists nowhere is a clean no-op returning [].
 *
 * An ARCHIVED end is skipped rather than refused. Archival is a legal end for a workload
 * that still has an open conflict (FR-041), and its issue is then locked forever (FR-043) —
 * refusing the whole call there left `conflict:open` on the SURVIVING workload's live work
 * items with no operator surface able to clear it, since this function is that surface.
 * The resolution is recorded on every writable end, and propagation treats the frozen end's
 * open mirror as superseded by it (justifyingLinks). Only when NO end can be written does
 * this refuse: the operator's judgment has to land somewhere to count as recorded (FR-047).
 *
 * Returns the resolved records in `sortLinks` order (see recordXLink) — one entry per end
 * that carries the link and could be written, so 0, 1, or 2 depending on what was recorded.
 */
export async function resolveXLink(
  gh: Octokit,
  repo: RepoRef,
  input: { fromSlug: string; toSlug: string; type: XLinkType; resolution: string },
): Promise<XLink[]> {
  if (input.fromSlug === input.toSlug) {
    throw new Refusal(`self-link refused: ${input.fromSlug} — a cross-workload link relates two DIFFERENT workloads (FR-047)`);
  }
  const resolution = input.resolution.trim();
  if (resolution.length === 0) {
    // FR-047: "the resolution is recorded" — clearing the flags without saying why would
    // erase the operator's judgment from the audit trail (withdrawProposal's cause rule).
    throw new Refusal('resolution refused: the resolution must be recorded (FR-047)');
  }
  const workloads = await loadWorkloads(gh, repo);
  const from = requireEnd(workloads, input.fromSlug);
  const to = requireEnd(workloads, input.toSlug);

  const ends: { workload: Workload; partner: string }[] = [
    { workload: from, partner: input.toSlug },
    { workload: to, partner: input.fromSlug },
  ];
  const writable = ends.filter((end) => end.workload.state !== 'archived');
  if (writable.length === 0) {
    throw new Refusal(
      `both ${input.fromSlug} and ${input.toSlug} are archived (locked read-only) — the resolution cannot be recorded on either timeline (FR-043)`,
    );
  }

  // Fold EVERY end (archived included) before writing anything. A resolution is a paired
  // record, so a half-written pair must be completed with the text already on its peer, not
  // with whatever the operator retyped: end A succeeds, end B's write fails, the operator
  // retries with edited text, and the pair would otherwise carry two DIFFERENT operator
  // resolutions permanently — while propagation clears the flags as though one resolution
  // had been agreed. First recorded wins, which is also how the answer records fold.
  // Archived ends are read here (never written) precisely because an end resolved before it
  // was archived still holds the binding text.
  const folded = await Promise.all(
    ends.map(async (end) => ({
      end,
      existing: (await foldIssueLinks(gh, repo, end.workload)).find(
        (link) => identityOf(link) === identityOf({ type: input.type, with: end.partner }),
      ),
    })),
  );
  const recorded = folded.find((f) => f.existing?.status === 'resolved')?.existing?.resolution;
  const effective = recorded ?? resolution;

  const resolved: XLink[] = [];
  for (const { end, existing } of folded) {
    if (!existing) continue; // never recorded on this end — nothing to resolve
    if (existing.status === 'resolved') {
      resolved.push(existing);
      continue;
    }
    if (end.workload.state === 'archived') continue; // frozen record (FR-043) — cannot be appended to
    const marker: XLinkMarker = { type: existing.type, with: existing.with, items: existing.items, status: 'resolved' };
    await gh.issues.createComment({ ...repo, issue_number: end.workload.issueNumber, body: serializeXLink(marker, effective) });
    resolved.push({ ...marker, slug: end.workload.slug, issueNumber: end.workload.issueNumber, resolution: effective });
  }

  await propagateConflictFlags(gh, repo, [input.fromSlug, input.toSlug]);
  return sortLinks(resolved);
}

/**
 * PURE verdict (Deterministic-First): the issues that MUST carry `conflict:open`, given a
 * set of links. Only `conflicts-with` links with `status:open` flag anything — FR-047
 * scopes flagging to conflicts, while `depends-on` and `overlaps` are recorded
 * relationships that gate nothing. Ascending and deduped: the paired records name the same
 * items twice, and callers diff this against the labels actually present.
 *
 * No clock, no network — the whole flag policy is testable as a function of link state.
 */
export function conflictFlagTargets(links: XLink[]): number[] {
  const targets = new Set<number>();
  for (const link of links) {
    if (link.type !== 'conflicts-with' || link.status !== 'open') continue;
    for (const item of link.items) targets.add(item);
  }
  return [...targets].sort((a, b) => a - b);
}

/**
 * PURE: the links that still JUSTIFY a flag, with the frozen records a recorded resolution
 * has already superseded dropped.
 *
 * An archived workload's issue is locked (FR-043), so `resolveXLink` records the operator's
 * resolution on the writable end(s) only and the archived end keeps saying `open` forever.
 * Counting that frozen mirror as justification would re-flag the surviving workload's live
 * work items on every propagation, with nothing able to clear them — the FR-047 dead end
 * this rule closes. Scoped to ARCHIVED owners deliberately: two LIVE ends that disagree mean
 * the pair is only half-resolved, and there the flag MUST stay until both timelines agree
 * (a resolution recorded on one end is not the operator's word on the other).
 */
function justifyingLinks(histories: LinkHistory[]): XLink[] {
  const frozen = new Set(histories.filter((history) => history.archived).map((history) => history.slug));
  const links = histories.flatMap((history) => history.links);
  const resolvedByLiveEnd = new Set(
    links.filter((link) => !frozen.has(link.slug) && link.status === 'resolved').map(pairKeyOf),
  );
  return links.filter(
    (link) => !(frozen.has(link.slug) && link.status === 'open' && resolvedByLiveEnd.has(pairKeyOf(link))),
  );
}

/**
 * Reconcile the `conflict:open` labels to `conflictFlagTargets`' verdict: add it wherever an
 * open conflict names an item that lacks it, remove it from the given workloads' items where
 * no open conflict justifies it any more. Idempotent — a converged repo returns
 * `{ added: [], removed: [] }`.
 *
 * Two DIFFERENT scopes, and the asymmetry is the point:
 *
 * - **Justification is portfolio-wide.** An item carries the flag because SOME pair's
 *   `conflicts-with` is open, and that pair need not be one this call was told about: two
 *   workloads can both name a shared chunk issue. Judging removal from the named slugs'
 *   links alone stripped a flag a third pair's still-open conflict justified, and work then
 *   proceeded on it as though the dispute were settled. So every workload's link records are
 *   read for the verdict; only the two ends' WRITES stay pair-scoped (FR-046).
 * - **Removal jurisdiction is the named slugs.** It only touches issues named by THESE
 *   slugs' link HISTORY, whatever the type or status — not just the current fold. An item no
 *   marker here mentions is somebody else's business (or another feature's flag) and is left
 *   exactly as found; an item a superseded marker named still IS ours, because the operator
 *   amending a link's scope is precisely how a flag stops being justified (`everItems`).
 *
 * Ordering is the label-mutation discipline this repo learned the hard way (GHI #48,
 * dropLiveLabelsAndClose): every ADD lands before any REMOVE, in ONE pass — splitting the
 * two across two calls (a pair-scoped propagate, then a portfolio-wide reconcile) is what
 * left an item under-flagged in between. A failure inside the add phase therefore leaves
 * items over-flagged, never under-flagged — an unflagged item under an open conflict is the
 * FR-047 failure that matters. Writes are sequential so that boundary holds and the returned
 * arrays report exactly what changed, in issue order.
 */
export async function propagateConflictFlags(
  gh: Octokit,
  repo: RepoRef,
  slugs: string[],
): Promise<{ added: number[]; removed: number[] }> {
  const workloads = await loadWorkloads(gh, repo);
  const named = workloadsOf(workloads, slugs);
  const scoped = await readHistories(gh, repo, named);
  const jurisdiction = new Set(scoped.flatMap((history) => history.everItems));
  // Nothing these slugs' history names means nothing here can be added or removed — skip
  // both the portfolio read and the repo-wide label scan rather than paginating every issue
  // to conclude "no change" (the reconciliation loop calls this on every dispatch).
  if (jurisdiction.size === 0) return { added: [], removed: [] };

  const namedSlugs = new Set(named.map((workload) => workload.slug));
  const rest = [...workloads.values()].filter((workload) => !namedSlugs.has(workload.slug));
  const justified = conflictFlagTargets(justifyingLinks([...scoped, ...(await readHistories(gh, repo, rest))]));

  // state:'all' — a step/chunk issue can be CLOSED while still carrying a stale flag
  // (records are never deleted, FR-042); scoping to open issues would strand it flagged
  // forever. PRs are filtered out: the issues endpoint answers with them too.
  const flagged = await gh.paginate(gh.issues.listForRepo, { ...repo, labels: CONFLICT_LABEL, state: 'all', per_page: 100 });
  const holders = new Set(flagged.filter((issue) => !issue.pull_request).map((issue) => issue.number));

  // Adds are NOT jurisdiction-scoped: FR-047 admits no item that an open conflict names and
  // the flag misses, whoever asked for the reconciliation, so a pass that noticed one and
  // walked past it would leave exactly the under-flagged item the ordering rule protects.
  const added: number[] = [];
  for (const issueNumber of justified) {
    if (holders.has(issueNumber)) continue;
    try {
      await gh.issues.addLabels({ ...repo, issue_number: issueNumber, labels: [CONFLICT_LABEL] });
      added.push(issueNumber);
    } catch (error: unknown) {
      // 404 only — the item ref names an issue that does not exist (an operator typo, or a
      // ref carried over from another repo). One bad ref must not wedge the rest of the
      // link's propagation, and it must not wedge resolveXLink either, which would leave
      // the pair's real flags stuck on forever. Anything else surfaces: a swallowed 5xx
      // would report a flag the item never got.
      if (errorStatus(error) !== 404) throw error;
    }
  }

  const removed: number[] = [];
  const stillJustified = new Set(justified);
  for (const issueNumber of [...jurisdiction].sort((a, b) => a - b)) {
    if (stillJustified.has(issueNumber) || !holders.has(issueNumber)) continue;
    try {
      await gh.issues.removeLabel({ ...repo, issue_number: issueNumber, name: CONFLICT_LABEL });
      removed.push(issueNumber);
    } catch (error: unknown) {
      // 404 only — the label (or the issue) is already gone, which is the desired end state
      // and the EXPECTED case on a retry. Any other failure propagates: reporting a cleared
      // flag that is still on the issue would tell the operator the conflict is behind them.
      if (errorStatus(error) !== 404) throw error;
    }
  }

  return { added, removed };
}
