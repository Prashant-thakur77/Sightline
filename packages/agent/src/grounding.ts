/**
 * Grounding guard for spoken claims.
 *
 * The model answers in segments, each listing the claims it rests on: a field of a product
 * snapshot ("attributes.colour", "price", "returnPolicy.windowDays") or a verbatim quote from an
 * archived page. The guard finds every product-specific token in a segment (money, numbers,
 * sizes, colours, materials, dates, policy terms) and requires each to be backed by one of the
 * segment's valid claims. A quote is valid only if it appears verbatim (case, whitespace, quote
 * marks and dashes normalised) in the archived text for its source.
 *
 * Unsupported segments are replaced by "The listing doesn't say." (or removed). Once a turn has
 * produced two unsupported segments, across one or more attempts, the caller should stop asking
 * the model and fall back to a template answer.
 *
 * Scope: this is a token-level check. It catches invented sizes, colours, materials, prices,
 * windows and quotes. It does not judge polarity ("it doesn't come in navy" passes if navy is
 * listed) or vague praise without product tokens ("it's lovely"), which carry no checkable fact.
 */
import { spokenDate, type Money, type ProductSnapshot } from '@sightline/core';
import { en } from './copy/en';
import { COLOURS, MATERIALS, POLICY_TERMS, SIZE_WORDS, findPhrases, normaliseSize, supportSet } from './lexicon';
import { readMoneyAt, readNumber } from './numbers';
import { normaliseForQuote, words } from './text';

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
}

export type TokenKind = 'money' | 'number' | 'size' | 'colour' | 'material' | 'date' | 'policy' | 'quoted';

