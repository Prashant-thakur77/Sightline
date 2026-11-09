import { z } from 'zod';
import { parseMoney } from '@sightline/core';
import type { CatalogProduct, CatalogSource, SearchQuery, SizeOffer, VariantOption } from './types';

export const CHANNEL3_BASE = 'https://api.trychannel3.com';

/** Common colour names mapped to a representative hex, for Channel3's palette filter. */
export const COLOUR_HEX: Record<string, string> = {
  navy: '#1f2a44',
  black: '#111111',
  white: '#f5f5f2',
  grey: '#8a8d91',
  gray: '#8a8d91',
  'heather grey': '#9a9a9a',
  charcoal: '#36454f',
  red: '#c0282d',
  burgundy: '#6d1a2b',
  maroon: '#6b1e2a',
  pink: '#f1a7c0',
  orange: '#e8742a',
  yellow: '#f2c230',
  mustard: '#c9a227',
  green: '#2f7d3a',
  'forest green': '#2d4b31',
  olive: '#6b6b36',
  teal: '#1f7a7a',
  blue: '#2a5bd7',
  'royal blue': '#2f4fb5',
  'light blue': '#9cc3e6',
  purple: '#6a3d9a',
  brown: '#6b4428',
  tan: '#c3a07a',
  beige: '#d9c9a8',
  cream: '#efe6cf',
  ivory: '#f4efe1',
  khaki: '#b9a77a',
  taupe: '#8b7d6b',
  natural: '#e6dcc6',
};

const PriceSchema = z
  .object({
    price: z.number().optional(),
    amount: z.number().optional(),
    compare_at_price: z.number().nullish(),
    currency: z.string().default('USD'),
  })
  .passthrough();

const OfferSchema = z
  .object({
    url: z.string(),
    domain: z.string(),
    price: PriceSchema,
    availability: z.string().default('InStock'),
    condition: z.string().nullish(),
  })
  .passthrough();

const ImageSchema = z
  .object({
    url: z.string(),
    cleaned_url: z.string().nullish(),
    is_main_image: z.boolean().optional(),
    shot_type: z.string().nullish(),
    alt_text: z.string().nullish(),
  })
  .passthrough();

const VariantsSchema = z
  .object({
    options: z
      .array(
        z
          .object({
            name: z.string(),
            values: z.array(
              z.object({ label: z.string(), exists: z.boolean().optional(), available: z.string().nullish() }).passthrough(),
            ),
          })
          .passthrough(),
      )
      .default([]),
    selected: z.array(z.object({ name: z.string(), label: z.string() }).passthrough()).default([]),
  })
  .passthrough();

export const Channel3ProductSchema = z
  .object({
    id: z.string(),
    title: z.string(),
    description: z.string().nullish(),
    brands: z.array(z.object({ id: z.string().optional(), name: z.string() }).passthrough()).nullish(),
    images: z.array(ImageSchema).nullish(),
    category: z.object({ slug: z.string().nullish(), title: z.string().nullish() }).passthrough().nullish(),
    materials: z.array(z.string()).nullish(),
    key_features: z.array(z.string()).nullish(),
    offers: z.array(OfferSchema).default([]),
    variants: VariantsSchema.nullish(),
    structured_attributes: z.record(z.string(), z.unknown()).nullish(),
  })
  .passthrough();

export type Channel3Product = z.infer<typeof Channel3ProductSchema>;

const SearchResponseSchema = z
  .object({ products: z.array(Channel3ProductSchema), next_page_token: z.string().nullish() })
  .passthrough();

export class Channel3Error extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = 'Channel3Error';
  }
}

/** The first of the structured attribute keys that is present, as text. */
function attr(p: Channel3Product, ...keys: string[]): string | undefined {
  for (const key of keys) {
    const v = p.structured_attributes?.[key];
    if (typeof v === 'string' && v.trim()) return v.trim();
    if (Array.isArray(v)) {
      const parts = v.filter((x): x is string => typeof x === 'string' && x.trim().length > 0);
      if (parts.length) return parts.join(', ');
    }
  }
  return undefined;
}

function selectedOption(p: Channel3Product, names: string[]): string | undefined {
  const sel = p.variants?.selected ?? [];
  const hit = sel.find((s) => names.includes(s.name.toLowerCase()));
  return hit?.label;
}

const STOCK_WORDS = /\b(?:not in stock|out of stock|sold out|unavailable)\b/i;
const SIZE_LIKE = /^(?:\d{1,2}(?:\.\d)?|[2-5]?x{0,3}[sml]|xx?l|one size|os|[a-z]{1,4}\/[a-z]{1,4})$/i;

/**
 * The listing's own size choices: an option named like "Size" or "EU Size", or a generic "Option"
 * whose values all look like sizes. Labels are cleaned ("S S not in stock" is S, out of stock) and
 * de-duplicated ("46" and "46 EU" are one). Stock is known only when the store says so.
 */
