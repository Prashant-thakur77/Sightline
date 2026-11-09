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

  it('an offer nobody settled by its deadline still releases the hold; a fresh offer keeps it', async () => {
    const late = await heldOrder({ status: 'case_open' });
    await rt.db().insert(t.cases).values({ id: id('cas'), orderId: late.orderId, userId: late.userId, kind: 'void', stage: 'offer_received', status: 'open', reason: 'size', dueAt: new Date(Date.now() - 60_000).toISOString() });
    const fresh = await heldOrder({ status: 'case_open' });
    await rt.db().insert(t.cases).values({ id: id('cas'), orderId: fresh.orderId, userId: fresh.userId, kind: 'void', stage: 'accepted', status: 'open', reason: 'size', dueAt: new Date(Date.now() + 5 * DAY).toISOString() });
    await holds.sweepHolds(new Date(), fake, { orderIds: [late.orderId, fresh.orderId] });
    expect(opsFor(late.auth)).toEqual(['void']);
    expect(opsFor(fresh.auth)).toEqual([]);
    expect((await notes(late.userId)).some((n) => n.includes("wasn't settled by the deadline"))).toBe(true);
  });

  it('pays the store a week after a replacement was agreed, not before', async () => {
    const agreed = async (daysAgo: number) => {
      const o = await heldOrder({ status: 'resolved_replacement', deliveredDaysAgo: 10, createdDaysAgo: 2 });
      await rt.db().insert(t.verifications).values({ id: id('ver'), orderId: o.orderId, status: 'done', verdict: { kind: 'mismatch', headline: 'x', reasons: [] } });
      await rt.db().insert(t.cases).values({ id: id('cas'), orderId: o.orderId, userId: o.userId, kind: 'void', stage: 'resolved', status: 'resolved', reason: 'size', updatedAt: new Date(Date.now() - daysAgo * DAY).toISOString() });
      return o;
    };
    const old = await agreed(8);
    const recent = await agreed(2);
    await holds.sweepHolds(new Date(), fake, { orderIds: [old.orderId, recent.orderId] });
    expect(opsFor(old.auth)).toEqual(['capture']);
    expect(opsFor(recent.auth)).toEqual([]);
  });

  it('reauthorizes each time the honour period runs out while the money is held, and never past day 29', async () => {
    const { orderId, auth } = await heldOrder({ createdDaysAgo: 4 });
    const reauths = () => calls.filter((c) => c.op === 'reauthorize' && c.auth.endsWith(auth));
    const t0 = Date.now();
    await holds.sweepHolds(new Date(t0), fake, { orderIds: [orderId] });
    await holds.sweepHolds(new Date(t0), fake, { orderIds: [orderId] });
    expect(reauths()).toHaveLength(1);
    expect((await order(orderId)).authorizationId).toBe(`RE-${auth}`);
    // Inside the new authorization's own three days: nothing to do.
    await holds.sweepHolds(new Date(t0 + DAY), fake, { orderIds: [orderId] });
    expect(reauths()).toHaveLength(1);
    // Its honour period has run out too: reauthorize again, on the new authorization, as a new request.
    await holds.sweepHolds(new Date(t0 + 3.5 * DAY), fake, { orderIds: [orderId] });
    expect(reauths().map((c) => c.auth)).toEqual([auth, `RE-${auth}`]);
    expect(new Set(reauths().map((c) => c.requestId)).size).toBe(2);
    expect((await order(orderId)).authorizationId).toBe(`RE-RE-${auth}`);

    // Past PayPal's 29 days there is nothing left to reauthorize.
    const old = await heldOrder({ createdDaysAgo: 30 });
    await holds.sweepHolds(new Date(), fake, { orderIds: [old.orderId] });
    expect(opsFor(old.auth)).toEqual([]);
  });

  it('keeps the hold honoured while a case is open, so an agreed capture later is still good', async () => {
    const { userId, orderId, auth } = await heldOrder({ createdDaysAgo: 4, status: 'case_open' });
    await rt.db().insert(t.cases).values({ id: id('cas'), orderId, userId, kind: 'void', stage: 'offer_received', status: 'open', reason: 'size', dueAt: new Date(Date.now() + 6 * DAY).toISOString() });
    await holds.sweepHolds(new Date(), fake, { orderIds: [orderId] });
    expect(opsFor(auth)).toEqual(['reauthorize']);
  });

  it('tells the buyer once, a day before a held case closes, what happens then, in one sentence', async () => {
    const soon = await heldOrder({ status: 'case_open' });
    await rt.db().insert(t.cases).values({ id: id('cas'), orderId: soon.orderId, userId: soon.userId, kind: 'void', stage: 'seller_contacted', status: 'open', reason: 'size', dueAt: new Date(Date.now() + 20 * 3_600_000).toISOString() });
    const later = await heldOrder({ status: 'case_open' });
    await rt.db().insert(t.cases).values({ id: id('cas'), orderId: later.orderId, userId: later.userId, kind: 'void', stage: 'seller_contacted', status: 'open', reason: 'size', dueAt: new Date(Date.now() + 3 * DAY).toISOString() });
    await holds.sweepHolds(new Date(), fake, { orderIds: [soon.orderId, later.orderId] });
    await holds.sweepHolds(new Date(), fake, { orderIds: [soon.orderId, later.orderId] });
    const told = (await notes(soon.userId)).filter((n) => n.startsWith('Demo Store has until'));
    expect(told).toHaveLength(1);
    expect(told[0]).toMatch(/^Demo Store has until \w+ \d+ \w+ to answer your case about the Harbor knit crew-neck sweater, and if they don't, I'll cancel the hold and your \$36\.72 is released\.$/);
    expect(told[0]!.split(/[.!?] /)).toHaveLength(1);
    expect(await notes(later.userId)).toEqual([]);
    expect(opsFor(soon.auth)).toEqual([]);
  });
});
