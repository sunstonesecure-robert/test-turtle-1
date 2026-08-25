/**
 * Machine-readable marker parsers/serializers for issue bodies and comments
 * (issue-tracker-contract.md "Issue types & required structure").
 *
 * Every marker is an HTML comment so it renders invisibly on GitHub while
 * remaining the authoritative machine linkage for dashboard and gates.
 */

// ---------- Andon header: <!-- andon:v1 run:<run_id> plan:plan/<feature>/v<N> ----------

export interface AndonHeader {
  runId: string;
  planRef: string; // e.g. plan/demo/v1
}

const ANDON_RE = /<!--\s*andon:v1\s+run:(\S+)\s+plan:(\S+)\s*-->/;

export function serializeAndonHeader(h: AndonHeader): string {
  return `<!-- andon:v1 run:${h.runId} plan:${h.planRef} -->`;
}

export function parseAndonHeader(body: string): AndonHeader | null {
  const m = ANDON_RE.exec(body);
  return m ? { runId: m[1]!, planRef: m[2]! } : null;
}

// ---------- Deliverable PR: <!-- deliverable:v1 plan:<ref> step:<id> run:<id> executor:<id> tier:<t> [engine:<e>] [image:<i>] [model:<m>] ----------

/**
 * What `build-publish` records on a deliverable pull request (US18, FR-065).
 *
 * This is the ONLY link between a build run and the pull request its work became,
 * and `deliverable-gate` reads all five of D1–D5 through it. Written by the
 * deterministic writer with its own scope — never by the executor, which holds
 * `contents: read` and could not open the PR in the first place. So the marker is
 * as trustworthy as the writer that emitted it, which is the whole point of the
 * substrate split.
 *
 * `runId` is the load-bearing field: it is the triggering `workflow_run.id`, which
 * the executor cannot author, and it is what lets D1 go back to the build run and
 * check what it was actually dispatched with rather than believing the envelope.
 */
export interface DeliverableMarker {
  planRef: string;
  stepId: string;
  /** the build run that produced the patch — trusted provenance (GHI #72 shape) */
  runId: string;
  executorId: string;
  tier: 'in-sandbox' | 'spawned';
  engine?: string;
  image?: string;
  model?: string;
}

const DELIVERABLE_RE =
  /<!--\s*deliverable:v1\s+plan:(\S+)\s+step:(step-[a-z0-9-]+)\s+run:(\d+)\s+executor:(\S+)\s+tier:(in-sandbox|spawned)(?:\s+engine:(\S+))?(?:\s+image:(\S+))?(?:\s+model:(\S+))?\s*-->/;

export function serializeDeliverableMarker(d: DeliverableMarker): string {
  const optional = [
    d.engine ? ` engine:${d.engine}` : '',
    d.image ? ` image:${d.image}` : '',
    d.model ? ` model:${d.model}` : '',
  ].join('');
  return `<!-- deliverable:v1 plan:${d.planRef} step:${d.stepId} run:${d.runId} executor:${d.executorId} tier:${d.tier}${optional} -->`;
}

export function parseDeliverableMarker(body: string): DeliverableMarker | null {
  const m = DELIVERABLE_RE.exec(body);
  if (!m) return null;
  return {
    planRef: m[1]!,
    stepId: m[2]!,
    runId: m[3]!,
    executorId: m[4]!,
    tier: m[5]! as 'in-sandbox' | 'spawned',
    ...(m[6] ? { engine: m[6] } : {}),
    ...(m[7] ? { image: m[7] } : {}),
    ...(m[8] ? { model: m[8] } : {}),
  };
}

// ---------- Judgment task-list items: - [ ] `bc-<id>` — description ----------

export interface JudgmentItem {
  id: string; // bc-* or st-* or q-*
  description: string;
  judged: boolean; // checked = ✓
}

const ITEM_RE = /^- \[( |x|X)\] `((?:bc|st|q)-[a-z0-9-]+)`\s+—\s+(.*)$/;

