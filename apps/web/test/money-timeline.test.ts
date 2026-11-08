import { describe, expect, it } from 'vitest';
import { buildMoneyTimeline, type TimelineCase, type TimelineEntry, type TimelineOrder } from '@/lib/money-timeline';

/* The money timeline only says what the records say: no record, no line. */

const order = (id: string, over: Partial<TimelineOrder> = {}): TimelineOrder => ({
  id,
  title: 'Harbor knit crew-neck sweater',
  amountCents: 3672,
  currency: 'USD',
  intent: 'AUTHORIZE',
  status: 'delivered',
  authorizationId: null,
  captureId: null,
  authorizationExpiresAt: null,
  ...over,
});
let seq = 0;
const entry = (action: string, subjectId: string, at: string, payload: Record<string, unknown> = {}): TimelineEntry => ({
  seq: ++seq,
  action,
  subjectId,
  payload: { ...payload, _at: at },
  createdAt: '2026-11-09T12:00:00.000Z',
});
const now = new Date('2026-11-09T12:00:00.000Z');

describe('buildMoneyTimeline', () => {
  it('is empty when nothing about money was recorded', () => {
    const events = buildMoneyTimeline({ orders: [order('o1')], cases: [], entries: [entry('check.verdict', 'o1', '2026-11-08T10:00:00Z')], now });
    expect(events).toEqual([]);
  });

  it('lists holds, payments and releases newest first, with amounts from integer cents', () => {
    const events = buildMoneyTimeline({
      orders: [order('o1', { status: 'voided', authorizationId: 'A1' }), order('o2', { intent: 'CAPTURE', status: 'captured', captureId: 'C2', amountCents: 2999 })],
      cases: [],
      entries: [
        entry('payment.authorized', 'o1', '2026-11-05T10:00:00Z'),
        entry('payment.captured', 'o2', '2026-11-07T10:00:00Z'),
        entry('payment.voided_after_check', 'o1', '2026-11-08T10:00:00Z'),
      ],
      now,
    });
    expect(events.map((e) => [e.orderId, e.status.word, e.amount])).toEqual([
      ['o1', 'Hold released', '$36.72'],
      ['o2', 'Paid', '$29.99'],
      ['o1', 'On hold', '$36.72'],
    ]);
    expect(events[0]!.sentence).toBe('PayPal released the hold on $36.72. Demo Store was never paid.');
  });

  it('puts a case deadline still ahead at the top, and drops it once the case is resolved', () => {
    const entries = [entry('case.sent_to_seller', 'o1', '2026-11-08T10:00:00Z')];
    const open: TimelineCase = { orderId: 'o1', stage: 'seller_contacted', status: 'open', dueAt: '2026-11-12T10:00:00Z' };
    const events = buildMoneyTimeline({ orders: [order('o1', { status: 'case_open' })], cases: [open], entries, now });
    expect(events.map((e) => e.status.word)).toEqual(['Reply due', 'Case sent']);
    expect(events[0]!.upcoming).toBe(true);
    const resolved = buildMoneyTimeline({ orders: [order('o1')], cases: [{ ...open, stage: 'resolved', status: 'resolved' }], entries, now });
    expect(resolved.map((e) => e.status.word)).toEqual(['Case sent']);
  });

  it('shows when a hold ends only while the money is still held', () => {
    const exp = '2026-12-01T00:00:00Z';
    const heldOrder = order('o1', { status: 'authorized', authorizationId: 'A1', authorizationExpiresAt: exp });
    expect(buildMoneyTimeline({ orders: [heldOrder], cases: [], entries: [], now }).map((e) => e.status.word)).toEqual(['Hold ends']);
    const captured = { ...heldOrder, captureId: 'C1', status: 'verified_match' };
    expect(buildMoneyTimeline({ orders: [captured], cases: [], entries: [], now })).toEqual([]);
  });

  it('ignores entries about orders that are not this buyer’s', () => {
    const events = buildMoneyTimeline({ orders: [order('o1')], cases: [], entries: [entry('payment.captured', 'someone-else', '2026-11-08T10:00:00Z')], now });
    expect(events).toEqual([]);
  });

  it('uses the refunded amount the record gives', () => {
    const events = buildMoneyTimeline({
      orders: [order('o1', { intent: 'CAPTURE', captureId: 'C1', status: 'resolved_refund' })],
      cases: [],
      entries: [entry('case.refunded', 'o1', '2026-11-08T10:00:00Z', { amountCents: 1000 })],
      now,
    });
    expect(events[0]!.amount).toBe('$10.00');
    expect(events[0]!.sentence).toBe('Demo Store refunded $10.00 through PayPal.');
  });
});
