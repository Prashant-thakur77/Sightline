import { describe, expect, it } from 'vitest';
import {
  BudgetGuard,
  CatalogPriceGuard,
  DuplicateGuard,
  EnvGuard,
  FreshnessGuard,
  InMemoryLedger,
  PayeeGuard,
  RateLimitGuard,
  ReadbackBindingGuard,
} from '../src';
import { MIN, NOW, OPTS, ago, ctx, makeCart, makeIntent, makePorts, makeReadback, makeSnapshot, rehash, usd } from './fixtures';

describe('EnvGuard', () => {
  const g = new EnvGuard();

  it('passes in the PayPal sandbox', async () => {
    expect(await g.run(ctx(makeIntent()))).toMatchObject({ ok: true, code: 'OK', guard: 'EnvGuard' });
  });

  it.each([
    ['live env', { PAYPAL_ENV: 'live', PAYPAL_API_BASE: 'https://api-m.sandbox.paypal.com' }],
    ['live API base', { PAYPAL_ENV: 'sandbox', PAYPAL_API_BASE: 'https://api-m.paypal.com' }],
    ['missing env', {}],
  ])('refuses %s', async (_label, env) => {
    const r = await g.run(ctx(makeIntent(), makePorts(), { ...OPTS, env }));
    expect(r).toMatchObject({ ok: false, code: 'ENV_NOT_SANDBOX' });
  });

  it('refuses an invalid clock and unsupported modes', async () => {
    expect((await g.run(ctx(makeIntent({ now: new Date('nope') })))).code).toBe('INVALID_CLOCK');
    // @ts-expect-error not a payment source
    expect((await g.run(ctx(makeIntent({ paymentSource: 'card-on-file' })))).code).toBe('UNSUPPORTED_MODE');
    // @ts-expect-error not an intent
    expect((await g.run(ctx(makeIntent({ intent: 'PAYOUT' })))).code).toBe('UNSUPPORTED_MODE');
  });
});

