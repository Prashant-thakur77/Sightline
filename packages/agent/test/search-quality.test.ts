import { describe, expect, it } from 'vitest';
import { createDemoStore, createMergedCatalog, createRecordedChannel3, snapshotOf, type CatalogSource } from '@sightline/catalog';
import { recordedSearches } from '@sightline/catalog/fixtures';
import { parseShoppingQuery } from '../src/grammar';
import { optionsHeading, presentOptions } from '../src/present';
import { pageOf, searchListings } from '../src/search';
import { sameSize } from '../src/lexicon';

const NOW = new Date('2026-11-09T12:00:00Z');
const SELLER = { name: 'Demo Store', merchantId: 'MERCHANT123' };
const merged = () => createMergedCatalog(createDemoStore(), createRecordedChannel3(recordedSearches()));
const live = () => createRecordedChannel3(recordedSearches());
const run = (text: string, source: CatalogSource = merged()) =>
  searchListings({ query: parseShoppingQuery(text), source, freeze: (p) => snapshotOf(p, SELLER, NOW) });

describe('search quality on recorded Channel3 data', () => {
  it('(a) "size M" never shows another size, and says when a listing gives no sizes', async () => {
    const r = await run('navy crewneck sweatshirt size M', live());
    expect(r.options.length).toBeGreaterThan(0);
    for (const o of r.options) {
      // Either the listing confirms M, or it gives no sizes and says so.
      if (o.sizeFit === 'unknown') expect(o.caveats).toContain("The listing doesn't give sizes, so I can't confirm size M.");
      else expect(sameSize(o.displaySize, 'M') || /(^|\/)M(\/|$)/.test(o.displaySize ?? '')).toBe(true);
      expect(o.snapshot.attributes.size === undefined || sameSize(o.snapshot.attributes.size, 'M')).toBe(true);
    }
    // SPRWMN's sweatshirt, pre-selected to XL with no M in navy, is left out for size M.
    expect(r.excluded.some((e) => e.snapshot.title === 'Crewneck Sweatshirt' && e.reason === 'size_not_offered')).toBe(true);
    const page = pageOf(r);
    const heading = optionsHeading(r.query, page.options);
    if (page.options.some((o) => o.sizeFit === 'unknown')) expect(heading).toMatch(/Not confirmed for every option: .*size M/);
    else expect(heading).toMatch(/in size M/);
  });

  it('(b) "navy" is a colour, not the Navy Midshipmen: team gear is left out unless asked', async () => {
    const r = await run('navy hoodie', live());
    expect(r.options.some((o) => /Midshipmen|Naval Academy/.test(o.snapshot.title))).toBe(false);
    expect(r.excluded.filter((e) => e.reason === 'fan_merch').length).toBeGreaterThanOrEqual(2);
    const fan = await run('navy midshipmen hoodie', live());
    expect(fan.options.some((o) => /Midshipmen/.test(o.snapshot.title))).toBe(true);
  });

  it('(c) complete listings first, and unknowns said once, not after every option', async () => {
    const r = await run('navy sweater', live());
    const page = pageOf(r);
    // The top three name their colour.
    expect(page.options.every((o) => o.snapshot.attributes.colour)).toBe(true);
    const spoken = presentOptions(page, { query: r.query });
    // Channel3 gives no return policy: said once for all three.
    expect(spoken.text.match(/return policy/g)).toHaveLength(1);
    expect(spoken.text).toContain('None of the three listings give a return policy.');
  });

  it('the Demo Store’s own sweater wins the hero request, with live results behind it', async () => {
    const r = await run('I need a navy crew-neck sweater, medium, under forty dollars');
    const page = pageOf(r);
    expect(page.options[0]!.snapshot.productId).toBe('demo:harbor-knit-crew');
    expect(page.options[0]!.snapshot.attributes).toMatchObject({ colour: 'navy', size: 'M' });
    expect(optionsHeading(r.query, page.options.slice(0, 1))).toBe('One option: a navy crew-neck sweater in size M under $40');
    expect(r.options.some((o) => o.snapshot.source === 'channel3')).toBe(true);
  });
});
