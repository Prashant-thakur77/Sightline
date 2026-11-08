import { describe, expect, it } from 'vitest';
import type { ProductSnapshot } from '@sightline/core';
import { parseShoppingQuery } from '../src/grammar';
import { WEIGHTS, cheapestOverBudget, rankProducts, type Candidate } from '../src/ranking';
import { snapshot, usd } from './helpers';

const q = parseShoppingQuery('navy crew-neck sweater, medium, under forty dollars');

function variant(id: string, over: Partial<ProductSnapshot>): Candidate {
  return { snapshot: snapshot({ id, productId: `p_${id}`, variantId: `v_${id}`, ...over }) };
}

const harbor = variant('harbor', {});
const blackKnit = variant('black', { title: 'Coastline crew-neck sweater', attributes: { colour: 'Black', size: 'M', neckline: 'crew-neck' }, price: usd(2900) });
const vague = variant('vague', { title: 'Cosy crew-neck sweater', attributes: {}, images: [], price: usd(2500), rating: { average: 4.9, count: 900 } });
const pricey = variant('pricey', { title: 'Merino crew-neck sweater', price: usd(4500) });
const noReturns = variant('noreturns', { title: 'Plain navy crew-neck sweater', returnPolicy: null, price: usd(3000), rating: undefined });

describe('rankProducts', () => {
  it('puts the matching, verifiable listing first and explains why', () => {
    const r = rankProducts({ candidates: [vague, blackKnit, harbor, noReturns], query: q });
    expect(r.options[0]!.snapshot.id).toBe('harbor');
    expect(r.options[0]!.why).toEqual([
      'Size M is listed.',
      'Navy, as you asked.',
      'Crew-neck, as you asked.',
      '$34, under your $40 budget.',
      'Free returns for 30 days.',
      'Rated 4.6 out of 5 from 212 reviews.',
      'The listing gives colour, size and photos, so I can check it when it arrives.',
    ]);
    expect(r.options[0]!.verifiable).toBe(true);
  });

  it('ranks down listings that cannot be checked on arrival, even with great reviews', () => {
    const r = rankProducts({ candidates: [vague, harbor, noReturns], query: q });
    const v = r.options.find((o) => o.snapshot.id === 'vague')!;
    expect(v.rank).toBe(3);
    expect(v.verifiable).toBe(false);
    expect(v.missing).toEqual(['colour', 'size', 'images']);
    expect(v.caveats).toContain("The listing doesn't give its colour, its size or photos, so it can't be checked on arrival.");
  });

  it('excludes over-budget listings with a reason and reports the closest price', () => {
    const r = rankProducts({ candidates: [harbor, pricey], query: q });
    expect(r.options.map((o) => o.snapshot.id)).toEqual(['harbor']);
    expect(r.excluded).toEqual([{ snapshot: pricey.snapshot, reason: 'over_budget', detail: '$45 is over your $40 budget.' }]);
    expect(cheapestOverBudget(r)).toEqual(usd(4500));
  });

  it('excludes a sold-out size and marks an in-stock one', () => {
    const r = rankProducts({
      candidates: [
        { ...harbor, availableSizes: ['S', 'M', 'L'] },
        { ...blackKnit, availableSizes: ['L'] },
      ],
      query: q,
    });
    expect(r.options[0]!.sizeInStock).toBe(true);
    expect(r.options[0]!.why[0]).toBe('Size M is in stock.');
    expect(r.excluded[0]!.reason).toBe('size_sold_out');
  });

  it('excludes out-of-stock listings and non-free returns when asked', () => {
    const r = rankProducts({
      candidates: [{ ...harbor, inStock: false }, noReturns, blackKnit],
      query: { ...q, freeReturns: true },
    });
    expect(r.excluded.map((e) => e.reason).sort()).toEqual(['out_of_stock', 'returns_not_free']);
    expect(r.options.map((o) => o.snapshot.id)).toEqual(['black']);
  });

  it('penalises a colour mismatch and a colour the user avoids', () => {
    const r = rankProducts({ candidates: [blackKnit, noReturns], query: q, avoidColours: ['black'] });
    const b = r.options.find((o) => o.snapshot.id === 'black')!;
    expect(b.caveats).toEqual(expect.arrayContaining(["It's listed as black, not navy.", "It's black, a colour you avoid."]));
    expect(r.options[0]!.snapshot.id).toBe('noreturns');
  });

  it('says when there is no return policy', () => {
    const r = rankProducts({ candidates: [noReturns], query: q });
    expect(r.options[0]!.caveats).toContain("The listing doesn't give a return policy.");
  });

  it('weighs rating by review count, so a few perfect reviews do not win', () => {
    const few = variant('few', { rating: { average: 5, count: 2 } });
    const many = variant('many', { rating: { average: 4.5, count: 500 } });
    const r = rankProducts({ candidates: [few, many], query: q });
    expect(r.options.map((o) => o.snapshot.id)).toEqual(['many', 'few']);
  });

  it('applies the store barrier score', () => {
    const r = rankProducts({ candidates: [{ ...harbor, barrierScore: 1 }, variant('twin', {})], query: q });
    expect(r.options[0]!.snapshot.id).toBe('twin');
    expect(r.options[1]!.score).toBeCloseTo(r.options[0]!.score + WEIGHTS.barrier, 3);
    expect(r.options[1]!.caveats).toContain("This store's own checkout is hard to use with a screen reader. I'd pay through PayPal instead.");
  });

  it('breaks ties deterministically: price, then review count, then id', () => {
    const a = variant('a', { price: usd(3000) });
    const b = variant('b', { price: usd(3000) });
    const r1 = rankProducts({ candidates: [b, a], query: { ...q, maxPrice: undefined } });
    const r2 = rankProducts({ candidates: [a, b], query: { ...q, maxPrice: undefined } });
    expect(r1.options.map((o) => o.snapshot.id)).toEqual(['a', 'b']);
    expect(r2.options.map((o) => o.snapshot.id)).toEqual(['a', 'b']);
  });

  it('returns at most three, pages with offset, and drops duplicate variants', () => {
    const many = Array.from({ length: 7 }, (_, i) => variant(`s${i}`, { price: usd(3000 + i * 10) }));
    const first = rankProducts({ candidates: [...many, many[0]!], query: q, limit: 10 });
    expect(first.options).toHaveLength(3);
    expect(first.total).toBe(7);
    expect(first.remaining).toBe(4);
    const second = rankProducts({ candidates: many, query: q, offset: 3 });
    expect(second.options.map((o) => o.rank)).toEqual([4, 5, 6]);
    expect(second.remaining).toBe(1);
  });

  it('does not ask for a size on unsized products', () => {
    const mug = variant('mug', { title: 'Stoneware mug', category: 'mug', attributes: { colour: 'Cream' } });
    const r = rankProducts({ candidates: [mug], query: parseShoppingQuery('cream mug') });
    expect(r.options[0]!.verifiable).toBe(true);
    expect(r.options[0]!.why).toContain('The listing gives colour and photos, so I can check it when it arrives.');
  });
});
