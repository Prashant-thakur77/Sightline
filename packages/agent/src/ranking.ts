/**
 * Explainable product ranking. Every point a listing gains or loses comes with a plain sentence,
 * so "why these?" can be answered from the same numbers that ordered the list. At most three
 * options are returned at a time.
 */
import type { Money, ProductSnapshot } from '@sightline/core';
import { en } from './copy/en';
import type { ShoppingQuery } from './grammar';
import {
  FITS,
  NECKLINES,
  PATTERNS,
  SLEEVES,
  categoryOf,
  colourSupport,
  findPhrases,
  materialSupport,
  sameSize,
  type LexEntry,
} from './lexicon';
import { joinOr, words } from './text';

export interface Candidate {
  snapshot: ProductSnapshot;
  /** Sizes in stock for this listing, when known. */
  availableSizes?: string[];
  inStock?: boolean;
  /** Checkout barrier score from the Barrier Index: 0 (none) to 1 (severe). */
  barrierScore?: number;
}

export interface RankInput {
  candidates: Candidate[];
  query: ShoppingQuery;
  avoidColours?: string[];
  /** Options per page, at most 3. */
  limit?: number;
  /** Skip this many ranked options (for "more"). */
  offset?: number;
}

export type MissingField = 'colour' | 'size' | 'images';

export interface RankedOption {
  /** 1-based rank across all eligible candidates. */
  rank: number;
  snapshot: ProductSnapshot;
  score: number;
  /** Spoken on "why these?": reasons for, then caveats. */
  why: string[];
  /** The caveats within why, kept apart so presentation can lead with the reasons. */
  caveats: string[];
  /** Colour, size (when the category is sized) and photos are listed, so the unboxing check can verify it. */
  verifiable: boolean;
  missing: MissingField[];
  /** True or false when the requested size's stock is known. */
  sizeInStock?: boolean;
  /** The size that the option list should mention. */
  displaySize?: string;
}

export type ExclusionReason = 'over_budget' | 'under_minimum' | 'out_of_stock' | 'size_sold_out' | 'returns_not_free';

export interface ExcludedCandidate {
  snapshot: ProductSnapshot;
  reason: ExclusionReason;
  detail: string;
}

export interface RankResult {
  options: RankedOption[];
  /** Eligible candidates in total. */
  total: number;
  /** Eligible candidates after this page. */
  remaining: number;
  excluded: ExcludedCandidate[];
}

/** Score weights, in one place so they can be tuned and explained. */
export const WEIGHTS = {
  categoryMatch: 3,
  categoryMismatch: -2,
  colourMatch: 3,
  colourMismatch: -4,
  sizeMatch: 2,
  sizeMismatch: -3,
  attributeMatch: 1,
  attributeMismatch: -1,
  withinBudget: 1,
  budgetHeadroom: 1,
  freeReturns: 1.5,
  returnWindow30: 1,
  returnWindow60: 0.5,
  noReturnPolicy: -1,
  ratingScale: 1,
  verifiable: 2,
  notVerifiable: -3,
  avoidColour: -5,
  barrier: -2,
} as const;

const ATTRIBUTE_LEXICONS: Record<string, LexEntry[]> = {
  neckline: NECKLINES,
  fit: FITS,
  sleeve: SLEEVES,
  pattern: PATTERNS,
};

function round(n: number): number {
  return Math.round(n * 1000) / 1000;
}

function listingCategory(s: ProductSnapshot) {
  return (s.category ? categoryOf(s.category) : undefined) ?? categoryOf(s.title);
}

function attributeSupport(s: ProductSnapshot, key: string): Set<string> {
  if (key === 'material') return materialSupport(s.attributes.material ?? s.title);
  const lex = ATTRIBUTE_LEXICONS[key];
  if (!lex) return new Set();
  const text = `${s.attributes[key] ?? ''} ${s.title}`;
  return new Set(findPhrases(words(text), lex).map((m) => m.canonical));
}

interface Scored {
  candidate: Candidate;
  score: number;
  why: string[];
  caveats: string[];
  verifiable: boolean;
  missing: MissingField[];
  sizeInStock?: boolean;
  displaySize?: string;
}

