/**
 * Grounding guard for spoken claims.
 *
 * The model answers in segments, each listing the claims it rests on: a field of a product
 * snapshot ("attributes.colour", "price", "returnPolicy.windowDays") or a verbatim quote from an
 * archived page. The guard finds every product-specific token in a segment (money, numbers,
 * sizes, colours, materials, dates, policy terms, listing features) and requires each to be backed
 * by one of the segment's valid claims. A quote is valid only if it appears verbatim (case,
 * whitespace, quote marks, dashes and edge punctuation normalised) in the archived text for its
 * source.
 *
 * Dates: with `now`, dates in any common form ("Friday", "next Tuesday", "Nov 14", "the 14th",
 * "in 3 days", "by the weekend") are read as days against that clock (see when.ts) and must cover
 * a day the cited source states.
 *
 * Polarity: each token carries the polarity of its clause. Denying something the cited source
 * states ("it isn't navy" for a navy listing) is caught; so is stating what the source denies.
 * A denial passes only when the cited field settles it ("it isn't wool" for a cotton listing).
 *
 * Citations: a sentence reporting what reviewers said needs a valid quote claim, and when it
 * paraphrases, most of its words must be in the quote.
 *
 * Unsupported segments are replaced by "The listing doesn't say." (or removed). Once a turn has
 * produced two unsupported segments, across one or more attempts, the caller should stop asking
 * the model and fall back to a template answer.
 *
 * Scope: vague praise without product tokens ("it's lovely") carries no checkable fact and passes.
 */
import { spokenDate, type Money, type ProductSnapshot } from '@sightline/core';
import { en } from './copy/en';
import { COLOURS, FEATURE_TERMS, MATERIAL_FAMILIES, MATERIALS, POLICY_TERMS, SIZE_WORDS, findPhrases, normaliseSize, supportSet } from './lexicon';
import { readMoneyAt, readNumber } from './numbers';
import { normaliseForQuote, normaliseText, words } from './text';
import { dayLabel, dayNumber, deliveryContext, readDates } from './when';

export type Claim =
  | { kind: 'field'; ref: string; snapshotId?: string }
  | { kind: 'quote'; quote: string; sourceId: string };

export interface Segment {
  text: string;
  claims: Claim[];
}

export type FactValue = string | number | boolean | Money | Date | null | undefined | FactValue[] | { [k: string]: FactValue };

export interface GroundingInput {
  segments: Segment[];
  snapshots: ProductSnapshot[];
  /** Archived page text by source id. */
  archives?: Record<string, string>;
  /** Values the system itself knows, citable by ref, e.g. "delivery.estimate" or "cart.total". */
  facts?: Record<string, FactValue>;
  /** "replace" (default) swaps an unsupported segment for "The listing doesn't say."; "remove" drops it. */
  mode?: 'replace' | 'remove';
  /** Shortest quote accepted, in words. Very short quotes can match by accident. */
  minQuoteWords?: number;
  /** Unsupported segments already seen earlier in this turn. */
  priorFailures?: number;
  /** Unsupported segments per turn before falling back to a template. */
  maxFailures?: number;
  /**
   * The clock relative dates are read against ("tomorrow", "next Tuesday", "in 3 days"). Without
   * it, only weekdays and dates written out in full can be checked, and relative dates fail.
   */
  now?: Date;
}

export type TokenKind = 'money' | 'number' | 'size' | 'colour' | 'material' | 'date' | 'policy' | 'quoted' | 'feature';

export interface ClaimToken {
  kind: TokenKind;
  /** Canonical value: "USD 3400", "30", "M", "navy", "17 november", "tuesday", "free returns". */
  value: string;
  raw: string;
  /** Word positions in the text, end exclusive. Absent for quoted spans. */
  start?: number;
  end?: number;
  /** For a date read against a clock: the UTC days it covers (see when.ts). */
  days?: [number, number];
  /** A weekday and a date that disagree: never supported. */
  conflict?: boolean;
  /** The sentence denies this token ("it isn't navy"). Set by the segment check. */
  negated?: boolean;
}

export interface ExtractOptions {
  /** Read dates against this clock (see when.ts). Without it, weekdays and day-month labels only. */
  now?: Date;
}

export interface UnsupportedSegment {
  index: number;
  text: string;
  unsupportedTokens: ClaimToken[];
  reasons: string[];
}

