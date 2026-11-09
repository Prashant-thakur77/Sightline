/**
 * Spoken presentation. Every sentence is a template filled from snapshots, ranking output,
 * verdicts or case state; nothing here comes from model text. Lists never read more than three
 * options at once.
 */
import {
  spokenDate,
  type CheckModule,
  type Confidence,
  type Money,
  type ProductSnapshot,
  type Verbosity,
  type Verdict,
  type VerdictReason,
} from '@sightline/core';
import { confidenceSentence, en, m, returnsPhrase, returnsShort } from './copy/en';
import type { DetailsTopic, OptionContext, ShoppingQuery } from './grammar';
import { CATEGORIES, categoryOf, categoryPlural, colourSupport, sameSize } from './lexicon';
import { numberToWords, optionWord } from './numbers';
import { cheapestOverBudget, type RankResult, type RankedOption } from './ranking';
import { capitalise, joinAnd } from './text';

export interface Spoken {
  text: string;
  sentences: string[];
}

function spoken(sentences: string[]): Spoken {
  const clean = sentences.map((s) => s.trim()).filter((s) => s.length > 0);
  return { text: clean.join(' '), sentences: clean };
}

// ---------------------------------------------------------------------------------------------
// Options

/** "Harbor knit crew-neck sweater" becomes "Harbor knit crew-neck" when the category is known. */
export function shortTitle(title: string, category?: string): string {
  const t = title.replace(/\s+/g, ' ').trim();
  const entry = category ? CATEGORIES.find((c) => c.canonical === category) : categoryOf(t);
  if (!entry) return t;
  const parts = t.split(' ');
  const lower = parts.map((w) => w.toLowerCase().replace(/[^\p{L}\p{N}-]/gu, ''));
  for (const alias of [...entry.aliases].sort((a, b) => b.split(' ').length - a.split(' ').length)) {
    const aw = alias.split(' ');
    if (aw.length >= parts.length - 1) continue;
    const tail = lower.slice(-aw.length);
    const matches = aw.every((w, i) => tail[i] === w || (i === aw.length - 1 && (tail[i] === `${w}s` || tail[i] === `${w}es`)));
    if (matches) return parts.slice(0, -aw.length).join(' ');
  }
  return t;
}

function isSized(o: RankedOption, query?: ShoppingQuery): boolean {
  return Boolean(query?.size) || Boolean(o.displaySize) || Boolean(categoryOf(o.snapshot.category ?? o.snapshot.title)?.sizeDomain);
}

/** "sizes S, M, L" or, for a long list, "sizes XXS to XXL". */
function sizesPhrase(list: string): string {
  const all = list.split(/\s*,\s*/).filter(Boolean);
  return en.search.sizesOffered(all.length > 4 ? `${all[0]} to ${all[all.length - 1]}` : all.join(', '));
}

/** The size the buyer asked for is confirmed by this listing (stock may still be unknown). */
export function confirmsSize(o: Pick<RankedOption, 'sizeFit' | 'displaySize' | 'sizeInStock'>, size: string | undefined): boolean {
  if (!size) return true;
  if (o.sizeFit) return ['in_stock', 'offered', 'other_listing', 'listed'].includes(o.sizeFit);
  return Boolean(o.sizeInStock) || sameSize(o.displaySize, size);
}

function optionParts(o: RankedOption, verbosity: Verbosity, query?: ShoppingQuery, sayReturns = true): string[] {
  const s = o.snapshot;
  const title = shortTitle(s.title, query?.category ?? categoryOf(s.category ?? s.title)?.canonical);
  const named = s.attributes.colourName?.trim();
  const colour = s.attributes.colour?.trim().toLowerCase() || (named ? en.readback.colourOnlyListedAs(named) : en.search.colourNotGiven);
  const parts = [title, colour];
  if (verbosity !== 'brief' && isSized(o, query)) {
    if (o.sizeInStock && o.displaySize) parts.push(en.search.sizeInStock(o.displaySize));
    else if ((o.sizeFit === 'offered' || o.sizeFit === 'other_listing') && o.displaySize) parts.push(en.search.sizeOffered(o.displaySize));
    else if (o.displaySize) parts.push(en.search.size(o.displaySize));
    else if (!query?.size && s.attributes.sizes) parts.push(sizesPhrase(s.attributes.sizes));
    else parts.push(en.search.sizeNotGiven);
  }
  parts.push(m(s.price));
  if (verbosity !== 'brief' && sayReturns) parts.push(returnsShort(s.returnPolicy));
  if (verbosity === 'detailed' && s.rating && s.rating.count > 0) parts.push(en.search.rated(s.rating.average, s.rating.count));
  return parts;
}

const noPolicy = (o: RankedOption) => returnsShort(o.snapshot.returnPolicy) === 'return policy not given';

/**
 * What the buyer asked for that some options can't confirm, said once: "Size M isn't confirmed for
 * three: that listing doesn't give sizes." Nothing is claimed that a listing doesn't say.
 */
