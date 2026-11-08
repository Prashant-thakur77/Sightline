import type { Cart, CartLine, Money, ProductSnapshot } from '@sightline/core';
import { hashCart, hashSnapshot } from '@sightline/evidence';

export const usd = (cents: number): Money => ({ cents, currency: 'USD' });

export function snapshot(over: Partial<ProductSnapshot> = {}): ProductSnapshot {
  const base: ProductSnapshot = {
    id: 'snap_harbor_navy_m',
    productId: 'prod_harbor',
    variantId: 'var_navy_m',
    source: 'demo-store',
    title: 'Harbor knit crew-neck sweater',
    brand: 'Harbor',
    category: 'sweater',
    attributes: { colour: 'Navy', size: 'M', material: '100% merino wool', neckline: 'crew-neck' },
    price: usd(3400),
    images: [{ url: 'https://demo.example/harbor-navy.jpg', alt: 'Navy crew-neck sweater, front' }],
    returnPolicy: { windowDays: 30, free: true, text: 'Free returns within 30 days of delivery.' },
    seller: { name: 'Demo Store', merchantId: 'MERCHANT123' },
    rating: { average: 4.6, count: 212 },
    capturedAt: '2026-11-09T10:00:00.000Z',
    hash: '',
    ...over,
  };
  return { ...base, hash: hashSnapshot(base) };
}

/** A cart whose totals are consistent with its lines and whose hash comes from hashCart. */
export function cart(lines: CartLine[], shipping = 0, tax = 272, userId = 'user_1'): Cart {
  const items = lines.reduce((a, l) => a + l.snapshot.price.cents * l.quantity, 0);
  const totals = { items: usd(items), shipping: usd(shipping), tax: usd(tax), total: usd(items + shipping + tax) };
  return {
    id: 'cart_1',
    userId,
    lines,
    totals,
    hash: hashCart({ userId, lines, totals }),
    createdAt: '2026-11-09T10:00:00.000Z',
  };
}

export const NOW = new Date('2026-11-09T12:00:00Z');
export const TUE_17_NOV = new Date('2026-11-17T12:00:00Z');
export const SAVED_PAYPAL = { kind: 'vault' as const, label: 'your saved PayPal' };