export function channel3Sizes(p: Channel3Product): SizeOffer[] | undefined {
  const options = p.variants?.options ?? [];
  const opt =
    options.find((o) => /\bsize\b/i.test(o.name)) ??
    options.find((o) => /^option$/i.test(o.name.trim()) && o.values.length > 0 && o.values.every((v) => SIZE_LIKE.test(v.label.trim())));
  if (!opt) return undefined;
  const out: SizeOffer[] = [];
  const seen = new Set<string>();
  for (const v of opt.values) {
    if (v.exists === false) continue;
    let label = v.label.replace(/\s+/g, ' ').trim();
    let available: boolean | undefined = v.available === 'OutOfStock' ? false : v.available === 'InStock' ? true : undefined;
    if (STOCK_WORDS.test(label)) {
      available = false;
      label = label.replace(STOCK_WORDS, '').trim();
    }
    // "S S" (a label repeated by the store) is one size.
    const words = label.split(' ');
    if (words.length === 2 && words[0]!.toLowerCase() === words[1]!.toLowerCase()) label = words[0]!;
    label = label.replace(/\s+(?:EU|US|UK|IT|FR)$/i, '');
    if (!label) continue;
    const key = label.toLowerCase();
    const prior = out.find((s) => s.label.toLowerCase() === key);
    if (prior) {
      if (available === false) prior.available = false;
      continue;
    }
    if (seen.has(key)) continue;
    seen.add(key);
    const own = (v as { product_id?: unknown }).product_id;
    const productId = typeof own === 'string' && own && own !== p.id ? `c3:${own}` : undefined;
    out.push({ label, ...(available === undefined ? {} : { available }), ...(productId ? { productId } : {}) });
  }
  return out.length ? out : undefined;
}

/** "male" and "female" as the store's audience words. */
function audience(p: Channel3Product): string | undefined {
  const g = (p as { gender?: unknown }).gender;
  if (g === 'male') return "men's";
  if (g === 'female') return "women's";
  if (g === 'unisex') return 'unisex';
  return undefined;
}

/** The store's rating, when it gives an average and a count. */
function ratingOf(p: Channel3Product): { average: number; count: number } | undefined {
  const r = (p as { ratings?: unknown }).ratings as { value?: unknown; count?: unknown } | null | undefined;
  if (!r || typeof r.value !== 'number' || typeof r.count !== 'number' || r.count < 1) return undefined;
  return { average: Math.round(r.value * 10) / 10, count: Math.round(r.count) };
}

/** Pick the offer we mirror: cheapest new, in-stock offer; else cheapest offer. */
export function pickOffer(p: Channel3Product) {
  const priced = p.offers
    .map((o) => ({ o, value: o.price.price ?? o.price.amount }))
    .filter((x): x is { o: (typeof p.offers)[number]; value: number } => typeof x.value === 'number');
  const good = priced.filter((x) => x.o.availability === 'InStock' && (!x.o.condition || x.o.condition === 'new'));
  const pool = good.length ? good : priced;
  return pool.sort((a, b) => a.value - b.value)[0];
}

/**
 * A Channel3 product as a CatalogProduct. `selection` is the variant the buyer chose, by the
 * listing's own labels (`{ Size: 'M' }`). A listing that offers several sizes never takes the size
 * the store happened to pre-select: the size is set only when the buyer chose one it offers.
 */
export function normaliseChannel3(p: Channel3Product, selection: Record<string, string> = {}): CatalogProduct | null {
  const offer = pickOffer(p);
  if (!offer) return null;
  const options: VariantOption[] = (p.variants?.options ?? []).map((o) => ({
    name: o.name,
    values: o.values.filter((v) => v.exists !== false).map((v) => ({ label: v.label, available: v.available !== 'OutOfStock' })),
  }));
  const colour = selectedOption(p, ['color', 'colour']) ?? attr(p, 'color', 'colour');
  const sizes = channel3Sizes(p);
  const wantedSize = Object.entries(selection).find(([k]) => /size/i.test(k))?.[1];
  const offered = wantedSize ? sizes?.find((s) => s.label.toLowerCase() === wantedSize.trim().toLowerCase()) : undefined;
  // A size sold as its own listing is that listing's size, not this one's.
  const chosenSize = offered && !offered.productId ? offered : undefined;
  // One size, or none listed: the store's own selection (or attribute) is the listing's size.
  const size = sizes && sizes.length > 1 ? chosenSize?.label : (chosenSize?.label ?? selectedOption(p, ['size']) ?? attr(p, 'size') ?? sizes?.[0]?.label);
  const images = (p.images ?? [])
    .sort((a, b) => Number(Boolean(b.is_main_image)) - Number(Boolean(a.is_main_image)))
    .slice(0, 6)
    .map((i) => ({ url: i.url, alt: i.alt_text ?? undefined }));
  const selected: Record<string, string> = {};
  for (const s of p.variants?.selected ?? []) if (!/size/i.test(s.name)) selected[s.name] = s.label;
  if (size) selected.Size = size;
  const rating = ratingOf(p);
  return {
    id: `c3:${p.id}`,
    source: 'channel3',
    title: p.title,
    brand: p.brands?.[0]?.name,
    category: p.category?.slug ?? undefined,
    description: p.description ?? undefined,
    materials: p.materials ?? undefined,
    keyFeatures: p.key_features ?? undefined,
    attributes: {
      colour: colour?.toLowerCase(),
      size,
      material: p.materials?.length ? p.materials.join(', ') : attr(p, 'fabric', 'material'),
      neckline: attr(p, 'neckline'),
      fit: attr(p, 'top-fit', 'bottom-fit', 'fit'),
      pattern: attr(p, 'pattern'),
      care: attr(p, 'care-instructions', 'care'),
      sleeve: attr(p, 'sleeve-length-type'),
      audience: audience(p),
    },
    ...(sizes ? { sizes } : {}),
    ...(rating ? { rating } : {}),
    price: parseMoney(offer.value.toFixed(2), offer.o.price.currency),
    compareAtPrice:
      typeof offer.o.price.compare_at_price === 'number'
        ? parseMoney(offer.o.price.compare_at_price.toFixed(2), offer.o.price.currency)
        : undefined,
    available: offer.o.availability === 'InStock',
    images,
    options,
    selected,
    returnPolicy: null,
    retailerDomain: offer.o.domain,
    retailerUrl: offer.o.url,
  };
}