describe('ReadbackBindingGuard', () => {
  const g = new ReadbackBindingGuard();
  const run = (intent = makeIntent(), opts = OPTS) => g.run(ctx(intent, makePorts(), opts));

  it('passes for a readback of this exact cart confirmed with both keys', async () => {
    expect(await run()).toMatchObject({ ok: true, details: { readbackId: 'rb_1', holdOpen: false } });
  });

  it('refuses a missing readback', async () => {
    expect((await run(makeIntent({ readback: null }))).code).toBe('READBACK_MISSING');
  });

  it('refuses a readback made for a different cart hash', async () => {
    const cart = makeCart();
    const other = makeCart([{ snapshot: makeSnapshot(), quantity: 2 }]);
    const r = await run(makeIntent({ cart: other, readback: makeReadback(cart) }));
    expect(r).toMatchObject({ ok: false, code: 'READBACK_CART_MISMATCH', details: { readbackCartHash: cart.hash } });
  });

  it('refuses a readback whose cart id differs', async () => {
    const cart = makeCart();
    expect((await run(makeIntent({ cart, readback: makeReadback(cart, { cartId: 'cart_other' }) }))).code).toBe(
      'READBACK_CART_MISMATCH',
    );
  });

  it('refuses a cart edited after the readback without updating its hash (quantity inflation)', async () => {
    const cart = makeCart();
    const inflated = { ...cart, lines: [{ ...cart.lines[0]!, quantity: 10 }] };
    expect((await run(makeIntent({ cart: inflated, readback: makeReadback(cart) }))).code).toBe('CART_TAMPERED');
  });

  it('refuses a readback whose text no longer matches what was hashed', async () => {
    const cart = makeCart();
    const rb = { ...makeReadback(cart), text: 'Total one dollar.' };
    expect((await run(makeIntent({ cart, readback: rb }))).code).toBe('READBACK_TAMPERED');
  });

  it("refuses someone else's cart", async () => {
    expect((await run(makeIntent({ userId: 'user_2' }))).code).toBe('USER_MISMATCH');
  });

  it('refuses an unconfirmed readback', async () => {
    const cart = makeCart();
    const none = makeReadback(cart, { confirmation: undefined, confirmedAt: undefined });
    expect((await run(makeIntent({ cart, readback: none }))).code).toBe('NOT_CONFIRMED');
    const neither = makeReadback(cart, {
      confirmation: { phraseMatched: false, classifierAgreed: false, utterance: 'hmm', at: ago(MIN) },
    });
    expect((await run(makeIntent({ cart, readback: neither }))).code).toBe('NOT_CONFIRMED');
  });

  it.each([
    ['phrase only', true, false],
    ['classifier only', false, true],
  ])('refuses a single-key confirmation (%s)', async (_label, phraseMatched, classifierAgreed) => {
    const cart = makeCart();
    const rb = makeReadback(cart, {
      confirmation: { phraseMatched, classifierAgreed, utterance: 'yeah sure buy ten', at: ago(MIN + 1000) },
    });
    const r = await run(makeIntent({ cart, readback: rb }));
    expect(r).toMatchObject({ ok: false, code: 'SINGLE_KEY_CONFIRMATION', details: { phraseMatched, classifierAgreed } });
  });

  it('refuses a confirmation heard before the readback, or stamped in the future', async () => {
    const cart = makeCart();
    const early = makeReadback(cart, {
      confirmation: { phraseMatched: true, classifierAgreed: true, utterance: 'confirm', at: ago(3 * MIN) },
    });
    expect((await run(makeIntent({ cart, readback: early }))).code).toBe('CONFIRMATION_OUT_OF_ORDER');
    const future = makeReadback(cart, { confirmedAt: ago(-MIN) });
    expect((await run(makeIntent({ cart, readback: future }))).code).toBe('CONFIRMATION_OUT_OF_ORDER');
  });

  it('refuses a confirmation outside the window', async () => {
    const cart = makeCart();
    const late = makeReadback(cart, {
      createdAt: ago(9 * MIN),
      confirmedAt: ago(1 * MIN),
      confirmation: { phraseMatched: true, classifierAgreed: true, utterance: 'confirm', at: ago(1 * MIN) },
    });
    const r = await run(makeIntent({ cart, readback: late }));
    expect(r).toMatchObject({ code: 'CONFIRMATION_EXPIRED', details: { elapsedMs: 8 * MIN, windowMs: 5 * MIN } });
  });

  it('has no hard timeout when the user said "wait"', async () => {
    const cart = makeCart();
    const held = makeReadback(cart, {
      createdAt: ago(45 * MIN),
      holdOpen: true,
      confirmedAt: ago(30_000),
      confirmation: { phraseMatched: true, classifierAgreed: true, utterance: 'ok, confirm purchase', at: ago(31_000) },
    });
    expect(await run(makeIntent({ cart, readback: held }))).toMatchObject({ ok: true, details: { holdOpen: true } });
  });

  it('still refuses to act on an old confirmation later, even when held open', async () => {
    const cart = makeCart();
    const replay = makeReadback(cart, {
      createdAt: ago(60 * MIN),
      holdOpen: true,
      confirmedAt: ago(20 * MIN),
      confirmation: { phraseMatched: true, classifierAgreed: true, utterance: 'confirm', at: ago(20 * MIN) },
    });
    expect((await run(makeIntent({ cart, readback: replay }))).code).toBe('CONFIRMATION_EXPIRED');
  });

  it('uses a configurable window', async () => {
    expect((await run(makeIntent(), { ...OPTS, confirmWindowMs: 30_000 })).code).toBe('CONFIRMATION_EXPIRED');
  });
});

