import { describe, expect, it } from 'vitest';
import { parseMoney } from '@sightline/core';
import { Channel3ProductSchema, channel3QueryText, channel3Sizes, createRecordedChannel3, normaliseChannel3, type Channel3Product } from '../src';
import { recordedSearches, recording } from './fixtures/channel3';

/** One product from a recorded Channel3 response, by a piece of its title. */
function recorded(file: string, title: string): Channel3Product {
  const all = recording(file).products as { title: string }[];
  const raw = all.find((p) => p.title === title) ?? all.find((p) => p.title.includes(title));
  if (!raw) throw new Error(`No "${title}" in ${file}`);
  return Channel3ProductSchema.parse(raw);
}

describe('Channel3 sizes from recorded listings', () => {
  it('never takes the size the store pre-selected when the listing offers several (the XL under "size M" bug)', () => {
    // SPRWMN's listing is pre-selected to XL and lists S, M (which does not exist in navy) and XL.
    const raw = recorded('navy-crewneck-sweatshirt', 'Crewneck Sweatshirt');
    expect(raw.variants?.selected.find((s) => s.name === 'Size')?.label).toBe('XL');
    const p = normaliseChannel3(raw)!;
    expect(p.attributes.size).toBeUndefined();
    expect(p.selected.Size).toBeUndefined();
    expect(p.sizes?.map((s) => s.label)).toEqual(['S', 'XL']);
  });

  it('sets the size only when the buyer chose one the listing offers', () => {
    const raw = recorded('navy-crewneck-sweatshirt', 'Crewneck Sweatshirt');
    expect(normaliseChannel3(raw, { Size: 'XL' })!.attributes.size).toBe('XL');
    expect(normaliseChannel3(raw, { Size: 'M' })!.attributes.size).toBeUndefined();
    // S is sold as its own listing: this listing's size stays unset, and the offer says where S is.
    const s = normaliseChannel3(raw, { Size: 'S' })!;
    expect(s.attributes.size).toBeUndefined();
    expect(s.sizes?.find((x) => x.label === 'S')?.productId).toMatch(/^c3:/);
  });

  it('reads "not in stock" in a size label as out of stock, once', () => {
    const sizes = channel3Sizes(recorded('navy-crewneck-sweatshirt', 'Naval Academy'))!;
    expect(sizes.filter((s) => s.label === 'S')).toEqual([{ label: 'S', available: false }]);
    expect(sizes.map((s) => s.label)).toEqual(['S', 'M', 'L', 'XL', 'XXL']);
  });

  it('de-duplicates "46" and "46 EU" and reads a generic "Option" of sizes', () => {
    const eu = channel3Sizes(recorded('navy-sweater-palette', 'Silk Crewe'))!;
    expect(eu.map((s) => s.label)).toEqual(['46', '48', '50', '52', '54', '56', '58', '60']);
    const socks = channel3Sizes(recorded('merino-hiking-socks-under-50', 'Step Wool'))!;
    expect(socks.map((s) => s.label)).toEqual(['S', 'M', 'L', 'XL']);
    // A colour option is never read as sizes.
    expect(channel3Sizes(recorded('navy-sweater-palette', 'Vero Moda'))).toBeUndefined();
  });

  it('fills fit, material, care and the rating from the listing data', () => {
    const p = normaliseChannel3(recorded('navy-sweater', 'Newnavy'))!;
    expect(p.attributes.fit).toBe('Relaxed');
    expect(p.attributes.material).toBe('100% Virgin wool');
    expect(p.attributes.audience).toBe("men's");
    const rated = normaliseChannel3(recorded('navy-sweater', 'crew neck wide sleeve'))!;
    expect(rated.rating).toEqual({ average: 5, count: 2 });
    const careful = normaliseChannel3(recorded('navy-sweater-palette', 'Navy Cable Knit'))!;
    expect(careful.attributes.care).toBe('Machine washable');
    // Channel3 gives no return policy: it stays unknown, never guessed.
    expect(careful.returnPolicy).toBeNull();
  });
});

describe('Channel3 query words', () => {
  it('says the colour once and navy as navy blue', () => {
    expect(channel3QueryText({ text: 'navy sweater', colour: 'navy' })).toBe('navy blue sweater');
    expect(channel3QueryText({ text: 'crew-neck sweater', colour: 'navy' })).toBe('navy blue crew-neck sweater');
    expect(channel3QueryText({ text: 'navy blue hoodie', colour: 'navy' })).toBe('navy blue hoodie');
    expect(channel3QueryText({ text: 'wool socks', colour: 'black' })).toBe('black wool socks');
    expect(channel3QueryText({ text: 'black wool socks', colour: 'black' })).toBe('black wool socks');
  });
});

describe('recorded Channel3 catalog', () => {
  it('answers a search from the closest recording, with price filters applied', async () => {
    const c3 = createRecordedChannel3(recordedSearches());
    const hoodies = await c3.search({ text: 'hoodie', colour: 'navy' });
    expect(hoodies.some((p) => /Midshipmen/.test(p.title))).toBe(true);
    const cheap = await c3.search({ text: 'merino hiking socks', maxPrice: parseMoney('20') });
    expect(cheap.length).toBeGreaterThan(0);
    expect(cheap.every((p) => p.price.cents <= 2000)).toBe(true);
    expect(await c3.search({ text: 'garden hose' })).toEqual([]);
    expect(c3.calls).toHaveLength(3);
  });

  it('gets a recorded product by id with a size selection', async () => {
    const c3 = createRecordedChannel3(recordedSearches());
    const p = await c3.get('c3:J5ZyN1v', { Size: 'XL' });
    expect(p?.attributes.size).toBe('XL');
    expect(await c3.get('c3:nope')).toBeNull();
  });
});