export interface GroundingReport {
  /** True when every segment was supported. */
  supported: boolean;
  unsupported: UnsupportedSegment[];
  replaced: number;
  removed: number;
  /** Output segments after replacement or removal. */
  segments: Segment[];
  /** Output text, segments joined with spaces. */
  text: string;
  failuresThisTurn: number;
  /** Stop using model text for this answer and speak a template instead. */
  fallbackToTemplate: boolean;
}

// ---------------------------------------------------------------------------------------------
// Token extraction

const UNITS = new Set([
  'day',
  'days',
  'week',
  'weeks',
  'month',
  'months',
  'year',
  'years',
  'star',
  'stars',
  'review',
  'reviews',
  'rating',
  'ratings',
  'percent',
  '%',
  'inch',
  'inches',
  'cm',
  'mm',
  'kg',
  'g',
  'lb',
  'lbs',
  'oz',
  'pack',
  'pieces',
  'hours',
  'minutes',
]);
const WEEKDAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
const MONTHS = [
  'january',
  'february',
  'march',
  'april',
  'may',
  'june',
  'july',
  'august',
  'september',
  'october',
  'november',
  'december',
];
const LETTER_SIZE_RE = /(?<![\p{L}\p{N}'])(XXS|XS|S|M|L|XL|XXL|XXXL|[2-5]XL)(?![\p{L}\p{N}'])/gu;
const SIZE_CONTEXT = new Set(['size', 'sizes', 'fit', 'fits', 'sizing']);
const SIZE_NAME_WORDS: Array<(typeof SIZE_WORDS)[number]> = SIZE_WORDS.map((s) => ({
  ...s,
  aliases: s.aliases.filter((a) => a.length > 3),
}));

function dayOfMonth(w: string | undefined): number | undefined {
  if (w === undefined) return undefined;
  const m = /^(\d{1,2})(?:st|nd|rd|th)?$/.exec(w);
  if (!m) return undefined;
  const d = Number(m[1]);
  return d >= 1 && d <= 31 ? d : undefined;
}

function fmtNumber(n: number): string {
  return String(Number(n.toFixed(4)));
}

/** Edge punctuation is not part of a quote: "Lovely colour." quotes "Lovely colour". */
function quoteCore(text: string): string {
  return normaliseForQuote(text).replace(/^[.,;:!?\s]+|[.,;:!?\s]+$/g, '');
}

/**
 * Every product-specific token in a sentence. With a clock (`opts.now`), dates are read in any
 * common form and carry the days they cover; without one, weekdays and "17 November" labels only.
 */
