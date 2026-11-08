/**
 * Real PayPal sandbox calls. Skipped unless PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET are set in the environment.
 * Buyer approval cannot happen headlessly, so the CAPTURE order is only created and read back; the
 * authorize-then-void path uses a sandbox test card, which authorizes without a buyer.
 */
import { randomUUID } from 'node:crypto';
import { SANDBOX_API_BASE } from '@sightline/core/env';
import { describe, expect, it } from 'vitest';
import {
  PayPalApiError,
  SUBSCRIBED_WEBHOOK_EVENTS,
  approvalUrl,
  authorizationFromOrder,
  createPayPalClient,
  type Order,
} from '../src';

const clientId = process.env.PAYPAL_CLIENT_ID ?? '';
const clientSecret = process.env.PAYPAL_CLIENT_SECRET ?? '';
const live = Boolean(clientId && clientSecret);

const rid = (tag: string) => `live-${tag}-${randomUUID()}`;
const usd = (cents: number) => ({ cents, currency: 'USD' });

describe.skipIf(!live)('PayPal sandbox (live)', { timeout: 60_000 }, () => {
  const client = live
    ? createPayPalClient({
        clientId,
        clientSecret,
        apiBase: process.env.PAYPAL_API_BASE ?? SANDBOX_API_BASE,
        paypalEnv: process.env.PAYPAL_ENV ?? 'sandbox',
      })
    : (undefined as never);

  const orderInput = {
    intent: 'CAPTURE' as const,
    items: [{ name: 'Sandbox test item', quantity: 1, unitAmount: usd(1000) }],
    shipping: usd(150),
    customId: 'live-test',
    invoiceId: `live-${randomUUID()}`,
    paymentSource: {
      type: 'paypal' as const,
      experienceContext: {
        returnUrl: 'https://example.com/return',
        cancelUrl: 'https://example.com/cancel',
        shippingPreference: 'NO_SHIPPING' as const,
      },
    },
  };

  it('creates an order, reads it back, and the same request id returns the same order', async () => {
    const requestId = rid('ord');
    const created = await client.orders.create({ ...orderInput, requestId, expectedTotal: usd(1150) });
    expect(['CREATED', 'PAYER_ACTION_REQUIRED']).toContain(created.status);
    expect(approvalUrl(created)).toMatch(/^https:\/\/www\.sandbox\.paypal\.com\//);

    const fetched = await client.orders.get(created.id);
    expect(fetched.id).toBe(created.id);
    expect(fetched.purchase_units?.[0]?.amount?.value).toBe('11.50');

    const again = await client.orders.create({ ...orderInput, requestId });
    expect(again.id).toBe(created.id);
  });

  it('authorizes with a sandbox test card and voids the authorization', async (ctx) => {
    const exp = `${new Date().getUTCFullYear() + 2}-12`;
    let order: Order;
    try {
      const res = await client.request({
        method: 'POST',
        path: '/v2/checkout/orders',
        requestId: rid('auth'),
        representation: true,
        json: {
          intent: 'AUTHORIZE',
          purchase_units: [
            { amount: { currency_code: 'USD', value: '5.00' }, invoice_id: `live-${randomUUID()}` },
          ],
          payment_source: {
            card: { number: '4111111111111111', expiry: exp, name: 'Sandbox Tester', security_code: '123' },
          },
        },
      });
      order = res.body as Order;
    } catch (err) {
      if (err instanceof PayPalApiError && err.status < 500) {
        ctx.skip(
          `Card authorization unavailable for this sandbox app: ${err.name} ${err.issue ?? ''} (debug ${err.debugId})`,
        );
      }
      throw err;
    }
    const auth = authorizationFromOrder(order);
    if (!auth) ctx.skip(`Order ${order.id} has no authorization (status ${order.status}).`);
    const voided = await client.payments.voidAuthorization(auth!.id, { requestId: rid('void') });
    const status = voided?.status ?? (await client.payments.getAuthorization(auth!.id)).status;
    expect(status).toBe('VOIDED');
  });

  it('lists webhook event types, including every event Sightline subscribes to', async () => {
    const names = new Set((await client.webhooks.listEventTypes()).map((e) => e.name));
    for (const e of SUBSCRIBED_WEBHOOK_EVENTS) expect(names.has(e), e).toBe(true);
  });

  it('lists disputes', async () => {
    const list = await client.disputes.list({ pageSize: 5 });
    expect(Array.isArray(list.items)).toBe(true);
  });

  it('mints a JS SDK client token', async () => {
    const t = await client.auth.clientToken();
    expect(t.token.length).toBeGreaterThan(20);
    expect(t.expiresIn).toBeGreaterThan(0);
  });
});