export function serializeJudgmentItem(item: JudgmentItem): string {
  return `- [${item.judged ? 'x' : ' '}] \`${item.id}\` — ${item.description}`;
}

export function parseJudgmentItems(body: string): JudgmentItem[] {
  const items: JudgmentItem[] = [];
  for (const line of body.split('\n')) {
    const m = ITEM_RE.exec(line.trim());
    if (m) items.push({ judged: m[1] !== ' ', id: m[2]!, description: m[3]! });
  }
  return items;
}

/** Flip one judgment item to ✓ in an issue body; returns null when the id is absent. */
export function checkJudgmentItem(body: string, id: string): string | null {
  const lines = body.split('\n');
  let found = false;
  const updated = lines.map((line) => {
    const m = ITEM_RE.exec(line.trim());
    if (m && m[2] === id) {
      found = true;
      return line.replace('- [ ]', '- [x]');
    }
    return line;
  });
  return found ? updated.join('\n') : null;
}

/** Flip one judgment item back to ✗ (re-flag path); returns null when the id is absent. */
export function uncheckJudgmentItem(body: string, id: string): string | null {
  const lines = body.split('\n');
  let found = false;
  const updated = lines.map((line) => {
    const m = ITEM_RE.exec(line.trim());
    if (m && m[2] === id) {
      found = true;
      return line.replace(/- \[(x|X)\]/, '- [ ]');
    }
    return line;
  });
  return found ? updated.join('\n') : null;
}

// ---------- Correction: <!-- correction:v1 andon:<issue#> [item:bc-<id>] ----------

export interface CorrectionMarker {
  andonIssue: number;
  /**
   * The judgment item this correction flags — or **null for a BREAK-LEVEL
   * correction**, which is about the proposal as a whole rather than one of its
   * items (US11 scope requests, GHI #73 option A1, decided 2026-07-28).
   *
   * Null rather than a synthetic id on purpose: an id naming an item that does not
   * exist on the break would be a false statement in a permanent record (FR-042),
   * and every reader that resolves item ids would have to special-case it anyway.
   * G7 — the check that makes a correction BLOCK approval — counts corrections
   * linked to the break and never reads an item, so a break-level correction blocks
   * with no gate change at all.
   */
  itemId: string | null;
}

// A ✗ correction MAY attach to a q- item (operator decision 2026-07-04). The
// `item:` clause is OPTIONAL: absent means break-level (see CorrectionMarker).
const CORRECTION_RE = /<!--\s*correction:v1\s+andon:(\d+)(?:\s+item:((?:bc|st|q)-[a-z0-9-]+))?\s*-->/;

export function serializeCorrectionMarker(c: CorrectionMarker): string {
  // The clause is omitted entirely rather than emitted empty: `item:` with nothing
  // after it would not match CORRECTION_RE, so the correction would be invisible to
  // every reader — including G7, which is what makes it block.
  const item = c.itemId === null ? '' : ` item:${c.itemId}`;
  return `<!-- correction:v1 andon:${c.andonIssue}${item} -->`;
}

export function parseCorrectionMarker(body: string): CorrectionMarker | null {
  const m = CORRECTION_RE.exec(body);
  return m ? { andonIssue: Number(m[1]), itemId: m[2] ?? null } : null;
}

// ---------- Workload header: <!-- workload:v1 id:<slug> ----------

export interface WorkloadHeader {
  id: string;
}

const WORKLOAD_RE = /<!--\s*workload:v1\s+id:([a-z0-9-]+)\s*-->/;

export function serializeWorkloadHeader(h: WorkloadHeader): string {
  return `<!-- workload:v1 id:${h.id} -->`;
}

export function parseWorkloadHeader(body: string): WorkloadHeader | null {
  const m = WORKLOAD_RE.exec(body);
  return m ? { id: m[1]! } : null;
}

// ---------- Workload lifecycle event comment ----------

export type WorkloadAction =
  | 'introduced'
  | 'activated'
  | 'edited'
  | 'deferred'
  | 'reactivated'
  | 'canceled'
  | 'completed'
  | 'archived';