function scoreCandidate(c: Candidate, input: RankInput): Scored | ExcludedCandidate {
  const s = c.snapshot;
  const q = input.query;
  const why: string[] = [];
  const caveats: string[] = [];
  let score = 0;

  if (c.inStock === false) return { snapshot: s, reason: 'out_of_stock', detail: en.why.excluded.outOfStock };

  // Price
  if (q.maxPrice && q.maxPrice.currency === s.price.currency && s.price.cents > q.maxPrice.cents)
    return { snapshot: s, reason: 'over_budget', detail: en.why.excluded.overBudget(s.price, q.maxPrice) };
  if (q.minPrice && q.minPrice.currency === s.price.currency && s.price.cents < q.minPrice.cents)
    return { snapshot: s, reason: 'under_minimum', detail: en.why.excluded.underMin(s.price, q.minPrice) };
  if (q.freeReturns && s.returnPolicy?.free !== true)
    return { snapshot: s, reason: 'returns_not_free', detail: en.why.excluded.notFreeReturns };

  // Size stock
  let sizeInStock: boolean | undefined;
  let displaySize: string | undefined = s.attributes.size;
  if (q.size) {
    if (c.availableSizes) {
      sizeInStock = c.availableSizes.some((x) => sameSize(x, q.size));
      if (!sizeInStock) return { snapshot: s, reason: 'size_sold_out', detail: en.why.excluded.sizeSoldOut(q.size) };
      score += WEIGHTS.sizeMatch;
      why.push(en.why.sizeInStock(q.size));
      displaySize = q.size;
    } else if (s.attributes.size) {
      if (sameSize(s.attributes.size, q.size)) {
        score += WEIGHTS.sizeMatch;
        why.push(en.why.sizeListed(q.size));
      } else {
        score += WEIGHTS.sizeMismatch;
        caveats.push(en.why.sizeMismatch(s.attributes.size, q.size));
      }
    }
  }

  // Category
  const cat = listingCategory(s);
  if (q.category) {
    if (cat?.canonical === q.category) score += WEIGHTS.categoryMatch;
    else if (cat) {
      score += WEIGHTS.categoryMismatch;
      caveats.push(en.why.categoryMismatch(q.category));
    }
  }

  // Colour
  const colours = colourSupport(s.attributes.colour);
  if (q.colour) {
    if (colours.has(q.colour)) {
      score += WEIGHTS.colourMatch;
      why.push(en.why.colourMatch(q.colour));
    } else if (s.attributes.colour) {
      score += WEIGHTS.colourMismatch;
      caveats.push(en.why.colourMismatch(s.attributes.colour.toLowerCase(), q.colour));
    }
  }
  const avoided = (input.avoidColours ?? []).map((a) => a.toLowerCase()).find((a) => colours.has(a));
  if (avoided) {
    score += WEIGHTS.avoidColour;
    caveats.push(en.why.avoidColour(avoided));
  }

  // Other attributes
  for (const [key, wanted] of Object.entries(q.attributes)) {
    const support = attributeSupport(s, key);
    if (support.has(wanted)) {
      score += WEIGHTS.attributeMatch;
      why.push(en.why.attributeMatch(wanted));
    } else if (support.size > 0) {
      score += WEIGHTS.attributeMismatch;
      caveats.push(en.why.attributeMismatch(wanted));
    }
  }

  // Budget
  if (q.maxPrice) {
    if (q.maxPrice.currency !== s.price.currency) caveats.push(en.why.otherCurrency(s.price.currency));
    else {
      score += WEIGHTS.withinBudget + WEIGHTS.budgetHeadroom * ((q.maxPrice.cents - s.price.cents) / Math.max(q.maxPrice.cents, 1));
      why.push(en.why.underBudget(s.price, q.maxPrice));
    }
  }

  // Returns
  const rp = s.returnPolicy;
  if (!rp || (rp.windowDays === undefined && rp.free === undefined)) {
    score += WEIGHTS.noReturnPolicy;
    caveats.push(en.why.noReturnPolicy);
  } else {
    if (rp.free === true) {
      score += WEIGHTS.freeReturns;
      why.push(en.why.freeReturns(rp.windowDays));
    } else if (rp.windowDays !== undefined) {
      why.push(en.why.returnsWindow(rp.windowDays));
    }
    if (rp.free === false) caveats.push(en.why.returnsNotFree);
    if ((rp.windowDays ?? 0) >= 30) score += WEIGHTS.returnWindow30;
    if ((rp.windowDays ?? 0) >= 60) score += WEIGHTS.returnWindow60;
  }

  // Rating: average scaled to 0..1, times log of review count, so a few perfect reviews do not win.
  if (s.rating && s.rating.count > 0) {
    score += WEIGHTS.ratingScale * (s.rating.average / 5) * Math.log10(1 + s.rating.count);
    why.push(en.why.rating(s.rating.average, s.rating.count));
  }

  // Listing clarity: can the unboxing check verify it?
  const sized = Boolean(q.size) || Boolean(cat?.sizeDomain) || Boolean(s.attributes.size);
  const missing: MissingField[] = [];
  if (!s.attributes.colour) missing.push('colour');
  if (sized && !s.attributes.size && !(c.availableSizes && c.availableSizes.length > 0)) missing.push('size');
  if (s.images.length === 0) missing.push('images');
  const verifiable = missing.length === 0;
  if (verifiable) {
    score += WEIGHTS.verifiable;
    why.push(sized ? en.why.verifiable : en.why.verifiableNoSize);
  } else {
    score += WEIGHTS.notVerifiable;
    caveats.push(en.why.notVerifiable(joinOr(missing.map((f) => en.why.missingNames[f]))));
  }

  // Store barriers
  if (c.barrierScore !== undefined) {
    const b = Math.min(1, Math.max(0, c.barrierScore));
    score += WEIGHTS.barrier * b;
    if (b >= 0.5) caveats.push(en.why.barrier);
  }

  return {
    candidate: c,
    score: round(score),
    why,
    caveats,
    verifiable,
    missing,
    ...(sizeInStock !== undefined ? { sizeInStock } : {}),
    ...(displaySize !== undefined ? { displaySize } : {}),
  };
}

