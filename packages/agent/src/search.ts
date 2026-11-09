/**
 * One search, the same for the grammar's fast path, the shopping agent's tool and the evals:
 * ask the catalog, read each listing honestly (colour, team merchandise, the asked size), freeze
 * it, and rank. Preferences are applied before this (applyPreferences); nothing here invents a
 * fact or a filter.
 */
import type { CatalogProduct, CatalogSource, MergedCatalog } from '@sightline/catalog';
import type { ProductSnapshot } from '@sightline/core';
import { queryToSearchText, type ShoppingQuery } from './grammar';
import { describeQuery } from './present';
import { interpretListing } from './listing';
import { rankAll, type ExcludedCandidate, type RankedOption } from './ranking';

export interface ListingSearchInput {
  query: ShoppingQuery;
  source: CatalogSource;
  /** Freezes a product into a snapshot (the seller is always the sandbox Demo Store). */
  freeze: (p: CatalogProduct) => ProductSnapshot;
  /** The words sent to the catalog, when the agent phrases them; else from the query. */
  text?: string;
  avoidColours?: string[];
  avoidMaterials?: string[];
  likeColours?: string[];
  /** How many listings to ask the catalog for. */
  limit?: number;
}

export interface ListingSearchResult {
  query: ShoppingQuery;
  /** The words the catalog was asked with. */
  text: string;
  /** Every eligible listing, best first, and what was left out and why. */
  options: RankedOption[];
  excluded: ExcludedCandidate[];
  /** How many listings the catalog returned before ranking. */
  returned: number;
  /** Channel3 was asked and didn't answer: only the Demo Store's own items came back. */
  liveFailed: boolean;
  /** Which catalog answered: "demo-store", "channel3" or "merged". */
  source: CatalogSource['name'];
}

export async function searchListings(input: ListingSearchInput): Promise<ListingSearchResult> {
  const q = input.query;
  const text = (input.text ?? queryToSearchText(q)).trim() || q.text;
  const products = await input.source.search({
    text,
    category: q.category,
    colour: q.colour,
    size: q.size,
    maxPrice: q.maxPrice,
    minPrice: q.minPrice,
    limit: input.limit ?? 16,
  });
  const candidates = products.map((p) => {
    const read = interpretListing(p, { size: q.size });
    return { snapshot: input.freeze(read.product), inStock: read.product.available, ...(q.size ? { sizeChoice: read.size } : {}) };
  });
  const ranked = rankAll({
    candidates,
    query: q,
    avoidColours: input.avoidColours,
    avoidMaterials: input.avoidMaterials,
    likeColours: input.likeColours,
  });
  const report = (input.source as Partial<MergedCatalog>).lastReport;
  return {
    query: q,
    text,
    options: ranked.options,
    excluded: ranked.excluded,
    returned: products.length,
    liveFailed: Boolean(report?.liveFailed),
    source: input.source.name,
  };
}

const EXCLUSION_WORDS: Record<string, string> = {
  wrong_category: 'another kind of product',
  over_budget: 'over budget',
  under_minimum: 'under the lowest price',
  out_of_stock: 'out of stock',
  size_sold_out: 'size sold out',
  size_not_offered: 'size not offered',
  returns_not_free: 'returns not free',
  fan_merch: 'team or fan merchandise',
  avoided_material: 'a material the buyer avoids',
};

/** How many listings were left out, by reason in words. */
export function leftOutCounts(result: Pick<ListingSearchResult, 'excluded'>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const e of result.excluded) {
    const k = EXCLUSION_WORDS[e.reason] ?? e.reason;
    out[k] = (out[k] ?? 0) + 1;
  }
  return out;
}

/** One plain sentence for the agent's step log: where it searched, for what, and what it kept. */
export function searchStepSummary(result: ListingSearchResult, kept: number): string {
  const where = result.source === 'demo-store' ? 'the Demo Store catalog' : result.source === 'merged' ? 'the Demo Store and Channel3' : 'Channel3';
  const out = Object.entries(leftOutCounts(result)).map(([why, n]) => `${n} ${why}`);
  const failed = result.liveFailed ? ' Channel3 did not answer, so only Demo Store items came back.' : '';
  return `Searched ${where} for "${result.text}" (${describeQuery(result.query)}): ${result.returned} listings, ${kept} kept${out.length ? `, left out ${out.join(', ')}` : ''}.${failed}`;
}

/** A page of a search's options, in the shape presentOptions and presentNone take. */
export function pageOf(result: Pick<ListingSearchResult, 'options' | 'excluded'>, offset = 0, size = 3) {
  const options = result.options.slice(offset, offset + size).map((o, i) => ({ ...o, rank: offset + i + 1 }));
  return { options, total: result.options.length, remaining: Math.max(0, result.options.length - offset - options.length), excluded: result.excluded };
}