export interface WorkloadEvent {
  action: WorkloadAction;
  by: string; // @login
  at: string; // ISO8601
  reason?: string; // required for canceled
  revisit?: string; // required for deferred
}

const EVENT_RE =
  /<!--\s*workload-event:v1\s+action:(\w+)\s+by:@(\S+)\s+at:(\S+?)(?:\s+reason:"([^"]*)")?(?:\s+revisit:"([^"]*)")?\s*-->/;

// reason/revisit are operator free text living inside a double-quote-delimited
// field of an HTML comment: `"` would truncate the EVENT_RE match and `-->`
// would terminate the comment itself, so both are entity-escaped on write and
// reversed on read (lossless round-trip).
function escapeMarkerValue(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/>/g, '&gt;');
}

function unescapeMarkerValue(value: string): string {
  return value.replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&amp;/g, '&');
}

// Blockquote continuation: without `> ` after each newline, only the first
// line of a multi-line reason/revisit renders inside the quote on GitHub.
function blockquote(value: string): string {
  return value.replace(/\n/g, '\n> ');
}

/**
 * Neutralize HTML-comment OPENERS in free text that rides OUTSIDE a marker.
 *
 * Every parser here takes the FIRST match in the body, so operator free text carrying a
 * verbatim `<!-- …:v1 … -->` would hijack the parse of the very comment that quotes it. On
 * the xlink path that is an FR-047 dead end reachable from a plain text input: the real link
 * keeps folding as `open`, its `conflict:open` can never clear, and every retry appends
 * another resolution comment (see serializeXLink / parseXLinkResolution).
 *
 * `&` is escaped first — escapeMarkerValue's own rule — so the transform is reversible and
 * `parseXLinkResolution` hands the operator's words back verbatim; `&amp;` renders as `&` in
 * the GitHub UI, so nothing the operator reads changes either.
 */
function escapeCommentOpeners(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/<!--/g, '&lt;!--');
}

function unescapeCommentOpeners(value: string): string {
  return value.replace(/&lt;!--/g, '<!--').replace(/&amp;/g, '&');
}

export function serializeWorkloadEvent(e: WorkloadEvent): string {
  let marker = `<!-- workload-event:v1 action:${e.action} by:@${e.by} at:${e.at}`;
  if (e.reason !== undefined) marker += ` reason:"${escapeMarkerValue(e.reason)}"`;
  if (e.revisit !== undefined) marker += ` revisit:"${escapeMarkerValue(e.revisit)}"`;
  marker += ' -->';
  // Human-visible line first: a marker-only body renders as an EMPTY comment in
  // the GitHub UI, hiding the attributed event timeline from UI-driven operators.
  let visible = `**Workload event**: \`${e.action}\` by @${e.by} at ${e.at}`;
  // escapeCommentOpeners on the VISIBLE copy (the marker's own copy is already
  // escapeMarkerValue'd): reason/revisit are operator free text, and the visible
  // block is rendered BEFORE the canonical marker. EVENT_RE takes the FIRST match,
  // so a reason quoting a literal `<!-- workload-event:v1 … -->` would hijack the
  // parse of the very comment recording it — every later history and archive read
  // would report the embedded event instead of the attributed one, falsifying the
  // audit record that FR-042 exists to keep. Nothing unescapes here because
  // parseWorkloadEvent reads the MARKER, never this line.
  if (e.reason !== undefined) visible += `\n> reason: ${blockquote(escapeCommentOpeners(e.reason))}`;
  if (e.revisit !== undefined) visible += `\n> revisit: ${blockquote(escapeCommentOpeners(e.revisit))}`;
  return `${visible}\n\n${marker}`;
}

export function parseWorkloadEvent(body: string): WorkloadEvent | null {
  const m = EVENT_RE.exec(body);
  if (!m) return null;
  const event: WorkloadEvent = { action: m[1] as WorkloadAction, by: m[2]!, at: m[3]! };
  if (m[4] !== undefined) event.reason = unescapeMarkerValue(m[4]);
  if (m[5] !== undefined) event.revisit = unescapeMarkerValue(m[5]);
  return event;
}