describe('CatalogPriceGuard', () => {
  const g = new CatalogPriceGuard();
  const run = (intent = makeIntent(), ports = makePorts()) => g.run(ctx(intent, ports));

  it('passes when the amount equals snapshot price x qty + shipping + tax', async () => {
    const cart = makeCart([{ snapshot: makeSnapshot(), quantity: 2 }], { shipping: 599, tax: 544 });
    const r = await run(makeIntent({ cart }));
    expect(r).toMatchObject({ ok: true, details: { items: usd(6800), total: usd(6800 + 599 + 544) } });
  });

  it('refuses a model-supplied amount that disagrees with the snapshot', async () => {
    const r = await run(makeIntent({ amount: usd(100) }));
    expect(r).toMatchObject({ ok: false, code: 'AMOUNT_MISMATCH', details: { expected: usd(3672), got: usd(100) } });
  });

  it('refuses one cent over', async () => {
    expect((await run(makeIntent({ amount: usd(3673) }))).code).toBe('AMOUNT_MISMATCH');
  });

  it.each([
    ['a decimal string', '36.72'],
    ['free text', 'thirty six dollars'],
    ['a bare number', 3672],
    ['fractional cents', { cents: 3672.5, currency: 'USD' }],
    ['string cents', { cents: '3672', currency: 'USD' }],
    ['zero', { cents: 0, currency: 'USD' }],
    ['negative', { cents: -3672, currency: 'USD' }],
    ['a bad currency', { cents: 3672, currency: 'dollars' }],
    ['nothing', undefined],
  ])('refuses %s as the amount', async (_label, amount) => {
    expect((await run(makeIntent({ amount: amount as never }))).code).toBe('AMOUNT_INVALID');
  });

  it('refuses quantity inflation when the totals were not recomputed', async () => {
    const cart = makeCart();
    const inflated = rehash({ ...cart, lines: [{ ...cart.lines[0]!, quantity: 10 }] });
    expect((await run(makeIntent({ cart: inflated, amount: cart.totals.total }))).code).toBe('TOTALS_MISMATCH');
  });

  it.each([0, -1, 1.5, 1000])('refuses quantity %s', async (quantity) => {
    const cart = makeCart();
    expect((await run(makeIntent({ cart: { ...cart, lines: [{ ...cart.lines[0]!, quantity }] } }))).code).toBe(
      'INVALID_QUANTITY',
    );
  });

  it('refuses mixed currencies', async () => {
    const cart = makeCart([
      { snapshot: makeSnapshot(), quantity: 1 },
      { snapshot: makeSnapshot({ id: 'snap_eur', price: { cents: 1000, currency: 'EUR' } }), quantity: 1 },
    ]);
    expect((await run(makeIntent({ cart }))).code).toBe('CURRENCY_MISMATCH');
  });

  it('uses server-side shipping and tax when a quote port is present', async () => {
    const ports = makePorts({ quoteExtras: () => ({ shipping: usd(500), tax: usd(272) }) });
    const r = await run(makeIntent(), ports);
    expect(r).toMatchObject({ ok: false, code: 'TOTALS_MISMATCH', details: { expected: { total: usd(4172) } } });
    const cart = makeCart(undefined, { shipping: 500 });
    expect((await run(makeIntent({ cart }), ports)).ok).toBe(true);
  });

  it('refuses an empty cart', async () => {
    const cart = makeCart();
    expect((await run(makeIntent({ cart: { ...cart, lines: [] } }))).code).toBe('CART_EMPTY');
  });
});

describe('PayeeGuard', () => {
  const g = new PayeeGuard();
  const run = (intent = makeIntent(), ports = makePorts()) => g.run(ctx(intent, ports));

  it('passes when the payee is the listing seller and allowlisted', async () => {
    expect(await run()).toMatchObject({ ok: true, details: { payee: 'MERCHANT1' } });
  });

  it('refuses a payee swap', async () => {
    const r = await run(makeIntent({ payee: { merchantId: 'ATTACKER' } }));
    expect(r).toMatchObject({ ok: false, code: 'PAYEE_MISMATCH', details: { payee: 'ATTACKER', seller: 'MERCHANT1' } });
  });

  it('compares merchant ids exactly', async () => {
    expect((await run(makeIntent({ payee: { merchantId: 'merchant1' } }))).code).toBe('PAYEE_MISMATCH');
  });

  it('refuses a seller that is not allowlisted, even when payee and seller agree', async () => {
    const cart = makeCart([{ snapshot: makeSnapshot({ seller: { name: 'Elsewhere', merchantId: 'OTHER' } }), quantity: 1 }]);
    expect((await run(makeIntent({ cart, payee: { merchantId: 'OTHER' } }))).code).toBe('PAYEE_NOT_ALLOWED');
    expect((await run(makeIntent(), makePorts({ payeeAllowlist: () => [] }))).code).toBe('PAYEE_NOT_ALLOWED');
  });

  it('refuses a cart with more than one seller', async () => {
    const cart = makeCart([
      { snapshot: makeSnapshot(), quantity: 1 },
      { snapshot: makeSnapshot({ id: 'snap_2', seller: { name: 'B', merchantId: 'MERCHANT2' } }), quantity: 1 },
    ]);
    const ports = makePorts({ payeeAllowlist: () => ['MERCHANT1', 'MERCHANT2'] });
    expect((await run(makeIntent({ cart }), ports)).code).toBe('MULTIPLE_SELLERS');
  });
});

