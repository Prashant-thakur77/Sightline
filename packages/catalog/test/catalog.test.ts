import { describe, expect, it } from 'vitest';
import { parseMoney } from '@sightline/core';
import { computeTotals, createDemoStore, normaliseChannel3, pickOffer, snapshotOf, verifySnapshot, createChannel3, Channel3ProductSchema } from '../src';

const seller = { name: 'Demo Store', merchantId: 'MERCHANT123' };

describe('pricing', () => {
  it('charges 8% tax and free shipping over $30', () => {
    const t = computeTotals([{ price: parseMoney('34.00'), quantity: 1 }]);
    expect(t.items.cents).toBe(3400);
    expect(t.shipping.cents).toBe(0);
    expect(t.tax.cents).toBe(272);
    expect(t.total.cents).toBe(3672);
  });
  it('adds flat shipping under the threshold', () => {
    const t = computeTotals([{ price: parseMoney('12.00'), quantity: 1 }]);
    expect(t.shipping.cents).toBe(499);
    expect(t.total.cents).toBe(1200 + 499 + 96);
  });
  it('rounds tax half up and multiplies quantity', () => {
    expect(computeTotals([{ price: parseMoney('0.06'), quantity: 1 }]).tax.cents).toBe(0);
    expect(computeTotals([{ price: parseMoney('18.00'), quantity: 2 }]).items.cents).toBe(3600);
  });
  it('refuses empty carts', () => {
    expect(() => computeTotals([])).toThrow();
  });
});

describe('demo store', () => {
  const store = createDemoStore();
  it('finds navy crew-neck sweaters under $40', async () => {
    const r = await store.search({ text: 'navy crew-neck sweater', colour: 'navy', size: 'M', maxPrice: parseMoney('40') });
    expect(r.length).toBeGreaterThanOrEqual(3);
    expect(r[0]!.title).toMatch(/crew/i);
    for (const p of r) {
      expect(p.price.cents).toBeLessThanOrEqual(4000);
      expect(p.attributes.colour).toBe('navy');
    }
    expect(r.find((p) => p.id === 'demo:harbor-knit-crew')?.attributes.size).toBe('M');
  });
  it('gets a product with a variant selection', async () => {
    const p = await store.get('demo:harbor-knit-crew', { Colour: 'black', Size: 'L' });
    expect(p?.attributes.colour).toBe('black');
    expect(p?.attributes.size).toBe('L');
    expect(p?.images[0]?.url).toBe('/demo-store/harbor-knit-crew--black.png');
  });
  it('returns null for unknown ids', async () => {
    expect(await store.get('demo:nope')).toBeNull();
  });
  it('marks out-of-stock variants', async () => {
    const p = await store.get('demo:tidewater-merino-crew', { Colour: 'navy', Size: 'S' });
    expect(p?.available).toBe(false);
  });
  it('keeps unknown return policies as null, never guessed', async () => {
    const p = await store.get('demo:everyday-cable-crew');
    expect(p?.returnPolicy).toBeNull();
  });
});

