/**
 * Explainable product ranking. Every point a listing gains or loses comes with a plain sentence,
 * so "why these?" can be answered from the same numbers that ordered the list. At most three
 * options are returned at a time.
 */
import type { Money, ProductSnapshot } from '@sightline/core';
import { en } from './copy/en';
import type { ShoppingQuery } from './grammar';
import {
  CATEGORIES,
  FITS,
  MATERIAL_FAMILIES,
  NECKLINES,
  PATTERNS,
  SLEEVES,
  categoryOf,
  categoryPlural,
  colourSupport,
  findPhrases,
  materialSupport,
  sameSize,
  type LexEntry,
} from './lexicon';
import { isFanMerchandise, wantsTeamGear, type SizeChoice, type SizeFit } from './listing';
import { joinOr, words } from './text';

export interface Candidate {
  snapshot: ProductSnapshot;
  /** Sizes in stock for this listing, when known. */
  availableSizes?: string[];
  inStock?: boolean;
  /** Checkout barrier score from the Barrier Index: 0 (none) to 1 (severe). */
  barrierScore?: number;
  /** How the listing answers the asked-for size, from interpretListing. */
  sizeChoice?: SizeChoice;
}

export interface RankInput {
  candidates: Candidate[];
  query: ShoppingQuery;
  avoidColours?: string[];
  /** Options per page, at most 3. */
  limit?: number;
  /** Skip this many ranked options (for "more"). */
  offset?: number;
  /** Materials the buyer never wants (canonical names, e.g. "wool"): such listings are left out. */
  avoidMaterials?: string[];
  /** Colours the buyer likes: a small boost when no colour was asked for. */
  likeColours?: string[];
  /** Keep fan and licensed team merchandise. Defaults to whether the request asked for it. */
  allowTeamGear?: boolean;
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
  /** How the listing answers the asked-for size, when a size was asked for. */
  sizeFit?: SizeFit;
  /** The listing to freeze for the asked size, when the store sells it as its own listing. */
  sizeProductId?: string;
}

export type ExclusionReason =
  | 'wrong_category'
  | 'over_budget'
  | 'under_minimum'
  | 'out_of_stock'
  | 'size_sold_out'
  | 'size_not_offered'
  | 'returns_not_free'
  | 'fan_merch'
  | 'avoided_material';

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
  colourMatch: 3,
  colourMismatch: -4,
  sizeMatch: 2,
  sizeMismatch: -3,
  sizeUnknown: -2,
  likedColour: 1,
  materialListed: 0.5,
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

/**
 * Whether a listing is the kind of thing asked for. The listing's category and title decide when
 * they name any category; the description is used only when neither does. "Black jeans" never
 * matches a black T-shirt or a black USB-C cable.
 */
export function isInCategory(s: ProductSnapshot, category: string): boolean {
  const named = new Set(
    [...findPhrases(words(s.category ?? ''), CATEGORIES, true), ...findPhrases(words(s.title), CATEGORIES, true)].map((m) => m.canonical),
  );
  if (named.size > 0) return named.has(category);
  return findPhrases(words(s.description ?? ''), CATEGORIES, true).some((m) => m.canonical === category);
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
  sizeFit?: SizeFit;
  sizeProductId?: string;
}

function avoidedMaterial(s: ProductSnapshot, avoid: string[] | undefined): string | undefined {
  if (!avoid?.length) return undefined;
  const have = materialSupport(`${s.attributes.material ?? ''} ${s.title}`);
  return avoid.find((a) => (MATERIAL_FAMILIES[a] ?? [a]).some((m) => have.has(m)));
}

