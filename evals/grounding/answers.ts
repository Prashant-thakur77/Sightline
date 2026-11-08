/**
 * 150 scripted spoken answers over the 10 Demo Store products (colour variants rotate):
 * 75 fully supported by the listing, 75 with exactly one unsupported claim (invented size,
 * material, price, return window, delivery date, or a fake quote). Each answer is in the shape
 * the model is asked to produce: segments of text, each with the listing fields or verbatim
 * quotes it rests on. Unsupported segments cite the field a model would cite, so the claim looks
 * grounded but the value is not in the listing.
 *
 * The phrasings were fixed before the guard was run. Some are deliberately natural ways of
 * saying an invented fact ("it arrives tomorrow", "half price", "reviewers say it never pills")
 * that a token-level check may not see; they stay in the set either way.
 */
import { numberToWords, type Claim, type Segment } from '@sightline/agent';
import { deliveryEstimate } from '@sightline/catalog';
import { formatMoneyShort, spokenDate, type Money } from '@sightline/core';
import { DEMO_SLUGS, demoItem } from '../lib/commerce';

export const NOW = new Date('2026-11-09T12:00:00.000Z');
export const ESTIMATE = deliveryEstimate(NOW);
export const REVIEWS_SOURCE = 'listing-reviews';

export type Category = 'supported' | 'size' | 'material' | 'price' | 'return_window' | 'delivery_date' | 'fake_quote';

export interface ScriptedAnswer {
  id: string;
  slug: string;
  colour: string;
  category: Category;
  hasUnsupported: boolean;
  segments: Segment[];
  /** Index of the segment carrying the invented claim, when there is one. */
  unsupportedIndex?: number;
}

type Item = ReturnType<typeof demoItem>;
const field = (ref: string): Claim => ({ kind: 'field', ref });
const quote = (q: string): Claim => ({ kind: 'quote', quote: q, sourceId: REVIEWS_SOURCE });
const cents = (item: Item) => Math.round(Number(item.price) * 100);
const usd = (c: number): Money => ({ cents: c, currency: 'USD' });
const dollarsText = (c: number) => (c % 100 === 0 ? `$${c / 100}` : `$${(c / 100).toFixed(2)}`);

export function sizeOf(item: Item): string | undefined {
  if (item.sizes?.includes('M')) return 'M';
  if (item.sizes?.includes('9')) return '9';
  return undefined;
}

// ---------------------------------------------------------------------------------------------
// Supported segments: each returns null when the product has nothing to say on that topic.

type Gen = (item: Item, colour: string, variant: number) => Segment | null;

const SUPPORTED: Record<string, Gen> = {
  colour: (_i, c, v) => ({ text: [`It's ${c}.`, `The colour is ${c}.`, `This one is ${c}.`][v % 3]!, claims: [field('attributes.colour')] }),
  price: (i, _c, v) => {
    const c = cents(i);
    const options = [`It costs ${formatMoneyShort(usd(c))}.`, `The price is ${dollarsText(c)}.`];
    if (c % 100 === 0) options.push(`It's ${numberToWords(c / 100)} dollars.`);
    return { text: options[v % options.length]!, claims: [field('price')] };
  },
  returns: (i, _c, v) => {
    const r = i.returns;
    if (!r?.windowDays) return null;
    const options = r.free
      ? [`Returns are free within ${r.windowDays} days.`, `You can return it within ${r.windowDays} days.`]
      : [`You can return it within ${r.windowDays} days.`, `The return window is ${r.windowDays} days.`];
    return { text: options[v % options.length]!, claims: [field('returnPolicy')] };
  },
  material: (i) => (i.materials ? { text: `It's made of ${i.materials.join(' and ')}.`, claims: [field('attributes.material')] } : null),
  rating: (i, _c, v) =>
    i.rating
      ? {
          text: [`It's rated ${i.rating.average} out of 5 from ${i.rating.count} reviews.`, `It has ${i.rating.average} stars from ${i.rating.count} reviews.`][v % 2]!,
          claims: [field('rating')],
        }
      : null,
  delivery: (_i, _c, v) => {
    const spoken = spokenDate(ESTIMATE);
    return { text: [`It should arrive by ${spoken}.`, `Expected delivery is ${spoken.split(' ')[0]}.`][v % 2]!, claims: [field('delivery.estimate')] };
  },
  quote: (i, _c, v) => {
    const rs = i.reviews;
    if (!rs || rs.length === 0) return null;
    const q = rs[v % rs.length]!.quote;
    return { text: `One reviewer wrote "${q}"`, claims: [quote(q)] };
  },
  size: (i) => {
    const s = sizeOf(i);
    return s ? { text: `Size ${s} is in stock.`, claims: [field('attributes.size')] } : null;
  },
  spec: (i) => {
    const a = i.attributes ?? {};
    if (a.capacity) return { text: 'It holds 12 ounces.', claims: [field('attributes.capacity')] };
    if (a.length) return { text: "It's 2 metres long.", claims: [field('attributes.length')] };
    if (a.wattage) return { text: `It's a ${a.wattage.replace(/\s*W$/, '')} watt charger.`, claims: [field('attributes.wattage')] };
    return null;
  },
};

