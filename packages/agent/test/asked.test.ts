import { describe, expect, it } from 'vitest';
import { askedConflicts, buyerAsked, colourMatches, compareAsked, sizeOf } from '../src/asked';

const said = (...texts: string[]) => buyerAsked(texts.map((text) => ({ text })));

describe("buyerAsked: read from the buyer's own words", () => {
  it('reads colour, size and material from a search', () => {
    const a = said('I need a navy merino sweater, medium, under forty dollars');
    expect(a.colour?.value).toBe('navy');
    expect(a.size?.value).toBe('M');
    expect(a.material?.value).toBe('merino');
    expect(a.colour?.utterance).toBe('I need a navy merino sweater, medium, under forty dollars');
  });

  it.each(['actually charcoal is fine', 'charcoal is fine', 'make it charcoal', 'switch to charcoal', 'can I get it in charcoal', 'the charcoal one'])(
    'an explicit change of mind replaces the earlier colour: %j',
    (change) => {
      expect(said('navy crew-neck sweater', change).colour?.value).toBe('charcoal');
    },
  );

  it('a later size change replaces the earlier size', () => {
    expect(said('navy sweater in medium', 'change the size to large').size?.value).toBe('L');
  });

  it('a new search starts the request again', () => {
    const a = said('navy sweater, medium', 'black running shoes');
    expect(a.colour?.value).toBe('black');
    expect(a.size).toBeUndefined();
  });

  it('"any colour" clears the colour', () => {
    expect(said('navy sweater', 'any colour').colour).toBeUndefined();
  });

  it.each(['is it charcoal?', 'confirm purchase', 'anything but charcoal', 'not charcoal', 'buy it'])('%j states no colour', (u) => {
    expect(said('navy sweater', u).colour?.value).toBe('navy');
  });

  it('nothing stated, nothing asked', () => {
    expect(said('buy it', 'confirm purchase')).toEqual({});
    expect(said()).toEqual({});
  });
});

describe('comparing with the cart variant', () => {
  it('a different colour conflicts', () => {
    expect(askedConflicts(said('navy sweater'), { colour: 'Charcoal' })).toMatchObject([{ attribute: 'colour', cart: 'Charcoal', asked: { value: 'navy' } }]);
  });

  it('the same colour, a shade name of it, or a plain family word does not', () => {
    expect(colourMatches('navy', 'Navy Heather')).toBe(true);
    expect(colourMatches('blue', 'Navy')).toBe(true);
    expect(colourMatches('navy', 'Blue')).toBe(true);
    expect(colourMatches('grey', 'Charcoal')).toBe(true);
    expect(colourMatches('navy', 'Royal Blue')).toBe(false);
    expect(colourMatches('navy', 'Harbor Mist')).toBeNull();
  });

  it('size and material conflicts', () => {
    const a = said('navy wool sweater, medium');
    expect(askedConflicts(a, { colour: 'Navy', size: 'L', material: '100% cotton' }).map((c) => c.attribute)).toEqual(['size', 'material']);
    expect(askedConflicts(a, { colour: 'Navy', size: 'Medium', material: 'Wool blend' })).toEqual([]);
  });

  it('reads listing size labels, and leaves ones it cannot tell uncompared', () => {
    expect(sizeOf('M')).toBe('M');
    expect(sizeOf('Medium (M)')).toBe('M');
    expect(sizeOf('Extra large (XL)')).toBe('XL');
    expect(sizeOf('9.5')).toBe('9.5');
    expect(sizeOf('M/L')).toBeUndefined();
    expect(sizeOf("9 (women's)")).toBeUndefined();
    expect(sizeOf('Regular')).toBeUndefined();
    expect(askedConflicts(said('warm socks for hiking', 'medium'), { size: 'Medium (M)' })).toEqual([]);
    expect(askedConflicts(said('warm socks for hiking', 'medium'), { size: 'Large (L)' })).toMatchObject([{ attribute: 'size' }]);
  });

  it('an attribute the cart does not state cannot conflict', () => {
    expect(compareAsked(said('navy sweater, medium'), {})).toEqual([
      { attribute: 'colour', asked: 'navy', cart: null, result: 'unknown' },
      { attribute: 'size', asked: 'M', cart: null, result: 'unknown' },
    ]);
  });
});
