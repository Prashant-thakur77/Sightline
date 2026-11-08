import type { ProductSnapshot, Readback, Verdict } from '@sightline/core';
import { hashCart, hashReadbackText, hashSnapshot } from '../src';

export function snapshot(overrides: Partial<ProductSnapshot> = {}): ProductSnapshot {
  const base: ProductSnapshot = {
    id: 'snap_1',
    productId: 'prod_1',
    variantId: 'var_navy_m',
    source: 'demo-store',
    title: 'Linen shirt',
    brand: 'Demo',
    attributes: { colour: 'navy', size: 'M' },
    price: { cents: 3400, currency: 'USD' },
    images: [{ url: 'https://example.test/shirt.jpg', alt: 'Navy linen shirt' }],
    returnPolicy: { windowDays: 30, free: true },
    seller: { name: 'Demo Store', merchantId: 'MERCHANT1' },
    capturedAt: '2026-11-09T10:00:00.000Z',
    hash: '',
    ...overrides,
  };
  return { ...base, hash: hashSnapshot(base) };
}

export function readback(text = 'One navy linen shirt, size M, $34. Total $36.72.'): Readback {
  const s = snapshot();
  const totals = {
    items: { cents: 3400, currency: 'USD' },
    shipping: { cents: 0, currency: 'USD' },
    tax: { cents: 272, currency: 'USD' },
    total: { cents: 3672, currency: 'USD' },
  };
  return {
    id: 'rb_1',
    cartId: 'cart_1',
    cartHash: hashCart({ userId: 'user_1', lines: [{ snapshot: s, quantity: 1 }], totals }),
    text,
    fields: [{ key: 'total', label: 'Total', value: '$36.72' }],
    textHash: hashReadbackText(text),
    createdAt: '2026-11-09T10:01:00.000Z',
  };
}

export const verdict: Verdict = {
  kind: 'mismatch',
  reasons: [
    {
      module: 'colour',
      finding: 'disagree',
      confidence: 'sure',
      expected: 'navy',
      observed: 'black',
      sentence: 'This looks black, not navy.',
    },
  ],
  headline: 'This is not the colour you ordered.',
  nextSteps: [],
};
