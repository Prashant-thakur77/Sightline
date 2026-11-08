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
import { CATEGORIES, categoryOf } from './lexicon';
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

function optionParts(o: RankedOption, verbosity: Verbosity, query?: ShoppingQuery): string[] {
  const s = o.snapshot;
  const title = shortTitle(s.title, query?.category ?? categoryOf(s.category ?? s.title)?.canonical);
  const colour = s.attributes.colour?.trim().toLowerCase() || en.search.colourNotGiven;
  const parts = [title, colour];
  if (verbosity !== 'brief' && isSized(o, query)) {
    if (o.sizeInStock && o.displaySize) parts.push(en.search.sizeInStock(o.displaySize));
    else if (o.displaySize) parts.push(en.search.size(o.displaySize));
    else parts.push(en.search.sizeNotGiven);
  }
  parts.push(m(s.price));
  if (verbosity !== 'brief') parts.push(returnsShort(s.returnPolicy));
  if (verbosity === 'detailed' && s.rating && s.rating.count > 0) parts.push(en.search.rated(s.rating.average, s.rating.count));
  return parts;
}

export interface OptionsPresentation extends Spoken {
  /** What the grammar needs to resolve "two" or "the cheaper one" next turn. */
  context: OptionContext[];
}

/**
 * "I found three. One: Harbor knit crew-neck, navy, size M in stock, $34, free returns for 30 days.
 * Two: ... Say a number for details, 'compare' to compare, or 'more' for other options."
 * Options are numbered from one on every page so "say a number" always means what was just read.
 */
export function presentOptions(
  result: Pick<RankResult, 'options' | 'remaining'>,
  opts: { query?: ShoppingQuery; verbosity?: Verbosity; firstPage?: boolean } = {},
): OptionsPresentation {
  const verbosity = opts.verbosity ?? 'standard';
  const options = result.options.slice(0, 3);
  if (options.length === 0) return { ...spoken([en.search.noneFoundGeneric]), context: [] };
  const count = numberToWords(options.length);
  const sentences = [opts.firstPage === false ? en.search.moreCount(count) : en.search.foundCount(count)];
  options.forEach((o, i) => sentences.push(en.search.option(optionWord(i + 1), optionParts(o, verbosity, opts.query))));
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
    head = `${article(phrase)} ${phrase}`;
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

/**
 * "I couldn't find a navy crew-neck sweater in size M under $40. The closest one is $45. Want me
 * to try up to $45, or any colour?" At most two suggestions.
 */
export function presentNone(query: ShoppingQuery, result?: Pick<RankResult, 'excluded'>): Spoken {
  const sentences = [en.search.noneFound(describeQuery(query))];
  const suggestions: string[] = [];
  const closest = result ? cheapestOverBudget({ options: [], total: 0, remaining: 0, excluded: result.excluded }) : undefined;
  if (closest) {
    sentences.push(en.search.closestOverBudget(closest));
    suggestions.push(en.search.suggestUpTo(closest));
  } else if (query.maxPrice) {
    suggestions.push(en.search.suggestUpTo(suggestedBudget(query.maxPrice)));
  }
  if (query.colour) suggestions.push(en.search.suggestAnyColour);
  if (query.freeReturns) suggestions.push(en.search.suggestAnyReturns);
  if (suggestions.length === 0) suggestions.push(en.search.suggestDifferentWords);
  sentences.push(en.search.tryInstead(suggestions.slice(0, 2)));
  return spoken(sentences);
}

/** "Here's why I picked these. One: Navy, as you asked. Free returns for 30 days. ..." */
export function presentWhy(options: RankedOption[]): Spoken {
  const shown = options.slice(0, 3);
  const sentences = [en.search.whyIntro(numberToWords(shown.length))];
  shown.forEach((o, i) => {
    const positives = o.why.filter((w) => !o.caveats.includes(w)).slice(0, 2);
    const caveat = o.caveats.slice(0, 1);
    sentences.push(`${optionWord(i + 1)}: ${[...positives, ...caveat].join(' ')}`);
  });
  return spoken(sentences);
}

// ---------------------------------------------------------------------------------------------
// Details (also the template fallback when the grounding guard gives up)

export function presentDetails(snapshot: ProductSnapshot, topic: DetailsTopic = 'general', verbosity: Verbosity = 'standard'): Spoken {
  const a = snapshot.attributes;
  const d = en.details;
  const colour = a.colour ? d.colour(a.colour.toLowerCase()) : d.colourMissing;
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

/**
 * Structured comparison of two or three options. `labels` are the numbers the user heard
 * ("one", "three"). Only listing data is compared; subjective aspects say so.
 */
export function presentComparison(items: Array<{ label: number; snapshot: ProductSnapshot }>, aspect?: string): Comparison {
  const shown = items.slice(0, 3);
  const who = shown.map((i) => numberToWords(i.label));
  const keys = rowsFor(aspect);
  const L = en.compare.labels;
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

  const sentences = [en.compare.intro(joinAnd(who))];
  if (aspect && SUBJECTIVE_MATERIAL_ASPECTS.has(aspect.toLowerCase())) sentences.push(en.compare.cantFeel(aspect.toLowerCase()));
  for (const row of rows) {
    const phrases = shown.map(({ snapshot: s }, i) => {
      const w = who[i]!;
      const v = row.values[i]!;
      const missing =
        (row.key === 'colour' && !s.attributes.colour) ||
        (row.key === 'size' && !s.attributes.size) ||
        (row.key === 'material' && !s.attributes.material);
      if (missing) return en.compare.valueMissing(w);
      if (row.key === 'returns') return v === 'return policy not given' ? en.compare.valueMissing(w) : en.compare.valueHas(w, v);
      if (row.key === 'rating') return v === en.compare.noRating ? en.compare.valueHas(w, v) : en.compare.valueIs(w, v);
      return en.compare.valueIs(w, v);
    });
    sentences.push(en.compare.row(row.label, phrases.join(', ')));
  }
  if (keys.includes('price') && shown.length >= 2) {
    const prices = shown.map((i) => i.snapshot.price);
    const sameCurrency = prices.every((p) => p.currency === prices[0]!.currency);
    if (sameCurrency) {
      if (shown.length === 2) {
        const diff = prices[0]!.cents - prices[1]!.cents;
        if (diff === 0) sentences.push(en.compare.samePrice);
        else sentences.push(en.compare.cheaperBy(diff > 0 ? who[1]! : who[0]!, { cents: Math.abs(diff), currency: prices[0]!.currency }));
      } else {
        const min = Math.min(...prices.map((p) => p.cents));
        const cheapest = prices.map((p, i) => (p.cents === min ? i : -1)).filter((i) => i >= 0);
        if (cheapest.length === 1) sentences.push(en.compare.cheapest(who[cheapest[0]!]!, prices[cheapest[0]!]!));
      }
    }
  }
  return { ...spoken(sentences), rows };
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
