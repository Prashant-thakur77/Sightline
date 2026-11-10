/**
 * Real Demo Store objects for the simulations: snapshots from the catalog, carts priced by the
 * catalog's own rules, readbacks from the real composer, and gate ports over the real
 * InMemoryLedger. Ids are deterministic so runs are reproducible.
 */
import { composeReadback } from '@sightline/agent';
import { DEMO_ITEMS, computeTotals, deliveryEstimate, snapshotOf, toCatalogProduct, type CatalogProduct } from '@sightline/catalog';
import type { Cart, CartLine, Money, ProductSnapshot, Seller } from '@sightline/core';
import { hashCart, hashSnapshot } from '@sightline/evidence';
import type { ConfirmedReadback, GateOptions, GatePorts, SpendLimits } from '@sightline/gate';
import { InMemoryLedger } from '@sightline/gate';

export const usd = (cents: number): Money => ({ cents, currency: 'USD' });

/** The sandbox merchant every Demo Store order is paid to (a placeholder id; no PayPal call is made). */
export const DEMO_SELLER: Seller = { name: 'Demo Store', merchantId: 'DEMO-STORE-SANDBOX' };

export const SANDBOX_ENV = { PAYPAL_ENV: 'sandbox', PAYPAL_API_BASE: 'https://api-m.sandbox.paypal.com' };

/** Receipt HMAC key for local simulations only. Not a secret: nothing it signs leaves this process. */
export const SIM_SIGNING_KEY = 'evals-local-simulation-receipt-key-0123456789abcdef'; // gitleaks:allow

export const GATE_OPTS: GateOptions = { env: SANDBOX_ENV, signingKey: SIM_SIGNING_KEY };

/** The web app's defaults when a user has not set limits (apps/web/src/server/gate-ports.ts). */
export const DEFAULT_LIMITS: SpendLimits = { perOrderCap: usd(10_000), dailyCap: usd(25_000), maxOrdersPerHour: 5 };

export const DEMO_SLUGS = DEMO_ITEMS.map((i) => i.slug);

export function demoItem(slug: string) {
  const item = DEMO_ITEMS.find((i) => i.slug === slug);
  if (!item) throw new Error(`No Demo Store item ${slug}`);
  return item;
}

export function demoProduct(slug: string, selection: Record<string, string> = {}): CatalogProduct {
  return toCatalogProduct(demoItem(slug), selection);
}

/** A snapshot with a deterministic id, through the catalog's own snapshotOf. */
export function freezeSnapshot(product: CatalogProduct, capturedAt: Date, id: string, seller: Seller = DEMO_SELLER): ProductSnapshot {
  const s = snapshotOf(product, seller, capturedAt);
  const body = { ...s, id, hash: '' };
  return { ...body, hash: hashSnapshot(body) };
}

export function makeCart(userId: string, lines: CartLine[], id: string, createdAt: Date): Cart {
  const totals = computeTotals(lines.map((l) => ({ price: l.snapshot.price, quantity: l.quantity })));
  return { id, userId, lines, totals, hash: hashCart({ userId, lines, totals }), createdAt: createdAt.toISOString() };
}

/**
 * Readback composed by the real template composer, as the app does in startReadback.
 * payAfterCheck: the readback tells the buyer PayPal holds the money until the item checks out,
 * which makes the payment an authorization (payForReadback reads this field).
 */
export function makeReadback(cart: Cart, id: string, createdAt: Date, opts: { payAfterCheck?: boolean } = {}): ConfirmedReadback {
  const composed = composeReadback({
    ...(opts.payAfterCheck ? { payAfterCheck: true } : {}),
    cart,
    paymentSource: { kind: 'vault', label: 'your saved PayPal' },
    deliveryEstimate: deliveryEstimate(createdAt),
    locale: 'en-US',
    verbosity: 'standard',
    now: createdAt,
  });
  return {
    id,
    cartId: cart.id,
    cartHash: cart.hash,
    text: composed.text,
    fields: composed.fields,
    textHash: composed.textHash,
    createdAt: createdAt.toISOString(),
  };
}

/** Gate ports over an InMemoryLedger, shaped like the web app's ports. */
export function ledgerPorts(ledger: InMemoryLedger, allowlist: string[] = [DEMO_SELLER.merchantId]): GatePorts {
  return {
    recentOrdersForCart: (h, since) => ledger.recentOrdersForCart(h, since),
    spentToday: (u, now) => ledger.spentToday(u, now),
    ordersInLastHour: (u, now) => ledger.ordersInLastHour(u, now),
    payeeAllowlist: () => allowlist,
    limits: () => DEFAULT_LIMITS,
    reservations: ledger,
  };
}

export { InMemoryLedger };