describe('BudgetGuard', () => {
  const g = new BudgetGuard();
  const limits = (perOrder: number, daily: number) => () => ({
    perOrderCap: usd(perOrder),
    dailyCap: usd(daily),
    maxOrdersPerHour: 5,
  });

  it('passes inside both caps and reports what is left', async () => {
    const r = await g.run(ctx(makeIntent(), makePorts({ limits: limits(10_000, 20_000) })));
    expect(r).toMatchObject({ ok: true, details: { remainingAfter: usd(20_000 - 3672) } });
  });

  it('refuses an order over the per-order cap', async () => {
    const r = await g.run(ctx(makeIntent(), makePorts({ limits: limits(3000, 20_000) })));
    expect(r).toMatchObject({ ok: false, code: 'OVER_ORDER_LIMIT', details: { limit: usd(3000), amount: usd(3672) } });
  });

  it('refuses when committed spend today plus this order is over the daily cap', async () => {
    const ledger = new InMemoryLedger();
    ledger.recordCommitted({ userId: 'user_1', cartHash: 'x'.repeat(64), amount: usd(8000), createdAt: new Date(NOW.getTime() - 3 * 3600_000) });
    const r = await g.run(ctx(makeIntent(), makePorts({ limits: limits(10_000, 10_000) }, ledger)));
    expect(r).toMatchObject({ code: 'OVER_DAILY_LIMIT', details: { spent: usd(8000), remaining: usd(2000) } });
  });

  it('counts active reservations against the daily cap', async () => {
    const ledger = new InMemoryLedger();
    const lim = { perOrderCap: usd(10_000), dailyCap: usd(10_000), maxOrdersPerHour: 5 };
    ledger.reserve({ key: 'k1', userId: 'user_1', cartHash: 'y'.repeat(64), amount: usd(7000), now: NOW, expiresAt: new Date(NOW.getTime() + 30 * MIN), limits: lim, duplicateWindowMs: 10 * MIN });
    const r = await g.run(ctx(makeIntent(), makePorts({ limits: () => lim }, ledger)));
    expect(r).toMatchObject({ code: 'OVER_DAILY_LIMIT', details: { held: usd(7000) } });
  });

  it('ignores expired reservations and spend older than a day', async () => {
    const ledger = new InMemoryLedger();
    const lim = { perOrderCap: usd(10_000), dailyCap: usd(10_000), maxOrdersPerHour: 5 };
    const earlier = new Date(NOW.getTime() - 40 * MIN);
    ledger.reserve({ key: 'k1', userId: 'user_1', cartHash: 'y'.repeat(64), amount: usd(7000), now: earlier, expiresAt: new Date(earlier.getTime() + 30 * MIN), limits: lim, duplicateWindowMs: 10 * MIN });
    ledger.recordCommitted({ userId: 'user_1', cartHash: 'z'.repeat(64), amount: usd(9000), createdAt: new Date(NOW.getTime() - 25 * 3600_000) });
    expect((await g.run(ctx(makeIntent(), makePorts({ limits: () => lim }, ledger)))).ok).toBe(true);
  });

  it('fails closed when limits are missing or malformed', async () => {
    const r = await g.run(ctx(makeIntent(), makePorts({ limits: () => ({ perOrderCap: usd(100) }) as never })));
    expect(r.code).toBe('LIMITS_UNAVAILABLE');
  });
});

