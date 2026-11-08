import type { Cart, CartLine, Money, ProductSnapshot } from '@sightline/core';
import { hashCart, hashReadbackText, hashSnapshot } from '@sightline/evidence';
import {
  InMemoryLedger,
  resolveOptions,
  type ConfirmedReadback,
  type GateOptions,
  type GatePorts,
  type GuardContext,
  type PaymentIntent,
} from '../src';

export const NOW = new Date('2026-11-09T10:05:00.000Z');
export const KEY = 'gate-test-signing-key-0123456789abcdef'; // gitleaks:allow (test fixture, not a secret)
export const SANDBOX = { PAYPAL_ENV: 'sandbox', PAYPAL_API_BASE: 'https://api-m.sandbox.paypal.com' };
export const OPTS: GateOptions = { env: SANDBOX, signingKey: KEY };
export const MIN = 60_000;

export const usd = (cents: number): Money => ({ cents, currency: 'USD' });
/** ISO timestamp `ms` before NOW (negative for after). */
export const ago = (ms: number, from: Date = NOW): string => new Date(from.getTime() - ms).toISOString();

export function makeSnapshot(over: Partial<ProductSnapshot> = {}): ProductSnapshot {
  const base: ProductSnapshot = {
    id: 'snap_shirt',
    productId: 'prod_shirt',
    variantId: 'var_navy_m',
    source: 'demo-store',
    title: 'Navy linen shirt',
    attributes: { colour: 'navy', size: 'M' },
    price: usd(3400),
    images: [],
    returnPolicy: { windowDays: 30, free: true },
    seller: { name: 'Demo Store', merchantId: 'MERCHANT1' },
    capturedAt: ago(5 * MIN),
    hash: '',
    ...over,
  };
  return { ...base, hash: hashSnapshot(base) };
}

/** Recompute a cart's hash after editing it, the way a legitimate cart update would. */
export function rehash(cart: Cart): Cart {
  return { ...cart, hash: hashCart(cart) };
}

export function makeCart(
  lines: CartLine[] = [{ snapshot: makeSnapshot(), quantity: 1 }],
  o: { shipping?: number; tax?: number; userId?: string; id?: string } = {},
): Cart {
  const currency = lines[0]?.snapshot.price.currency ?? 'USD';
  const items = lines.reduce((a, l) => a + l.snapshot.price.cents * l.quantity, 0);
  const shipping = o.shipping ?? 0;
  const tax = o.tax ?? 272;
  return rehash({
    id: o.id ?? 'cart_1',
    userId: o.userId ?? 'user_1',
    lines,
    totals: {
      items: { cents: items, currency },
      shipping: { cents: shipping, currency },
      tax: { cents: tax, currency },
      total: { cents: items + shipping + tax, currency },
    },
    hash: '',
    createdAt: ago(4 * MIN),
  });
}

export function makeReadback(cart: Cart, over: Partial<ConfirmedReadback> = {}): ConfirmedReadback {
  const text = over.text ?? `${cart.lines.length} item. Total ${cart.totals.total.cents} cents.`;
  return {
    id: 'rb_1',
    cartId: cart.id,
    cartHash: cart.hash,
    text,
    fields: [],
    textHash: hashReadbackText(text),
    createdAt: ago(2 * MIN),
    confirmedAt: ago(1 * MIN),
    confirmation: { phraseMatched: true, classifierAgreed: true, utterance: 'confirm purchase', at: ago(1 * MIN + 1000) },
    ...over,
  };
}

export function makeIntent(over: Partial<PaymentIntent> = {}): PaymentIntent {
  const cart = over.cart ?? makeCart();
  return {
    userId: cart.userId,
    cart,
    readback: 'readback' in over ? (over.readback ?? null) : makeReadback(cart),
    payee: { merchantId: 'MERCHANT1' },
    amount: cart.totals.total,
    paymentSource: 'vault',
    intent: 'CAPTURE',
    now: NOW,
    ...over,
  };
}

export type TestPorts = GatePorts & { ledger: InMemoryLedger };

export function makePorts(over: Partial<GatePorts> = {}, ledger = new InMemoryLedger()): TestPorts {
  return {
    ledger,
    recentOrdersForCart: (h, since) => ledger.recentOrdersForCart(h, since),
    spentToday: (u, now) => ledger.spentToday(u, now),
    ordersInLastHour: (u, now) => ledger.ordersInLastHour(u, now),
    payeeAllowlist: () => ['MERCHANT1'],
    limits: () => ({ perOrderCap: usd(10_000), dailyCap: usd(20_000), maxOrdersPerHour: 5 }),
    reservations: ledger,
    ...over,
  };
}

export function ctx(intent: PaymentIntent, ports: GatePorts = makePorts(), opts: GateOptions = OPTS): GuardContext {
  return { intent, ports, opts: resolveOptions(opts, intent) };
}
