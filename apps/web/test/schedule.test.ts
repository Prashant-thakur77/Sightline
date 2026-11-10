import { describe, expect, it } from 'vitest';
import { buildSchedule, orderEvents, type ScheduleEvent, type ScheduleOrderFacts } from '@/server/schedule';
import {
  AUTHORIZATION_DAYS,
  AUTO_CAPTURE_DAYS,
  CHECK_REMINDER_DAYS,
  DAY_MS,
  HONOR_PERIOD_DAYS,
} from '@/server/hold-rules';

/* Every date on the store's schedule comes from the order's own rows and the hold rules. */

const NOW = new Date('2026-11-09T12:00:00.000Z');
const at = (days: number) => new Date(NOW.getTime() + days * DAY_MS).toISOString();
const plus = (iso: string, days: number) => new Date(Date.parse(iso) + days * DAY_MS).toISOString();

function held(o: Partial<ScheduleOrderFacts> = {}): ScheduleOrderFacts {
  return {
    id: 'ord_held',
    title: 'Harbor knit crew-neck sweater',
    buyer: 'Maya',
    amountCents: 3672,
    currency: 'USD',
    intent: 'AUTHORIZE',
    status: 'authorized',
    authorizationId: 'AUTH-1',
    captureId: null,
    createdAt: at(-1),
    updatedAt: at(-1),
    deliveredAt: null,
    verdict: null,
    kase: null,
    happenings: [],
    ...o,
  };
}

const kinds = (es: ScheduleEvent[]) => es.map((e) => e.kind);
const only = (es: ScheduleEvent[], kind: ScheduleEvent['kind']) => es.filter((e) => e.kind === kind);
const one = (es: ScheduleEvent[], kind: ScheduleEvent['kind']) => {
  const found = only(es, kind);
  expect(found, `exactly one ${kind}`).toHaveLength(1);
  return found[0]!;
};