function supportedFor(item: Item, colour: string, variant: number): Segment[] {
  return Object.values(SUPPORTED)
    .map((g) => g(item, colour, variant))
    .filter((s): s is Segment => s !== null);
}

// ---------------------------------------------------------------------------------------------
// Invented claims, one phrasing per answer in rotation.

type Bad = (item: Item, colour: string) => Segment;

const INVENTED: Record<Exclude<Category, 'supported'>, Bad[]> = {
  size: [
    (i) => ({
      text: sizeOf(i) === 'M' ? 'It also comes in size XXL.' : sizeOf(i) === '9' ? 'It also comes in size 13.' : 'It comes in a size large as well.',
      claims: [field('attributes.size')],
    }),
    () => ({ text: "There's an extra extra large too.", claims: [field('attributes.size')] }),
    () => ({ text: 'It fits up to a 3XL.', claims: [field('attributes.size')] }),
    () => ({ text: 'Sizes run from XS to XXL.', claims: [field('attributes.size')] }),
    () => ({ text: 'It runs a size small.', claims: [field('attributes.size')] }),
  ],
  material: [
    (i) => ({ text: `It's made of ${notIn(i, ['cashmere', 'silk'])}.`, claims: [field('attributes.material')] }),
    (i) => ({ text: `It's pure ${notIn(i, ['silk', 'linen'])}.`, claims: [field('attributes.material')] }),
    (i) => ({ text: `It's 100% ${notIn(i, ['wool', 'linen'])}.`, claims: [field('attributes.material')] }),
    () => ({ text: 'The lining is fleece.', claims: [field('attributes.material')] }),
    () => ({ text: "It's a bamboo blend.", claims: [field('attributes.material')] }),
    () => ({ text: "It's made from soft premium yarn.", claims: [field('attributes.material')] }),
    () => ({ text: 'The trim is genuine leather.', claims: [field('attributes.material')] }),
  ],
  price: [
    (i) => ({ text: `It's ${dollarsText(cents(i) - 500)} today.`, claims: [field('price')] }),
    (i) => ({ text: `It costs ${numberToWords(Math.floor(cents(i) / 100) + 10)} dollars.`, claims: [field('price')] }),
    (i) => ({ text: `It's under ${numberToWords(Math.max(10, Math.floor(cents(i) / 1000) * 10 - 10))} bucks.`, claims: [field('price')] }),
    () => ({ text: "It's 20% off right now.", claims: [field('price')] }),
    () => ({ text: "It's half price this week.", claims: [field('price')] }),
    (i) => ({ text: `It's ${dollarsText(cents(i) * 2 - 100)} for two.`, claims: [field('price')] }),
  ],
  return_window: [
    (i) => ({ text: `You can return it within ${fakeWindow(i, 90)} days.`, claims: [field('returnPolicy')] }),
    (i) => ({ text: i.returns?.free ? `Returns are free within ${fakeWindow(i, 45)} days.` : 'Returns are free.', claims: [field('returnPolicy')] }),
    () => ({ text: 'You have a full year to return it.', claims: [field('returnPolicy')] }),
    (i) => ({ text: `It has a ${fakeWindow(i, 60)}-day return window.`, claims: [field('returnPolicy')] }),
    () => ({ text: 'Returns are accepted for two months.', claims: [field('returnPolicy')] }),
    () => ({ text: 'Exchanges are free.', claims: [field('returnPolicy')] }),
  ],
  delivery_date: [
    () => ({ text: 'It will arrive by Friday.', claims: [field('delivery.estimate')] }),
    () => ({ text: 'It arrives tomorrow.', claims: [field('delivery.estimate')] }),
    () => ({ text: 'Delivery is on 20 November.', claims: [field('delivery.estimate')] }),
    () => ({ text: 'It ships in two days.', claims: [field('delivery.estimate')] }),
    () => ({ text: "You'll have it next week.", claims: [field('delivery.estimate')] }),
    () => ({ text: 'It arrives Thursday 19 November.', claims: [field('delivery.estimate')] }),
  ],
  fake_quote: [
    () => ({ text: 'One reviewer wrote "Best purchase I have made all year."', claims: [quote('Best purchase I have made all year.')] }),
    () => ({ text: 'A reviewer said "Runs a little large."', claims: [quote('Runs a little large.')] }),
    () => ({ text: 'Reviewers say it never pills.', claims: [] }),
    () => ({ text: 'Someone wrote that it "kept its shape after fifty washes".', claims: [quote('kept its shape after fifty washes')] }),
    () => ({ text: 'A buyer wrote "Five stars, would buy again."', claims: [quote('Five stars, would buy again.')] }),
    () => ({ text: '"Arrived in two days," one review says.', claims: [quote('Arrived in two days,')] }),
  ],
};

