import { beforeAll, describe, expect, it, vi } from 'vitest';
import path from 'node:path';

/**
 * "Buy my usual again" with a saved PayPal (Vault v3 vault_id): the usual is found from order
 * history, read back from the template at today's price, and paid only after both confirmations,
 * through the vault. PayPal is a mock here (no sandbox keys in tests); the gate, the readback and
 * the database are real. Skipped without a database.
 */
try {
  process.loadEnvFile(path.resolve(import.meta.dirname, '../../../.env.local'));
} catch {
  /* CI provides env directly */
}
const hasDb = Boolean(process.env.DATABASE_URL) && Boolean(process.env.RECEIPT_SIGNING_KEY);

const created: Array<Record<string, unknown>> = [];
const RUN = Date.now().toString(36);
vi.mock('../src/server/paypal', () => ({
  PayPalNotConfiguredError: class extends Error {},
  paypal: () => ({
    orders: {
      create: async (body: Record<string, unknown>) => {
        created.push(body);
        return {
          id: `PP-ORDER-${RUN}`,
          status: 'COMPLETED',
          purchase_units: [{ payments: { authorizations: [{ id: `AUTH-${RUN}`, status: 'CREATED', expiration_time: '2026-12-08T10:00:00Z' }] } }],
        };
      },
    },
  }),
}));

describe.skipIf(!hasDb)('buy my usual again, paid with the saved PayPal (Postgres, PayPal mocked)', () => {
  let conductor: typeof import('../src/server/conductor');
  let personas: typeof import('../src/server/personas');
  let rt: typeof import('../src/server/runtime');
  let t: typeof import('@sightline/db').tables;
  let q: typeof import('drizzle-orm');
  let newId: typeof import('@sightline/core').newId;
  let cat: typeof import('@sightline/catalog');

  beforeAll(async () => {
    rt = await import('../src/server/runtime');
    conductor = await import('../src/server/conductor');
    personas = await import('../src/server/personas');
    ({ tables: t } = await import('@sightline/db'));
    q = await import('drizzle-orm');
    ({ newId } = await import('@sightline/core'));
    cat = await import('@sightline/catalog');
  });

  /** A past order for a Demo Store item, with the snapshot it was bought from. */
  async function pastOrder(userId: string, slug: string, selection: Record<string, string>, daysAgo: number) {
    const product = (await cat.createDemoStore().get(`demo:${slug}`, selection))!;
    const at = new Date(Date.now() - daysAgo * 86_400_000);
    const snap = cat.snapshotOf(product, rt.demoSeller(), at);
    await rt.db().insert(t.productSnapshots).values({ id: snap.id, productId: snap.productId, variantId: snap.variantId, source: snap.source, body: snap, hash: snap.hash, capturedAt: snap.capturedAt });
    await rt.db().insert(t.orders).values({
      id: newId('ord'),
      userId,
      cartId: newId('crt'),
      readbackId: newId('rdb'),
      snapshotId: snap.id,
      paypalRequestId: newId('req'),
      paypalOrderId: newId('pp'),
      intent: 'AUTHORIZE',
      paymentSource: 'vault',
      status: 'verified_match',
      captureId: newId('cap'),
      amountCents: 3672,
      merchantId: rt.demoSeller().merchantId,
      title: snap.title,
      createdAt: at.toISOString(),
    });
  }

  it('finds the usual, reads it back with the saved PayPal, and pays only after both presses', async () => {
    const userId = await personas.ensurePersona('maya');
    await rt.db().delete(t.vaultTokens).where(q.eq(t.vaultTokens.userId, userId));
    await rt.db().insert(t.vaultTokens).values({ id: newId('vlt'), userId, vaultId: 'VAULT-SAVED-1', status: 'ACTIVE', label: 'your saved PayPal' });
    await pastOrder(userId, 'harbor-knit-crew', { Colour: 'navy', Size: 'M' }, 40);
    await pastOrder(userId, 'stoneware-mug', { Colour: 'teal' }, 20);
    await pastOrder(userId, 'harbor-knit-crew', { Colour: 'navy', Size: 'M' }, 10);

    const rb = await conductor.handleTurn(userId, { text: 'buy my usual again', source: 'voice' });
    expect(rb.say).toMatch(/^Your usual is the Harbor knit crew-neck sweater, navy, size M\. You've bought it twice\. Here it is again, at today's price\. /);
    expect(rb.card?.kind).toBe('readback');
    const card = rb.card?.kind === 'readback' ? rb.card : null;
    expect(card!.text).toContain('your saved PayPal');
    expect(card!.total).toBe('$36.72');
    expect(created).toHaveLength(0);

    // One press is never a payment.
    const first = await conductor.handleTurn(userId, { action: 'confirm-button', readbackId: card!.readbackId });
    expect(first.card?.kind === 'readback' && first.card.needsSecondPress).toBe(true);
    expect(created).toHaveLength(0);
    await new Promise((r) => setTimeout(r, 550));
    const paid = await conductor.handleTurn(userId, { action: 'confirm-button', readbackId: card!.readbackId });
    expect(paid.card?.kind === 'refusal' ? `${paid.card.code}: ${paid.card.reason}` : 'paid').toBe('paid');
    expect(paid.say).toBe('$36.72 is on hold for Demo Store. You only pay once the check matches. I\'ll tell you when it ships.');

    // The order went to PayPal through the vault, with the amount from the readback's cart.
    expect(created).toHaveLength(1);
    expect(created[0]).toMatchObject({
      intent: 'AUTHORIZE',
      paymentSource: { type: 'vault', vaultId: 'VAULT-SAVED-1', storedCredential: { payment_initiator: 'CUSTOMER', usage: 'SUBSEQUENT' } },
      expectedTotal: { cents: 3672, currency: 'USD' },
    });
    const [order] = await rt.db().select().from(t.orders).where(q.and(q.eq(t.orders.userId, userId), q.eq(t.orders.paypalOrderId, `PP-ORDER-${RUN}`)));
    expect(order).toMatchObject({ status: 'authorized', authorizationId: `AUTH-${RUN}`, paymentSource: 'vault' });

    // The step log tells the story: found the usual, read it back, PayPal held the money.
    const log = (
      await rt.db().select({ payload: t.auditLog.payload }).from(t.auditLog).where(q.and(q.eq(t.auditLog.userId, userId), q.eq(t.auditLog.action, 'agent.step'))).orderBy(q.asc(t.auditLog.seq))
    ).map((r) => r.payload as { tool: string; step: string });
    expect(log.map((s) => `${s.tool}:${s.step}`)).toEqual(['app:found_usual', 'app:proposed_readback', 'paypal:held']);

    // The order's "what your agent did" timeline shows those steps with readable tool names.
    const { orderTimeline } = await import('../src/server/timeline');
    const agentSteps = (await orderTimeline(order!.id, userId)).filter((s) => s.action === 'agent.step');
    expect(agentSteps.map((s) => [s.tool, s.decided])).toEqual([
      ['Fixed templates', 'rules'],
      ['Fixed templates', 'rules'],
      ['PayPal Orders API', null],
    ]);
  });
});