describe('a hold that is still running', () => {
  it('spans the PayPal authorization from authorize to the 29-day limit', () => {
    const o = held();
    const auth = one(orderEvents(o, NOW), 'authorization');
    expect(auth.start).toBe(o.createdAt);
    expect(auth.end).toBe(plus(o.createdAt, AUTHORIZATION_DAYS));
    expect(auth.tone).toBe('hold');
    expect(auth.status).toBe('running');
    expect(auth.statusWords).toBe('Running now');
    expect(auth.detail).toContain('$36.72');
  });

  it('has an honour period every 3 days, each ending in a planned renewal, inside the 29 days', () => {
    const o = held();
    const es = orderEvents(o, NOW);
    const honour = only(es, 'honour');
    const renew = only(es, 'reauthorize');
    expect(honour[0]).toMatchObject({
      start: o.createdAt,
      end: plus(o.createdAt, HONOR_PERIOD_DAYS),
      status: 'running',
      label: 'Honour period 1',
    });
    expect(honour.slice(1).every((h) => h.status === 'planned')).toBe(true);
    // Renewals at days 3, 6, … 27: PayPal allows none on or after day 29.
    expect(renew.map((r) => r.start)).toEqual(
      [3, 6, 9, 12, 15, 18, 21, 24, 27].map((d) => plus(o.createdAt, d)),
    );
    expect(renew.every((r) => r.tone === 'deadline' && r.end === null && r.status === 'planned')).toBe(true);
    // No honour period runs past the end of the authorization.
    const limit = Date.parse(plus(o.createdAt, AUTHORIZATION_DAYS));
    expect(honour.every((h) => Date.parse(h.end!) <= limit)).toBe(true);
  });

  it('after delivery: the day-5 reminder and the day-7 auto-capture, and renewals only until then', () => {
    const o = held({ createdAt: at(-3.5), deliveredAt: at(-2), status: 'delivered' });
    const es = orderEvents(o, NOW);
    expect(one(es, 'reminder')).toMatchObject({
      start: plus(o.deliveredAt!, CHECK_REMINDER_DAYS),
      status: 'planned',
      tone: 'deadline',
      end: null,
    });
    const cap = one(es, 'auto_capture');
    expect(cap).toMatchObject({ start: plus(o.deliveredAt!, AUTO_CAPTURE_DAYS), status: 'planned' });
    expect(cap.detail).toContain('$36.72');
    // The first renewal is past due (the sweep has not run yet); the next ones stop at the auto-capture.
    const renew = only(es, 'reauthorize');
    expect(renew[0]).toMatchObject({
      start: plus(o.createdAt, 3),
      status: 'overdue',
      statusWords: 'Past due',
    });
    expect(renew.every((r) => Date.parse(r.start) < Date.parse(cap.start))).toBe(true);
  });

  it('reauthorized twice: three honour periods from the real renewals, and the next one planned', () => {
    const r1 = at(-5.9);
    const r2 = at(-2.8);
    const o = held({
      createdAt: at(-9),
      happenings: [
        { action: 'payment.reauthorized', at: r1, payload: { n: 1 } },
        { action: 'payment.reauthorized', at: r2, payload: { n: 2 } },
      ],
    });
    const es = orderEvents(o, NOW);
    const done = only(es, 'reauthorized');
    expect(done.map((d) => [d.start, d.tone, d.status, d.label])).toEqual([
      [r1, 'done', 'done', 'Hold renewed'],
      [r2, 'done', 'done', 'Hold renewed'],
    ]);
    const honour = only(es, 'honour');
    expect(honour.slice(0, 3).map((h) => [h.start, h.end, h.status])).toEqual([
      [o.createdAt, plus(o.createdAt, 3), 'ended'],
      [r1, plus(r1, 3), 'ended'],
      [r2, plus(r2, 3), 'running'],
    ]);
    expect(only(es, 'reauthorize')[0]).toMatchObject({
      start: plus(r2, 3),
      status: 'planned',
      label: 'Renew hold',
    });
    expect(only(es, 'reauthorize')[0]!.detail).toContain('renewal 3');
  });

  it('pauses the day-7 auto-capture while a case is open, and stops renewals at the case deadline', () => {
    const due = at(2);
    const o = held({
      createdAt: at(-6),
      deliveredAt: at(-4),
      status: 'case_open',
      verdict: 'mismatch',
      kase: {
        id: 'cas_1',
        kind: 'void',
        stage: 'seller_contacted',
        dueAt: due,
        createdAt: at(-1),
        updatedAt: at(-1),
        offers: [],
        outcome: null,
      },
      happenings: [{ action: 'case.return_requested', at: at(-1), payload: { caseId: 'cas_1', dueAt: due } }],
    });
    const es = orderEvents(o, NOW);
    expect(one(es, 'auto_capture')).toMatchObject({ status: 'paused', statusWords: 'Paused' });
    expect(one(es, 'auto_capture').detail).toMatch(/case is open/);
    expect(only(es, 'reminder')).toHaveLength(0);
    const reply = one(es, 'reply_by');
    expect(reply).toMatchObject({ start: due, status: 'planned', tone: 'deadline' });
    expect(reply.detail).toMatch(/hold is released/);
    expect(only(es, 'reauthorize').every((r) => Date.parse(r.start) < Date.parse(due))).toBe(true);
  });

  it('an offer on a held payment: the reply-by was answered and the offer deadline is next', () => {
    const replyDue = at(-1);
    const offerDue = at(8);
    const o = held({
      createdAt: at(-6),
      deliveredAt: at(-4),
      status: 'case_open',
      kase: {
        id: 'cas_2',
        kind: 'void',
        stage: 'offer_received',
        dueAt: offerDue,
        createdAt: at(-3),
        updatedAt: at(-2),
        offers: [{ at: at(-2) }],
        outcome: null,
      },
      happenings: [{ action: 'case.return_requested', at: at(-3), payload: { dueAt: replyDue } }],
    });
    const es = orderEvents(o, NOW);
    expect(one(es, 'reply_by')).toMatchObject({
      start: replyDue,
      status: 'answered',
      statusWords: 'Answered',
    });
    expect(one(es, 'offer_by')).toMatchObject({ start: offerDue, status: 'planned', tone: 'deadline' });
  });

  it('a replacement was agreed: the store is paid a week after that, not a week after delivery', () => {
    const agreed = at(-2);
    const o = held({
      createdAt: at(-8),
      deliveredAt: at(-6),
      status: 'resolved_replacement',
      kase: {
        id: 'cas_3',
        kind: 'void',
        stage: 'resolved',
        dueAt: at(3),
        createdAt: at(-5),
        updatedAt: agreed,
        offers: [{ at: at(-4) }],
        outcome: { kind: 'replacement' },
      },
    });
    const cap = one(orderEvents(o, NOW), 'auto_capture');
    expect(cap.start).toBe(plus(agreed, AUTO_CAPTURE_DAYS));
    expect(cap.label).toBe('Paid after replacement');
  });
});