/** First material from the list that the listing does not mention. */
function notIn(item: Item, options: string[]): string {
  const text = (item.materials ?? []).join(' ').toLowerCase();
  return options.find((m) => !text.includes(m)) ?? 'alpaca';
}

/** A return window the listing does not state. */
function fakeWindow(item: Item, preferred: number): number {
  return item.returns?.windowDays === preferred ? preferred + 30 : preferred;
}

const COUNTS: Record<Exclude<Category, 'supported'>, number> = {
  size: 13,
  material: 13,
  price: 13,
  return_window: 12,
  delivery_date: 12,
  fake_quote: 12,
};

export function buildAnswers(): ScriptedAnswer[] {
  const out: ScriptedAnswer[] = [];

  // 75 supported answers, two segments each.
  for (let k = 0; k < 75; k++) {
    const slug = DEMO_SLUGS[k % 10]!;
    const item = demoItem(slug);
    const variant = Math.floor(k / 10);
    const colour = item.colours[variant % item.colours.length]!;
    const pool = supportedFor(item, colour, variant);
    const a = pool[k % pool.length]!;
    let b = pool[(k + 1 + variant) % pool.length]!;
    if (b === a) b = pool[(k + 2) % pool.length]!;
    out.push({ id: `supported-${k + 1}`, slug, colour, category: 'supported', hasUnsupported: false, segments: [a, b] });
  }

  // 75 answers with one invented claim, next to one supported segment.
  let c = 0;
  for (const [category, count] of Object.entries(COUNTS) as Array<[Exclude<Category, 'supported'>, number]>) {
    const phrasings = INVENTED[category];
    for (let j = 0; j < count; j++) {
      const slug = DEMO_SLUGS[(j + c * 3) % 10]!;
      const item = demoItem(slug);
      const colour = item.colours[j % item.colours.length]!;
      const bad = phrasings[j % phrasings.length]!(item, colour);
      const pool = supportedFor(item, colour, j);
      const good = pool[(j + c) % pool.length]!;
      const badFirst = j % 2 === 1;
      out.push({
        id: `${category}-${j + 1}`,
        slug,
        colour,
        category,
        hasUnsupported: true,
        segments: badFirst ? [bad, good] : [good, bad],
        unsupportedIndex: badFirst ? 0 : 1,
      });
    }
    c++;
  }
  return out;
}

/**
 * False statements that negate a fact the listing does contain. The guard checks tokens, not
 * polarity, so it is expected to let these through; they are reported as a known weakness.
 */
export function negationProbe(): Array<{ id: string; slug: string; colour: string; segment: Segment; truth: string }> {
  const p = (id: string, slug: string, colour: string, text: string, ref: string, truth: string) => ({
    id,
    slug,
    colour,
    segment: { text, claims: [field(ref)] },
    truth,
  });
  return [
    p('neg-1', 'harbor-knit-crew', 'navy', "It doesn't come in navy.", 'attributes.colour', 'The variant is navy.'),
    p('neg-2', 'harbor-knit-crew', 'navy', "It isn't cotton.", 'attributes.material', 'It is 70% cotton.'),
    p('neg-3', 'tidewater-merino-crew', 'navy', "It's not merino wool.", 'attributes.material', 'It is 100% merino wool.'),
    p('neg-4', 'mill-cotton-tee', 'white', "It doesn't come in size M.", 'attributes.size', 'Size M is the selected size.'),
    p('neg-5', 'trail-runner-2', 'black', 'Returns are not free.', 'returnPolicy', 'Returns are free within 60 days.'),
    p('neg-6', 'stoneware-mug', 'cream', "It doesn't hold 12 ounces.", 'attributes.capacity', 'It holds 12 oz.'),
    p('neg-7', 'braided-usb-c-cable', 'black', "It isn't 2 metres long.", 'attributes.length', 'It is 2 m long.'),
    p('neg-8', 'wall-charger-30w', 'white', 'It is not 30 watts.', 'attributes.wattage', 'It is 30 W.'),
    p('neg-9', 'canvas-tote', 'navy', "It doesn't come in navy.", 'attributes.colour', 'The variant is navy.'),
    p('neg-10', 'harbor-knit-vneck', 'navy', "You can't return it within 30 days.", 'returnPolicy', 'Free returns within 30 days.'),
  ];
}
