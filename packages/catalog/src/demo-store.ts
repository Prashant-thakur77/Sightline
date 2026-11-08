import { parseMoney } from '@sightline/core';
import type { CatalogProduct, CatalogSource, SearchQuery, VariantOption } from './types';

/**
 * The Demo Store is the PayPal sandbox merchant every order is placed with. Its own catalog is
 * used when Channel3 is not configured, in tests, and for the hero sweater in the demo. Images
 * are the store's own illustrations (served by the web app under /demo-store/).
 */

interface DemoItem {
  slug: string;
  title: string;
  brand: string;
  category: string;
  price: string;
  description: string;
  materials?: string[];
  keyFeatures?: string[];
  colours: string[];
  sizes?: string[];
  outOfStock?: string[];
  attributes?: Record<string, string>;
  returns: { windowDays?: number; free?: boolean; text?: string } | null;
  rating?: { average: number; count: number };
  reviews?: { quote: string; rating?: number }[];
}

const APPAREL_SIZES = ['S', 'M', 'L', 'XL'];

const ITEMS: DemoItem[] = [
  {
    slug: 'harbor-knit-crew',
    title: 'Harbor knit crew-neck sweater',
    brand: 'Harbor & Co',
    category: 'sweaters',
    price: '34.00',
    description:
      'A midweight cotton-blend crew-neck sweater with ribbed cuffs and hem. Regular fit. Machine washable.',
    materials: ['70% cotton', '30% recycled polyester'],
    keyFeatures: ['Crew neck', 'Ribbed cuffs and hem', 'Regular fit'],
    colours: ['navy', 'black', 'heather grey'],
    sizes: APPAREL_SIZES,
    attributes: { neckline: 'crew neck', fit: 'regular', pattern: 'solid', care: 'machine wash cold' },
    returns: { windowDays: 30, free: true, text: 'Free returns within 30 days of delivery.' },
    rating: { average: 4.4, count: 312 },
    reviews: [
      { quote: 'Runs true to size. I am usually a medium and the medium fits well.', rating: 5 },
      { quote: 'Soft and not itchy at all.', rating: 5 },
      { quote: 'The navy is quite dark, close to black indoors.', rating: 4 },
    ],
  },
  {
    slug: 'tidewater-merino-crew',
    title: 'Tidewater merino crew-neck',
    brand: 'Tidewater',
    category: 'sweaters',
    price: '39.00',
    description: 'Fine-gauge merino wool crew-neck. Slim fit. Hand wash or dry clean.',
    materials: ['100% merino wool'],
    keyFeatures: ['Crew neck', 'Fine gauge', 'Slim fit'],
    colours: ['navy', 'burgundy', 'charcoal'],
    sizes: APPAREL_SIZES,
    outOfStock: ['navy:S'],
    attributes: { neckline: 'crew neck', fit: 'slim', pattern: 'solid', care: 'hand wash' },
    returns: { windowDays: 14, free: false, text: 'Returns within 14 days. A $5.95 return shipping fee applies.' },
    rating: { average: 4.6, count: 88 },
    reviews: [
      { quote: 'Slim through the body, size up if you are between sizes.', rating: 4 },
      { quote: 'Lovely wool, very warm for how thin it is.', rating: 5 },
    ],
  },
  {
    slug: 'everyday-cable-crew',
    title: 'Everyday cable-knit crew',
    brand: 'Northline',
    category: 'sweaters',
    price: '29.50',
    description: 'Chunky cable-knit sweater with a relaxed fit.',
    colours: ['navy', 'cream'],
    sizes: APPAREL_SIZES,
    attributes: { neckline: 'crew neck', fit: 'relaxed', pattern: 'cable knit' },
    returns: null,
    rating: { average: 3.9, count: 41 },
  },
  {
    slug: 'harbor-knit-vneck',
    title: 'Harbor knit V-neck sweater',
    brand: 'Harbor & Co',
    category: 'sweaters',
    price: '36.00',
    description: 'The Harbor knit in a V-neck. Midweight cotton blend. Regular fit.',
    materials: ['70% cotton', '30% recycled polyester'],
    colours: ['navy', 'olive'],
    sizes: APPAREL_SIZES,
    attributes: { neckline: 'v-neck', fit: 'regular', pattern: 'solid', care: 'machine wash cold' },
    returns: { windowDays: 30, free: true, text: 'Free returns within 30 days of delivery.' },
    rating: { average: 4.3, count: 120 },
  },
  {
    slug: 'mill-cotton-tee',
    title: 'Mill heavyweight cotton T-shirt',
    brand: 'Mill',
    category: 't-shirts',
    price: '18.00',
    description: 'Heavyweight 240 gsm cotton T-shirt with a crew neck. Boxy fit.',
    materials: ['100% organic cotton'],
    colours: ['white', 'black', 'navy', 'forest green'],
    sizes: APPAREL_SIZES,
    attributes: { neckline: 'crew neck', fit: 'boxy', pattern: 'solid', care: 'machine wash warm' },
    returns: { windowDays: 30, free: true, text: 'Free returns within 30 days of delivery.' },
    rating: { average: 4.7, count: 902 },
    reviews: [{ quote: 'Boxy and a little short, I sized up for length.', rating: 4 }],
  },
  {
    slug: 'trail-runner-2',
    title: 'Trail Runner 2 running shoes',
    brand: 'Stride',
    category: 'shoes',
    price: '72.00',
    description: 'Lightweight trail running shoe with a grippy outsole and a padded tongue.',
    materials: ['Engineered mesh upper', 'Rubber outsole'],
    colours: ['black', 'royal blue'],
    sizes: ['8', '9', '10', '11'],
    attributes: { pattern: 'solid' },
    returns: { windowDays: 60, free: true, text: 'Free returns within 60 days, even if worn outdoors.' },
    rating: { average: 4.5, count: 233 },
  },
  {
    slug: 'stoneware-mug',
    title: 'Speckled stoneware mug, 12 oz',
    brand: 'Kiln House',
    category: 'mugs',
    price: '16.00',
    description: 'Handmade speckled stoneware mug. Dishwasher and microwave safe. Holds 12 ounces.',
    materials: ['Stoneware'],
    colours: ['cream', 'teal'],
    attributes: { capacity: '12 oz', care: 'dishwasher safe' },
    returns: { windowDays: 30, free: false, text: 'Returns within 30 days. Buyer pays return shipping.' },
    rating: { average: 4.8, count: 57 },
  },
  {
    slug: 'braided-usb-c-cable',
    title: 'Braided USB-C to USB-C cable, 2 m',
    brand: 'Voltline',
    category: 'chargers',
    price: '12.00',
    description: '60 watt braided USB-C cable, 2 metres long. Model VL-C60-2M.',
    colours: ['black'],
    attributes: { length: '2 m', model: 'VL-C60-2M', wattage: '60 W' },
    returns: { windowDays: 30, free: true, text: 'Free returns within 30 days of delivery.' },
    rating: { average: 4.2, count: 1430 },
  },
  {
    slug: 'wall-charger-30w',
    title: '30 W USB-C wall charger',
    brand: 'Voltline',
    category: 'chargers',
    price: '19.00',
    description: 'Compact 30 watt USB-C wall charger. Model VL-30C. US plug.',
    colours: ['white'],
    attributes: { model: 'VL-30C', wattage: '30 W', plug: 'US' },
    returns: { windowDays: 30, free: true, text: 'Free returns within 30 days of delivery.' },
    rating: { average: 4.5, count: 610 },
  },
  {
    slug: 'canvas-tote',
    title: 'Canvas tote bag with inner pocket',
    brand: 'Harbor & Co',
    category: 'bags',
    price: '22.00',
    description: 'Heavy canvas tote with a zip inner pocket and long handles.',
    materials: ['100% cotton canvas'],
    colours: ['natural', 'navy'],
    attributes: { pattern: 'solid' },
    returns: { windowDays: 30, free: true, text: 'Free returns within 30 days of delivery.' },
    rating: { average: 4.6, count: 75 },
  },
];

