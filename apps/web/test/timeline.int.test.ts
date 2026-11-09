import { beforeAll, describe, expect, it } from 'vitest';
import path from 'node:path';

/**
 * The order timeline against the local Postgres: the shopping steps before the order are joined
 * by the order's readback and by the buyer's conversation since their previous order; another
 * buyer's steps and an earlier purchase's shopping never appear. Skipped without a database.
 */
try {
  process.loadEnvFile(path.resolve(import.meta.dirname, '../../../.env.local'));
} catch {
  /* CI provides env directly */
}
const hasDb = Boolean(process.env.DATABASE_URL);

describe.skipIf(!hasDb)('orderTimeline (Postgres)', () => {
  let rt: typeof import('../src/server/runtime');
  let t: typeof import('@sightline/db').tables;
  let id: typeof import('@sightline/core').newId;
  let audit: typeof import('../src/server/audit').audit;
  let timeline: typeof import('../src/server/timeline');

  beforeAll(async () => {
    rt = await import('../src/server/runtime');
    ({ tables: t } = await import('@sightline/db'));
    ({ newId: id } = await import('@sightline/core'));
    ({ audit } = await import('../src/server/audit'));
    timeline = await import('../src/server/timeline');
  });

  async function user() {
    const userId = id('usr');
    await rt.db().insert(t.users).values({ id: userId, email: `${userId}@test.local`, displayName: 'Test', isDemo: true });
    const convo = id('cnv');
    await rt.db().insert(t.conversations).values({ id: convo, userId, state: {} });
    return { userId, convo };
  }
  async function order(userId: string, createdAt: string) {
    const orderId = id('ord');
    const readbackId = id('rbk');
    await rt.db().insert(t.orders).values({
      id: orderId,
      userId,
      cartId: id('crt'),
      readbackId,
      snapshotId: id('snp'),
      paypalRequestId: id('req'),
      intent: 'AUTHORIZE',
      paymentSource: 'vault',
      status: 'authorized',
      amountCents: 3672,
      merchantId: 'demo-store',
      title: 'Harbor knit crew-neck sweater',
      createdAt,
    });
    return { orderId, readbackId };
  }
  const pause = () => new Promise((r) => setTimeout(r, 15));

  it('joins the shopping steps by readback and conversation, in order, and nothing from anyone else', async () => {
    const { userId, convo } = await user();
    const other = await user();
    // An earlier purchase, and the shopping that led to it.
    await audit({ userId, actor: 'agent', action: 'agent.step', subjectId: convo, payload: { tool: 'channel3', step: 'search', summary: 'Searched for black jeans.', conversationId: convo } });
    await pause();
    await order(userId, new Date().toISOString());
    await pause();
    // This purchase.
    await audit({ userId, actor: 'agent', action: 'agent.step', subjectId: convo, payload: { tool: 'channel3', step: 'search', summary: 'Searched Channel3 for a navy sweater.', conversationId: convo } });
    await audit({ userId: other.userId, actor: 'agent', action: 'agent.step', subjectId: other.convo, payload: { tool: 'channel3', step: 'search', summary: 'Someone else searched.', conversationId: other.convo } });
    await pause();
    const now = new Date(Date.now() + 1000).toISOString();
    const { orderId, readbackId } = await order(userId, now);
    await audit({ userId, actor: 'agent', action: 'readback.spoken', subjectId: readbackId, payload: {} });
    await audit({ userId, actor: 'agent', action: 'agent.step', subjectId: convo, payload: { tool: 'paypal', step: 'pay', summary: 'Asked PayPal to put the money on hold.', conversationId: convo, readbackId } });
    await audit({ userId, actor: 'gate', action: 'gate.allowed', subjectId: readbackId, payload: {} });
    await audit({ userId, actor: 'paypal', action: 'payment.authorized', subjectId: orderId, payload: { authorizationId: 'AU-1', paypalStatus: 'CREATED', amount: '$36.72' } });

    const steps = await timeline.orderTimeline(orderId, userId);
    expect(steps.map((s) => s.what)).toEqual([
      'Searched Channel3 for a navy sweater.',
      'Read the order back to you, word for word, before any money could move.',
      'Asked PayPal to put the money on hold.',
      'Checked the payment against eight fixed rules (amount, payee, budget, duplicates and more) before any money moved. It passed.',
      'Put $36.72 on hold. Demo Store is paid only after your check.',
    ]);
    expect(steps.map((s) => s.whoWords)).toEqual(['Your agent', 'Your agent', 'Your agent', 'Sightline’s safety check', 'PayPal']);
    expect(steps.at(-1)!.paypal).toEqual({ label: 'Authorization', id: 'AU-1', status: 'CREATED', source: 'answer' });
    // Another buyer asking for this order gets nothing.
    expect(await timeline.orderTimeline(orderId, other.userId)).toEqual([]);
  });

  it('shows the judge page the visitor’s own latest order, else the lifecycle run’s, never another visitor’s', async () => {
    const mine = await user();
    const { orderId } = await order(mine.userId, new Date().toISOString());
    const own = await timeline.latestDemoTimeline(mine.userId, 'nobody@test.local');
    expect(own).toMatchObject({ orderId, whose: 'yours' });
    const stranger = await user();
    expect(await timeline.latestDemoTimeline(stranger.userId, 'nobody@test.local')).toBeNull();
  });
});
