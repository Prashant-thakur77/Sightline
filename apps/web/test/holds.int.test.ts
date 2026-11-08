import { beforeAll, describe, expect, it } from 'vitest';
import path from 'node:path';

/**
 * Integration test against the local Postgres with a fake PayPal: the life of a pay-after-check
 * hold. Every rule is checked on orders this test creates only. Skipped without a database.
 */
try {
  process.loadEnvFile(path.resolve(import.meta.dirname, '../../../.env.local'));
} catch {
  /* CI provides env directly */
}
const hasDb = Boolean(process.env.DATABASE_URL);
const DAY = 86_400_000;

describe.skipIf(!hasDb)('payment holds over time (Postgres, fake PayPal)', () => {
  let holds: typeof import('../src/server/holds');
  let rt: typeof import('../src/server/runtime');
  let t: typeof import('@sightline/db').tables;
  let id: (p: string) => string;
  let eq: typeof import('drizzle-orm').eq;

  const calls: { op: string; auth: string; requestId: string }[] = [];
  let failCapture = 0;
  const fake = {
    async captureAuthorization(auth: string, i: { requestId: string }) {
      calls.push({ op: 'capture', auth, requestId: i.requestId });
      if (failCapture > 0) {
        failCapture--;
        throw new Error('PayPal 500');
      }
      return { id: `CAP-${auth}`, status: 'COMPLETED' } as never;
    },
    async voidAuthorization(auth: string, i: { requestId: string }) {
      calls.push({ op: 'void', auth, requestId: i.requestId });
      return undefined;
    },
    async reauthorize(auth: string, i: { requestId: string }) {
      calls.push({ op: 'reauthorize', auth, requestId: i.requestId });
      return { id: `RE-${auth}`, status: 'CREATED', expiration_time: new Date(Date.now() + 29 * DAY).toISOString() } as never;
    },
  };
  const opsFor = (auth: string) => calls.filter((c) => c.auth === auth).map((c) => c.op);

  async function heldOrder(o: { createdDaysAgo?: number; deliveredDaysAgo?: number; status?: string } = {}) {
    const userId = id('usr');
    await rt.db().insert(t.users).values({ id: userId, email: `${userId}@test.local`, displayName: 'Test', isDemo: true });
    const orderId = id('ord');
    const auth = `AUTH-${orderId}`;
    const created = new Date(Date.now() - (o.createdDaysAgo ?? 1) * DAY).toISOString();
    await rt.db().insert(t.orders).values({
      id: orderId,
      userId,
      cartId: id('crt'),
      readbackId: id('rbk'),
      snapshotId: id('snp'),
      paypalRequestId: id('req'),
      paypalOrderId: `PP-${orderId}`,
      intent: 'AUTHORIZE',
      paymentSource: 'vault',
      status: o.status ?? 'authorized',
      amountCents: 3672,
      merchantId: 'demo-store',
      title: 'Harbor knit crew-neck sweater',
      authorizationId: auth,
      createdAt: created,
    });
    if (o.deliveredDaysAgo !== undefined)
      await rt.db().insert(t.shipments).values({ orderId, status: 'delivered', shippedVariant: 'correct', deliveredAt: new Date(Date.now() - o.deliveredDaysAgo * DAY).toISOString() });
    return { userId, orderId, auth };
  }
  const order = async (orderId: string) => (await rt.db().select().from(t.orders).where(eq(t.orders.id, orderId)))[0]!;
  const notes = async (userId: string) => (await rt.db().select().from(t.notifications).where(eq(t.notifications.userId, userId))).map((n) => n.text);

  beforeAll(async () => {
    rt = await import('../src/server/runtime');
    holds = await import('../src/server/holds');
    ({ tables: t } = await import('@sightline/db'));
    ({ newId: id } = await import('@sightline/core'));
    ({ eq } = await import('drizzle-orm'));
  });

  it('voids the hold when the store does not answer a return request by the deadline, once', async () => {
    const { userId, orderId, auth } = await heldOrder({ status: 'case_open' });
    const caseId = id('cas');
    await rt.db().insert(t.cases).values({ id: caseId, orderId, userId, kind: 'void', stage: 'seller_contacted', status: 'open', reason: 'size', dueAt: new Date(Date.now() - 60_000).toISOString() });
    await holds.sweepHolds(new Date(), fake, { orderIds: [orderId] });
    await holds.sweepHolds(new Date(), fake, { orderIds: [orderId] });
    expect(opsFor(auth)).toEqual(['void']);
    expect((await order(orderId)).status).toBe('voided');
    const [c] = await rt.db().select().from(t.cases).where(eq(t.cases.id, caseId));
    expect(c!.stage).toBe('resolved');
    expect((await notes(userId)).some((n) => n.startsWith("Demo Store didn't answer in time"))).toBe(true);
  });

  it('keeps the hold while the store still has time to answer', async () => {
    const { userId, orderId, auth } = await heldOrder({ status: 'case_open', deliveredDaysAgo: 9 });
    await rt.db().insert(t.cases).values({ id: id('cas'), orderId, userId, kind: 'void', stage: 'seller_contacted', status: 'open', reason: 'size', dueAt: new Date(Date.now() + DAY).toISOString() });
    await holds.sweepHolds(new Date(), fake, { orderIds: [orderId] });
    expect(opsFor(auth)).toEqual([]);
  });

  it('reminds on day 5 after delivery without a check, once, and pays the store on day 7', async () => {
    const day5 = await heldOrder({ deliveredDaysAgo: 5.5, createdDaysAgo: 2 });
    await holds.sweepHolds(new Date(), fake, { orderIds: [day5.orderId] });
    await holds.sweepHolds(new Date(), fake, { orderIds: [day5.orderId] });
    expect((await notes(day5.userId)).filter((n) => n.includes('is still on hold'))).toHaveLength(1);
    expect(opsFor(day5.auth)).toEqual([]);

    const day7 = await heldOrder({ deliveredDaysAgo: 7.2, createdDaysAgo: 2 });
    await holds.sweepHolds(new Date(), fake, { orderIds: [day7.orderId] });
    expect(opsFor(day7.auth)).toEqual(['capture']);
    const o = await order(day7.orderId);
    expect(o.captureId).toBe(`CAP-${day7.auth}`);
    expect((await notes(day7.userId)).some((n) => n.includes('Demo Store is now paid'))).toBe(true);
  });

  it('never pays the store while a wrong-item verdict stands', async () => {
    const { orderId, auth } = await heldOrder({ deliveredDaysAgo: 10, status: 'verified_mismatch', createdDaysAgo: 2 });
    await rt.db().insert(t.verifications).values({ id: id('ver'), orderId, status: 'done', verdict: { kind: 'mismatch', headline: 'x', reasons: [] } });
    await holds.sweepHolds(new Date(), fake, { orderIds: [orderId] });
    expect(opsFor(auth)).toEqual([]);
  });

  it('retries a failed capture after a match with the same request id, and stops once it works', async () => {
    const { orderId, auth } = await heldOrder({ status: 'verified_match', createdDaysAgo: 1 });
    await rt.db().insert(t.verifications).values({ id: id('ver'), orderId, status: 'done', verdict: { kind: 'match', headline: 'x', reasons: [] } });
    failCapture = 1;
    await holds.sweepHolds(new Date(), fake, { orderIds: [orderId] });
    await holds.sweepHolds(new Date(), fake, { orderIds: [orderId] });
    await holds.sweepHolds(new Date(), fake, { orderIds: [orderId] });
    const caps = calls.filter((c) => c.auth === auth && c.op === 'capture');
    expect(caps).toHaveLength(2);
    expect(new Set(caps.map((c) => c.requestId)).size).toBe(1);
    expect((await order(orderId)).captureId).toBe(`CAP-${auth}`);
  });

  it('sending money back on a held payment asks the store first: no PayPal call, a deadline, the money stays held', async () => {
    const cases = await import('../src/server/cases');
    const { userId, orderId, auth } = await heldOrder({ status: 'verified_mismatch', deliveredDaysAgo: 1 });
    const caseId = id('cas');
    await rt.db().insert(t.cases).values({ id: caseId, orderId, userId, kind: 'void', stage: 'evidence_built', status: 'draft', reason: 'size' });
    const out = await cases.sendMoneyBack(userId, caseId);
    expect(out.stage).toBe('seller_contacted');
    expect(out.say).toMatch(/stays on hold, so Demo Store can't take it\. They have until \w+ \d+ \w+ to accept the return/);
    expect(opsFor(auth)).toEqual([]);
    const [c] = await rt.db().select().from(t.cases).where(eq(t.cases.id, caseId));
    expect(Date.parse(c!.dueAt!) - Date.now()).toBeGreaterThan(2 * DAY);
    expect((await order(orderId)).status).toBe('case_open');
  });

  it('reauthorizes once after the three-day honour period', async () => {
    const { orderId, auth } = await heldOrder({ createdDaysAgo: 4 });
    await holds.sweepHolds(new Date(), fake, { orderIds: [orderId] });
    await holds.sweepHolds(new Date(), fake, { orderIds: [orderId] });
    expect(opsFor(auth)).toEqual(['reauthorize']);
    expect((await order(orderId)).authorizationId).toBe(`RE-${auth}`);
  });
});