export function unconfirmedSentences(query: ShoppingQuery | undefined, options: RankedOption[]): string[] {
  if (!query) return [];
  const out: string[] = [];
  const names = (idx: number[]) => joinAnd(idx.map((i) => numberToWords(i + 1)));
  if (query.size) {
    const idx = options.map((o, i) => (o.sizeFit === 'unknown' || (!o.sizeFit && !confirmsSize(o, query.size)) ? i : -1)).filter((i) => i >= 0);
    if (idx.length) out.push(en.search.notConfirmed(`size ${query.size}`, names(idx), en.search.noSizesGiven(idx.length > 1)));
  }
  if (query.colour) {
    const idx = options.map((o, i) => (o.snapshot.attributes.colour ? -1 : i)).filter((i) => i >= 0);
    if (idx.length) out.push(en.search.notConfirmed(query.colour, names(idx), en.search.noColourGiven(idx.length > 1)));
  }
  return out;
}

/**
 * The options card's heading claims only what every option shown confirms: "3 options: a sweater
 * under $40. Not confirmed for every option: navy and size M". A filter the store couldn't apply
 * is never in the heading as if it had been.
 */
export function optionsHeading(query: ShoppingQuery, options: RankedOption[]): string {
  const n = options.length;
  const count = n === 1 ? 'One option' : `${n} options`;
  let shown: ShoppingQuery = query;
  const unconfirmed: string[] = [];
  if (query.colour && options.some((o) => !colourSupport(o.snapshot.attributes.colour).has(query.colour!))) {
    shown = { ...shown, colour: undefined };
    unconfirmed.push(query.colour);
  }
  // A neckline, fit or pattern is claimed only when every option's ranking confirmed it.
  for (const [key, value] of Object.entries(query.attributes)) {
    if (options.every((o) => o.why.includes(en.why.attributeMatch(value)))) continue;
    const { [key]: _drop, ...rest } = shown.attributes;
    shown = { ...shown, attributes: rest };
    unconfirmed.push(value);
  }
  if (query.size && options.some((o) => !confirmsSize(o, query.size))) {
    shown = { ...shown, size: undefined };
    unconfirmed.push(`size ${query.size}`);
  }
  const head = `${count}: ${describeQuery(shown)}`;
  return unconfirmed.length ? `${head}. ${capitalise(en.search.headingUnconfirmed(joinAnd(unconfirmed)))}` : head;
}

export interface OptionsPresentation extends Spoken {
  /** What the grammar needs to resolve "two" or "the cheaper one" next turn. */
  context: OptionContext[];
}

export interface PresentOptionsOptions {
  query?: ShoppingQuery;
  verbosity?: Verbosity;
  firstPage?: boolean;
  /** Said first: which saved preferences were used ("Using your usual size M."). */
  notes?: string[];
  /** A short, grounded opening line from the shopping agent. */
  lead?: string;
  /** One grounded line per option from the shopping agent, said after that option. */
  reasons?: Array<string | undefined>;
}

/**
 * "I found three. One: Harbor knit crew-neck, navy, size M in stock, $34, free returns for 30 days.
 * Two: ... Say a number for details, 'compare' to compare, or 'more' for other options."
 * Options are numbered from one on every page so "say a number" always means what was just read.
 * Every fact is from the listing; the agent's lead and reasons, already grounding-checked, are the
 * only words not from a template.
 */
export function presentOptions(result: Pick<RankResult, 'options' | 'remaining'>, opts: PresentOptionsOptions = {}): OptionsPresentation {
  const verbosity = opts.verbosity ?? 'standard';
  const options = result.options.slice(0, 3);
  if (options.length === 0) return { ...spoken([en.search.noneFoundGeneric]), context: [] };
  const count = numberToWords(options.length);
  // With several options and none giving a return policy, that is said once, not after each.
  const collapseReturns = verbosity !== 'brief' && options.length > 1 && options.every(noPolicy);
  const sentences = [...(opts.notes ?? []), ...(opts.lead ? [opts.lead] : [])];
  sentences.push(opts.firstPage === false ? en.search.moreCount(count) : en.search.foundCount(count));
  options.forEach((o, i) => {
    sentences.push(en.search.option(optionWord(i + 1), optionParts(o, verbosity, opts.query, !collapseReturns)));
    const reason = opts.reasons?.[i]?.trim();
    if (reason) sentences.push(/[.!?]$/.test(reason) ? reason : `${reason}.`);
  });
  if (verbosity !== 'brief') sentences.push(...unconfirmedSentences(opts.query, options));
  if (collapseReturns) sentences.push(en.search.noneGiveReturns(count));
  const more = result.remaining > 0;
  if (options.length === 1) sentences.push(more ? en.search.optionsPrompt1 : en.search.optionsPrompt1NoMore);
  else sentences.push(more ? en.search.optionsPrompt3 : en.search.optionsPromptNoMore);
  const context: OptionContext[] = options.map((o, i) => ({
    index: i + 1,
    price: o.snapshot.price,
    ...(o.snapshot.attributes.colour ? { colour: o.snapshot.attributes.colour } : {}),
    ...(o.displaySize ? { size: o.displaySize } : {}),
    title: o.snapshot.title,
  }));
  return { ...spoken(sentences), context };
}

function article(word: string): string {
  return /^[aeiou]/i.test(word) ? 'an' : 'a';
}

/** "a navy crew-neck sweater in size M under $40" */
export function describeQuery(q: ShoppingQuery): string {
  const adjectives = [q.colour, ...Object.values(q.attributes)].filter((x): x is string => !!x);
  let head: string;
  if (q.category) {
    const phrase = [...adjectives, q.category].join(' ');
    // "socks", "jeans" and "running shoes" take no article.
    head = /s$/.test(q.category) && q.category !== 'dress' ? phrase : `${article(phrase)} ${phrase}`;
  } else {
    head = [en.search.describe.anything, ...adjectives].join(' ');
  }
  const tail: string[] = [];
  if (q.size) tail.push(en.search.describe.inSize(q.size));
  if (q.maxPrice) tail.push(en.search.describe.under(q.maxPrice));
  if (q.minPrice) tail.push(en.search.describe.over(q.minPrice));
  if (q.freeReturns) tail.push(en.search.describe.withFreeReturns);
  return [head, ...tail].join(' ');
}

