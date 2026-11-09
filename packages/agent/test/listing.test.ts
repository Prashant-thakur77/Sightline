import { describe, expect, it } from 'vitest';
import { Channel3ProductSchema, createDemoStore, normaliseChannel3, type CatalogProduct } from '@sightline/catalog';
import { RECORDED_QUERIES, recording } from '@sightline/catalog/fixtures';
import { chooseSize, interpretListing, isFanMerchandise, listingColour, normaliseColourLabel, wantsTeamGear } from '../src/listing';

/** Every listing in the recorded Channel3 responses, normalised as live data is. */
function recordedListings(): CatalogProduct[] {
  return Object.keys(RECORDED_QUERIES).flatMap((name) =>
    recording(name).products.map((raw) => normaliseChannel3(Channel3ProductSchema.parse(raw))!).filter(Boolean),
  );
}

function listing(over: Partial<CatalogProduct>): CatalogProduct {
  return {
    id: 'c3:x',
    source: 'channel3',
    title: 'Crew sweater',
    attributes: {},
    price: { cents: 3000, currency: 'USD' },
    available: true,
    images: [],
    options: [],
    selected: {},
    returnPolicy: null,
    ...over,
  };
}

describe('colour from the listing’s own words', () => {
  it('keeps plain colours and turns marketing names into a colour plus the store’s words', () => {
    expect(normaliseColourLabel('Navy Blue')).toEqual({ colour: 'navy blue' });
    expect(normaliseColourLabel('NAVY')).toEqual({ colour: 'navy' });
    expect(normaliseColourLabel('In The Navy')).toEqual({ colour: 'navy', listedAs: 'In The Navy' });
    expect(normaliseColourLabel('Midnight Navy')).toEqual({ colour: 'navy', listedAs: 'Midnight Navy' });
    expect(normaliseColourLabel('Charcoal Heather Grey')).toEqual({ colour: 'charcoal heather grey' });
    // No colour word: never spoken as a colour, only as the listing's own name.
    expect(normaliseColourLabel('Abalone')).toEqual({ listedAs: 'Abalone' });
    expect(normaliseColourLabel('HTHR SANDY HAZE')).toEqual({ listedAs: 'HTHR SANDY HAZE' });
  });

  it('drops words a colour label repeats from the title ("Navy Standard Hoodie" is navy)', () => {
    expect(normaliseColourLabel('Navy Standard Hoodie', 'Entire Studios Standard Hoodie')).toEqual({ colour: 'navy' });
  });

  it('reads the title, but never a brand or a team name, as the colour', () => {
    expect(listingColour({ title: 'Navy Cable Knit Sweater', attributes: {} })).toEqual({ colour: 'navy' });
    expect(listingColour({ title: 'Old Navy Cozy Crew Sweater', brand: 'Old Navy', attributes: {} })).toEqual({});
    expect(listingColour({ title: 'Boston Red Sox Logo Tee', attributes: {} })).toEqual({});
    expect(listingColour({ title: 'Black and white striped tee', attributes: {} })).toEqual({});
    expect(listingColour({ title: 'Wool sweater', keyFeatures: ['Color: Navy', 'Relaxed fit'], attributes: {} })).toEqual({ colour: 'navy' });
  });
});

describe('fan and licensed team merchandise', () => {
  it('flags exactly the team listings among 76 recorded Channel3 results', () => {
    const flagged = recordedListings()
      .filter((p) => isFanMerchandise(p))
      .map((p) => p.title);
    expect([...new Set(flagged)].sort()).toEqual([
      "Men's Navy Midshipmen Navy Bones Hoodie",
      "Men's Navy Midshipmen Navy Victory Pullover Hoodie",
      'U.S. Naval Academy Freeman Crewneck Sweatshirt',
    ]);
  });

  it('knows teams by league, mascot, place and team, or "officially licensed"', () => {
    expect(isFanMerchandise({ title: "Men's Michigan Wolverines Navy Hoodie" })).toBe(true);
    expect(isFanMerchandise({ title: 'Chicago Bears Knit Beanie' })).toBe(true);
    expect(isFanMerchandise({ title: 'Crew sweatshirt', description: 'Officially licensed NCAA apparel.' })).toBe(true);
    expect(isFanMerchandise({ title: 'Teddy bears pyjama set' })).toBe(false);
    expect(isFanMerchandise({ title: 'Navy crew-neck sweater', description: 'A navy sweater with a crew neck.' })).toBe(false);
  });

  it('keeps team gear when the buyer asks for it', () => {
    expect(wantsTeamGear('navy hoodie')).toBe(false);
    expect(wantsTeamGear('navy midshipmen hoodie')).toBe(true);
    expect(wantsTeamGear('a michigan wolverines hoodie')).toBe(true);
    expect(wantsTeamGear('a team jersey for my dad')).toBe(true);
  });
});

describe('sizes', () => {
  const offered = listing({ sizes: [{ label: 'S' }, { label: 'M', available: false }, { label: 'L', available: true }, { label: 'XL', productId: 'c3:other' }] });

  it('says how the listing answers the asked-for size', () => {
    expect(chooseSize(offered, 'M').fit).toBe('sold_out');
    expect(chooseSize(offered, 'L')).toMatchObject({ fit: 'in_stock', label: 'L' });
    expect(chooseSize(offered, 'small')).toMatchObject({ fit: 'offered', label: 'S' });
    expect(chooseSize(offered, 'XL')).toMatchObject({ fit: 'other_listing', productId: 'c3:other' });
    expect(chooseSize(offered, 'XXL').fit).toBe('not_offered');
    expect(chooseSize(listing({ attributes: { size: 'XL' } }), 'M').fit).toBe('not_offered');
    expect(chooseSize(listing({ attributes: { size: 'M' } }), 'M').fit).toBe('listed');
    expect(chooseSize(listing({}), 'M').fit).toBe('unknown');
    expect(chooseSize(listing({ sizes: [{ label: 'S/M' }, { label: 'L/XL' }] }), 'M')).toMatchObject({ fit: 'offered', label: 'S/M' });
  });

  it('freezes the chosen size, and no size at all when several are offered and none was asked for', () => {
    const chosen = interpretListing(offered, { size: 'L' }).product;
    expect(chosen.attributes.size).toBe('L');
    expect(chosen.selected.Size).toBe('L');
    const open = interpretListing({ ...offered, attributes: { size: 'XL' }, selected: { Size: 'XL' } }).product;
    expect(open.attributes.size).toBeUndefined();
    expect(open.selected.Size).toBeUndefined();
    expect(open.attributes.sizes).toBe('S, M, L, XL');
  });

  it('agrees with the Demo Store’s own stock', async () => {
    const tide = (await createDemoStore().get('demo:tidewater-merino-crew', { Colour: 'navy' }))!;
    expect(chooseSize(tide, 'S').fit).toBe('sold_out');
    expect(chooseSize(tide, 'M').fit).toBe('in_stock');
  });
});