function optionsFor(item: DemoItem): VariantOption[] {
  const out: VariantOption[] = [
    {
      name: 'Colour',
      values: item.colours.map((c) => ({ label: c, available: true })),
    },
  ];
  if (item.sizes) out.push({ name: 'Size', values: item.sizes.map((s) => ({ label: s, available: true })) });
  return out;
}

function isAvailable(item: DemoItem, colour: string, size?: string): boolean {
  if (!item.outOfStock) return true;
  return !item.outOfStock.includes(size ? `${colour}:${size}` : colour);
}

export function imagePath(slug: string, colour: string): string {
  return `/demo-store/${slug}--${colour.replace(/\s+/g, '-')}.png`;
}

export function toCatalogProduct(item: DemoItem, selection: Record<string, string> = {}): CatalogProduct {
  const colour = item.colours.find((c) => c === selection.Colour?.toLowerCase()) ?? item.colours[0]!;
  const size = item.sizes ? (item.sizes.find((s) => s === selection.Size?.toUpperCase()) ?? undefined) : undefined;
  return {
    id: `demo:${item.slug}`,
    source: 'demo-store',
    title: item.title,
    brand: item.brand,
    category: item.category,
    description: item.description,
    materials: item.materials,
    keyFeatures: item.keyFeatures,
    attributes: {
      colour,
      size,
      material: item.materials?.join(', '),
      ...item.attributes,
    },
    price: parseMoney(item.price),
    available: isAvailable(item, colour, size),
    images: [
      {
        url: imagePath(item.slug, colour),
        alt: `${item.title} in ${colour}, front view on a plain background.`,
        variantId: colour,
      },
    ],
    options: optionsFor(item),
    selected: { Colour: colour, ...(size ? { Size: size } : {}) },
    returnPolicy: item.returns,
    rating: item.rating,
    reviews: item.reviews,
  };
}