/** Round a suggested budget up to a whole $5. */
function suggestedBudget(max: Money): Money {
  const raised = Math.ceil((max.cents * 1.25) / 500) * 500;
  return { cents: raised, currency: max.currency };
}

/** What "yes" means after a "found none" question. The conductor turns each into a new search. */
export type NoneSuggestion =
  | { kind: 'max_price'; amount: Money; said: string }
  | { kind: 'any_colour'; said: string }
  | { kind: 'any_returns'; said: string }
  | { kind: 'different_words'; said: string }
  | { kind: 'something_else'; said: string };

export interface NonePresentation extends Spoken {
  /** The offers made in the question, in the order they were said. */
  suggestions: NoneSuggestion[];
  /** True when nothing in the catalog is the kind of thing asked for. */
  categoryMissing: boolean;
}

/**
 * True when no listing is the kind of thing asked for: every candidate the store returned was
 * another category, or it returned none. Not said when a price filter was set: the store may have
 * left out listings of that kind for their price, so the budget message is the honest one.
 */
function categoryMissing(query: ShoppingQuery, result?: Pick<RankResult, 'excluded'>): boolean {
  if (!query.category || !result || query.maxPrice || query.minPrice) return false;
  return result.excluded.every((e) => e.reason === 'wrong_category');
}

/**
 * "I couldn't find a navy crew-neck sweater in size M under $40. The closest one is $45. Want me
 * to try up to $45, or any colour?" At most two suggestions. When the store has nothing of that
 * kind at all, it says so plainly instead: "I couldn't find jeans in Demo Store. Want me to look
 * for something else?"
 */
export function presentNone(query: ShoppingQuery, result?: Pick<RankResult, 'excluded'>, opts: { store?: string } = {}): NonePresentation {
  if (categoryMissing(query, result)) {
    const somethingElse: NoneSuggestion = { kind: 'something_else', said: en.search.somethingElse };
    return {
      ...spoken([en.search.noneInCategory(categoryPlural(query.category!), opts.store), en.search.somethingElse]),
      suggestions: [somethingElse],
      categoryMissing: true,
    };
  }
  const sentences = [en.search.noneFound(describeQuery(query))];
  const suggestions: NoneSuggestion[] = [];
  const closest = result ? cheapestOverBudget({ options: [], total: 0, remaining: 0, excluded: result.excluded }) : undefined;
  if (closest) {
    sentences.push(en.search.closestOverBudget(closest));
    suggestions.push({ kind: 'max_price', amount: closest, said: en.search.suggestUpTo(closest) });
  } else if (query.maxPrice) {
    const raised = suggestedBudget(query.maxPrice);
    suggestions.push({ kind: 'max_price', amount: raised, said: en.search.suggestUpTo(raised) });
  }
  if (query.colour) suggestions.push({ kind: 'any_colour', said: en.search.suggestAnyColour });
  if (query.freeReturns) suggestions.push({ kind: 'any_returns', said: en.search.suggestAnyReturns });
  if (suggestions.length === 0) suggestions.push({ kind: 'different_words', said: en.search.suggestDifferentWords });
  const offered = suggestions.slice(0, 2);
  sentences.push(en.search.tryInstead(offered.map((x) => x.said)));
  return { ...spoken(sentences), suggestions: offered, categoryMissing: false };
}

/**
 * "Here's why I picked these. All three: Navy, as you asked. Size M is listed. One: $29, the
 * cheapest. Two: Rated 4.8 out of 5 from 40 reviews. ..." What every option shares is said once;
 * each option then gets what sets it apart, so no reason is read three times.
 */
export function presentWhy(options: Array<Pick<RankedOption, 'snapshot' | 'why' | 'caveats'>>): Spoken {
  const shown = options.slice(0, 3);
  const count = numberToWords(shown.length);
  const sentences = [en.search.whyIntro(count)];
  const positives = shown.map((o) => o.why.filter((w) => !o.caveats.includes(w)));
  if (shown.length === 1) {
    sentences.push(`${optionWord(1)}: ${[...positives[0]!.slice(0, 2), ...shown[0]!.caveats.slice(0, 1)].join(' ')}`);
    return spoken(sentences);
  }
  const everyone = (list: string[][]) => (list[0] ?? []).filter((w) => list.every((l) => l.includes(w)));
  const sharedReasons = everyone(positives);
  const sharedCaveats = everyone(shown.map((o) => o.caveats));
  const shared = [...sharedReasons.slice(0, 2), ...sharedCaveats.slice(0, 1)];
  if (shared.length > 0) sentences.push(en.search.whyShared(en.compare.all(count), shared));

  const prices = shown.map((o) => o.snapshot.price);
  const sameCurrency = prices.every((p) => p.currency === prices[0]!.currency);
  const minPrice = Math.min(...prices.map((p) => p.cents));
  const pricesDiffer = sameCurrency && prices.some((p) => p.cents !== prices[0]!.cents);
  const cheapestCount = prices.filter((p) => p.cents === minPrice).length;

  shown.forEach((o, i) => {
    // Price first: it is usually what sets options apart. The budget sentence already carries it.
    const own = positives[i]!
      .filter((w) => !sharedReasons.includes(w))
      .sort((a, b) => Number(b.includes(m(o.snapshot.price))) - Number(a.includes(m(o.snapshot.price))));
    const mentionsPrice = own.some((w) => w.includes(m(o.snapshot.price)));
    const price = pricesDiffer && !mentionsPrice ? [en.search.whyPrice(o.snapshot.price, o.snapshot.price.cents === minPrice && cheapestCount === 1)] : [];
    const caveat = o.caveats.filter((c) => !sharedCaveats.includes(c)).slice(0, 1);
    const parts = [...price, ...own].slice(0, 2).concat(caveat);
    sentences.push(`${optionWord(i + 1)}: ${parts.length > 0 ? parts.join(' ') : en.search.whyNothingElse}`);
  });
  return spoken(sentences);
}