describe('snapshots', () => {
  it('hash the product and detect tampering', async () => {
    const p = (await createDemoStore().get('demo:harbor-knit-crew', { Colour: 'navy', Size: 'M' }))!;
    const s = snapshotOf(p, seller, new Date('2026-11-09T10:00:00Z'), 'https://app.example');
    expect(s.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(verifySnapshot(s)).toBe(true);
    expect(s.images[0]!.url).toBe('https://app.example/demo-store/harbor-knit-crew--navy.png');
    expect(verifySnapshot({ ...s, price: parseMoney('3.40') })).toBe(false);
    expect(verifySnapshot({ ...s, attributes: { ...s.attributes, colour: 'black' } })).toBe(false);
  });
});

const sample = {
  id: 'abc123',
  title: 'Crew Neck Sweater',
  description: 'Soft cotton',
  brands: [{ id: 'b1', name: 'Brand' }],
  images: [
    { url: 'https://img/2.jpg', is_main_image: false },
    { url: 'https://img/1.jpg', is_main_image: true, alt_text: 'Navy sweater' },
  ],
  category: { slug: 'sweaters', title: 'Sweaters' },
  materials: ['Cotton'],
  offers: [
    { url: 'https://a.com/p', domain: 'a.com', price: { price: 49.5, currency: 'USD' }, availability: 'InStock', condition: 'new' },
    { url: 'https://b.com/p', domain: 'b.com', price: { price: 39.99, currency: 'USD' }, availability: 'InStock', condition: 'new' },
    { url: 'https://c.com/p', domain: 'c.com', price: { price: 19, currency: 'USD' }, availability: 'InStock', condition: 'used' },
  ],
  variants: {
    options: [{ name: 'Color', values: [{ label: 'Navy', exists: true, available: 'InStock' }, { label: 'Black', exists: true, available: 'OutOfStock' }] }],
    selected: [{ name: 'Color', label: 'Navy' }, { name: 'Size', label: 'M' }],
  },
  structured_attributes: { neckline: 'crew neck' },
};

describe('channel3 normalisation', () => {
  it('mirrors the cheapest new in-stock offer and reads variants', () => {
    const parsed = Channel3ProductSchema.parse(sample);
    expect(pickOffer(parsed)!.o.domain).toBe('b.com');
    const p = normaliseChannel3(parsed)!;
    expect(p.id).toBe('c3:abc123');
    expect(p.price.cents).toBe(3999);
    expect(p.attributes.colour).toBe('navy');
    expect(p.attributes.size).toBe('M');
    expect(p.attributes.neckline).toBe('crew neck');
    expect(p.images[0]!.url).toBe('https://img/1.jpg');
    expect(p.options[0]!.values[1]!.available).toBe(false);
    expect(p.returnPolicy).toBeNull();
    expect(p.retailerUrl).toBe('https://b.com/p');
  });
  it('accepts the amount field variant of price', () => {
    const p = normaliseChannel3(Channel3ProductSchema.parse({ ...sample, offers: [{ url: 'u', domain: 'd.com', price: { amount: 395, currency: 'USD' } }] }))!;
    expect(p.price.cents).toBe(39500);
  });
  it('drops products with no priced offer', () => {
    expect(normaliseChannel3(Channel3ProductSchema.parse({ ...sample, offers: [] }))).toBeNull();
  });
  it('sends key, colour palette and price filters', async () => {
    let seen: { url: string; init: RequestInit } | undefined;
    const fake = (async (url: string, init: RequestInit) => {
      seen = { url, init };
      return new Response(JSON.stringify({ products: [sample] }), { status: 200 });
    }) as unknown as typeof fetch;
    const c3 = createChannel3({ apiKey: 'k', fetch: fake, userId: 'usr_1' });
    const r = await c3.search({ text: 'crew-neck sweater', colour: 'navy', maxPrice: parseMoney('40') });
    expect(r).toHaveLength(1);
    expect(seen!.url).toBe('https://api.trychannel3.com/v1/search');
    const h = seen!.init.headers as Record<string, string>;
    expect(h['x-api-key']).toBe('k');
    expect(h['x-user-id']).toBe('usr_1');
    const body = JSON.parse(String(seen!.init.body));
    expect(body.query).toBe('navy crew-neck sweater');
    expect(body.filters.price.max_price).toBe(40);
    expect(body.filters.colors.palette[0].hex).toBe('#1f2a44');
  });
  it('passes variant selection as option_ params and maps 404 to null', async () => {
    const urls: string[] = [];
    const fake = (async (url: string) => {
      urls.push(url);
      return url.includes('missing') ? new Response('nope', { status: 404 }) : new Response(JSON.stringify(sample), { status: 200 });
    }) as unknown as typeof fetch;
    const c3 = createChannel3({ apiKey: 'k', fetch: fake });
    await c3.get('c3:abc123', { Color: 'Navy', Size: 'M' });
    expect(urls[0]).toBe('https://api.trychannel3.com/v1/products/abc123?option_Color=Navy&option_Size=M');
    expect(await c3.get('c3:missing')).toBeNull();
  });
});