describe('a hold that ended', () => {
  it('captured early after a match: the hold ends at the capture and nothing more is planned', () => {
    const paid = at(-0.5);
    const o = held({
      createdAt: at(-2),
      deliveredAt: at(-1),
      status: 'verified_match',
      captureId: 'CAP-1',
      verdict: 'match',
      happenings: [{ action: 'payment.captured_after_check', at: paid, payload: { captureId: 'CAP-1' } }],
    });
    const es = orderEvents(o, NOW);
    expect(one(es, 'authorization')).toMatchObject({ start: o.createdAt, end: paid, status: 'ended' });
    expect(one(es, 'honour')).toMatchObject({ start: o.createdAt, end: paid, status: 'ended' });
    expect(one(es, 'captured')).toMatchObject({ start: paid, end: null, tone: 'done', label: 'Store paid' });
    for (const k of ['reauthorize', 'reminder', 'auto_capture'] as const) expect(only(es, k)).toHaveLength(0);
  });

  it('voided at the deadline: the reply-by was missed and the hold was released', () => {
    const due = at(-1);
    const voided = at(-0.9);
    const o = held({
      createdAt: at(-8),
      deliveredAt: at(-6),
      status: 'voided',
      kase: {
        id: 'cas_4',
        kind: 'void',
        stage: 'resolved',
        dueAt: due,
        createdAt: at(-4),
        updatedAt: voided,
        offers: [],
        outcome: { kind: 'voided', by: 'deadline' },
      },
      happenings: [
        { action: 'case.return_requested', at: at(-4), payload: { dueAt: due } },
        { action: 'payment.voided_no_reply', at: voided, payload: {} },
      ],
    });
    const es = orderEvents(o, NOW);
    expect(one(es, 'reply_by')).toMatchObject({ start: due, status: 'missed', statusWords: 'Missed' });
    expect(one(es, 'released')).toMatchObject({ start: voided, tone: 'done' });
    expect(one(es, 'released').detail).toMatch(/never charged/);
    expect(one(es, 'authorization')).toMatchObject({ end: voided, status: 'ended' });
    expect(kinds(es)).not.toContain('reauthorize');
  });

  it('a case resolved by a refund on a paid order: the refund and its amount', () => {
    const o = held({
      intent: 'CAPTURE',
      authorizationId: null,
      captureId: 'CAP-9',
      status: 'resolved_refund',
      createdAt: at(-6),
      kase: {
        id: 'cas_5',
        kind: 'refund',
        stage: 'resolved',
        dueAt: at(-2),
        createdAt: at(-4),
        updatedAt: at(-3),
        offers: [],
        outcome: { kind: 'refunded' },
      },
      happenings: [
        { action: 'case.sent_to_seller', at: at(-4), payload: { dueAt: at(-1) } },
        { action: 'case.refunded', at: at(-3), payload: { amountCents: 3672 } },
      ],
    });
    const es = orderEvents(o, NOW);
    expect(kinds(es)).not.toContain('authorization');
    expect(one(es, 'reply_by')).toMatchObject({ start: at(-1), status: 'answered' });
    expect(one(es, 'refunded')).toMatchObject({ start: at(-3), tone: 'done' });
    expect(one(es, 'refunded').detail).toContain('$36.72');
  });

  it('a hold the 29 days ran out on reads as expired, with nothing planned after it', () => {
    const o = held({ createdAt: at(-30) });
    const es = orderEvents(o, NOW);
    expect(one(es, 'authorization')).toMatchObject({ status: 'expired', statusWords: 'Expired' });
    expect(only(es, 'reauthorize')).toHaveLength(0);
  });

  it('a renewal the sweep has not run yet is past due once; the next ones count from now', () => {
    const o = held({ createdAt: at(-4) });
    const renew = only(orderEvents(o, NOW), 'reauthorize');
    expect(renew[0]).toMatchObject({ start: plus(o.createdAt, HONOR_PERIOD_DAYS), status: 'overdue' });
    expect(renew[1]).toMatchObject({ start: at(HONOR_PERIOD_DAYS), status: 'planned' });
    expect(renew.filter((r) => r.status === 'overdue')).toHaveLength(1);
  });
});