// ---------- Correction lifecycle event comment ----------

export type CorrectionAction = 'addressed' | 'withdrawn';

export interface CorrectionEvent {
  action: CorrectionAction;
  by: string; // @login or single-writer workflow name
  at: string; // ISO8601
  cause?: string; // required for withdrawn (data-model: causes recorded)
}

const CORRECTION_EVENT_RE =
  /<!--\s*correction-event:v1\s+action:(\w+)\s+by:@(\S+)\s+at:(\S+?)(?:\s+cause:"([^"]*)")?\s*-->/;

export function serializeCorrectionEvent(e: CorrectionEvent): string {
  let marker = `<!-- correction-event:v1 action:${e.action} by:@${e.by} at:${e.at}`;
  if (e.cause !== undefined) marker += ` cause:"${escapeMarkerValue(e.cause)}"`;
  marker += ' -->';
  // Same dual rendering as workload events: visible line first, marker after.
  let visible = `**Correction event**: \`${e.action}\` by @${e.by} at ${e.at}`;
  // Same hijack, same escape as serializeWorkloadEvent: `cause` is operator free
  // text (a withdrawal reason) rendered before the marker, and
  // CORRECTION_EVENT_RE also takes the first match. Parsed from the MARKER, so no
  // unescape counterpart is needed.
  if (e.cause !== undefined) visible += `\n> cause: ${blockquote(escapeCommentOpeners(e.cause))}`;
  return `${visible}\n\n${marker}`;
}

export function parseCorrectionEvent(body: string): CorrectionEvent | null {
  const m = CORRECTION_EVENT_RE.exec(body);
  if (!m || (m[1] !== 'addressed' && m[1] !== 'withdrawn')) return null;
  const event: CorrectionEvent = { action: m[1] as CorrectionAction, by: m[2]!, at: m[3]! };
  if (m[4] !== undefined) event.cause = unescapeMarkerValue(m[4]);
  return event;
}

// ---------- Answer: <!-- answer:v1 andon:<issue#> item:q-<id> by:@<login> at:<ISO8601> ----------

export interface AnswerMarker {
  andonIssue: number;
  itemId: string; // q-* only (FR-055/FR-056)
  by: string; // @login
  at: string; // ISO8601
}

const ANSWER_RE = /<!--\s*answer:v1\s+andon:(\d+)\s+item:(q-[a-z0-9-]+)\s+by:@(\S+)\s+at:(\S+?)\s*-->/;

export function serializeAnswer(a: AnswerMarker, text: string): string {
  const marker = `<!-- answer:v1 andon:${a.andonIssue} item:${a.itemId} by:@${a.by} at:${a.at} -->`;
  // Same dual rendering as workload/correction events: visible line first, answer
  // text as a blockquote, marker after. The marker itself carries no free text —
  // but the ANSWER TEXT does, and it is rendered BEFORE the marker, so it needs
  // escaping for the same reason (this is the xlink-resolution case exactly).
  //
  // The stake here is higher than a lost event: ANSWER_RE takes the FIRST match, so
  // an answer quoting a literal `<!-- answer:v1 andon:… item:q-… by:@someone-else … -->`
  // makes parseAnswer report THAT marker — a forged attribution on a judgment-level
  // answer, which G11 then treats as the operator's own (FR-055/FR-056).
  //
  // Unlike the event serializers, this one needs the inverse in parseAnswerText:
  // the payload rides OUTSIDE the comment, so the text is read back from the
  // blockquote (parseXLinkResolution's arrangement).
  const visible = `**Answer** to \`${a.itemId}\` by @${a.by} at ${a.at}\n> ${blockquote(escapeCommentOpeners(text))}`;
  return `${visible}\n\n${marker}`;
}

