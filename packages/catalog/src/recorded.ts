import { Channel3ProductSchema, channel3QueryText, normaliseChannel3, type Channel3Product } from './channel3';
import type { CatalogProduct, CatalogSource, SearchQuery } from './types';

/** One recorded Channel3 search: the words it was made with, and its response body. */
export interface RecordedSearch {
  query: string;
  body: unknown;
}

const words = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 1 && !['a', 'an', 'the', 'for', 'and', 'with', 'in', 'of', 'blue'].includes(w))
    .map((w) => w.replace(/(?:es|s)$/, ''));

/**
 * A catalog that answers from recorded Channel3 responses, for tests and offline evals. A search
 * gets the recording whose words overlap the query most (none when nothing overlaps), through the
 * same normaliser as live data, with the price filters applied as Channel3 applies them.
 */
export function createRecordedChannel3(recordings: RecordedSearch[]): CatalogSource & { calls: SearchQuery[] } {
  const parsed = recordings.map((r) => ({
    words: new Set(words(r.query)),
    products: ((r.body as { products?: unknown[] }).products ?? []).map((p) => Channel3ProductSchema.parse(p)),
  }));
  const byId = new Map<string, Channel3Product>();
  for (const r of parsed) for (const p of r.products) if (!byId.has(p.id)) byId.set(p.id, p);
  const calls: SearchQuery[] = [];
  return {
    name: 'channel3',
    calls,
    async search(q) {
      calls.push(q);
      const asked = words(channel3QueryText(q));
      let best: (typeof parsed)[number] | undefined;
      let bestScore = 0;
      for (const r of parsed) {
        const score = asked.filter((w) => r.words.has(w)).length;
        if (score > bestScore) {
          best = r;
          bestScore = score;
        }
      }
      if (!best) return [];
      return best.products
        .map((p) => normaliseChannel3(p))
        .filter((p): p is CatalogProduct => p !== null)
        .filter((p) => (!q.maxPrice || p.price.cents <= q.maxPrice.cents) && (!q.minPrice || p.price.cents >= q.minPrice.cents))
        .slice(0, q.limit ?? 12);
    },
    async get(id, selection) {
      const raw = byId.get(id.replace(/^c3:/, ''));
      return raw ? normaliseChannel3(raw, selection) : null;
    },
  };
}