describe('buildSchedule', () => {
  const paidLongAgo = held({
    id: 'ord_old',
    intent: 'AUTHORIZE',
    captureId: 'CAP-2',
    status: 'captured',
    createdAt: at(-40),
    happenings: [{ action: 'payment.captured_no_check', at: at(-30), payload: {} }],
  });
  const capturedNoCase = held({
    id: 'ord_plain',
    intent: 'CAPTURE',
    authorizationId: null,
    captureId: 'CAP-3',
    status: 'captured',
    createdAt: at(-1),
  });
  const soon = held({
    id: 'ord_soon',
    createdAt: at(-5),
    deliveredAt: at(-4.5),
    happenings: [{ action: 'payment.reauthorized', at: at(-2), payload: { n: 1 } }],
  });
  const later = held({ id: 'ord_later', createdAt: at(-1) });
  const settled = held({
    id: 'ord_settled',
    captureId: 'CAP-4',
    status: 'verified_match',
    createdAt: at(-2),
    happenings: [{ action: 'payment.captured_after_check', at: at(-1), payload: {} }],
  });
  const openCase = held({
    id: 'ord_case',
    intent: 'CAPTURE',
    authorizationId: null,
    captureId: 'CAP-5',
    status: 'case_open',
    createdAt: at(-5),
    kase: {
      id: 'cas_open',
      kind: 'refund',
      stage: 'seller_contacted',
      dueAt: at(1),
      createdAt: at(-1),
      updatedAt: at(-1),
      offers: [],
      outcome: null,
    },
  });
  const s = buildSchedule([paidLongAgo, capturedNoCase, later, settled, soon, openCase], NOW);

  it('has one row per order with money on hold or a case open, then recently settled holds', () => {
    expect(s.rows.map((r) => r.orderId)).toEqual(['ord_soon', 'ord_case', 'ord_later', 'ord_settled']);
    expect(s.rows.map((r) => r.active)).toEqual([true, true, true, false]);
    expect(s.rows.map((r) => r.stateWords)).toEqual([
      'On hold',
      'Case open',
      'On hold',
      'Settled: store paid',
    ]);
  });

  it('links each row to its case on the cases desk, or to the Orders page when there is no case', () => {
    const c = s.rows.find((r) => r.orderId === 'ord_case')!;
    expect(c.href).toBe('/merchant/disputes#case-cas_open');
    expect(c.linkWords).toMatch(/^Open case .+ on the cases desk$/);
    expect(s.rows.find((r) => r.orderId === 'ord_later')!.href).toBe('/merchant');
  });

  it('gives the next deadline of each active row, and a range that holds every event and now', () => {
    const soonRow = s.rows[0]!;
    expect(soonRow.nextDue).toBe(plus(soon.deliveredAt!, CHECK_REMINDER_DAYS));
    const all = s.rows.flatMap((r) => r.events);
    expect(Date.parse(s.start)).toBeLessThanOrEqual(
      Math.min(...all.map((e) => Date.parse(e.start)), NOW.getTime()),
    );
    expect(Date.parse(s.end)).toBeGreaterThanOrEqual(
      Math.max(...all.map((e) => Date.parse(e.end ?? e.start)), NOW.getTime()),
    );
    expect(s.now).toBe(NOW.toISOString());
  });

  it('labels every event in words: a kind, a status and a sentence', () => {
    for (const e of s.rows.flatMap((r) => r.events)) {
      expect(['Hold', 'Deadline', 'Done']).toContain(e.toneWords);
      expect(e.statusWords.length).toBeGreaterThan(2);
      expect(e.label.length).toBeGreaterThan(2);
      expect(e.detail).toMatch(/\.$/);
    }
  });

  it('is empty, with a sensible range, when nothing is held', () => {
    const empty = buildSchedule([capturedNoCase], NOW);
    expect(empty.rows).toEqual([]);
    expect(Date.parse(empty.start)).toBeLessThan(NOW.getTime());
    expect(Date.parse(empty.end)).toBeGreaterThan(NOW.getTime());
  });
});