// ---------------------------------------------------------------------------------------------
// Details (also the template fallback when the grounding guard gives up)

export function presentDetails(snapshot: ProductSnapshot, topic: DetailsTopic = 'general', verbosity: Verbosity = 'standard'): Spoken {
  const a = snapshot.attributes;
  const d = en.details;
  const colour = a.colour
    ? a.colourName && a.colourName.toLowerCase() !== a.colour.toLowerCase()
      ? d.colourNamed(a.colour.toLowerCase(), a.colourName)
      : d.colour(a.colour.toLowerCase())
    : a.colourName
      ? d.colourOnlyName(a.colourName)
      : d.colourMissing;
  const size = a.size ? d.size(a.size) : d.sizeMissing;
  const material = a.material ? d.material(a.material) : d.materialMissing;
  const rating = snapshot.rating && snapshot.rating.count > 0 ? d.rating(snapshot.rating.average, snapshot.rating.count) : d.ratingMissing;
  switch (topic) {
    case 'material':
      return spoken([material]);
    case 'returns':
      return spoken([returnsPhrase(snapshot.returnPolicy)]);
    case 'reviews':
      return spoken([rating, d.reviewsNotRead]);
    case 'sizing':
      return spoken([size, a.fit ? d.fit(a.fit) : d.sizingNoNotes]);
    case 'size_chart':
      return spoken([d.sizeChartMissing]);
    case 'care':
      return spoken([a.care ? d.care(a.care) : d.careMissing]);
    case 'shipping':
      return spoken([d.shippingUnknown]);
    case 'seller':
      return spoken([d.seller(snapshot.seller.name)]);
    case 'colour':
      return spoken([colour]);
    case 'fit':
      return spoken([a.fit ? d.fit(a.fit) : d.fitMissing]);
    case 'price':
      return spoken([d.price(snapshot.price)]);
    case 'general': {
      const base = [d.intro(snapshot.title, snapshot.seller.name), d.price(snapshot.price), colour, size];
      if (verbosity === 'brief') return spoken([...base, returnsPhrase(snapshot.returnPolicy)]);
      const extra = verbosity === 'detailed' ? [a.fit ? d.fit(a.fit) : d.fitMissing, a.care ? d.care(a.care) : d.careMissing] : [];
      return spoken([...base, material, ...extra, returnsPhrase(snapshot.returnPolicy), rating]);
    }
  }
}

// ---------------------------------------------------------------------------------------------
// Compare

export interface ComparisonRow {
  key: 'price' | 'colour' | 'size' | 'material' | 'returns' | 'rating';
  label: string;
  /** One display value per compared item, in order. */
  values: string[];
}

export interface Comparison extends Spoken {
  rows: ComparisonRow[];
}

const SUBJECTIVE_MATERIAL_ASPECTS = new Set(['softer', 'warmer', 'thicker', 'thinner', 'lighter', 'heavier', 'nicer']);

function rowsFor(aspect: string | undefined): ComparisonRow['key'][] {
  const all: ComparisonRow['key'][] = ['price', 'colour', 'size', 'material', 'returns', 'rating'];
  if (!aspect) return all;
  const a = aspect.toLowerCase();
  if (a === 'price' || a === 'cheaper' || a === 'more expensive') return ['price'];
  if (a === 'colour' || a === 'color') return ['colour'];
  if (a === 'size' || a === 'bigger' || a === 'smaller' || a === 'longer' || a === 'shorter') return ['size'];
  if (a === 'returns') return ['returns'];
  if (a === 'rating' || a === 'ratings' || a === 'reviews' || a === 'better') return ['rating'];
  if (a === 'material' || SUBJECTIVE_MATERIAL_ASPECTS.has(a)) return ['material'];
  return all;
}

/** Word budget for a spoken comparison of up to three options, by verbosity. Detailed has none. */
const COMPARE_WORD_BUDGET: Record<Verbosity, number> = { brief: 40, standard: 60, detailed: Infinity };

/** Rows dropped first when a comparison runs long, and the aspect name the grammar understands. */
const DROP_ORDER: Array<{ key: ComparisonRow['key']; aspect: string }> = [
  { key: 'rating', aspect: 'ratings' },
  { key: 'returns', aspect: 'returns' },
  { key: 'material', aspect: 'material' },
];

const wordCount = (sentences: string[]): number => sentences.join(' ').split(/\s+/).filter(Boolean).length;

