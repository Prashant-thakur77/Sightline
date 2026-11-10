import { beforeAll, describe, expect, it } from 'vitest';
import path from 'node:path';

/**
 * Integration test against the local Postgres: the store's schedule is read from real order, case,
 * shipment, check and audit rows, for one demo scope only. Skipped without a database.
 */
try {
  process.loadEnvFile(path.resolve(import.meta.dirname, '../../../.env.local'));
} catch {
  /* CI provides env directly */
}
const hasDb = Boolean(process.env.DATABASE_URL);
const DAY = 86_400_000;

describe.skipIf(!hasDb)('holds and deadlines schedule (Postgres)', () => {
  let rt: typeof import('../src/server/runtime');
  let read: typeof import('../src/server/schedule-read');
  let audit: typeof import('../src/server/audit').audit;
  let t: typeof import('@sightline/db').tables;
  let id: (p: string) => string;
  const ago = (days: number) => new Date(Date.now() - days * DAY).toISOString();

  async function user() {
    const userId = id('usr');
    await rt
      .db()
      .insert(t.users)
      .values({ id: userId, email: `${userId}@test.local`, displayName: 'Sam', isDemo: true });
    return userId;
  }
  async function order(
    userId: string,
    o: {
      intent?: string;
      status?: string;
      createdDaysAgo: number;
      captureId?: string | null;
      authorized?: boolean;
    },
  ) {
    const orderId = id('ord');
    await rt
      .db()
      .insert(t.orders)
      .values({
        id: orderId,
        userId,
        cartId: id('crt'),
        readbackId: id('rbk'),
        snapshotId: id('snp'),
        paypalRequestId: id('req'),
        paypalOrderId: `PP-${orderId}`,
        intent: o.intent ?? 'AUTHORIZE',
        paymentSource: 'vault',
        status: o.status ?? 'authorized',
        amountCents: 3672,
        merchantId: 'demo-store',
        title: 'Harbor knit crew-neck sweater',
        authorizationId: o.authorized === false ? null : `AUTH-${orderId}`,
        captureId: o.captureId ?? null,
        createdAt: ago(o.createdDaysAgo),
      });
    return orderId;
  }

  beforeAll(async () => {
    rt = await import('../src/server/runtime');
    read = await import('../src/server/schedule-read');
    ({ audit } = await import('../src/server/audit'));
    ({ tables: t } = await import('@sightline/db'));
    ({ newId: id } = await import('@sightline/core'));
  });

  it('reads a held order with an open case: renewals, the reply-by from the audit log, and the paused auto-capture', async () => {
    const me = await user();
    const orderId = await order(me, { status: 'case_open', createdDaysAgo: 4 });
    await rt
      .db()
      .insert(t.shipments)
      .values({ orderId, status: 'delivered', shippedVariant: 'wrong_size', deliveredAt: ago(2) });
    await rt
      .db()
      .insert(t.verifications)
      .values({
        id: id('ver'),
        orderId,
        status: 'done',
        verdict: { kind: 'mismatch', headline: 'x', reasons: [] },
      });
    const caseId = id('cas');
    const due = new Date(Date.now() + 3 * DAY).toISOString();
    await rt
      .db()
      .insert(t.cases)
      .values({
        id: caseId,
        orderId,
        userId: me,
        kind: 'void',
        stage: 'seller_contacted',
        status: 'open',
        reason: 'size',
        dueAt: due,
      });
    await audit({
      userId: me,
      actor: 'paypal',
      action: 'payment.reauthorized',
      subjectId: orderId,
      payload: { n: 1 },
    });
    await audit({
      userId: me,
      actor: 'user',
      action: 'case.return_requested',
      subjectId: orderId,
      payload: { caseId, dueAt: due },
    });

    const s = await read.loadSchedule(me);
    expect(s.rows).toHaveLength(1);
    const row = s.rows[0]!;
    expect(row).toMatchObject({
      orderId,
      caseId,
      href: `/merchant/disputes#case-${caseId}`,
      stateWords: 'On hold, case open',
      buyer: 'Sam',
      amount: '$36.72',
      active: true,
    });
    const kinds = row.events.map((e) => e.kind);
    expect(kinds).toContain('authorization');
    expect(kinds.filter((k) => k === 'reauthorized')).toHaveLength(1);
    expect(row.events.find((e) => e.kind === 'reply_by')).toMatchObject({ start: due, status: 'planned' });
    expect(row.events.find((e) => e.kind === 'auto_capture')).toMatchObject({ status: 'paused' });
    expect(row.nextDue).not.toBeNull();
  });

  it('shows only the demo scope, never a draft case, and keeps a recently settled hold with what happened', async () => {
    const me = await user();
    const someoneElse = await user();
    const theirs = await order(someoneElse, { createdDaysAgo: 1 });
    const settled = await order(me, { status: 'verified_match', createdDaysAgo: 2, captureId: 'CAP-x' });
    await audit({
      userId: me,
      actor: 'agent',
      action: 'payment.captured_after_check',
      subjectId: settled,
      payload: { captureId: 'CAP-x' },
    });
    const paidAtOrder = await order(me, {
      intent: 'CAPTURE',
      status: 'captured',
      createdDaysAgo: 1,
      captureId: 'CAP-y',
      authorized: false,
    });
    await rt
      .db()
      .insert(t.cases)
      .values({
        id: id('cas'),
        orderId: paidAtOrder,
        userId: me,
        kind: 'refund',
        stage: 'draft',
        status: 'draft',
        reason: 'size',
      });

    const s = await read.loadSchedule(me);
    const ids = s.rows.map((r) => r.orderId);
    expect(ids).toEqual([settled]);
    expect(ids).not.toContain(theirs);
    const row = s.rows[0]!;
    expect(row).toMatchObject({
      active: false,
      stateWords: 'Settled: store paid',
      href: '/merchant',
      caseId: null,
    });
    expect(row.events.find((e) => e.kind === 'captured')?.tone).toBe('done');
    expect(row.events.find((e) => e.kind === 'authorization')?.status).toBe('ended');
  });

  it('is empty for a scope with no orders', async () => {
    const s = await read.loadSchedule(await user());
    expect(s.rows).toEqual([]);
  });
});
