import { describe, expect, it } from 'vitest';
import { NetworkEdge, ledgerBreaches, orderRecord, termsFromReadback, type LedgerOrder } from './sandbox-ledger';

const order = {
  id: 'ORDER1',
  status: 'COMPLETED',
  purchase_units: [
    {
      invoice_id: 'ord_1',
      custom_id: 'bind',
      amount: { currency_code: 'USD', value: '36.72' },
      payee: { merchant_id: 'MERCHANT1' },
      items: [
        { name: 'Sweater', quantity: '1', description: 'Navy, size M', unit_amount: { currency_code: 'USD', value: '34.00' } },
      ],
      payments: { authorizations: [{ id: 'AUTH1', status: 'CREATED', amount: { currency_code: 'USD', value: '36.72' } }] },
    },
  ],
};

function edgeWith(replies: Array<{ status: number; json?: unknown } | Error>) {
  const clock = { t: 0 };
  const sleeps: number[] = [];
  const seen: string[] = [];
  const edge = new NetworkEdge({
    fetch: async (url, init) => {
      seen.push(`${init.method} ${new URL(url).pathname}`);
      const r = replies.shift()!;
      if (r instanceof Error) throw r;
      return new Response(JSON.stringify(r.json ?? {}), { status: r.status, headers: { 'content-type': 'application/json', 'paypal-debug-id': 'dbg' } });
    },
    now: () => clock.t,
    sleep: async (ms) => {
      sleeps.push(ms);
      clock.t += ms;
    },
    minIntervalMs: 500,
  });
  return { edge, clock, sleeps, seen };
}

const post = (body = {}) => ({ method: 'POST', headers: { 'PayPal-Request-Id': 'REQ1', Authorization: 'Bearer secret' }, body: JSON.stringify(body) });

describe('NetworkEdge', () => {
  it('records order and authorization ids from responses, never the authorization header', async () => {
    const { edge } = edgeWith([{ status: 201, json: order }]);
    edge.scenario = 's1';
    const res = await edge.fetch('https://api-m.sandbox.paypal.com/v2/checkout/orders', post());
    expect(res.status).toBe(201);
    expect(edge.ordersCreated('s1')).toEqual(['ORDER1']);
    expect(edge.authorizationsSeen('s1')).toEqual(['AUTH1']);
    expect(edge.calls[0]).toMatchObject({ scenario: 's1', method: 'POST', path: '/v2/checkout/orders', status: 201, paypalRequestId: 'REQ1', dropped: false });
    expect(JSON.stringify(edge.calls)).not.toContain('secret');
  });

  it('drops a create response after PayPal answered, and still records what PayPal created', async () => {
    const { edge, seen } = edgeWith([{ status: 201, json: order }]);
    edge.scenario = 's2';
    edge.dropCreates = 1;
    await expect(edge.fetch('https://api-m.sandbox.paypal.com/v2/checkout/orders', post())).rejects.toThrow(TypeError);
    expect(seen).toEqual(['POST /v2/checkout/orders']);
    expect(edge.dropCreates).toBe(0);
    expect(edge.calls[0]!.dropped).toBe(true);
    expect(edge.ordersCreated('s2')).toEqual(['ORDER1']);
  });

  it('does not drop calls other than an order create', async () => {
    const { edge } = edgeWith([{ status: 200, json: order }]);
    edge.dropCreates = 1;
    const res = await edge.fetch('https://api-m.sandbox.paypal.com/v2/checkout/orders/ORDER1', { method: 'GET', headers: {} });
    expect(res.status).toBe(200);
    expect(edge.dropCreates).toBe(1);
  });

  it('paces requests to at most one per interval', async () => {
    const { edge, sleeps } = edgeWith([{ status: 200 }, { status: 200 }, { status: 200 }]);
    for (let i = 0; i < 3; i++) await edge.fetch('https://api-m.sandbox.paypal.com/v2/checkout/orders/X', { method: 'GET', headers: {} });
    expect(sleeps).toEqual([500, 500]);
  });

  it('backs off on 429 and re-sends the same request', async () => {
    const { edge, seen, sleeps } = edgeWith([{ status: 429 }, { status: 200, json: order }]);
    const res = await edge.fetch('https://api-m.sandbox.paypal.com/v2/checkout/orders/ORDER1', { method: 'GET', headers: {} });
    expect(res.status).toBe(200);
    expect(seen).toHaveLength(2);
    expect(Math.max(...sleeps)).toBeGreaterThanOrEqual(1000);
    expect(edge.calls.map((c) => c.status)).toEqual([429, 200]);
    expect(edge.summary()).toEqual({ 'GET /v2/checkout/orders/:id': 2 });
  });
});

describe('ledger comparison', () => {
  const rec: LedgerOrder = orderRecord(order as never);

  it('reads amount, payee, quantity and authorizations from the PayPal order', () => {
    expect(rec).toMatchObject({ id: 'ORDER1', amountCents: 3672, currency: 'USD', payeeMerchantId: 'MERCHANT1', quantity: 1, invoiceId: 'ord_1', customId: 'bind' });
    expect(rec.authorizations).toEqual([{ id: 'AUTH1', status: 'CREATED', amountCents: 3672, currency: 'USD' }]);
    expect(rec.captures).toEqual([]);
  });

  it('takes the confirmed terms from the readback fields', () => {
    const terms = termsFromReadback({ fields: [{ key: 'line1.quantity', value: '1' }, { key: 'total', value: '$36.72' }] } as never, 'MERCHANT1');
    expect(terms).toEqual({ amountCents: 3672, currency: 'USD', payeeMerchantId: 'MERCHANT1', quantity: 1 });
    expect(ledgerBreaches(rec, terms)).toEqual([]);
  });

  it('flags every difference from what the buyer confirmed', () => {
    const terms = { amountCents: 3000, currency: 'USD', payeeMerchantId: 'OTHER', quantity: 2 };
    expect(ledgerBreaches(rec, terms)).toEqual(['wrong_amount', 'wrong_payee', 'wrong_quantity', 'authorization_amount']);
    expect(ledgerBreaches({ ...rec, captures: [{ id: 'C', status: 'COMPLETED', amountCents: 3672, currency: 'USD' }] }, { ...terms, amountCents: 3672, payeeMerchantId: 'MERCHANT1', quantity: 1 })).toEqual(['captured']);
  });
});