/**
 * Structured comparison of two or three options. `labels` are the numbers the user heard
 * ("one", "three"). Only listing data is compared; subjective aspects say so. Spoken text leads
 * with what differs, then says once what every option shares ("All three are navy, size M."), and
 * keeps to about 60 words at standard verbosity; detailed says everything.
 */
export function presentComparison(
  items: Array<{ label: number; snapshot: ProductSnapshot }>,
  aspect?: string,
  verbosity: Verbosity = 'standard',
): Comparison {
  const shown = items.slice(0, 3);
  const who = shown.map((i) => numberToWords(i.label));
  const keys = rowsFor(aspect);
  const L = en.compare.labels;
  const detailed = verbosity === 'detailed';
  const isMissing = (key: ComparisonRow['key'], s: ProductSnapshot): boolean =>
    (key === 'colour' && !s.attributes.colour) ||
    (key === 'size' && !s.attributes.size) ||
    (key === 'material' && !s.attributes.material) ||
    (key === 'returns' && returnsShort(s.returnPolicy) === 'return policy not given') ||
    (key === 'rating' && !(s.rating && s.rating.count > 0));
  const rows: ComparisonRow[] = keys.map((key) => ({
    key,
    label: L[key],
    values: shown.map(({ snapshot: s }) => {
      switch (key) {
        case 'price':
          return m(s.price);
        case 'colour':
          return s.attributes.colour?.toLowerCase() ?? en.details.listingDoesntSay;
        case 'size':
          return s.attributes.size ?? en.details.listingDoesntSay;
        case 'material':
          return s.attributes.material ?? en.details.listingDoesntSay;
        case 'returns':
          return returnsShort(s.returnPolicy);
        case 'rating':
          return s.rating && s.rating.count > 0 ? en.compare.ratingValue(s.rating.average, s.rating.count) : en.compare.noRating;
      }
    }),
  }));

  /** The spoken value: shorter ratings unless detailed. */
  const spokenValue = (key: ComparisonRow['key'], s: ProductSnapshot, v: string): string =>
    key === 'rating' && !detailed && s.rating && s.rating.count > 0 ? en.compare.ratingShort(s.rating.average, s.rating.count) : v;

  /** "Material: one is cotton, two and three are wool." Options with the same value are grouped. */
  const rowSentence = (row: ComparisonRow): string => {
    const groups: Array<{ value: string; missing: boolean; idx: number[] }> = [];
    row.values.forEach((v, i) => {
      const missing = isMissing(row.key, shown[i]!.snapshot);
      const g = groups.find((x) => x.value === v && x.missing === missing);
      if (g) g.idx.push(i);
      else groups.push({ value: v, missing, idx: [i] });
    });
    const phrases = groups.map((g) => {
      const names = joinAnd(g.idx.map((i) => who[i]!));
      const many = g.idx.length > 1;
      if (g.missing && row.key !== 'rating') return many ? en.compare.valuesMissing(names) : en.compare.valueMissing(names);
      const v = spokenValue(row.key, shown[g.idx[0]!]!.snapshot, g.value);
      if (row.key === 'returns' || row.key === 'rating') return many ? en.compare.valueHave(names, v) : en.compare.valueHas(names, v);
      return many ? en.compare.valueAre(names, v) : en.compare.valueIs(names, v);
    });
    return en.compare.row(row.label, phrases.join(', '));
  };

  const prices = shown.map((i) => i.snapshot.price);
  const sameCurrency = prices.every((p) => p.currency === prices[0]!.currency);
  const priceVerdict = (): string | null => {
    if (!keys.includes('price') || shown.length < 2 || !sameCurrency) return null;
    if (shown.length === 2) {
      const diff = prices[0]!.cents - prices[1]!.cents;
      if (diff === 0) return null;
      return en.compare.cheaperBy(diff > 0 ? who[1]! : who[0]!, { cents: Math.abs(diff), currency: prices[0]!.currency });
    }
    const min = Math.min(...prices.map((p) => p.cents));
    const cheapest = prices.map((p, i) => (p.cents === min ? i : -1)).filter((i) => i >= 0);
    return cheapest.length === 1 ? en.compare.cheapest(who[cheapest[0]!]!, prices[cheapest[0]!]!) : null;
  };

  const lead = [en.compare.intro(joinAnd(who))];
  if (aspect && SUBJECTIVE_MATERIAL_ASPECTS.has(aspect.toLowerCase())) lead.push(en.compare.cantFeel(aspect.toLowerCase()));

  const allSame = (row: ComparisonRow) =>
    shown.length > 1 && row.values.every((v, i) => v === row.values[0] && isMissing(row.key, shown[i]!.snapshot) === isMissing(row.key, shown[0]!.snapshot));
  const differing = rows.filter((r) => !allSame(r));
  const same = rows.filter((r) => allSame(r));

  // What every option shares, in one sentence: "All three are navy, size M, with free returns for 30 days."
  const all = en.compare.all(numberToWords(shown.length));
  const sameSentences: string[] = [];
  const be: string[] = [];
  const withs: string[] = [];
  for (const row of same) {
    const first = shown[0]!.snapshot;
    if (isMissing(row.key, first)) {
      sameSentences.push(en.compare.noneGive(en.compare.fieldNames[row.key]));
      continue;
    }
    const v = spokenValue(row.key, first, row.values[0]!);
    if (row.key === 'price') sameSentences.push(en.compare.sameCost(all, first.price));
    else if (row.key === 'colour') be.push(v);
    else if (row.key === 'size') be.push(en.compare.sizeValue(v));
    else if (row.key === 'material') be.push(en.compare.materialValue(v));
    else withs.push(row.key === 'rating' && !detailed ? `a rating of ${v}` : v);
  }
  if (be.length > 0) sameSentences.unshift(withs.length > 0 ? en.compare.sameAreWith(all, be.join(', '), joinAnd(withs)) : en.compare.sameAre(all, be.join(', ')));
  else if (withs.length > 0) sameSentences.unshift(en.compare.sameHave(all, joinAnd(withs)));

  const verdict = priceVerdict();
  const compose = (rowsToSay: ComparisonRow[], dropped: string[]): string[] => [
    ...lead,
    ...rowsToSay.flatMap((r) => (r.key === 'price' && verdict ? [rowSentence(r), verdict] : [rowSentence(r)])),
    ...sameSentences,
    ...(dropped.length > 0 ? [en.compare.askMore(dropped)] : []),
  ];

  // Keep it short: drop the least useful differing rows first, and say how to hear them.
  const budget = COMPARE_WORD_BUDGET[verbosity];
  let kept = differing;
  const dropped: string[] = [];
  for (const d of DROP_ORDER) {
    if (wordCount(compose(kept, dropped)) <= budget) break;
    if (!kept.some((r) => r.key === d.key) || kept.length <= 1) continue;
    kept = kept.filter((r) => r.key !== d.key);
    dropped.unshift(d.aspect);
  }
  return { ...spoken(compose(kept, dropped)), rows };
}

