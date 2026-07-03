import { describe, expect, it } from 'vitest';
import {
  serializeAndonHeader,
  parseAndonHeader,
  serializeJudgmentItem,
  parseJudgmentItems,
  checkJudgmentItem,
  serializeCorrectionMarker,
  parseCorrectionMarker,
  serializeWorkloadHeader,
  parseWorkloadHeader,
  serializeWorkloadEvent,
  parseWorkloadEvent,
  parseAddressesTrailer,
} from '../../dashboard/lib/github/markers';

describe('machine-readable markers (T013/T014)', () => {
  it('round-trips the andon header', () => {
    const h = { runId: 'run-42', planRef: 'plan/demo/v1' };
    expect(parseAndonHeader(serializeAndonHeader(h))).toEqual(h);
  });

  it('round-trips judgment items and flips ✓', () => {
    const body = [
      serializeJudgmentItem({ id: 'bc-empty-name', description: 'fallback greeting', judged: false }),
      serializeJudgmentItem({ id: 'st-upgrade', description: 'upgrade transition', judged: true }),
    ].join('\n');
    const items = parseJudgmentItems(body);
    expect(items).toHaveLength(2);
    expect(items[0]).toMatchObject({ id: 'bc-empty-name', judged: false });
    expect(items[1]).toMatchObject({ id: 'st-upgrade', judged: true });

    const checked = checkJudgmentItem(body, 'bc-empty-name');
    expect(checked).not.toBeNull();
    expect(parseJudgmentItems(checked!).every((i) => i.judged)).toBe(true);
    expect(checkJudgmentItem(body, 'bc-missing')).toBeNull();
  });

  it('round-trips correction and workload markers', () => {
    const c = { andonIssue: 7, itemId: 'bc-empty-name' };
    expect(parseCorrectionMarker(serializeCorrectionMarker(c))).toEqual(c);
    expect(parseWorkloadHeader(serializeWorkloadHeader({ id: 'demo' }))).toEqual({ id: 'demo' });
  });

  it('round-trips workload events including reason/revisit', () => {
    const deferred = { action: 'deferred' as const, by: 'sme-operator', at: '2026-07-02T12:00:00Z', revisit: '2026-08-01' };
    expect(parseWorkloadEvent(serializeWorkloadEvent(deferred))).toEqual(deferred);
    const canceled = { action: 'canceled' as const, by: 'sme-operator', at: '2026-07-02T12:00:00Z', reason: 'priorities changed' };
    expect(parseWorkloadEvent(serializeWorkloadEvent(canceled))).toEqual(canceled);
  });

  it('rejects malformed markers', () => {
    expect(parseAndonHeader('<!-- andon:v2 nope -->')).toBeNull();
    expect(parseWorkloadHeader('<!-- workload:v1 -->')).toBeNull();
    expect(parseCorrectionMarker('correction: yes please')).toBeNull();
  });

  it('parses the addresses commit trailer', () => {
    expect(parseAddressesTrailer('fix greeting\n\naddresses: correction #12')).toBe(12);
    expect(parseAddressesTrailer('fix greeting')).toBeNull();
  });
});