describe('DuplicateGuard', () => {
  const g = new DuplicateGuard();

  it('passes with no recent order for this cart', async () => {
    expect((await g.run(ctx(makeIntent()))).ok).toBe(true);
  });

  it('refuses when the same cart was ordered a minute ago', async () => {
    const intent = makeIntent();
    const ledger = new InMemoryLedger();
    ledger.recordCommitted({ userId: 'user_1', cartHash: intent.cart.hash, amount: usd(3672), createdAt: new Date(NOW.getTime() - MIN) });
    const r = await g.run(ctx(intent, makePorts({}, ledger)));
    expect(r).toMatchObject({ ok: false, code: 'DUPLICATE_ORDER', details: { ageMs: MIN, kind: 'order' } });
  });

  it('allows the same cart again after the 10-minute window', async () => {
    const intent = makeIntent();
    const ledger = new InMemoryLedger();
    ledger.recordCommitted({ userId: 'user_1', cartHash: intent.cart.hash, amount: usd(3672), createdAt: new Date(NOW.getTime() - 11 * MIN) });
    expect((await g.run(ctx(intent, makePorts({}, ledger)))).ok).toBe(true);
  });

  it('does not count failed or voided orders', async () => {
    const intent = makeIntent();
    const ports = makePorts({
      recentOrdersForCart: (h) => [
        { id: 'o1', cartHash: h, createdAt: ago(MIN), status: 'failed' },
        { id: 'o2', cartHash: h, createdAt: ago(2 * MIN), status: 'voided' },
      ],
    });
    expect((await g.run(ctx(intent, ports))).ok).toBe(true);
  });

  it('refuses while a hold for the same cart is in flight', async () => {
    const intent = makeIntent();
    const ledger = new InMemoryLedger();
    const lim = { perOrderCap: usd(10_000), dailyCap: usd(20_000), maxOrdersPerHour: 5 };
    ledger.reserve({ key: 'other', userId: 'user_1', cartHash: intent.cart.hash, amount: usd(3672), now: new Date(NOW.getTime() - 5000), expiresAt: new Date(NOW.getTime() + MIN), limits: lim, duplicateWindowMs: 10 * MIN });
    expect(await g.run(ctx(intent, makePorts({}, ledger)))).toMatchObject({ code: 'DUPLICATE_ORDER', details: { kind: 'reservation' } });
  });

  it('cannot be configured to look back less than 10 minutes', async () => {
    const intent = makeIntent();
    const ledger = new InMemoryLedger();
    ledger.recordCommitted({ userId: 'user_1', cartHash: intent.cart.hash, amount: usd(3672), createdAt: new Date(NOW.getTime() - 5 * MIN) });
    const r = await g.run(ctx(intent, makePorts({}, ledger), { ...OPTS, duplicateWindowMs: MIN }));
    expect(r.code).toBe('DUPLICATE_ORDER');
  });
});

describe('RateLimitGuard', () => {
  const g = new RateLimitGuard();
  const seed = (ledger: InMemoryLedger, n: number, minutesAgo: number) => {
    for (let i = 0; i < n; i++) {
      ledger.recordCommitted({ userId: 'user_1', cartHash: `${i}`.padStart(64, 'a'), amount: usd(100), createdAt: new Date(NOW.getTime() - minutesAgo * MIN - i) });
    }
  };

  it('passes under the hourly limit', async () => {
    const ledger = new InMemoryLedger();
    seed(ledger, 4, 10);
    expect(await g.run(ctx(makeIntent(), makePorts({}, ledger)))).toMatchObject({ ok: true, details: { count: 4, limit: 5 } });
  });

  it('refuses at the limit', async () => {
    const ledger = new InMemoryLedger();
    seed(ledger, 5, 10);
    expect(await g.run(ctx(makeIntent(), makePorts({}, ledger)))).toMatchObject({ code: 'RATE_LIMITED', details: { count: 5 } });
  });

  it('does not count orders older than an hour', async () => {
    const ledger = new InMemoryLedger();
    seed(ledger, 5, 61);
    expect((await g.run(ctx(makeIntent(), makePorts({}, ledger)))).ok).toBe(true);
  });

  it('counts in-flight holds', async () => {
    const ledger = new InMemoryLedger();
    seed(ledger, 4, 10);
    const lim = { perOrderCap: usd(10_000), dailyCap: usd(20_000), maxOrdersPerHour: 5 };
    ledger.reserve({ key: 'k', userId: 'user_1', cartHash: 'q'.repeat(64), amount: usd(100), now: NOW, expiresAt: new Date(NOW.getTime() + MIN), limits: lim, duplicateWindowMs: 10 * MIN });
    expect((await g.run(ctx(makeIntent(), makePorts({}, ledger)))).code).toBe('RATE_LIMITED');
  });
});