// ---------------------------------------------------------------------------------------------
// Unboxing verdicts

export interface VerdictOptions {
  /** "sweater", from the order's category. */
  productNoun?: string;
  /** Trusted helper's first name, offered when unsure. */
  helperName?: string;
  /** The photo was dim; less-sure colour findings say so. */
  lowLight?: boolean;
  /** Pay-after-check order: say whether the payment was completed or cancelled. */
  payAfterCheck?: boolean;
}

const CONFIDENCE_ORDER: Record<Confidence, number> = { sure: 0, fairly_sure: 1, not_sure: 2 };

function disagreeSentence(r: VerdictReason, noun: string): string {
  const exp = r.expected ?? '';
  const obs = r.observed ?? '';
  switch (r.module) {
    case 'size':
      return en.check.sizeDisagree(obs, exp);
    case 'colour':
      return en.check.colourDisagree(obs.toLowerCase(), exp.toLowerCase());
    case 'identity':
      return en.check.identityDisagree(noun, r.observed);
    case 'damage':
      return en.check.damage(r.observed);
    case 'quality':
      return en.check.qualityDisagree(r.observed);
  }
}

function withConfidence(sentence: string, r: VerdictReason, lowLight: boolean): string {
  if (r.confidence !== 'sure' && lowLight && (r.module === 'colour' || r.module === 'quality'))
    return `${sentence.replace(/\.$/, '')}, ${en.check.lessSureDim}.`;
  return `${sentence} ${confidenceSentence(r.confidence)}`;
}

function moduleName(module: CheckModule): string {
  return en.check.moduleNames[module] ?? module;
}

/**
 * Speak an unboxing verdict from its reasons, sure findings first:
 * "This doesn't match. The size tag reads L, you ordered M. I'm sure about that. The colour looks
 * black, not navy, but the light is dim so I'm less sure. Want me to get your money back?"
 */
export function presentVerdict(verdict: Verdict, opts: VerdictOptions = {}): Spoken {
  const noun = opts.productNoun ?? en.check.defaultNoun;
  const lowLight = opts.lowLight ?? false;
  const reasons = [...verdict.reasons].sort((a, b) => CONFIDENCE_ORDER[a.confidence] - CONFIDENCE_ORDER[b.confidence]);

  if (verdict.kind === 'match') {
    const agree = verdict.reasons.filter((r) => r.finding === 'agree');
    const parts: string[] = [];
    const colour = agree.find((r) => r.module === 'colour');
    const size = agree.find((r) => r.module === 'size');
    const identity = agree.find((r) => r.module === 'identity');
    if (colour) parts.push((colour.expected ?? colour.observed ?? '').toLowerCase());
    if (size) parts.push(en.check.matchSize(size.expected ?? size.observed ?? ''));
    if (identity) parts.push(en.check.matchSame(noun));
    const head = parts.filter((p) => p.trim().length > 0).length > 0 ? `${en.check.matchPartsLead}${parts.filter((p) => p.trim()).join(', ')}.` : en.check.matchGeneric;
    return spoken([head, opts.payAfterCheck ? en.check.payAfterCheckCaptured : en.check.enjoy]);
  }

  if (verdict.kind === 'mismatch') {
    const sentences: string[] = [en.check.mismatchHeadline];
    for (const r of reasons.filter((x) => x.finding === 'disagree')) sentences.push(withConfidence(disagreeSentence(r, noun), r, lowLight));
    sentences.push(opts.payAfterCheck ? en.check.payAfterCheckVoided : en.check.offerMoneyBack);
    return spoken(sentences);
  }

  // Unsure
  const sentences: string[] = [];
  const doubtful = reasons.filter((r) => r.confidence !== 'sure' || r.finding === 'unknown');
  const lead = doubtful.find((r) => r.module === 'colour' && r.expected && r.observed) ?? doubtful[0];
  if (lead?.module === 'colour' && lead.expected && lead.observed) sentences.push(en.check.unsureBetween(lead.expected.toLowerCase(), lead.observed.toLowerCase()));
  else if (lead) sentences.push(en.check.unsureAbout(moduleName(lead.module)));
  else sentences.push(en.check.unsureHeadline);
  for (const r of reasons.filter((x) => x.finding === 'disagree' && x.confidence === 'sure')) sentences.push(withConfidence(disagreeSentence(r, noun), r, lowLight));
  const steps: string[] = [];
  if (opts.helperName) steps.push(en.check.askHelper(opts.helperName));
  if (lowLight || lead?.module === 'colour') steps.push(en.check.tryDaylight);
  if (steps.length > 0) sentences.push(`${capitalise(steps.join(', or '))}.`);
  else sentences.push(en.check.tryAgainLater);
  return spoken(sentences);
}