function compareScored(a: Scored, b: Scored): number {
  if (b.score !== a.score) return b.score - a.score;
  const pa = a.candidate.snapshot.price.cents;
  const pb = b.candidate.snapshot.price.cents;
  if (pa !== pb) return pa - pb;
  const ca = a.candidate.snapshot.rating?.count ?? 0;
  const cb = b.candidate.snapshot.rating?.count ?? 0;
  if (ca !== cb) return cb - ca;
  const ia = a.candidate.snapshot.id;
  const ib = b.candidate.snapshot.id;
  return ia < ib ? -1 : ia > ib ? 1 : 0;
}

/**
 * Rank candidates for a query. Deterministic: ties break on lower price, then more reviews, then
 * snapshot id. Over-budget, out-of-stock and sold-out-size listings are excluded with a reason,
 * which the "found none" message uses to suggest a refinement.
 */
export function rankProducts(input: RankInput): RankResult {
  const limit = Math.min(3, Math.max(1, input.limit ?? 3));
  const offset = Math.max(0, input.offset ?? 0);
  const seen = new Set<string>();
  const scored: Scored[] = [];
  const excluded: ExcludedCandidate[] = [];
  for (const c of input.candidates) {
    const key = `${c.snapshot.productId}:${c.snapshot.variantId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const r = scoreCandidate(c, input);
    if ('reason' in r) excluded.push(r);
    else scored.push(r);
  }
  scored.sort(compareScored);
  const page = scored.slice(offset, offset + limit);
  return {
    options: page.map((s, i) => ({
      rank: offset + i + 1,
      snapshot: s.candidate.snapshot,
      score: s.score,
      why: [...s.why, ...s.caveats],
      caveats: s.caveats,
      verifiable: s.verifiable,
      missing: s.missing,
      ...(s.sizeInStock !== undefined ? { sizeInStock: s.sizeInStock } : {}),
      ...(s.displaySize !== undefined ? { displaySize: s.displaySize } : {}),
    })),
    total: scored.length,
    remaining: Math.max(0, scored.length - offset - page.length),
    excluded,
  };
}

/** Cheapest excluded-for-budget price, used to suggest "up to $45". */
export function cheapestOverBudget(result: RankResult): Money | undefined {
  const over = result.excluded.filter((e) => e.reason === 'over_budget').map((e) => e.snapshot.price);
  if (over.length === 0) return undefined;
  return over.reduce((a, b) => (b.cents < a.cents ? b : a));
}