export const DEMO_ITEMS: readonly DemoItem[] = ITEMS;

const tokenize = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, ' ')
    .split(/[\s-]+/)
    .filter(Boolean);

const STOP = new Set(['a', 'an', 'the', 'i', 'need', 'want', 'find', 'me', 'show', 'some', 'for', 'under', 'with', 'in', 'size']);

function score(item: DemoItem, q: SearchQuery): number {
  const hay = new Set(
    tokenize(
      [item.title, item.brand, item.category, item.description, item.colours.join(' '), Object.values(item.attributes ?? {}).join(' ')].join(' '),
    ),
  );
  const words = tokenize(q.text).filter((w) => !STOP.has(w));
  let s = 0;
  for (const w of words) {
    if (hay.has(w)) s += 2;
    else if (w.endsWith('s') && hay.has(w.slice(0, -1))) s += 2;
    else if ([...hay].some((h) => h.startsWith(w) && w.length > 3)) s += 1;
  }
  if (q.category && item.category === q.category) s += 3;
  if (q.colour && item.colours.includes(q.colour.toLowerCase())) s += 3;
  return s;
}

export function createDemoStore(): CatalogSource {
  return {
    name: 'demo-store',
    async search(q) {
      const scored = ITEMS.map((item) => ({ item, s: score(item, q) }))
        .filter(({ s }) => s > 0)
        .filter(({ item }) => !q.maxPrice || parseMoney(item.price).cents <= q.maxPrice.cents)
        .filter(({ item }) => !q.minPrice || parseMoney(item.price).cents >= q.minPrice.cents)
        .sort((a, b) => b.s - a.s || a.item.slug.localeCompare(b.item.slug));
      return scored.slice(0, q.limit ?? 10).map(({ item }) => {
        const colour = q.colour && item.colours.includes(q.colour.toLowerCase()) ? q.colour.toLowerCase() : undefined;
        const size = q.size && item.sizes?.includes(q.size.toUpperCase()) ? q.size.toUpperCase() : undefined;
        return toCatalogProduct(item, { ...(colour ? { Colour: colour } : {}), ...(size ? { Size: size } : {}) });
      });
    },
    async get(id, selection) {
      const slug = id.replace(/^demo:/, '');
      const item = ITEMS.find((i) => i.slug === slug);
      return item ? toCatalogProduct(item, selection) : null;
    },
  };
}