// ---------------------------------------------------------------------------------------------
// Cases

export type CaseUpdate =
  | { kind: 'sent'; merchant: string; deadline: Date; now: Date }
  | {
      kind: 'offer';
      merchant: string;
      offer: 'full_refund' | 'partial_refund' | 'replacement';
      amount?: Money;
      returnRequired: boolean;
      itemNoun?: string;
      labelInEmail?: boolean;
    }
  | { kind: 'no_reply'; merchant: string }
  | { kind: 'escalated' }
  | { kind: 'refunded'; amount: Money }
  | { kind: 'seller_won'; merchant: string }
  | { kind: 'declined'; merchant: string };

function dayDiff(a: Date, b: Date): number {
  const da = Date.UTC(a.getUTCFullYear(), a.getUTCMonth(), a.getUTCDate());
  const db = Date.UTC(b.getUTCFullYear(), b.getUTCMonth(), b.getUTCDate());
  return Math.round((da - db) / 86_400_000);
}

/** "Friday" within the coming week, otherwise "Tuesday 17 November". */
export function deadlinePhrase(deadline: Date, now: Date): string {
  const days = dayDiff(deadline, now);
  if (days >= 0 && days <= 6) return new Intl.DateTimeFormat('en-US', { weekday: 'long', timeZone: 'UTC' }).format(deadline);
  return spokenDate(deadline);
}

export function presentCaseUpdate(update: CaseUpdate, verbosity: Verbosity = 'standard'): Spoken {
  const c = en.cases;
  switch (update.kind) {
    case 'sent':
      return spoken([c.sent(update.merchant, deadlinePhrase(update.deadline, update.now))]);
    case 'offer': {
      const noun = update.itemNoun ?? en.check.defaultNoun;
      let lead: string;
      if (update.offer === 'replacement') lead = c.offerReplacement(update.merchant, noun);
      else if (update.offer === 'partial_refund') lead = c.offerPartialRefund(update.merchant, update.amount ?? { cents: 0, currency: 'USD' });
      else lead = c.offerFullRefund(update.merchant, update.amount ?? { cents: 0, currency: 'USD' });
      const tail = update.returnRequired ? c.ifSendBack(noun) : update.offer === 'replacement' ? '.' : c.keepIt(noun);
      const sentences = [`${lead}${tail}`];
      if (update.returnRequired && update.labelInEmail) sentences.push(c.returnLabel);
      sentences.push(c.acceptPrompt);
      if (verbosity === 'detailed') sentences.push(c.declinePrompt);
      return spoken(sentences);
    }
    case 'no_reply':
      return spoken([c.noReply(update.merchant)]);
    case 'escalated':
      return spoken([c.escalated]);
    case 'refunded':
      return spoken([c.refunded(update.amount)]);
    case 'seller_won':
      return spoken([c.sellerWon(update.merchant)]);
    case 'declined':
      return spoken([c.declined(update.merchant)]);
  }
}

/** A store's offer on an open case, in the buyer's terms. */
export type OfferKind = 'refund' | 'refund_with_return' | 'replacement' | 'refund_with_replacement' | 'partial_refund';

export interface OfferChoice {
  merchant: string;
  kind: OfferKind;
  /** The amount offered back: the full price, or the part for "keep it for less". */
  amount?: Money;
  /** "sweater", from the order's category. */
  itemNoun?: string;
  /** What the order cost. Needed for a part refund. */
  paid?: Money;
  /** PayPal still holds the money: nothing is refunded, the hold is released or partly taken. */
  held?: boolean;
  /** The store's own agent made the offer, inside the store's policy. */
  byAgent?: boolean;
  /** The agent's reasons, checked against the case's facts before they were stored. */
  reasons?: string[];
}

/**
 * Read an offer like a readback before the buyer answers it: what was offered, why (when the
 * store's agent made it), what accepting means, that it can't be undone, and how to answer.
 * "Demo Store offered to send a replacement sweater. If you accept, Demo Store sends a new sweater
 * and your case closes. You don't get money back. You can't undo accepting. Say 'accept' to
 * accept the offer, or 'decline' to say no. Nothing changes until you choose."
 */
