import { z } from 'zod';
import { parseMoney } from '@sightline/core';
import type { CatalogProduct, CatalogSource, SearchQuery, VariantOption } from './types';

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

function attr(p: Channel3Product, key: string): string | undefined {
  const v = p.structured_attributes?.[key];
  if (typeof v === 'string') return v;
  if (Array.isArray(v) && typeof v[0] === 'string') return v.join(', ');
  return undefined;
}

function selectedOption(p: Channel3Product, names: string[]): string | undefined {
  const sel = p.variants?.selected ?? [];
  const hit = sel.find((s) => names.includes(s.name.toLowerCase()));
  return hit?.label;
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

export function normaliseChannel3(p: Channel3Product): CatalogProduct | null {
  const offer = pickOffer(p);
  if (!offer) return null;
  const options: VariantOption[] = (p.variants?.options ?? []).map((o) => ({
    name: o.name,
    values: o.values.filter((v) => v.exists !== false).map((v) => ({ label: v.label, available: v.available !== 'OutOfStock' })),
  }));
  const colour = selectedOption(p, ['color', 'colour']) ?? attr(p, 'color') ?? attr(p, 'colour');
  const size = selectedOption(p, ['size']) ?? attr(p, 'size');
  const images = (p.images ?? [])
    .sort((a, b) => Number(Boolean(b.is_main_image)) - Number(Boolean(a.is_main_image)))
    .slice(0, 6)
    .map((i) => ({ url: i.url, alt: i.alt_text ?? undefined }));
  const selected: Record<string, string> = {};
  for (const s of p.variants?.selected ?? []) selected[s.name] = s.label;
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
      material: p.materials?.join(', ') ?? attr(p, 'material'),
      neckline: attr(p, 'neckline'),
      fit: attr(p, 'fit'),
      pattern: attr(p, 'pattern'),
    },
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

export interface Channel3Options {
  apiKey: string;
  fetch?: typeof fetch;
  baseUrl?: string;
  /** Stable per-user id for Channel3's x-user-id header (never an email). */
  userId?: string;
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
    const res = await f(`${base}${path}`, init);
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
      const text = [q.colour, q.text].filter(Boolean).join(' ');
      const res = await rawSearch({ query: text, filters, limit: q.limit ?? 12 });
      return res.products.map(normaliseChannel3).filter((p): p is CatalogProduct => p !== null);
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
        return normaliseChannel3(Channel3ProductSchema.parse(json));
      } catch (e) {
        if (e instanceof Channel3Error && e.status === 404) return null;
        throw e;
      }
    },
  };
}