export function parseAnswer(body: string): AnswerMarker | null {
  const m = ANSWER_RE.exec(body);
  return m ? { andonIssue: Number(m[1]), itemId: m[2]!, by: m[3]!, at: m[4]! } : null;
}

/** The blockquoted free text of a marker-plus-text comment (un-blockquoted), '' when absent.
 *  Splits CRLF-tolerantly: browser form submissions canonicalize textarea content to \r\n,
 *  and a stray \r defeats both `.` and `$` in the line regex (\r is a JS line terminator).
 *  Shared by every marker whose payload rides outside the HTML comment (answers, xlink
 *  resolutions) — the inverse of `blockquote()`. */
function unblockquote(body: string): string {
  const lines: string[] = [];
  for (const line of body.split(/\r?\n/)) {
    const m = /^> ?(.*)$/.exec(line);
    if (m) lines.push(m[1]!);
  }
  return lines.join('\n');
}

/** Visible answer text of a serialized answer comment (un-blockquoted), or '' when absent.
 *  Unescapes the comment openers serializeAnswer escaped, so the operator's words come
 *  back verbatim — the same round trip as parseXLinkResolution. */
export function parseAnswerText(body: string): string {
  return unescapeCommentOpeners(unblockquote(body));
}

// ---------- Cross-workload link: <!-- xlink:v1 type:<t> with:<slug> items:<n,...> status:<s> ----------

export type XLinkType = 'depends-on' | 'conflicts-with' | 'overlaps';

export interface XLinkMarker {
  type: XLinkType;
  with: string; // the OTHER workload slug — the marker is MIRRORED, not byte-identical, across the pair
  items: number[]; // step/chunk tracking-issue refs, ascending, deduped
  status: 'open' | 'resolved';
}

// `\s+` between fields, never a literal space: issue-tracker-contract.md documents
// this marker line-broken with an indented continuation before `items:`, so the
// two-line contract form and the canonical single-line form MUST both parse.
// `items:` may legitimately be empty (a workload-level depends-on names no specific
// work item), hence `\s*` — not `\s+` — ahead of `status:`.
const XLINK_RE =
  /<!--\s*xlink:v1\s+type:(depends-on|conflicts-with|overlaps)\s+with:([a-z0-9][a-z0-9-]*)\s+items:([0-9,\s]*?)\s*status:(open|resolved)\s*-->/;

/** Item refs are a SET of issue numbers, so the marker stores them in one canonical
 *  order — ascending, deduped. Without this, two operators recording the same link in
 *  different orders would produce markers that no longer compare equal, and recordXLink's
 *  retry-safety check (is this exact open link already here?) would duplicate them. */
function normalizeItemRefs(items: number[]): number[] {
  return [...new Set(items)].sort((a, b) => a - b);
}

/**
 * Serialize a cross-workload link comment (FR-047). `resolution` is the operator's
 * recorded resolution text and rides OUTSIDE the marker as a blockquote, exactly as
 * `serializeAnswer` carries answer text — so it imposes no length limit on the marker. It is
 * emitted only for `status:resolved`: an open link has no resolution by construction, which
 * is the invariant `parseXLinkResolution` relies on.
 *
 * Riding outside the marker means the text needs no ENTITY escaping, but it must still not
 * be able to open a comment of its own: `parseXLink` takes the first `xlink:v1` match in the
 * body, so a resolution containing one would be read as the link (escapeCommentOpeners).
 */
export function serializeXLink(x: XLinkMarker, resolution?: string): string {
  const items = normalizeItemRefs(x.items);
  const marker = `<!-- xlink:v1 type:${x.type} with:${x.with} items:${items.join(',')} status:${x.status} -->`;
  // Human-visible line first: a marker-only body renders as an EMPTY comment in the
  // GitHub UI, hiding the link — and the operator's resolution — from UI-driven operators.
  const itemList = items.length > 0 ? items.map((n) => `#${n}`).join(', ') : '(none)';
  let visible = `**Cross-workload link** (${x.status}): \`${x.type}\` with \`${x.with}\` — affected items: ${itemList}`;
  if (x.status === 'resolved' && resolution !== undefined) {
    visible += `\n> ${blockquote(escapeCommentOpeners(resolution))}`;
  }
  return `${visible}\n\n${marker}`;
}

