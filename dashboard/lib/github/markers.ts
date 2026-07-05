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

// ---------- Correction: <!-- correction:v1 andon:<issue#> item:bc-<id> ----------

export interface CorrectionMarker {
  andonIssue: number;
  itemId: string;
}

// A ✗ correction MAY attach to a q- item (operator decision 2026-07-04).
const CORRECTION_RE = /<!--\s*correction:v1\s+andon:(\d+)\s+item:((?:bc|st|q)-[a-z0-9-]+)\s*-->/;

export function serializeCorrectionMarker(c: CorrectionMarker): string {
  return `<!-- correction:v1 andon:${c.andonIssue} item:${c.itemId} -->`;
}

export function parseCorrectionMarker(body: string): CorrectionMarker | null {
  const m = CORRECTION_RE.exec(body);
  return m ? { andonIssue: Number(m[1]), itemId: m[2]! } : null;
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

export function serializeWorkloadEvent(e: WorkloadEvent): string {
  let marker = `<!-- workload-event:v1 action:${e.action} by:@${e.by} at:${e.at}`;
  if (e.reason !== undefined) marker += ` reason:"${escapeMarkerValue(e.reason)}"`;
  if (e.revisit !== undefined) marker += ` revisit:"${escapeMarkerValue(e.revisit)}"`;
  marker += ' -->';
  // Human-visible line first: a marker-only body renders as an EMPTY comment in
  // the GitHub UI, hiding the attributed event timeline from UI-driven operators.
  let visible = `**Workload event**: \`${e.action}\` by @${e.by} at ${e.at}`;
  if (e.reason !== undefined) visible += `\n> reason: ${blockquote(e.reason)}`;
  if (e.revisit !== undefined) visible += `\n> revisit: ${blockquote(e.revisit)}`;
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
  if (e.cause !== undefined) visible += `\n> cause: ${blockquote(e.cause)}`;
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
  // Same dual rendering as workload/correction events: visible line first,
  // answer text as a blockquote, marker after. The marker carries no free
  // text, so nothing needs entity-escaping.
  const visible = `**Answer** to \`${a.itemId}\` by @${a.by} at ${a.at}\n> ${blockquote(text)}`;
  return `${visible}\n\n${marker}`;
}

export function parseAnswer(body: string): AnswerMarker | null {
  const m = ANSWER_RE.exec(body);
  return m ? { andonIssue: Number(m[1]), itemId: m[2]!, by: m[3]!, at: m[4]! } : null;
}

/** Visible answer text of a serialized answer comment (un-blockquoted), or '' when absent.
 *  Splits CRLF-tolerantly: browser form submissions canonicalize textarea content to \r\n,
 *  and a stray \r defeats both `.` and `$` in the line regex (\r is a JS line terminator). */
export function parseAnswerText(body: string): string {
  const lines: string[] = [];
  for (const line of body.split(/\r?\n/)) {
    const m = /^> ?(.*)$/.exec(line);
    if (m) lines.push(m[1]!);
  }
  return lines.join('\n');
}

// ---------- Revision commit trailer: addresses: correction #N ----------

const ADDRESSES_RE = /addresses:\s*correction\s+#(\d+)/i;

export function parseAddressesTrailer(commitMessage: string): number | null {
  const m = ADDRESSES_RE.exec(commitMessage);
  return m ? Number(m[1]) : null;
}