export function extractTokens(text: string, opts: ExtractOptions = {}): ClaimToken[] {
  const out: ClaimToken[] = [];
  const seen = new Set<string>();
  const push = (t: ClaimToken) => {
    const key = `${t.kind}:${t.value}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push(t);
  };
  const ws = words(text);
  const used = new Set<number>();
  const take = (a: number, b: number) => {
    for (let k = a; k < b; k++) used.add(k);
  };
  const at = (a: number, b: number) => ({ raw: ws.slice(a, b).join(' '), start: a, end: b });

  // Quoted spans must come from a quote claim.
  for (const m of text.matchAll(/["“]([^"”]{2,})["”]/g)) push({ kind: 'quoted', value: quoteCore(m[1]!), raw: m[0] });

  // Dates first, so "17 November" is not read as the number 17.
  if (opts.now) {
    for (const d of readDates(ws, opts.now, deliveryContext(normaliseText(text)))) {
      const value = d.from === d.to ? dayLabel(d.from) : `${dayLabel(d.from)}..${dayLabel(d.to)}`;
      push({ kind: 'date', value, ...at(d.start, d.end), days: [d.from, d.to], conflict: d.conflict });
      take(d.start, d.end);
    }
  } else {
    // Without a clock "tomorrow" or "in 3 days" cannot be read as a day, so nothing can back it.
    const norm = normaliseText(text);
    if (deliveryContext(norm))
      for (const d of readDates(ws, new Date(0), true))
        if (d.relative) {
          push({ kind: 'date', value: `relative: ${ws.slice(d.start, d.end).join(' ')}`, ...at(d.start, d.end) });
          take(d.start, d.end);
        }
    for (let i = 0; i < ws.length; i++) {
      const w = ws[i]!;
      if (WEEKDAYS.includes(w)) {
        push({ kind: 'date', value: w, ...at(i, i + 1) });
        used.add(i);
      }
      const monthHere = MONTHS.indexOf(w);
      if (monthHere >= 0) {
        const before = dayOfMonth(ws[i - 1]);
        const after = dayOfMonth(ws[i + 1]);
        if (before !== undefined && !used.has(i - 1)) {
          push({ kind: 'date', value: `${before} ${w}`, ...at(i - 1, i + 1) });
          take(i - 1, i + 1);
        } else if (after !== undefined) {
          push({ kind: 'date', value: `${after} ${w}`, ...at(i, i + 2) });
          take(i, i + 2);
        }
      }
    }
  }

  // Money.
  for (let i = 0; i < ws.length; i++) {
    if (used.has(i)) continue;
    const r = readMoneyAt(ws, i, 'USD', true);
    if (r) {
      push({ kind: 'money', value: `${r.money.currency} ${r.money.cents}`, ...at(r.start, r.end) });
      take(r.start, r.end);
      i = r.end - 1;
    }
  }

  // Sizes: "size 9", "size M", capital letter sizes, and size names near sizing words.
  for (let i = 0; i < ws.length; i++) {
    if (ws[i] !== 'size' || used.has(i + 1)) continue;
    const letter = findPhrases(ws.slice(i + 1), SIZE_WORDS)[0];
    if (letter && letter.start === 0) {
      push({ kind: 'size', value: letter.canonical, ...at(i, i + 1 + letter.end) });
      take(i + 1, i + 1 + letter.end);
      continue;
    }
    const n = readNumber(ws, i + 1);
    if (n) {
      push({ kind: 'size', value: fmtNumber(n.value), ...at(i, n.end) });
      take(i + 1, n.end);
    }
  }
  for (const m of text.matchAll(LETTER_SIZE_RE)) {
    const size = normaliseSize(m[1]!)!;
    const pos = ws.indexOf(m[1]!.toLowerCase());
    push(pos >= 0 ? { kind: 'size', value: size, ...at(pos, pos + 1), raw: m[1]! } : { kind: 'size', value: size, raw: m[1]! });
  }
  if (ws.some((w) => SIZE_CONTEXT.has(w))) {
    for (const m of findPhrases(ws, SIZE_NAME_WORDS)) if (!used.has(m.start)) push({ kind: 'size', value: m.canonical, ...at(m.start, m.end) });
  }

  // Numbers: digits anywhere, number words only before a unit ("thirty days").
  for (let i = 0; i < ws.length; i++) {
    if (used.has(i)) continue;
    const n = readNumber(ws, i);
    if (!n) continue;
    const isScale = ws[i - 2] === 'out' && ws[i - 1] === 'of';
    if (!isScale && (!n.spoken || UNITS.has(ws[n.end] ?? ''))) push({ kind: 'number', value: fmtNumber(n.value), ...at(i, n.end) });
    take(i, n.end);
    i = n.end - 1;
  }

  for (const m of findPhrases(ws, COLOURS)) push({ kind: 'colour', value: m.canonical, ...at(m.start, m.end) });
  for (const m of findPhrases(ws, MATERIALS)) push({ kind: 'material', value: m.canonical, ...at(m.start, m.end) });
  for (const m of findPhrases(ws, POLICY_TERMS)) push({ kind: 'policy', value: m.canonical, ...at(m.start, m.end) });
  return out;
}

// ---------------------------------------------------------------------------------------------
// Polarity: what a sentence denies

const NEGATOR_WORDS = new Set(['not', 'no', 'never', 'without', 'nor', 'none', 'neither', 'cannot']);
const isNegator = (w: string) => NEGATOR_WORDS.has(w) || /n't$/.test(w);
/** Words that start a new clause, so "it isn't grey, it's navy" denies only grey. */
const CLAUSE_WORDS = new Set(['but', 'while', 'whereas', 'though', 'although', 'however', 'yet', 'instead']);
const NEW_SUBJECT = /^(it|it's|its|they|they're|you|you'll|you're|the|this|that|there|there's|returns?|shipping|delivery)$/;
/** "not after 30 days", "no more than $40": the negation bounds the number, it does not deny it. */
const COMPARATORS = new Set(['after', 'beyond', 'over', 'past', 'more', 'longer', 'than', 'under', 'less', 'fewer', 'up', 'least', 'most']);
/** A colour or size denied in these words is about the product's other variants, which a snapshot does not list. */
const AVAILABILITY = /\b(come|comes|available|offered|offer|offers|make|makes|stock|stocked|option|options|sell|sells)\b/;

const AFTER_PREDICATES = new Set(['available', 'offered', 'included', 'stock', 'stocked', 'option', 'listed', 'used', 'accepted', 'allowed', 'possible', 'sold', 'supported']);

/** Clause number for each word of the text. */
function clauseIds(text: string): number[] {
  const all = words(text);
  const ids: number[] = [];
  let c = 0;
  for (const piece of text.split(/[;:!?()]|,(?!\d{3})|\.(?=\s|$)|\s[-–—]\s/)) {
    const pw = words(piece);
    pw.forEach((w, k) => {
      if (k > 0 && (CLAUSE_WORDS.has(w) || (w === 'and' && NEW_SUBJECT.test(pw[k + 1] ?? '')))) c++;
      ids.push(c);
    });
    c++;
  }
  return ids.length === all.length ? ids : all.map(() => 0);
}

/** "Returns are free", "returns aren't free", "shipping is free": a free-policy claim, either way round. */
function freePolicyTokens(ws: string[], ids: number[], have: ClaimToken[]): ClaimToken[] {
  const out: ClaimToken[] = [];
  const covered = (k: number) => have.some((t) => t.kind === 'policy' && t.start !== undefined && t.end !== undefined && k >= t.start && k < t.end);
  for (let k = 0; k < ws.length; k++) {
    if (ws[k] !== 'free' || covered(k)) continue;
    const clause = ws.filter((_, j) => ids[j] === ids[k]);
    const value = clause.some((w) => /^return(s|ed|ing)?$/.test(w))
      ? 'free returns'
      : clause.some((w) => /^(shipping|delivery|ships)$/.test(w))
        ? 'free shipping'
        : clause.some((w) => /^exchanges?$/.test(w))
          ? 'free exchanges'
          : null;
    if (value && !have.some((t) => t.kind === 'policy' && t.value === value)) out.push({ kind: 'policy', value, raw: ws[k]!, start: k, end: k + 1 });
  }
  return out;
}

/**
 * Every token a segment check judges: extractTokens, free-policy claims and listing features
 * ("machine washable"), each marked negated when its clause denies it.
 */
export function segmentTokens(text: string, now?: Date): ClaimToken[] {
  const ws = words(text);
  const ids = clauseIds(text);
  const tokens = extractTokens(text, { now });
  tokens.push(...freePolicyTokens(ws, ids, tokens));
  for (const m of findPhrases(ws, FEATURE_TERMS)) tokens.push({ kind: 'feature', value: m.canonical, raw: ws.slice(m.start, m.end).join(' '), start: m.start, end: m.end });
  for (const t of tokens) {
    if (t.start === undefined || t.end === undefined || t.kind === 'quoted') continue;
    let n = 0;
    for (let k = t.start - 1; k >= 0 && ids[k] === ids[t.start]; k--) if (isNegator(ws[k]!) && ws[k + 1] !== 'only' && ws[k + 1] !== 'just') n++;
    // "Size M is not available", "navy isn't an option": the denial comes after the token.
    for (let k = t.end; k < Math.min(ws.length, t.end + 3) && ids[k] === ids[t.start]; k++) {
      if (!isNegator(ws[k]!)) continue;
      let p = k + 1;
      while (ws[p] === 'an' || ws[p] === 'a' || ws[p] === 'in' || ws[p] === 'on' || ws[p] === 'currently') p++;
      if (ids[p] === ids[t.start] && AFTER_PREDICATES.has(ws[p] ?? '')) n++;
      break;
    }
    if (t.kind === 'material' && (ws[t.end] === 'free' || (ws[t.start - 1] === 'of' && ws[t.start - 2] === 'free'))) n++;
    if ((t.kind === 'number' || t.kind === 'money') && COMPARATORS.has(ws[t.start - 1] ?? '')) n = 0;
    t.negated = n % 2 === 1;
  }
  return tokens;
}

// ---------------------------------------------------------------------------------------------
// What a claim supports

interface Support {
  money: Money[];
  numbers: number[];
  sizes: Set<string>;
  colours: Set<string>;
  materials: Set<string>;
  dates: Set<string>;
  policies: Set<string>;
  /** Normalised quote text, for quoted spans. */
  quotes: string[];
  /** Listing features the source states ("machine washable"). */
  features: Set<string>;
  /** Tokens the source denies, as "kind:value" ("feature:machine washable", "policy:free returns"). */
  neg: Set<string>;
  /** UTC day numbers of the dates the source states. */
  days: number[];
}

function emptySupport(): Support {
  return {
    money: [],
    numbers: [],
    sizes: new Set(),
    colours: new Set(),
    materials: new Set(),
    dates: new Set(),
    policies: new Set(),
    quotes: [],
    features: new Set(),
    neg: new Set(),
    days: [],
  };
}

function merge(into: Support, from: Support): void {
  into.money.push(...from.money);
  into.numbers.push(...from.numbers);
  for (const k of ['sizes', 'colours', 'materials', 'dates', 'policies', 'features', 'neg'] as const) for (const v of from[k]) into[k].add(v);
  into.quotes.push(...from.quotes);
  into.days.push(...from.days);
}

function isMoney(v: unknown): v is Money {
  return typeof v === 'object' && v !== null && typeof (v as Money).cents === 'number' && typeof (v as Money).currency === 'string';
}

function dateSupport(d: Date, s: Support): void {
  if (Number.isNaN(d.getTime())) return;
  const spoken = spokenDate(d).toLowerCase().split(' ');
  s.dates.add(spoken[0]!);
  s.dates.add(`${spoken[1]} ${spoken[2]}`);
  s.days.push(dayNumber(d));
}

function textSupport(text: string, now?: Date): Support {
  const s = emptySupport();
  for (const t of segmentTokens(text, now)) {
    // What the source denies backs only a denial ("Do not machine wash").
    if (t.negated) {
      s.neg.add(`${t.kind}:${t.value}`);
      continue;
    }
    if (t.kind === 'feature') s.features.add(t.value);
    else if (t.kind === 'date' && t.days && t.days[0] === t.days[1] && !t.conflict) s.days.push(t.days[0]);
    if (t.kind === 'money') {
      const [currency, cents] = t.value.split(' ');
      s.money.push({ currency: currency!, cents: Number(cents) });
    } else if (t.kind === 'number') s.numbers.push(Number(t.value));
    else if (t.kind === 'size') s.sizes.add(t.value);
    else if (t.kind === 'date') s.dates.add(t.value);
    else if (t.kind === 'policy') s.policies.add(t.value);
  }
  for (const c of supportSet(text, COLOURS)) s.colours.add(c);
  for (const mat of supportSet(text, MATERIALS)) s.materials.add(mat);
  // Plain numbers inside the text (e.g. "Free returns within 30 days") count even without a unit.
  for (const w of words(text)) if (/^\d+(?:\.\d+)?$/.test(w)) s.numbers.push(Number(w));
  return s;
}

function valueSupport(value: FactValue | unknown, ref: string, now?: Date): Support {
  const s = emptySupport();
  if (value === undefined || value === null) return s;
  if (isMoney(value)) {
    s.money.push(value);
    s.numbers.push(value.cents / 100);
    return s;
  }
  if (value instanceof Date) {
    dateSupport(value, s);
    return s;
  }
  if (typeof value === 'number') {
    s.numbers.push(value);
    return s;
  }
  if (typeof value === 'boolean') {
    if (/returnPolicy\.free$/.test(ref)) {
      if (value) s.policies.add('free returns');
      else s.neg.add('policy:free returns');
    }
    if (/shipping\.free$|freeShipping$/.test(ref)) {
      if (value) s.policies.add('free shipping');
      else s.neg.add('policy:free shipping');
    }
    return s;
  }
  if (typeof value === 'string') {
    if (/^\d{4}-\d{2}-\d{2}(T[\d:.]+Z?)?$/.test(value)) {
      dateSupport(new Date(value), s);
      return s;
    }
    merge(s, textSupport(value, now));
    if (/(^|\.)size$/.test(ref)) {
      const n = normaliseSize(value);
      if (n) s.sizes.add(n);
    }
    return s;
  }
  if (Array.isArray(value)) {
    for (const v of value) merge(s, valueSupport(v, ref, now));
    return s;
  }
  if (typeof value === 'object') {
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) merge(s, valueSupport(v, `${ref}.${k}`, now));
  }
  return s;
}

function resolvePath(root: unknown, path: string): unknown {
  let cur: unknown = root;
  for (const part of path.split('.')) {
    if (cur === null || cur === undefined || typeof cur !== 'object') return undefined;
    cur = (cur as Record<string, unknown>)[part];
  }
  return cur;
}

interface ClaimCheck {
  valid: boolean;
  reason?: string;
  support: Support;
}

function checkClaim(claim: Claim, input: GroundingInput): ClaimCheck {
  if (claim.kind === 'field') {
    if (input.facts && claim.ref in input.facts) {
      const v = input.facts[claim.ref];
      if (v === undefined || v === null) return { valid: false, reason: `fact ${claim.ref} is empty`, support: emptySupport() };
      return { valid: true, support: valueSupport(v, claim.ref, input.now) };
    }
    let snap: ProductSnapshot | undefined;
    if (claim.snapshotId) snap = input.snapshots.find((x) => x.id === claim.snapshotId || x.productId === claim.snapshotId);
    else if (input.snapshots.length === 1) snap = input.snapshots[0];
    if (!snap)
      return {
        valid: false,
        reason: claim.snapshotId ? `snapshot ${claim.snapshotId} not found` : `field ${claim.ref} needs a snapshotId when comparing products`,
        support: emptySupport(),
      };
    const v = resolvePath(snap, claim.ref);
    if (v === undefined || v === null || v === '') return { valid: false, reason: `the listing has no ${claim.ref}`, support: emptySupport() };
    return { valid: true, support: valueSupport(v, claim.ref, input.now) };
  }
  const archive = input.archives?.[claim.sourceId];
  if (archive === undefined) return { valid: false, reason: `no archived text for ${claim.sourceId}`, support: emptySupport() };
  const q = quoteCore(claim.quote);
  const minWords = input.minQuoteWords ?? 2;
  if (q.split(' ').filter((w) => w.length > 0).length < minWords) return { valid: false, reason: 'quote is too short to verify', support: emptySupport() };
  if (!normaliseForQuote(archive).includes(q)) return { valid: false, reason: `quote not found in ${claim.sourceId}`, support: emptySupport() };
  const support = textSupport(claim.quote, input.now);
  support.quotes.push(q);
  return { valid: true, support };
}

function tokenSupported(t: ClaimToken, s: Support): boolean {
  switch (t.kind) {
    case 'money': {
      const [currency, centsStr] = t.value.split(' ');
      const cents = Number(centsStr);
      return s.money.some((m) => m.cents === cents && m.currency === currency) || (currency === 'USD' && s.numbers.includes(cents / 100));
    }
    case 'number': {
      const v = Number(t.value);
      return s.numbers.some((n) => Math.abs(n - v) < 1e-9) || s.money.some((m) => m.cents === Math.round(v * 100));
    }
    case 'size':
      return s.sizes.has(t.value);
    case 'colour':
      return s.colours.has(t.value);
    case 'material':
      return s.materials.has(t.value);
    case 'date':
      if (t.days) return !t.conflict && s.days.some((d) => d >= t.days![0] && d <= t.days![1]);
      return s.dates.has(t.value);
    case 'policy':
      return s.policies.has(t.value);
    case 'quoted':
      return s.quotes.some((q) => q.includes(t.value));
    // In a segment a feature must be in the cited source's own words. checkFreeText checks
    // features against the whole listing separately.
    case 'feature':
      return s.features.has(t.value);
  }
}

/** The source states this token (a denied material counts if any of its family is stated). */
function assertedBy(t: ClaimToken, s: Support): boolean {
  if (t.kind === 'material') return (MATERIAL_FAMILIES[t.value] ?? [t.value]).some((m) => s.materials.has(m));
  return tokenSupported(t, s);
}

/**
 * The cited source settles the question, so denying something it does not state is true: a
 * material field lists every material, a number field gives the number. A colour or size field
 * covers this variant only, so "it doesn't come in black" is not settled by it. Features and
 * policy terms are settled only by an explicit denial in the source.
 */
function settledBy(t: ClaimToken, s: Support, availability: boolean): boolean {
  switch (t.kind) {
    case 'material':
      return s.materials.size > 0;
    case 'colour':
      return !availability && s.colours.size > 0;
    case 'size':
      return !availability && s.sizes.size > 0;
    case 'number':
      return s.numbers.length > 0 || s.money.length > 0;
    case 'money':
      return s.money.length > 0;
    case 'date':
      return t.days ? s.days.length > 0 : s.dates.size > 0;
    default:
      return false;
  }
}

/** Why this token is not backed, or null when it is. */
function judgeToken(t: ClaimToken, s: Support, availability: boolean): string | null {
  const key = `${t.kind}:${t.value}`;
  if (t.negated) {
    if (s.neg.has(key)) return null;
    if (assertedBy(t, s)) return 'is denied, but the cited source states it';
    return settledBy(t, s, availability) ? null : 'is denied, and the cited source does not say';
  }
  if (tokenSupported(t, s)) return null;
  return s.neg.has(key) ? 'is stated, but the cited source denies it' : 'is not backed by a claim';
}

const REVIEW_CLAIM =
  /\b(?:reviewers?|reviews?|buyers?|customers?|shoppers?|owners?|people|someone|somebody|users?)\b(?:\s+[\w']+){0,3}?\s+(?:say|says|said|wrote|write|writes|mention(?:s|ed)?|report(?:s|ed)?|note[sd]?|find|finds|found|feel|feels|felt|call(?:s|ed)?|describe[sd]?|complain(?:s|ed)?|love[sd]?|agree[sd]?)\b|\baccording to (?:the |some )?(?:reviews|reviewers|buyers|customers)\b/;
const FILLER = new Set(
  'it its it\'s is are was were be been a an the this that these they them their and or but of to in on for with very really quite so too one has have had you your if at as just than then also all some most many lot lots'.split(' '),
);
const stem = (w: string) => w.replace(/(ing|ed|es|s)$/, '');

/**
 * A sentence that reports what reviewers said is a claim about a review: it needs a verbatim quote
 * behind it, and when it paraphrases rather than quotes, most of its words must be in that quote.
 */
function reviewClaimProblem(text: string, support: Support, validQuotes: number): string | null {
  const n = normaliseText(text);
  const m = REVIEW_CLAIM.exec(n);
  if (!m) return null;
  if (validQuotes === 0) return 'reports what reviewers said without a verbatim quote';
  if (/["“”]/.test(text)) return null;
  const content = words(n.slice(m.index + m[0].length)).filter((w) => !FILLER.has(w) && w.length > 1);
  if (content.length === 0) return null;
  const quoted = new Set(support.quotes.flatMap((q) => words(q)).map(stem));
  const found = content.filter((w) => quoted.has(stem(w))).length;
  return found / content.length >= 0.6 ? null : 'reports what reviewers said, but the quote it cites does not say it';
}

/** Check one segment. Exported for tests and for checking a single sentence. */
export function checkSegment(segment: Segment, input: GroundingInput): { supported: boolean; unsupportedTokens: ClaimToken[]; reasons: string[] } {
  const tokens = segmentTokens(segment.text, input.now);
  const reasons: string[] = [];
  const support = emptySupport();
  let validQuotes = 0;
  for (const c of segment.claims) {
    const r = checkClaim(c, input);
    if (!r.valid) reasons.push(r.reason ?? 'invalid claim');
    else {
      merge(support, r.support);
      if (c.kind === 'quote') validQuotes++;
    }
  }
  const availability = AVAILABILITY.test(normaliseText(segment.text));
  const unsupportedTokens: ClaimToken[] = [];
  for (const t of tokens) {
    const why = judgeToken(t, support, availability);
    if (!why) continue;
    unsupportedTokens.push(t);
    reasons.push(`"${t.raw}" (${t.negated ? `not ${t.kind}` : t.kind}) ${why}`);
  }
  const review = reviewClaimProblem(segment.text, support, validQuotes);
  if (review) reasons.push(review);
  return { supported: reasons.length === 0, unsupportedTokens, reasons };
}

/** Run the guard over a model answer. */
export function checkGrounding(input: GroundingInput): GroundingReport {
  const mode = input.mode ?? 'replace';
  const maxFailures = input.maxFailures ?? 2;
  const unsupported: UnsupportedSegment[] = [];
  const out: Segment[] = [];
  let replaced = 0;
  let removed = 0;
  input.segments.forEach((segment, index) => {
    const r = checkSegment(segment, input);
    if (r.supported) {
      out.push(segment);
      return;
    }
    unsupported.push({ index, text: segment.text, unsupportedTokens: r.unsupportedTokens, reasons: r.reasons });
    if (mode === 'remove') {
      removed++;
      return;
    }
    replaced++;
    const last = out[out.length - 1];
    if (last && last.text === en.grounding.doesntSay && last.claims.length === 0) return;
    out.push({ text: en.grounding.doesntSay, claims: [] });
  });
  const failuresThisTurn = (input.priorFailures ?? 0) + unsupported.length;
  return {
    supported: unsupported.length === 0,
    unsupported,
    replaced,
    removed,
    segments: out,
    text: out.map((s) => s.text.trim()).join(' '),
    failuresThisTurn,
    fallbackToTemplate: failuresThisTurn >= maxFailures,
  };
}

/** Tracks failures across attempts within one user turn. Create one per turn. */
export class GroundingTurn {
  private failures = 0;
  constructor(private readonly maxFailures = 2) {}

  check(input: Omit<GroundingInput, 'priorFailures' | 'maxFailures'>): GroundingReport {
    const report = checkGrounding({ ...input, priorFailures: this.failures, maxFailures: this.maxFailures });
    this.failures = report.failuresThisTurn;
    return report;
  }

  get failureCount(): number {
    return this.failures;
  }

  get shouldFallBack(): boolean {
    return this.failures >= this.maxFailures;
  }
}

// ---------------------------------------------------------------------------------------------
// Free text from the shopping agent

export interface FreeTextInput {
  /** One sentence or short line the agent wrote. */
  text: string;
  /** The listings it is about: every product fact must be in one of them. */
  snapshots: ProductSnapshot[];
  /** Other things the system knows this turn (the buyer's own words, saved preferences). */
  facts?: Record<string, FactValue>;
}

export interface FreeTextReport {
  supported: boolean;
  unsupportedTokens: ClaimToken[];
}

/** What a listing supports: its title, description, attributes, price, returns, rating and review quotes. */
function snapshotSupport(s: ProductSnapshot): Support {
  const out = emptySupport();
  const listing = {
    title: s.title,
    brand: s.brand,
    category: s.category,
    description: s.description,
    attributes: s.attributes,
    price: s.price,
    returnPolicy: s.returnPolicy,
    rating: s.rating,
    seller: s.seller.name,
  } as unknown as FactValue;
  merge(out, valueSupport(listing, 'listing'));
  for (const r of s.reviews ?? []) {
    merge(out, textSupport(r.quote));
    out.quotes.push(normaliseForQuote(r.quote));
  }
  if (s.description) out.quotes.push(normaliseForQuote(s.description));
  out.quotes.push(normaliseForQuote(s.title));
  return out;
}

/**
 * Check a line the shopping agent wrote, without per-claim citations: every product token in it
 * (money, numbers, sizes, colours, materials, dates, policy terms, quoted words) must be backed by
 * the listings it is about or by the turn's facts. A line that fails is not spoken.
 */
export function checkFreeText(input: FreeTextInput): FreeTextReport {
  const support = emptySupport();
  for (const s of input.snapshots) merge(support, snapshotSupport(s));
  for (const [ref, v] of Object.entries(input.facts ?? {})) merge(support, valueSupport(v, ref));
  // "No wool", "without wool", "wool-free" claim an absence: true only when every listing it is
  // about names its material and none of that family is in it. An unknown material can't back it.
  const absent = absentMaterials(input.text);
  const absenceHolds = (m: string) =>
    input.snapshots.length > 0 &&
    input.snapshots.every((s) => {
      if (!s.attributes.material) return false;
      const have = supportSet(`${s.attributes.material} ${s.title}`, MATERIALS);
      return !(MATERIAL_FAMILIES[m] ?? [m]).some((x) => have.has(x));
    });
  // A negated material is judged by absence alone: "no wool" is false for merino even though
  // the word "wool" is in the listing.
  const unsupportedTokens = extractTokens(input.text).filter((t) =>
    t.kind === 'material' && absent.has(t.value) ? !absenceHolds(t.value) : !tokenSupported(t, support),
  );
  // Feature claims ("waterproof", "machine washable") must be words the listing itself uses.
  const listingText = [
    ...input.snapshots.flatMap((s) => [s.title, s.description ?? '', ...(s.keyFeatures ?? []), ...Object.values(s.attributes), ...(s.reviews ?? []).map((r) => r.quote)]),
    ...Object.values(input.facts ?? {}).filter((v): v is string => typeof v === 'string'),
  ].join(' . ');
  const offered = new Set(findPhrases(words(listingText), FEATURE_TERMS).map((m) => m.canonical));
  const ws = words(input.text);
  for (const m of findPhrases(ws, FEATURE_TERMS))
    if (!offered.has(m.canonical)) unsupportedTokens.push({ kind: 'feature', value: m.canonical, raw: ws.slice(m.start, m.end).join(' ') });
  return { supported: unsupportedTokens.length === 0, unsupportedTokens };
}

const NEGATORS = new Set(['no', 'not', 'without', 'non', 'zero', 'nor']);

/** Materials the text says are absent: "no wool", "without merino", "wool-free", "free of wool". */
function absentMaterials(text: string): Set<string> {
  const ws = words(text);
  const out = new Set<string>();
  for (const m of findPhrases(ws, MATERIALS)) {
    const before = ws[m.start - 1];
    const negated = (before !== undefined && NEGATORS.has(before)) || ws[m.end] === 'free' || (ws[m.start - 2] === 'free' && before === 'of');
    if (negated) out.add(m.canonical);
  }
  return out;
}

/** Exposed for tests: normalised comparison used for quotes. */
export function quoteAppears(quote: string, archive: string): boolean {
  return normaliseForQuote(archive).includes(normaliseForQuote(quote));
}

