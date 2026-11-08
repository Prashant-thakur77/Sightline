import { describe, expect, it } from 'vitest';
import { listingWarnings } from '../src';
import type { ProductSnapshot } from '@sightline/core';

const base = {
  id: 's',
  productId: 'p',
  variantId: 'v',
  source: 'demo-store',
  title: 'Harbor knit crew-neck sweater',
  attributes: { colour: 'navy', size: 'M' },
  price: { cents: 3400, currency: 'USD' },
  images: [],
  returnPolicy: null,
  seller: { name: 'Demo Store', merchantId: 'M' },
  capturedAt: '2026-11-09T00:00:00Z',
  hash: 'x',
} as ProductSnapshot;

describe('listing warnings', () => {
  it('is silent when the description agrees', () => {
    expect(listingWarnings({ ...base, description: 'A soft navy sweater.' })).toEqual([]);
  });
  it('warns when the description names another colour', () => {
    const w = listingWarnings({ ...base, description: 'Shown here in black. Midweight cotton.' });
    expect(w[0]).toContain('listed as navy');
    expect(w[0]).toContain('black');
  });
  it('treats compound colour names as agreeing', () => {
    expect(listingWarnings({ ...base, attributes: { colour: 'navy heather' }, description: 'Navy heather knit.' })).toEqual([]);
  });
});
