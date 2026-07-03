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
  id: string; // bc-* or st-*
  description: string;
  judged: boolean; // checked = ✓
}

const ITEM_RE = /^- \[( |x|X)\] `((?:bc|st)-[a-z0-9-]+)`\s+—\s+(.*)$/;

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

// ---------- Correction: <!-- correction:v1 andon:<issue#> item:bc-<id> ----------

export interface CorrectionMarker {
  andonIssue: number;
  itemId: string;
}

const CORRECTION_RE = /<!--\s*correction:v1\s+andon:(\d+)\s+item:((?:bc|st)-[a-z0-9-]+)\s*-->/;

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

export function serializeWorkloadEvent(e: WorkloadEvent): string {
  let s = `<!-- workload-event:v1 action:${e.action} by:@${e.by} at:${e.at}`;
  if (e.reason !== undefined) s += ` reason:"${e.reason}"`;
  if (e.revisit !== undefined) s += ` revisit:"${e.revisit}"`;
  return `${s} -->`;
}

export function parseWorkloadEvent(body: string): WorkloadEvent | null {
  const m = EVENT_RE.exec(body);
  if (!m) return null;
  const event: WorkloadEvent = { action: m[1] as WorkloadAction, by: m[2]!, at: m[3]! };
  if (m[4] !== undefined) event.reason = m[4];
  if (m[5] !== undefined) event.revisit = m[5];
  return event;
}

// ---------- Revision commit trailer: addresses: correction #N ----------

const ADDRESSES_RE = /addresses:\s*correction\s+#(\d+)/i;

export function parseAddressesTrailer(commitMessage: string): number | null {
  const m = ADDRESSES_RE.exec(commitMessage);
  return m ? Number(m[1]) : null;
}