export function parseXLink(body: string): XLinkMarker | null {
  const m = XLINK_RE.exec(body);
  if (!m) return null;
  // The item group admits whitespace so the contract's two-line form parses, which means
  // char-class membership does NOT imply each comma-separated ref is a number: `items:10 20`
  // splits to the single ref "10 20", and Number() yields NaN. Validate every ref instead —
  // a NaN item renders as #NaN and is passed as an issue_number during propagation, so a
  // hand-edited marker (the GitHub-UI path is a first-class flow here — FR-025) would wedge
  // reconciliation. Rejecting the whole marker is the FAIL-SAFE choice: an unparsed comment
  // contributes nothing to `everItems`, so propagation's removal jurisdiction never reaches
  // its items and an existing `conflict:open` stays put until a human repairs the marker.
  const refs = m[3]!
    .split(',')
    .map((ref) => ref.trim())
    .filter((ref) => ref.length > 0);
  if (refs.some((ref) => !/^[0-9]+$/.test(ref) || Number(ref) === 0)) return null;
  const items = normalizeItemRefs(refs.map(Number));
  return { type: m[1] as XLinkType, with: m[2]!, items, status: m[4] as XLinkMarker['status'] };
}

/** The operator's recorded resolution text on a resolved xlink comment, '' when none.
 *  Guarded on `status:resolved`: `serializeXLink` never blockquotes text next to an open
 *  marker, so quoted text found there is somebody's prose, not a resolution — reporting
 *  it as one would put unrecorded words in the operator's mouth on the audit trail.
 *  Un-escapes the comment openers `serializeXLink` neutralized, so what comes back is the
 *  operator's text character for character. */
export function parseXLinkResolution(body: string): string {
  if (parseXLink(body)?.status !== 'resolved') return '';
  return unescapeCommentOpeners(unblockquote(body));
}

// ---------- Intent confirmation: <!-- intent-confirmed by:@<login> at:<ISO8601> chunk:<issue#> ----------

export interface IntentConfirmed {
  by: string; // @login
  at: string; // ISO8601
  chunk: number;
}

// The structured comment that permits an UNATTENDED run on a chunk (FR-018,
// issue-tracker-contract "Chunk issue"). Written only by the dashboard's
// confirm-intent action; preflight B4 requires it to be well-formed — a label
// alone is not confirmation, because the label carries no identity/timestamp.
const INTENT_CONFIRMED_RE = /<!--\s*intent-confirmed\s+by:@(\S+)\s+at:(\S+)\s+chunk:(\d+)\s*-->/;

export function serializeIntentConfirmed(c: IntentConfirmed): string {
  return `<!-- intent-confirmed by:@${c.by} at:${c.at} chunk:${c.chunk} -->`;
}

export function parseIntentConfirmed(body: string): IntentConfirmed | null {
  const m = INTENT_CONFIRMED_RE.exec(body);
  return m ? { by: m[1]!, at: m[2]!, chunk: Number(m[3]) } : null;
}

// ---------- Revision commit trailer: addresses: correction #N ----------

const ADDRESSES_RE = /addresses:\s*correction\s+#(\d+)/i;
const ADDRESSES_RE_ALL = /addresses:\s*correction\s+#(\d+)/gi;

export function parseAddressesTrailer(commitMessage: string): number | null {
  const m = ADDRESSES_RE.exec(commitMessage);
  return m ? Number(m[1]) : null;
}

/** EVERY correction a commit cites — one revision commit may carry out several
 *  corrections at once (the plan-revise agent addresses all open ones in one
 *  pass), and crediting only the first would strand the rest un-✓-able. */
export function parseAddressesTrailers(commitMessage: string): number[] {
  return [...commitMessage.matchAll(ADDRESSES_RE_ALL)].map((m) => Number(m[1]));
}
