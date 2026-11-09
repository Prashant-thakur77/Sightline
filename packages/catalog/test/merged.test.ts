import { describe, expect, it } from 'vitest';
import { parseMoney } from '@sightline/core';
import { catalogFromEnv, createDemoStore, createMergedCatalog, createRecordedChannel3, type CatalogSource } from '../src';
import { recordedSearches } from './fixtures/channel3';

describe('merged catalog: the Demo Store’s inventory with live Channel3 results', () => {
  it('returns Demo Store items first, then Channel3, each tagged with its source', async () => {
    const merged = createMergedCatalog(createDemoStore(), createRecordedChannel3(recordedSearches()));
    const r = await merged.search({ text: 'navy crew-neck sweater', colour: 'navy', size: 'M', maxPrice: parseMoney('40') });
    const firstLive = r.findIndex((p) => p.source === 'channel3');
    expect(firstLive).toBeGreaterThan(0);
    expect(r.slice(0, firstLive).map((p) => p.id)).toContain('demo:harbor-knit-crew');
    expect(r.slice(0, firstLive).every((p) => p.source === 'demo-store')).toBe(true);
    expect(r.slice(firstLive).every((p) => p.source === 'channel3')).toBe(true);
    expect(merged.lastReport).toMatchObject({ liveFailed: false });
    expect(merged.lastReport!.demoCount).toBe(firstLive);
  });

  it('keeps the Demo Store’s results when Channel3 fails, and says it failed', async () => {
    const broken: CatalogSource = {
      name: 'channel3',
      search: async () => {
        throw new Error('timeout');
      },
      get: async () => null,
    };
    const merged = createMergedCatalog(createDemoStore(), broken);
    const r = await merged.search({ text: 'navy crew-neck sweater' });
    expect(r.length).toBeGreaterThan(0);
    expect(merged.lastReport).toMatchObject({ liveFailed: true, liveCount: 0 });
  });

  it('drops a live result that repeats a Demo Store item', async () => {
    const demo = createDemoStore();
    const [harbor] = await demo.search({ text: 'harbor knit crew-neck sweater' });
    const echo: CatalogSource = { name: 'channel3', search: async () => [{ ...harbor!, id: 'c3:echo', source: 'channel3' }], get: async () => null };
    const r = await createMergedCatalog(demo, echo).search({ text: 'harbor knit crew-neck sweater' });
    expect(r.filter((p) => p.title === harbor!.title)).toHaveLength(1);
    expect(r.find((p) => p.title === harbor!.title)!.source).toBe('demo-store');
  });

  it('gets each item from its own source', async () => {
    const merged = createMergedCatalog(createDemoStore(), createRecordedChannel3(recordedSearches()));
    expect((await merged.get('demo:harbor-knit-crew', { Colour: 'navy', Size: 'M' }))?.source).toBe('demo-store');
    expect((await merged.get('c3:J5ZyN1v'))?.source).toBe('channel3');
  });

  it('uses the Demo Store alone without a Channel3 key, and both with one', () => {
    expect(catalogFromEnv({}).name).toBe('demo-store');
    expect(catalogFromEnv({ CHANNEL3_API_KEY: 'k' }).name).toBe('merged');
  });
});