export interface ClaimToken {
  kind: TokenKind;
  /** Canonical value: "USD 3400", "30", "M", "navy", "17 november", "tuesday", "free returns". */
  value: string;
  raw: string;
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

/** Every product-specific token in a sentence. */
export function extractTokens(text: string): ClaimToken[] {
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

  // Quoted spans must come from a quote claim.
  for (const m of text.matchAll(/["“]([^"”]{2,})["”]/g)) push({ kind: 'quoted', value: normaliseForQuote(m[1]!), raw: m[0] });

  // Dates first, so "17 November" is not read as the number 17.
  for (let i = 0; i < ws.length; i++) {
    const w = ws[i]!;
    if (WEEKDAYS.includes(w)) {
      push({ kind: 'date', value: w, raw: w });
      used.add(i);
    }
    const monthHere = MONTHS.indexOf(w);
    if (monthHere >= 0) {
      const before = dayOfMonth(ws[i - 1]);
      const after = dayOfMonth(ws[i + 1]);
      if (before !== undefined && !used.has(i - 1)) {
        push({ kind: 'date', value: `${before} ${w}`, raw: `${ws[i - 1]} ${w}` });
        take(i - 1, i + 1);
      } else if (after !== undefined) {
        push({ kind: 'date', value: `${after} ${w}`, raw: `${w} ${ws[i + 1]}` });
        take(i, i + 2);
      }
    }
  }

  // Money.
  for (let i = 0; i < ws.length; i++) {
    if (used.has(i)) continue;
    const r = readMoneyAt(ws, i, 'USD', true);
    if (r) {
      push({ kind: 'money', value: `${r.money.currency} ${r.money.cents}`, raw: ws.slice(r.start, r.end).join(' ') });
      take(r.start, r.end);
      i = r.end - 1;
    }
  }

  // Sizes: "size 9", "size M", capital letter sizes, and size names near sizing words.
  for (let i = 0; i < ws.length; i++) {
    if (ws[i] !== 'size' || used.has(i + 1)) continue;
    const letter = findPhrases(ws.slice(i + 1), SIZE_WORDS)[0];
    if (letter && letter.start === 0) {
      push({ kind: 'size', value: letter.canonical, raw: ws.slice(i, i + 1 + letter.end).join(' ') });
      take(i + 1, i + 1 + letter.end);
      continue;
    }
    const n = readNumber(ws, i + 1);
    if (n) {
      push({ kind: 'size', value: fmtNumber(n.value), raw: ws.slice(i, n.end).join(' ') });
      take(i + 1, n.end);
    }
  }
  for (const m of text.matchAll(LETTER_SIZE_RE)) push({ kind: 'size', value: normaliseSize(m[1]!)!, raw: m[1]! });
  if (ws.some((w) => SIZE_CONTEXT.has(w))) {
    for (const m of findPhrases(ws, SIZE_NAME_WORDS)) if (!used.has(m.start)) push({ kind: 'size', value: m.canonical, raw: ws.slice(m.start, m.end).join(' ') });
  }

  // Numbers: digits anywhere, number words only before a unit ("thirty days").
  for (let i = 0; i < ws.length; i++) {
    if (used.has(i)) continue;
    const n = readNumber(ws, i);
    if (!n) continue;
    const isScale = ws[i - 2] === 'out' && ws[i - 1] === 'of';
    if (!isScale && (!n.spoken || UNITS.has(ws[n.end] ?? ''))) push({ kind: 'number', value: fmtNumber(n.value), raw: ws.slice(i, n.end).join(' ') });
    take(i, n.end);
    i = n.end - 1;
  }

  for (const m of findPhrases(ws, COLOURS)) push({ kind: 'colour', value: m.canonical, raw: ws.slice(m.start, m.end).join(' ') });
  for (const m of findPhrases(ws, MATERIALS)) push({ kind: 'material', value: m.canonical, raw: ws.slice(m.start, m.end).join(' ') });
  for (const m of findPhrases(ws, POLICY_TERMS)) push({ kind: 'policy', value: m.canonical, raw: ws.slice(m.start, m.end).join(' ') });
  return out;
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
}

function emptySupport(): Support {
  return { money: [], numbers: [], sizes: new Set(), colours: new Set(), materials: new Set(), dates: new Set(), policies: new Set(), quotes: [] };
}

function merge(into: Support, from: Support): void {
  into.money.push(...from.money);
  into.numbers.push(...from.numbers);
  for (const k of ['sizes', 'colours', 'materials', 'dates', 'policies'] as const) for (const v of from[k]) into[k].add(v);
  into.quotes.push(...from.quotes);
}

function isMoney(v: unknown): v is Money {
  return typeof v === 'object' && v !== null && typeof (v as Money).cents === 'number' && typeof (v as Money).currency === 'string';
}

function dateSupport(d: Date, s: Support): void {
  if (Number.isNaN(d.getTime())) return;
  const spoken = spokenDate(d).toLowerCase().split(' ');
  s.dates.add(spoken[0]!);
  s.dates.add(`${spoken[1]} ${spoken[2]}`);
}

function textSupport(text: string): Support {
  const s = emptySupport();
  for (const t of extractTokens(text)) {
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

function valueSupport(value: FactValue | unknown, ref: string): Support {
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
    if (value && /returnPolicy\.free$/.test(ref)) s.policies.add('free returns');
    if (value && /shipping\.free$|freeShipping$/.test(ref)) s.policies.add('free shipping');
    return s;
  }
  if (typeof value === 'string') {
    if (/^\d{4}-\d{2}-\d{2}(T[\d:.]+Z?)?$/.test(value)) {
      dateSupport(new Date(value), s);
      return s;
    }
    merge(s, textSupport(value));
    if (/(^|\.)size$/.test(ref)) {
      const n = normaliseSize(value);
      if (n) s.sizes.add(n);
    }
    return s;
  }
  if (Array.isArray(value)) {
    for (const v of value) merge(s, valueSupport(v, ref));
    return s;
  }
  if (typeof value === 'object') {
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) merge(s, valueSupport(v, `${ref}.${k}`));
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
      return { valid: true, support: valueSupport(v, claim.ref) };
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
    return { valid: true, support: valueSupport(v, claim.ref) };
  }
  const archive = input.archives?.[claim.sourceId];
  if (archive === undefined) return { valid: false, reason: `no archived text for ${claim.sourceId}`, support: emptySupport() };
  const q = normaliseForQuote(claim.quote);
  const minWords = input.minQuoteWords ?? 2;
  if (q.split(' ').filter((w) => w.length > 0).length < minWords) return { valid: false, reason: 'quote is too short to verify', support: emptySupport() };
  if (!normaliseForQuote(archive).includes(q)) return { valid: false, reason: `quote not found in ${claim.sourceId}`, support: emptySupport() };
  const support = textSupport(claim.quote);
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
      return s.dates.has(t.value);
    case 'policy':
      return s.policies.has(t.value);
    case 'quoted':
      return s.quotes.some((q) => q.includes(t.value));
  }
}

/** Check one segment. Exported for tests and for checking a single sentence. */
export function checkSegment(segment: Segment, input: GroundingInput): { supported: boolean; unsupportedTokens: ClaimToken[]; reasons: string[] } {
  const tokens = extractTokens(segment.text);
  const reasons: string[] = [];
  const support = emptySupport();
  for (const c of segment.claims) {
    const r = checkClaim(c, input);
    if (!r.valid) reasons.push(r.reason ?? 'invalid claim');
    else merge(support, r.support);
  }
  const unsupportedTokens = tokens.filter((t) => !tokenSupported(t, support));
  for (const t of unsupportedTokens) reasons.push(`"${t.raw}" (${t.kind}) is not backed by a claim`);
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

/** Exposed for tests: normalised comparison used for quotes. */
export function quoteAppears(quote: string, archive: string): boolean {
  return normaliseForQuote(archive).includes(normaliseForQuote(quote));
}