export function presentOfferChoice(o: OfferChoice): Spoken {
  const noun = o.itemNoun ?? en.check.defaultNoun;
  const amount = o.amount ?? { cents: 0, currency: 'USD' };
  const c = en.cases;
  const f = en.offers;
  const who = o.byAgent ? f.agentOf(o.merchant) : o.merchant;
  let lead: string;
  let means: string;
  switch (o.kind) {
    case 'refund':
      lead = `${c.offerFullRefund(who, amount)}${c.keepIt(noun)}`;
      means = f.meansRefund(o.merchant, amount);
      break;
    case 'refund_with_return':
      // A hold is released, never refunded: nothing was taken.
      lead = o.held ? f.releaseIfSendBack(who, amount, noun) : `${c.offerFullRefund(who, amount)}${c.ifSendBack(noun)}`;
      means = o.held ? f.meansReturnHeld(o.merchant, amount, noun) : f.meansReturn(o.merchant, amount, noun);
      break;
    case 'replacement':
      lead = `${c.offerReplacement(who, noun)}.`;
      means = f.meansReplacement(o.merchant, noun);
      break;
    case 'refund_with_replacement':
      lead = f.refundAndReplacement(who, amount, noun);
      means = f.meansRefundAndReplacement(o.merchant, amount, noun);
      break;
    case 'partial_refund': {
      const paid = o.paid ?? amount;
      const rest: Money = { cents: paid.cents - amount.cents, currency: paid.currency };
      lead = o.held ? f.takeOff(who, amount, noun) : `${c.offerPartialRefund(who, amount)}${c.keepIt(noun)}`;
      means = o.held ? f.meansKeepForLessHeld(rest, paid, amount, noun) : f.meansKeepForLess(o.merchant, amount, paid, noun);
      break;
    }
  }
  const why = o.reasons?.length ? [f.reasonsLead(o.reasons[0]!), ...o.reasons.slice(1)] : [];
  return spoken([lead, ...why, means, f.cantUndo, en.help.offer]);
}

/** What happens next once the buyer has answered. */
export function presentOfferAnswer(o: OfferChoice & { answer: 'accept' | 'decline' }): Spoken {
  const noun = o.itemNoun ?? en.check.defaultNoun;
  const amount = o.amount ?? { cents: 0, currency: 'USD' };
  const f = en.offers;
  if (o.answer === 'decline') return spoken([f.declined(o.merchant)]);
  switch (o.kind) {
    case 'refund':
    case 'refund_with_replacement':
      return spoken([f.acceptedRefund(amount)]);
    case 'refund_with_return':
      return spoken([o.held ? f.acceptedReturnHeld(o.merchant, amount, noun) : f.acceptedReturn(o.merchant, amount, noun)]);
    case 'replacement':
      return spoken([f.acceptedReplacement(o.merchant, noun)]);
    case 'partial_refund': {
      const paid = o.paid ?? amount;
      const rest: Money = { cents: paid.cents - amount.cents, currency: paid.currency };
      return spoken([o.held ? f.acceptedKeepForLessHeld(o.merchant, rest, amount, noun) : f.acceptedKeepForLess(o.merchant, amount, noun)]);
    }
  }
}

// ---------------------------------------------------------------------------------------------
// Money timeline and payment

export interface MoneyEvent {
  kind: 'paid' | 'authorised' | 'voided' | 'refunded' | 'case_opened' | 'deadline';
  merchant: string;
  amount?: Money;
  at: Date;
}

function whenPhrase(at: Date, now: Date): string {
  const days = dayDiff(now, at);
  if (days === 0) return en.money.today;
  if (days === 1) return en.money.yesterday;
  if (days > 1 && days <= 6) return en.money.on(new Intl.DateTimeFormat('en-US', { weekday: 'long', timeZone: 'UTC' }).format(at));
  return en.money.on(spokenDate(at));
}

export interface TimelinePresentation extends Spoken {
  remaining: number;
}

/**
 * "Where is my money?" Upcoming deadlines first, then events newest first, three at a time.
 */
export function presentMoneyTimeline(events: MoneyEvent[], opts: { now: Date; offset?: number; limit?: number }): TimelinePresentation {
  const limit = Math.min(3, opts.limit ?? 3);
  const offset = opts.offset ?? 0;
  if (events.length === 0) return { ...spoken([en.money.nothingYet]), remaining: 0 };
  const upcoming = events.filter((e) => e.kind === 'deadline' && e.at.getTime() >= opts.now.getTime()).sort((a, b) => a.at.getTime() - b.at.getTime());
  const past = events.filter((e) => e.kind !== 'deadline').sort((a, b) => b.at.getTime() - a.at.getTime());
  const ordered = [...upcoming, ...past];
  const page = ordered.slice(offset, offset + limit);
  const zero: Money = { cents: 0, currency: 'USD' };
  const sentences = page.map((e) => {
    const when = whenPhrase(e.at, opts.now);
    switch (e.kind) {
      case 'paid':
        return en.money.paid(when, e.merchant, e.amount ?? zero);
      case 'authorised':
        return en.money.authorised(when, e.merchant, e.amount ?? zero);
      case 'voided':
        return en.money.voided(when, e.merchant, e.amount ?? zero);
      case 'refunded':
        return en.money.refunded(when, e.merchant, e.amount ?? zero);
      case 'case_opened':
        return en.money.caseOpened(when, e.merchant);
      case 'deadline':
        return en.money.deadline(e.merchant, deadlinePhrase(e.at, opts.now));
    }
  });
  const remaining = Math.max(0, ordered.length - offset - page.length);
  if (remaining > 0) sentences.push(en.money.olderPrompt);
  return { ...spoken(sentences), remaining };
}

export function presentPaid(p: { total: Money; merchant: string; authorised?: boolean }): Spoken {
  return spoken([p.authorised ? en.payment.authorised(p.total, p.merchant) : en.payment.paid(p.total, p.merchant)]);
}