function scoreCandidate(c: Candidate, input: RankInput): Scored | ExcludedCandidate {
  const s = c.snapshot;
  const q = input.query;
  const why: string[] = [];
  const caveats: string[] = [];
  let score = 0;

  // Category first: something that isn't what was asked for is never shown, whatever its price.
  if (q.category && !isInCategory(s, q.category))
    return { snapshot: s, reason: 'wrong_category', detail: en.why.excluded.otherCategory(categoryPlural(q.category)) };
  if (c.inStock === false) return { snapshot: s, reason: 'out_of_stock', detail: en.why.excluded.outOfStock };

  // Price
  if (q.maxPrice && q.maxPrice.currency === s.price.currency && s.price.cents > q.maxPrice.cents)
    return { snapshot: s, reason: 'over_budget', detail: en.why.excluded.overBudget(s.price, q.maxPrice) };
  if (q.minPrice && q.minPrice.currency === s.price.currency && s.price.cents < q.minPrice.cents)
    return { snapshot: s, reason: 'under_minimum', detail: en.why.excluded.underMin(s.price, q.minPrice) };
  if (q.freeReturns && s.returnPolicy?.free !== true)
    return { snapshot: s, reason: 'returns_not_free', detail: en.why.excluded.notFreeReturns };

  // Fan and licensed team merchandise ("Navy Midshipmen" for "navy"), and materials the buyer avoids.
  if (!(input.allowTeamGear ?? wantsTeamGear(q.text)) && isFanMerchandise(s))
    return { snapshot: s, reason: 'fan_merch', detail: en.why.excluded.fanMerch };
  const avoided = avoidedMaterial(s, input.avoidMaterials);
  if (avoided) return { snapshot: s, reason: 'avoided_material', detail: en.why.excluded.avoidedMaterial(avoided) };

  // Size: a listing that is another size, or doesn't offer the size, is never shown for it.
  let sizeInStock: boolean | undefined;
  let displaySize: string | undefined = s.attributes.size;
  let sizeFit: SizeFit | undefined;
  let sizeProductId: string | undefined;
  if (q.size) {
    const choice = c.sizeChoice;
    if (choice && choice.fit !== 'not_asked') {
      sizeFit = choice.fit;
      switch (choice.fit) {
        case 'sold_out':
          return { snapshot: s, reason: 'size_sold_out', detail: en.why.excluded.sizeSoldOut(q.size) };
        case 'not_offered':
          return { snapshot: s, reason: 'size_not_offered', detail: en.why.excluded.sizeNotOffered(q.size) };
        case 'in_stock':
          sizeInStock = true;
          score += WEIGHTS.sizeMatch;
          why.push(en.why.sizeInStock(q.size));
          displaySize = choice.label;
          break;
        case 'offered':
        case 'other_listing':
          score += WEIGHTS.sizeMatch;
          why.push(en.why.sizeOffered(q.size));
          displaySize = choice.label;
          if (choice.productId) sizeProductId = choice.productId;
          break;
        case 'listed':
          score += WEIGHTS.sizeMatch;
          why.push(en.why.sizeListed(q.size));
          displaySize = choice.label;
          break;
        case 'unknown':
          score += WEIGHTS.sizeUnknown;
          caveats.push(en.why.sizeUnknown(q.size));
          break;
      }
    } else if (c.availableSizes) {
      sizeInStock = c.availableSizes.some((x) => sameSize(x, q.size));
      if (!sizeInStock) return { snapshot: s, reason: 'size_sold_out', detail: en.why.excluded.sizeSoldOut(q.size) };
      score += WEIGHTS.sizeMatch;
      why.push(en.why.sizeInStock(q.size));
      displaySize = q.size;
      sizeFit = 'in_stock';
    } else if (s.attributes.size) {
      // Another size is never shown under the one asked for.
      if (!sameSize(s.attributes.size, q.size)) return { snapshot: s, reason: 'size_not_offered', detail: en.why.excluded.sizeNotOffered(q.size) };
      score += WEIGHTS.sizeMatch;
      why.push(en.why.sizeListed(q.size));
      sizeFit = 'listed';
    } else {
      score += WEIGHTS.sizeUnknown;
      caveats.push(en.why.sizeUnknown(q.size));
      sizeFit = 'unknown';
    }
  }

  // Category: listings in another category were excluded above.
  const cat = listingCategory(s);
  if (q.category) score += WEIGHTS.categoryMatch;

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
  const avoidedColour = (input.avoidColours ?? []).map((a) => a.toLowerCase()).find((a) => colours.has(a));
  if (avoidedColour) {
    score += WEIGHTS.avoidColour;
    caveats.push(en.why.avoidColour(avoidedColour));
  }
  const liked = q.colour ? undefined : (input.likeColours ?? []).map((a) => a.toLowerCase()).find((a) => colours.has(a));
  if (liked) {
    score += WEIGHTS.likedColour;
    why.push(en.why.likedColour(liked));
  }
  // A listing that names its material can be compared and checked; small, but it adds up.
  if (s.attributes.material) score += WEIGHTS.materialListed;

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
    ...(sizeFit !== undefined ? { sizeFit } : {}),
    ...(sizeProductId !== undefined ? { sizeProductId } : {}),
  };
}

function compareScored(a: Scored, b: Scored): number {
  if (b.score !== a.score) return b.score - a.score;
  // The Demo Store is the sandbox merchant every order is placed with: its own item wins a tie.
  const da = a.candidate.snapshot.source === 'demo-store' ? 0 : 1;
  const dbs = b.candidate.snapshot.source === 'demo-store' ? 0 : 1;
  if (da !== dbs) return da - dbs;
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
 * snapshot id. Listings in another category, over-budget, out-of-stock and sold-out-size listings
 * are excluded with a reason, which the "found none" message uses to suggest a refinement.
 */
function scoreAll(input: RankInput): { scored: Scored[]; excluded: ExcludedCandidate[] } {
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
  return { scored, excluded };
}

function toOption(s: Scored, rank: number): RankedOption {
  return {
    rank,
    snapshot: s.candidate.snapshot,
    score: s.score,
    why: [...s.why, ...s.caveats],
    caveats: s.caveats,
    verifiable: s.verifiable,
    missing: s.missing,
    ...(s.sizeInStock !== undefined ? { sizeInStock: s.sizeInStock } : {}),
    ...(s.displaySize !== undefined ? { displaySize: s.displaySize } : {}),
    ...(s.sizeFit !== undefined ? { sizeFit: s.sizeFit } : {}),
    ...(s.sizeProductId !== undefined ? { sizeProductId: s.sizeProductId } : {}),
  };
}

export function rankProducts(input: RankInput): RankResult {
  const limit = Math.min(3, Math.max(1, input.limit ?? 3));
  const offset = Math.max(0, input.offset ?? 0);
  const { scored, excluded } = scoreAll(input);
  const page = scored.slice(offset, offset + limit);
  return {
    options: page.map((s, i) => toOption(s, offset + i + 1)),
    total: scored.length,
    remaining: Math.max(0, scored.length - offset - page.length),
    excluded,
  };
}

/** Every eligible candidate in rank order, for the shopping agent to choose from. */
export function rankAll(input: Omit<RankInput, 'limit' | 'offset'>): { options: RankedOption[]; excluded: ExcludedCandidate[] } {
  const { scored, excluded } = scoreAll(input);
  return { options: scored.map((s, i) => toOption(s, i + 1)), excluded };
}

/** Cheapest excluded-for-budget price, used to suggest "up to $45". */
export function cheapestOverBudget(result: RankResult): Money | undefined {
  const over = result.excluded.filter((e) => e.reason === 'over_budget').map((e) => e.snapshot.price);
  if (over.length === 0) return undefined;
  return over.reduce((a, b) => (b.cents < a.cents ? b : a));
}