/**
 * The words sent to Channel3: the colour once (it is often already in the text), and "navy" as
 * "navy blue", so the colour is not read as the U.S. Navy's teams and gear.
 */
export function channel3QueryText(q: Pick<SearchQuery, 'text' | 'colour'>): string {
  const words = q.text.trim().split(/\s+/).filter(Boolean);
  const colour = q.colour?.trim().toLowerCase();
  const has = (w: string) => words.some((x) => x.toLowerCase() === w);
  const out = colour && !colour.split(' ').every(has) ? [colour, ...words] : words;
  const text = out.join(' ');
  return /\bnavy\b(?!\s+blue)/i.test(text) ? text.replace(/\bnavy\b(?!\s+blue)/i, 'navy blue') : text;
}

export interface Channel3Options {
  apiKey: string;
  fetch?: typeof fetch;
  baseUrl?: string;
  /** Stable per-user id for Channel3's x-user-id header (never an email). */
  userId?: string;
  /** Per-request time limit in milliseconds (default 8 seconds). */
  timeoutMs?: number;
}

export function createChannel3(opts: Channel3Options): CatalogSource & {
  raw: { search: (body: unknown) => Promise<z.infer<typeof SearchResponseSchema>> };
} {
  const f = opts.fetch ?? fetch;
  const base = opts.baseUrl ?? CHANNEL3_BASE;
  const headers = (extra: Record<string, string> = {}) => ({
    'x-api-key': opts.apiKey,
    accept: 'application/json',
    ...(opts.userId ? { 'x-user-id': opts.userId } : {}),
    ...extra,
  });

  async function call(path: string, init: RequestInit): Promise<unknown> {
    // A voice turn can't wait long: a slow answer is a failed one, and the caller says so.
    const res = await f(`${base}${path}`, { ...init, signal: init.signal ?? AbortSignal.timeout(opts.timeoutMs ?? 8000) });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Channel3Error(`Channel3 ${res.status}: ${text.slice(0, 200)}`, res.status);
    }
    return res.json();
  }

  async function rawSearch(body: unknown) {
    const json = await call('/v1/search', {
      method: 'POST',
      headers: headers({ 'content-type': 'application/json' }),
      body: JSON.stringify(body),
    });
    return SearchResponseSchema.parse(json);
  }

  return {
    name: 'channel3',
    raw: { search: rawSearch },
    async search(q: SearchQuery) {
      const filters: Record<string, unknown> = { availability: ['InStock'] };
      if (q.maxPrice || q.minPrice)
        filters.price = {
          ...(q.minPrice ? { min_price: q.minPrice.cents / 100 } : {}),
          ...(q.maxPrice ? { max_price: q.maxPrice.cents / 100 } : {}),
        };
      const hex = q.colour ? COLOUR_HEX[q.colour.toLowerCase()] : undefined;
      if (hex) filters.colors = { palette: [{ hex }] };
      const res = await rawSearch({ query: channel3QueryText(q), filters, limit: q.limit ?? 12 });
      return res.products.map((p) => normaliseChannel3(p)).filter((p): p is CatalogProduct => p !== null);
    },
    async get(id: string, selection?: Record<string, string>) {
      const raw = id.replace(/^c3:/, '');
      const params = new URLSearchParams();
      for (const [k, v] of Object.entries(selection ?? {})) params.set(`option_${k}`, v);
      const qs = params.toString();
      try {
        const json = await call(`/v1/products/${encodeURIComponent(raw)}${qs ? `?${qs}` : ''}`, {
          method: 'GET',
          headers: headers(),
        });
        return normaliseChannel3(Channel3ProductSchema.parse(json), selection);
      } catch (e) {
        if (e instanceof Channel3Error && e.status === 404) return null;
        throw e;
      }
    },
  };
}