describe('FreshnessGuard', () => {
  const g = new FreshnessGuard();
  const withSnapshot = (capturedAt: string) => {
    const cart = makeCart([{ snapshot: makeSnapshot({ capturedAt }), quantity: 1 }]);
    return makeIntent({ cart });
  };

  it('passes when every snapshot is younger than 15 minutes', async () => {
    expect(await g.run(ctx(withSnapshot(ago(14 * MIN))))).toMatchObject({ ok: true, details: { refreshed: [] } });
  });

  it('refuses a stale snapshot, including one exactly 15 minutes old', async () => {
    const r = await g.run(ctx(withSnapshot(ago(16 * MIN))));
    expect(r).toMatchObject({ ok: false, code: 'SNAPSHOT_STALE', details: { ageMs: 16 * MIN, maxAgeMs: 15 * MIN } });
    expect((await g.run(ctx(withSnapshot(ago(15 * MIN))))).code).toBe('SNAPSHOT_STALE');
  });

  it('refuses a capture time in the future or unparseable', async () => {
    expect((await g.run(ctx(withSnapshot(ago(-MIN))))).code).toBe('SNAPSHOT_TIME_INVALID');
    expect((await g.run(ctx(withSnapshot('yesterday')))).code).toBe('SNAPSHOT_TIME_INVALID');
  });

  it('cannot be configured to accept older snapshots', async () => {
    const r = await g.run(ctx(withSnapshot(ago(20 * MIN)), makePorts(), { ...OPTS, snapshotMaxAgeMs: 60 * MIN }));
    expect(r.code).toBe('SNAPSHOT_STALE');
  });

  it('passes a stale snapshot that re-reads with the same price, seller and variant', async () => {
    const intent = withSnapshot(ago(20 * MIN));
    const ports = makePorts({ refreshSnapshot: (s) => makeSnapshot({ ...s, capturedAt: ago(1000) }) });
    expect(await g.run(ctx(intent, ports))).toMatchObject({ ok: true, details: { refreshed: ['snap_shirt'] } });
  });

  it('reports a price change found on re-read', async () => {
    const intent = withSnapshot(ago(20 * MIN));
    const ports = makePorts({ refreshSnapshot: (s) => makeSnapshot({ ...s, price: usd(3900), capturedAt: ago(1000) }) });
    expect(await g.run(ctx(intent, ports))).toMatchObject({
      code: 'PRICE_CHANGED',
      details: { from: usd(3400), to: usd(3900), title: 'Navy linen shirt' },
    });
  });

  it('reports a listing that is gone or now a different item or seller', async () => {
    const intent = withSnapshot(ago(20 * MIN));
    expect((await g.run(ctx(intent, makePorts({ refreshSnapshot: () => null })))).code).toBe('LISTING_UNAVAILABLE');
    const swapped = makePorts({
      refreshSnapshot: (s) => makeSnapshot({ ...s, seller: { name: 'X', merchantId: 'ATTACKER' }, capturedAt: ago(1000) }),
    });
    expect((await g.run(ctx(intent, swapped))).code).toBe('LISTING_CHANGED');
  });
});
