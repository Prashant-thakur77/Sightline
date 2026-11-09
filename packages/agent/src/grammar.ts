/**
 * Deterministic voice grammar. Turns an utterance into an intent with slots and a confidence
 * word. Anything it does not recognise becomes "freeform" and goes to the model. During a
 * readback or an offer, confirm, hold, cancel and change are decided by confirm.ts.
 */
import { money, type Confidence, type Money, type Preferences, type Verbosity } from '@sightline/core';
import { matchConfirmationPhrase, type PhraseMatch } from './confirm';
import {
  CATEGORIES,
  COLOURS,
  FITS,
  MATERIALS,
  NECKLINES,
  PATTERNS,
  SIZE_WORDS,
  SLEEVES,
  colourSupport,
  findPhrases,
  type LexEntry,
} from './lexicon';
import { parseForget, parsePreferenceStatement, type ForgetTarget, type MemoryDraft } from './memory';
import { parseMoneyQuestion, type MoneyAsk } from './money';
import { ordinalValue, readMoneyAt, readNumber } from './numbers';
import { expandContractions, normaliseText, words } from './text';

// ---------------------------------------------------------------------------------------------
// Types

export type Intent =
  | 'search'
  | 'choose'
  | 'details'
  | 'compare'
  | 'refine'
  | 'cart'
  | 'confirm'
  | 'hold'
  | 'cancel'
  | 'status'
  | 'check'
  | 'case'
  | 'offer'
  | 'help'
  | 'settings'
  | 'money'
  | 'memory'
  | 'reorder'
  | 'freeform';

export interface ShoppingQuery {
  /** The words the query was read from. */
  text: string;
  category?: string;
  colour?: string;
  size?: string;
  /** Whether the size was spoken or filled in from the user's saved sizes. */
  sizeSource?: 'spoken' | 'saved' | 'memory';
  maxPrice?: Money;
  minPrice?: Money;
  /** neckline, fit, sleeve, pattern, material. */
  attributes: Record<string, string>;
  freeReturns?: boolean;
  /** Words left over that still matter for search ("running", "waterproof"). */
  keywords: string[];
}

export type DetailsTopic =
  | 'general'
  | 'material'
  | 'returns'
  | 'reviews'
  | 'sizing'
  | 'size_chart'
  | 'care'
  | 'shipping'
  | 'seller'
  | 'colour'
  | 'fit'
  | 'price';

export type CaseReason = 'wrong_item' | 'wrong_size' | 'wrong_colour' | 'damaged' | 'not_received' | 'refund' | 'general';

export interface ChooseSlots {
  index?: number;
  by: 'position' | 'last' | 'price_low' | 'price_high' | 'colour';
  value?: string;
  /** True when the choice can only be resolved against options that were not given. */
  needsContext: boolean;
}

export interface RefineSlots {
  cheaper?: boolean;
  colour?: string;
  anyColour?: boolean;
  size?: string;
  anySize?: boolean;
  maxPrice?: Money;
  minPrice?: Money;
  freeReturns?: boolean;
  more?: boolean;
  attributes?: Record<string, string>;
}

export interface CartSlots {
  action: 'buy' | 'add' | 'remove' | 'change';
  index?: number;
  changes?: { size?: string; colour?: string; quantity?: number };
}

export interface SettingsSlots {
  setting: 'speech_rate' | 'verbosity' | 'spending_limit' | 'daily_limit' | 'sizes' | 'voice_mode';
  change?: 'faster' | 'slower';
  verbosity?: Verbosity;
  amount?: Money;
}

interface Base<I extends Intent, S> {
  intent: I;
  slots: S;
  confidence: Confidence;
}

export type ParsedIntent =
  | Base<'search', { query: ShoppingQuery }>
  | Base<'choose', ChooseSlots>
  | Base<'details', { topic: DetailsTopic; aspect?: string; index?: number }>
  | Base<'compare', { indices: number[] | 'all'; aspect?: string }>
  | Base<'refine', RefineSlots>
  | Base<'cart', CartSlots>
  | Base<'confirm', { phrase: PhraseMatch }>
  | Base<'hold', { phrase?: PhraseMatch }>
  | Base<'cancel', { phrase?: PhraseMatch; target?: 'order' }>
  | Base<'status', { topic: 'order' | 'money' | 'shipping' }>
  | Base<'check', { action: 'start' | 'arrived' }>
  | Base<'case', { reason: CaseReason }>
  | Base<'offer', { action: 'accept' | 'decline' | 'status'; phrase?: PhraseMatch }>
  | Base<'help', { topic: 'general' | 'more' | 'repeat' }>
  | Base<'settings', SettingsSlots>
  | Base<'money', MoneyAsk>
  | Base<'memory', MemorySlots>
  | Base<'reorder', { what: 'usual' | 'last' | string }>
  | Base<'freeform', { text: string }>;

export type MemorySlots =
  | { action: 'recall' }
  | { action: 'forget'; target: ForgetTarget }
  | { action: 'state'; drafts: MemoryDraft[]; explicit: boolean };

export interface OptionContext {
  /** 1-based position as spoken. */
  index: number;
  price?: Money;
  colour?: string;
  size?: string;
  title?: string;
}

export interface GrammarContext {
  phase?: 'browsing' | 'readback' | 'offer';
  /** The options last read out, in spoken order. */
  options?: OptionContext[];
  savedSizes?: Preferences['sizes'];
  currency?: string;
}

// ---------------------------------------------------------------------------------------------
// Money and sizes

const MAX_MARKERS = [
  'under',
  'below',
  'less than',
  'at most',
  'no more than',
  'not more than',
  'max',
  'maximum',
  'up to',
  'cheaper than',
  'within',
  'budget of',
  'budget is',
  'for under',
  'for less than',
];
const MIN_MARKERS = ['over', 'above', 'more than', 'at least', 'from', 'starting at', 'minimum'];

interface PriceRead {
  maxPrice?: Money;
  minPrice?: Money;
  used: Set<number>;
}

function markerAt(ws: string[], i: number, markers: string[]): number {
  for (const mk of markers) {
    const parts = mk.split(' ');
    if (parts.every((p, k) => ws[i + k] === p)) return parts.length;
  }
  return 0;
}

function readPrices(ws: string[], currency: string): PriceRead {
  const used = new Set<number>();
  const mark = (a: number, b: number) => {
    for (let k = a; k < b; k++) used.add(k);
  };
  const out: PriceRead = { used };
  for (let i = 0; i < ws.length; i++) {
    if (used.has(i)) continue;
    if (ws[i] === 'between') {
      const a = readMoneyAt(ws, i + 1, currency, false);
      if (a && ws[a.end] === 'and') {
        const b = readMoneyAt(ws, a.end + 1, a.money.currency, false);
        if (b) {
          out.minPrice = a.money;
          out.maxPrice = money(b.money.cents, a.money.currency);
          mark(i, b.end);
          i = b.end - 1;
          continue;
        }
      }
    }
    const maxLen = markerAt(ws, i, MAX_MARKERS);
    if (maxLen) {
      const r = readMoneyAt(ws, i + maxLen, currency, false);
      if (r) {
        out.maxPrice = r.money;
        mark(i, r.end);
        i = r.end - 1;
        continue;
      }
    }
    const minLen = markerAt(ws, i, MIN_MARKERS);
    if (minLen) {
      const r = readMoneyAt(ws, i + minLen, currency, false);
      if (r) {
        out.minPrice = r.money;
        mark(i, r.end);
        if (ws[r.end] === 'to') {
          const b = readMoneyAt(ws, r.end + 1, r.money.currency, false);
          if (b) {
            out.maxPrice = b.money;
            mark(r.end, b.end);
            i = b.end - 1;
            continue;
          }
        }
        i = r.end - 1;
        continue;
      }
    }
    // A bare amount with a currency is read as a budget: "a $40 sweater".
    const r = readMoneyAt(ws, i, currency, true);
    if (r && out.maxPrice === undefined) {
      out.maxPrice = r.money;
      mark(r.start, r.end);
      i = r.end - 1;
    }
  }
  return out;
}

/** Letter sizes said on their own; single letters only count after the word "size". */
const STANDALONE_SIZE_WORDS: LexEntry[] = SIZE_WORDS.map((s) => ({
  ...s,
  aliases: s.aliases.filter((a) => a.length > 3 || /^\d?x+[sl]$/.test(a)),
}));

interface SizeRead {
  size: string;
  start: number;
  end: number;
}

function readSizes(ws: string[]): SizeRead | undefined {
  for (let i = 0; i < ws.length; i++) {
    if (ws[i] !== 'size') continue;
    const from = ws[i + 1] === 'to' || ws[i + 1] === 'is' ? i + 2 : i + 1;
    const rest = ws.slice(from);
    const lettered = findPhrases(rest, SIZE_WORDS)[0];
    if (lettered && lettered.start === 0) return { size: lettered.canonical, start: i, end: from + lettered.end };
    const n = readNumber(ws, from);
    if (n) return { size: String(n.value), start: i, end: n.end };
  }
  const m = findPhrases(ws, STANDALONE_SIZE_WORDS)[0];
  return m ? { size: m.canonical, start: m.start, end: m.end } : undefined;
}

// ---------------------------------------------------------------------------------------------
// Shopping queries

const STOPWORDS = new Set(
  (
    'i me my we a an the some any something anything need needs want wanted would like looking look for find show get ' +
    'buy search searching please with that is it its in of to and or can could you do have has one ones me some ' +
    'which are also just really very new good nice pair maybe around about under over size sizes colour color in ' +
    'only free returns return cheap cheaper budget price priced costs cost dollars dollar bucks am going'
  ).split(' '),
);

const ATTRIBUTE_LEXICONS: Array<[string, LexEntry[]]> = [
  ['neckline', NECKLINES],
  ['fit', FITS],
  ['sleeve', SLEEVES],
  ['pattern', PATTERNS],
  ['material', MATERIALS],
];

export interface ParseQueryOptions {
  savedSizes?: Preferences['sizes'];
  currency?: string;
}

/**
 * "navy crew-neck sweater, medium, under forty dollars" becomes
 * { category: 'sweater', colour: 'navy', attributes: { neckline: 'crew-neck' }, size: 'M', maxPrice: $40 }.
 * The saved size for the category's size group fills in when no size is spoken.
 */
export function parseShoppingQuery(text: string, opts: ParseQueryOptions = {}): ShoppingQuery {
  const currency = opts.currency ?? 'USD';
  const ws = expandContractions(words(text));
  const used = new Set<number>();
  const take = (a: number, b: number) => {
    for (let k = a; k < b; k++) used.add(k);
  };
  const query: ShoppingQuery = { text: normaliseText(text), attributes: {}, keywords: [] };

  const prices = readPrices(ws, currency);
  for (const k of prices.used) used.add(k);
  if (prices.maxPrice) query.maxPrice = prices.maxPrice;
  if (prices.minPrice) query.minPrice = prices.minPrice;

  const freeIdx = ws.findIndex((w, i) => w === 'free' && (ws[i + 1] === 'returns' || ws[i + 1] === 'return'));
  if (freeIdx >= 0) {
    query.freeReturns = true;
    take(freeIdx, freeIdx + 2);
  }

  const free = (m: { start: number; end: number }) => {
    for (let k = m.start; k < m.end; k++) if (used.has(k)) return false;
    return true;
  };

  const categories = findPhrases(ws, CATEGORIES, true).filter(free);
  const head = categories[categories.length - 1];
  if (head) {
    query.category = head.canonical;
    take(head.start, head.end);
  }

  for (const [key, lex] of ATTRIBUTE_LEXICONS) {
    const m = findPhrases(ws, lex).filter(free)[0];
    if (m) {
      query.attributes[key] = m.canonical;
      take(m.start, m.end);
    }
  }

  const colour = findPhrases(ws, COLOURS).filter(free)[0];
  if (colour) {
    query.colour = colour.canonical;
    take(colour.start, colour.end);
  }

  const size = readSizes(ws.map((w, i) => (used.has(i) ? '\u0000' : w)));
  if (size) {
    query.size = size.size;
    query.sizeSource = 'spoken';
    take(size.start, size.end);
  } else if (head?.entry.sizeDomain && opts.savedSizes?.[head.entry.sizeDomain]) {
    query.size = opts.savedSizes[head.entry.sizeDomain];
    query.sizeSource = 'saved';
  }

  query.keywords = ws.filter((w, i) => !used.has(i) && !STOPWORDS.has(w) && !/^\d/.test(w) && w.length > 1);
  return query;
}

/** Search text for a catalogue API, from the structured query. */
export function queryToSearchText(q: ShoppingQuery): string {
  const parts = [q.colour, ...Object.values(q.attributes), ...q.keywords, q.category].filter((p): p is string => !!p);
  return [...new Set(parts)].join(' ');
}

// ---------------------------------------------------------------------------------------------
// Intent parsing

const FILLER_LEAD = new Set(['um', 'umm', 'uh', 'er', 'erm', 'okay', 'ok', 'so', 'well', 'hey', 'oh', 'alright', 'please']);

function clean(utterance: string): string[] {
  const ws = expandContractions(words(utterance));
  let i = 0;
  while (i < ws.length && FILLER_LEAD.has(ws[i]!)) i++;
  const out = ws.slice(i);
  while (out.length > 0 && out[out.length - 1] === 'please') out.pop();
  return out;
}

const startsWithAny = (s: string, phrases: string[]): string | undefined => phrases.find((p) => s === p || s.startsWith(`${p} `));
const containsAny = (s: string, phrases: string[]): string | undefined => phrases.find((p) => ` ${s} `.includes(` ${p} `));

function result<I extends Intent>(intent: I, slots: Extract<ParsedIntent, { intent: I }>['slots'], confidence: Confidence): ParsedIntent {
  return { intent, slots, confidence } as ParsedIntent;
}

/** Option index from "two", "number two", "option 2", "the second one", "2". */
function readIndex(ws: string[]): number | undefined {
  for (let i = 0; i < ws.length; i++) {
    const w = ws[i]!;
    const ord = ordinalValue(w);
    if (ord !== undefined) return ord;
    if (w === 'number' || w === 'option' || w === 'item' || w === 'choice') {
      const n = readNumber(ws, i + 1);
      if (n && Number.isInteger(n.value)) return n.value;
    }
  }
  return undefined;
}

function readAllIndices(ws: string[]): number[] {
  const out: number[] = [];
  for (let i = 0; i < ws.length; i++) {
    const w = ws[i]!;
    const ord = ordinalValue(w);
    if (ord !== undefined) {
      out.push(ord);
      continue;
    }
    if (w === 'a') continue;
    const n = readNumber([w], 0);
    if (n && Number.isInteger(n.value) && n.value >= 1 && n.value <= 20) out.push(n.value);
  }
  return [...new Set(out)];
}

const BARE_NUMBER = /^(?:(?:number|option|item|choice)\s+)?(one|two|three|four|five|six|seven|eight|nine|ten|\d{1,2})$/;

function resolveChoice(slots: ChooseSlots, ctx: GrammarContext): ParsedIntent {
  const opts = ctx.options;
  if (slots.by === 'position') {
    const ok = !opts || (slots.index !== undefined && slots.index >= 1 && slots.index <= opts.length);
    return result('choose', { ...slots, needsContext: false }, ok ? 'sure' : 'not_sure');
  }
  if (!opts || opts.length === 0) return result('choose', { ...slots, needsContext: true }, 'not_sure');
  if (slots.by === 'last') return result('choose', { ...slots, index: opts[opts.length - 1]!.index, needsContext: false }, 'sure');
  if (slots.by === 'price_low' || slots.by === 'price_high') {
    const priced = opts.filter((o) => o.price);
    if (priced.length < 2) return result('choose', { ...slots, needsContext: true }, 'not_sure');
    const sorted = [...priced].sort((a, b) => a.price!.cents - b.price!.cents);
    const pick = slots.by === 'price_low' ? sorted[0]! : sorted[sorted.length - 1]!;
    const tie = sorted.filter((o) => o.price!.cents === pick.price!.cents).length > 1;
    if (tie) return result('choose', { ...slots, needsContext: false }, 'not_sure');
    return result('choose', { ...slots, index: pick.index, needsContext: false }, opts.length === 2 ? 'sure' : 'fairly_sure');
  }
  // colour
  const matches = opts.filter((o) => slots.value !== undefined && colourSupport(o.colour).has(slots.value));
  if (matches.length === 1) return result('choose', { ...slots, index: matches[0]!.index, needsContext: false }, 'sure');
  return result('choose', { ...slots, needsContext: false }, 'not_sure');
}

const CHOOSE_LEADS = [
  'i will take',
  'i will go with',
  'let us go with',
  'go with',
  'i choose',
  'i pick',
  'choose',
  'pick',
  'i want',
  'i like',
  'i would like',
];

/** "two", "number two", "option 2", "second", "the second one". */
function indexFromPhrase(body: string): number | undefined {
  const ws = body.split(' ').filter((w) => w.length > 0);
  if (ws[0] === 'the') ws.shift();
  if (ws[0] === 'number' || ws[0] === 'option' || ws[0] === 'item' || ws[0] === 'choice') ws.shift();
  if (ws[ws.length - 1] === 'one' && ws.length > 1) ws.pop();
  if (ws.length !== 1) return undefined;
  const ord = ordinalValue(ws[0]!);
  if (ord !== undefined) return ord;
  const n = readNumber(ws, 0);
  return n && Number.isInteger(n.value) && n.value >= 1 && n.value <= 20 ? n.value : undefined;
}

function parseChoose(s: string, ctx: GrammarContext): ParsedIntent | null {
  if (BARE_NUMBER.test(s)) return resolveChoice({ index: indexFromPhrase(s)!, by: 'position', needsContext: false }, ctx);
  const lead = startsWithAny(s, CHOOSE_LEADS);
  let body = lead ? s.slice(lead.length).trim() : s;
  if (!lead && !body.startsWith('the ')) return null;
  const idx = indexFromPhrase(body);
  if (idx !== undefined) return resolveChoice({ index: idx, by: 'position', needsContext: false }, ctx);
  if (!body.startsWith('the ')) return null;
  body = body.slice(4);
  if (/^last( one)?$/.test(body)) return resolveChoice({ by: 'last', needsContext: false }, ctx);
  if (/^(cheaper|cheapest|less expensive|least expensive)( one)?$/.test(body)) return resolveChoice({ by: 'price_low', needsContext: false }, ctx);
  if (/^(more expensive|most expensive|pricier|priciest)( one)?$/.test(body)) return resolveChoice({ by: 'price_high', needsContext: false }, ctx);
  const m = /^(.+) one$/.exec(body);
  if (m) {
    const ws = m[1]!.split(' ');
    const colour = findPhrases(ws, COLOURS)[0];
    if (colour && colour.start === 0 && colour.end === ws.length)
      return resolveChoice({ by: 'colour', value: colour.canonical, needsContext: false }, ctx);
  }
  return null;
}

const DETAIL_TOPICS: Array<[DetailsTopic, string[]]> = [
  ['size_chart', ['size chart', 'size guide', 'sizing chart']],
  ['returns', ['return policy', 'returns policy', 'returns', 'can i return it', 'can i send it back', 'refund policy']],
  ['reviews', ['what do reviews say', 'what do the reviews say', 'reviews', 'what do people say', 'ratings', 'rating']],
  ['material', ['what is it made of', 'what is it made from', 'made of', 'material', 'fabric', 'what is the material']],
  ['care', ['how do i wash it', 'wash', 'washable', 'care instructions', 'care', 'dry clean', 'machine wash']],
  ['sizing', ['how does it fit', 'does it run small', 'does it run large', 'run small', 'runs small', 'true to size', 'sizing']],
  ['fit', ['fit', 'is it loose', 'is it tight', 'is it slim']],
  ['shipping', ['shipping', 'delivery', 'how long to arrive', 'how long does shipping take']],
  ['seller', ['who sells it', 'who is the seller', 'seller', 'which store', 'what store']],
  ['colour', ['what colour is it', 'what color is it', 'what colour', 'what color', 'is it more']],
  ['price', ['how much is it', 'how much does it cost', 'how much', 'what is the price', 'price']],
];

function parseDetails(s: string, ws: string[]): ParsedIntent | null {
  const general = startsWithAny(s, ['tell me more', 'more details', 'more about', 'details', 'tell me about', 'what about', 'describe']);
  const reviewAbout = /^what do (?:the )?(?:reviews|reviewers|people) say about (.+)$/.exec(s);
  if (reviewAbout) return result('details', { topic: 'reviews', aspect: reviewAbout[1]!, ...indexSlot(ws) }, 'sure');
  for (const [topic, phrases] of DETAIL_TOPICS) {
    const hit = containsAny(s, phrases);
    if (hit) return result('details', { topic, ...indexSlot(ws) }, s === hit ? 'sure' : 'fairly_sure');
  }
  // "is it wool?", "is it navy?", "does it come in medium?"
  if (QUESTIONISH.test(s)) {
    if (findPhrases(ws, MATERIALS).length > 0) return result('details', { topic: 'material', ...indexSlot(ws) }, 'fairly_sure');
    if (findPhrases(ws, COLOURS).length > 0) return result('details', { topic: 'colour', ...indexSlot(ws) }, 'fairly_sure');
    if (findPhrases(ws, SIZE_WORDS).length > 0) return result('details', { topic: 'sizing', ...indexSlot(ws) }, 'fairly_sure');
  }
  if (general) return result('details', { topic: 'general', ...indexSlot(ws) }, general === s ? 'sure' : 'fairly_sure');
  return null;
}

function indexSlot(ws: string[]): { index?: number } {
  const idx = readIndex(ws) ?? (ws.length > 0 ? readAllIndices(ws.slice(-1))[0] : undefined);
  return idx !== undefined ? { index: idx } : {};
}

const QUESTIONISH = /^(what|how|is|does|do|can|could|who|which|tell|are|will|when|why|where)\b/;

const SEARCH_LEADS = [
  'i need',
  'i am looking for',
  'looking for',
  'i want to buy',
  'i want',
  'i would like',
  'find me',
  'find',
  'show me',
  'search for',
  'search',
  'get me',
  'do you have',
  'have you got',
  'can you find',
  'could you find',
  'can you find me',
  'help me find',
  'i am after',
  'buy me',
];

function parseRefine(s: string, ctx: GrammarContext): ParsedIntent | null {
  if (/^(more|show me more|more options|other options|something else|any others|next|next ones|what else|keep going|different ones)$/.test(s))
    return result('refine', { more: true }, 'sure');
  if (QUESTIONISH.test(s)) return null;
  const slots: RefineSlots = {};
  let recognised = 0;
  if (containsAny(s, ['cheaper', 'less expensive', 'lower price', 'cheaper ones', 'something cheaper'])) {
    slots.cheaper = true;
    recognised++;
  }
  if (containsAny(s, ['any colour', 'any color', 'colour does not matter', 'color does not matter'])) {
    slots.anyColour = true;
    recognised++;
  }
  if (containsAny(s, ['any size'])) {
    slots.anySize = true;
    recognised++;
  }
  const q = parseShoppingQuery(s, { currency: ctx.currency ?? 'USD' });
  if (q.category) return null;
  if (q.colour && !slots.anyColour) {
    slots.colour = q.colour;
    recognised++;
  }
  if (q.size && !slots.anySize) {
    slots.size = q.size;
    recognised++;
  }
  if (q.maxPrice) {
    slots.maxPrice = q.maxPrice;
    recognised++;
  }
  if (q.minPrice) {
    slots.minPrice = q.minPrice;
    recognised++;
  }
  if (q.freeReturns) {
    slots.freeReturns = true;
    recognised++;
  }
  if (Object.keys(q.attributes).length > 0) {
    slots.attributes = q.attributes;
    recognised++;
  }
  if (recognised === 0) return null;
  const leftovers = q.keywords.filter((k) => !['ones', 'only', 'something', 'show', 'instead', 'those', 'these', 'them'].includes(k));
  return result('refine', slots, leftovers.length === 0 ? 'sure' : 'fairly_sure');
}

function parseCart(s: string, ws: string[], ctx: GrammarContext): ParsedIntent | null {
  const buy = /^(?:buy|order|get|get me|i will take|i will buy|i want to buy|i would like to buy) (.+?)(?: now| please)?$/.exec(s);
  if (buy) {
    if (/^(it|this|that|this one|that one)$/.test(buy[1]!)) return result('cart', { action: 'buy' }, 'sure');
    const idx = indexFromPhrase(buy[1]!);
    if (idx !== undefined) return result('cart', { action: 'buy', index: idx }, 'sure');
  }
  if (containsAny(s, ['add to cart', 'add it to my cart', 'add it to the cart', 'add to my cart', 'put it in my cart', 'put it in the cart', 'add it']))
    return result('cart', { action: 'add', ...indexSlot(ws) }, 'sure');
  if (/^(remove|delete|take out)( it| that| this)?( from (my|the) cart)?$/.test(s) || containsAny(s, ['remove it', 'take it out of my cart', 'remove from cart']))
    return result('cart', { action: 'remove' }, 'sure');
  const changeLead = startsWithAny(s, ['change', 'make it', 'switch to', 'switch it to', 'i want it in', 'can i get it in', 'can i have it in', 'actually']);
  if (changeLead || ctx.phase === 'readback') {
    const changes: CartSlots['changes'] = {};
    const q = parseShoppingQuery(s);
    if (q.size) changes.size = q.size;
    if (q.colour) changes.colour = q.colour;
    const qtyIdx = ws.findIndex((w) => w === 'quantity');
    const qtyStart = qtyIdx >= 0 ? qtyIdx + 1 : s.startsWith('make it ') ? 2 : -1;
    if (qtyStart >= 0) {
      const after = ws[qtyStart] === 'to' ? qtyStart + 1 : qtyStart;
      const n = readNumber(ws, after);
      if (n && Number.isInteger(n.value) && n.value > 0) changes.quantity = n.value;
    }
    if (Object.keys(changes).length > 0) return result('cart', { action: 'change', changes }, changeLead ? 'sure' : 'fairly_sure');
    if (changeLead && changeLead !== 'actually') return result('cart', { action: 'change' }, 'not_sure');
  }
  return null;
}

function parseSettings(s: string): ParsedIntent | null {
  if (/^(talk|speak|go|read) faster$|^faster$|^speed up$|^(talk|speak) quicker$/.test(s))
    return result('settings', { setting: 'speech_rate', change: 'faster' }, 'sure');
  if (/^(talk|speak|go|read) slower$|^slower$|^slow down$|^(talk|speak) more slowly$/.test(s))
    return result('settings', { setting: 'speech_rate', change: 'slower' }, 'sure');
  if (/^(be brief|be briefer|brief|shorter|keep it short|less detail|be quick|short answers)$/.test(s))
    return result('settings', { setting: 'verbosity', verbosity: 'brief' }, 'sure');
  if (/^(more detail|be detailed|detailed|give me more detail|more detailed|longer answers)$/.test(s))
    return result('settings', { setting: 'verbosity', verbosity: 'detailed' }, 'sure');
  if (/^(normal detail|standard detail|normal|back to normal)$/.test(s))
    return result('settings', { setting: 'verbosity', verbosity: 'standard' }, 'sure');
  const limit = /(spending limit|order limit|daily limit|limit per day|limit for today|budget limit|my limit)/.exec(s);
  if (limit && /(change|set|raise|lower|increase|decrease|update|what is|make)/.test(s)) {
    const setting = /daily|per day|today/.test(limit[1]!) ? 'daily_limit' : 'spending_limit';
    const ws = s.split(' ');
    const toIdx = ws.lastIndexOf('to');
    const amount = toIdx >= 0 ? readMoneyAt(ws, toIdx + 1, 'USD', false) : null;
    return result('settings', { setting, ...(amount ? { amount: amount.money } : {}) }, 'sure');
  }
  if (/^(change|set|update) my sizes?$|^my sizes?$/.test(s)) return result('settings', { setting: 'sizes' }, 'sure');
  if (/(use my screen reader|use your voice|use your own voice|stop using your voice|voice settings)/.test(s))
    return result('settings', { setting: 'voice_mode' }, 'fairly_sure');
  return null;
}

function parseStatus(s: string): ParsedIntent | null {
  if (containsAny(s, ['where is my money', 'where is my refund', 'money timeline', 'did i pay', 'was i charged', 'what did i spend', 'my payments', 'did i get my refund', 'have i been refunded']))
    return result('status', { topic: 'money' }, 'sure');
  if (containsAny(s, ['did it ship', 'has it shipped', 'has it been shipped', 'is it shipped', 'when will it arrive', 'when does it arrive', 'when is it arriving', 'when will it come', 'tracking', 'track my order', 'track it']))
    return result('status', { topic: 'shipping' }, 'sure');
  if (containsAny(s, ['where is my order', 'where is my parcel', 'where is my package', 'order status', 'my orders', 'what did i order', 'status of my order', 'what have i bought']))
    return result('status', { topic: 'order' }, 'sure');
  return null;
}

function parseCase(s: string): ParsedIntent | null {
  if (containsAny(s, ['never came', 'never arrived', 'did not arrive', 'has not arrived', 'never got it', 'not received', 'did not get it', 'it is missing', 'still not here', 'never showed up']))
    return result('case', { reason: 'not_received' }, 'sure');
  if (containsAny(s, ['damaged', 'broken', 'torn', 'ripped', 'stained', 'smashed', 'cracked', 'has a hole']))
    return result('case', { reason: 'damaged' }, 'sure');
  if (containsAny(s, ['wrong size', 'does not fit', 'too small', 'too big', 'too large']))
    return result('case', { reason: 'wrong_size' }, 'fairly_sure');
  if (containsAny(s, ['size is wrong'])) return result('case', { reason: 'wrong_size' }, 'fairly_sure');
  if (containsAny(s, ['wrong colour', 'wrong color', 'not the right colour', 'not the right color', 'colour is wrong', 'color is wrong']))
    return result('case', { reason: 'wrong_colour' }, 'sure');
  if (containsAny(s, ['wrong item', 'not what i ordered', 'not what i bought', 'they sent the wrong', 'wrong thing']))
    return result('case', { reason: 'wrong_item' }, 'sure');
  if (containsAny(s, ['get my money back', 'money back', 'i want a refund', 'refund me', 'i want my money', 'refund it']))
    return result('case', { reason: 'refund' }, 'sure');
  if (/^(this|it|that) is wrong$|^something is wrong$|^this is not right$|^open a case$|^i want to complain$|^(i want to )?(return it|send it back)$|^dispute( it)?$/.test(s))
    return result('case', { reason: 'general' }, 'sure');
  return null;
}

function parseCheck(s: string): ParsedIntent | null {
  if (containsAny(s, ['check my delivery', 'check my parcel', 'check my package', 'check the parcel', 'check the package', 'check the delivery', 'start the check', 'check it now', 'check it', 'verify it', 'scan it']))
    return result('check', { action: 'start' }, 'sure');
  if (/^(it|my parcel|the parcel|my package|the package|my order|the order|the sweater|my delivery) (arrived|came|is here|has arrived|got here)$|^(it is|it has) (here|arrived)$|^(it|they) came$/.test(s))
    return result('check', { action: 'arrived' }, 'sure');
  return null;
}

function parseOffer(s: string): ParsedIntent | null {
  if (containsAny(s, ['what did they offer', 'what is the offer', 'what was the offer', 'read the offer', 'what are they offering', 'any offer']))
    return result('offer', { action: 'status' }, 'sure');
  if (/^(i )?(accept|accept it|accept the offer|accept the refund)$/.test(s)) return result('offer', { action: 'accept' }, 'fairly_sure');
  if (/^(i )?(decline|decline it|decline the offer|reject it|reject the offer|refuse)$/.test(s)) return result('offer', { action: 'decline' }, 'fairly_sure');
  return null;
}

function parseCompare(s: string, ws: string[]): ParsedIntent | null {
  if (s.startsWith('compare') || /^what is the difference/.test(s) || s === 'compare them') {
    const indices = readAllIndices(ws.slice(1));
    const aspect = /(?:by|on|for) (price|material|returns|colour|color|size|reviews|ratings)$/.exec(s)?.[1];
    return result('compare', { indices: indices.length >= 2 ? indices : 'all', ...(aspect ? { aspect } : {}) }, indices.length === 1 ? 'not_sure' : 'sure');
  }
  const which = /^which (?:one )?is (softer|warmer|cheaper|better|lighter|heavier|bigger|smaller|thicker|thinner|more expensive|nicer|longer|shorter)/.exec(s);
  if (which) return result('compare', { indices: 'all', aspect: which[1]! }, 'fairly_sure');
  return null;
}

function parseHelp(s: string): ParsedIntent | null {
  if (/^(repeat|repeat that|say that again|say it again|again|what did you say|come again|pardon|sorry what|one more time)$/.test(s))
    return result('help', { topic: 'repeat' }, 'sure');
  if (/^(more help|other commands|what else can i say)$/.test(s)) return result('help', { topic: 'more' }, 'sure');
  if (/^(help|help me|what can i say|what can you do|commands|how does this work|i am lost|options)$/.test(s))
    return result('help', { topic: 'general' }, 'sure');
  return null;
}

/** "What do you remember about me?", "forget my size". Statements are read later, after choices. */
function parseMemoryCommand(s: string): ParsedIntent | null {
  if (/^(?:what (?:do|did) you (?:remember|know) about me|what have you remembered|what do you remember|what are my (?:preferences|sizes)|tell me what you (?:remember|know)(?: about me)?|what do you have saved(?: about me)?)$/.test(s))
    return result('memory', { action: 'recall' }, 'sure');
  const target = parseForget(s);
  return target ? result('memory', { action: 'forget', target }, 'sure') : null;
}

/** "I'm a medium in sweaters", "nothing with wool": a lasting preference, said on its own. */
function parseMemoryStatement(utterance: string): ParsedIntent | null {
  const read = parsePreferenceStatement(utterance);
  if (read.drafts.length === 0 || read.hasSearch || !read.lasting) return null;
  return result('memory', { action: 'state', drafts: read.drafts, explicit: read.explicit }, 'sure');
}

function parseMoney(utterance: string): ParsedIntent | null {
  const ask = parseMoneyQuestion(utterance);
  return ask ? result('money', ask, 'sure') : null;
}

/** "Buy my usual again", "order the same again", "reorder the sweater". */
function parseReorder(s: string): ParsedIntent | null {
  if (/^(?:(?:buy|order|get|reorder|re order)(?: me)? )?(?:my|the) usual(?: one)?(?: again)?$/.test(s)) return result('reorder', { what: 'usual' }, 'sure');
  if (/^(?:(?:buy|order|get)(?: me)? (?:it|that|the same|the same thing|the same one|that one) again|reorder(?: it| that)?|order again|buy again)$/.test(s))
    return result('reorder', { what: 'last' }, 'sure');
  const named = /^(?:buy|order|get|reorder)(?: me)? (?:the|my) (.+?) again$/.exec(s) ?? /^reorder (?:the|my) (.+)$/.exec(s);
  return named ? result('reorder', { what: named[1]! }, 'fairly_sure') : null;
}

function parseGeneralCancelHold(s: string): ParsedIntent | null {
  if (/^(cancel|stop|never mind|nevermind|forget it|quiet|be quiet|shut up|enough)( it| that)?$/.test(s)) return result('cancel', {}, 'sure');
  if (/^cancel (my|the) order$/.test(s)) return result('cancel', { target: 'order' }, 'sure');
  if (/^(wait|hold on|hang on|one moment|one second|pause|give me a (minute|moment|second))$/.test(s)) return result('hold', {}, 'sure');
  return null;
}

function parseSearch(s: string, ctx: GrammarContext): ParsedIntent | null {
  const lead = startsWithAny(s, SEARCH_LEADS);
  const body = lead ? s.slice(lead.length).trim() : s;
  if (lead && body.length === 0) return null;
  const query = parseShoppingQuery(body, { savedSizes: ctx.savedSizes, currency: ctx.currency });
  if (lead) return result('search', { query }, query.category ? 'sure' : 'fairly_sure');
  if (query.category) return result('search', { query }, 'fairly_sure');
  return null;
}

const YES = new Set([
  'yes',
  'yeah',
  'yep',
  'yup',
  'sure',
  'ok',
  'okay',
  'alright',
  'all right',
  'please do',
  'do it',
  'go ahead',
  'go for it',
  'sure thing',
  'why not',
  'sounds good',
  'let us do that',
  'let us do it',
  'that would be great',
  'definitely',
  'absolutely',
  'of course',
  'yes do it',
  'yes go ahead',
  'yes do that',
]);
const NO = new Set(['no', 'nope', 'nah', 'no thanks', 'no thank you', 'not now', 'not really', 'no need', 'skip it', 'leave it', 'no do not']);

/**
 * A plain "yes" or "no" to a question the assistant just asked ("Want me to try up to $45?").
 * Anything longer or hedged is not an answer here and goes through the normal grammar. This is
 * never used to confirm a purchase: the readback has its own two-key confirmation.
 */
export function parseYesNo(utterance: string): 'yes' | 'no' | null {
  let ws = expandContractions(words(utterance));
  while (ws.length > 0 && ['um', 'umm', 'uh', 'er', 'erm', 'oh', 'well', 'hmm'].includes(ws[0]!)) ws = ws.slice(1);
  while (ws.length > 0 && ['please', 'thanks', 'then'].includes(ws[ws.length - 1]!)) ws = ws.slice(0, -1);
  if (ws.length >= 2 && ws[ws.length - 2] === 'thank' && ws[ws.length - 1] === 'you' && ws[0] !== 'no') ws = ws.slice(0, -2);
  const s = ws.join(' ');
  if (YES.has(s) || /^(yes|yeah|sure|okay|ok) (please|yes)$/.test(s)) return 'yes';
  if (NO.has(s) || /^no (no|thanks|thank you)$/.test(s)) return 'no';
  return null;
}

/**
 * Parse one utterance. Order matters: phase-specific decisions first, then commands that are
 * whole-utterance matches, then keyword rules, then search, then freeform.
 */
export function parseIntent(utterance: string, ctx: GrammarContext = {}): ParsedIntent {
  const ws = clean(utterance);
  const s = ws.join(' ');
  if (s.length === 0) return result('freeform', { text: '' }, 'not_sure');

  if (ctx.phase === 'readback' || ctx.phase === 'offer') {
    const phrase = matchConfirmationPhrase(utterance, { phase: ctx.phase });
    if (ctx.phase === 'readback') {
      if (phrase.decision === 'confirm') return result('confirm', { phrase }, 'sure');
      if (phrase.decision === 'hold') return result('hold', { phrase }, 'sure');
      if (phrase.decision === 'cancel') return result('cancel', { phrase }, 'sure');
      if (phrase.decision === 'change') {
        const cart = parseCart(s, ws, ctx);
        return cart ?? result('cart', { action: 'change' }, 'not_sure');
      }
    } else {
      if (phrase.decision === 'confirm') return result('offer', { action: 'accept', phrase }, 'sure');
      if (phrase.decision === 'cancel' && /\b(decline|reject|refuse|no)\b/.test(s)) return result('offer', { action: 'decline', phrase }, 'sure');
      if (phrase.decision === 'cancel') return result('cancel', { phrase }, 'sure');
      if (phrase.decision === 'hold') return result('hold', { phrase }, 'sure');
    }
  }

  return (
    parseHelp(s) ??
    parseGeneralCancelHold(s) ??
    parseSettings(s) ??
    parseMemoryCommand(s) ??
    parseMoney(utterance) ??
    parseStatus(s) ??
    parseCase(s) ??
    parseCheck(s) ??
    parseOffer(s) ??
    parseCompare(s, ws) ??
    parseChoose(s, ctx) ??
    parseReorder(s) ??
    parseCart(s, ws, ctx) ??
    (startsWithAny(s, ['tell me more', 'more details']) ? parseDetails(s, ws) : null) ??
    parseMemoryStatement(utterance) ??
    parseRefine(s, ctx) ??
    parseSearchFirst(s, ws, ctx) ??
    result('freeform', { text: utterance.trim() }, 'not_sure')
  );
}

/**
 * Details questions and searches share words ("returns", "material"). A search lead, or a product
 * category in a sentence that is not a question, means search; otherwise details come first.
 */
function parseSearchFirst(s: string, ws: string[], ctx: GrammarContext): ParsedIntent | null {
  if (startsWithAny(s, SEARCH_LEADS)) return parseSearch(s, ctx);
  if (QUESTIONISH.test(s)) return parseDetails(s, ws);
  if (parseShoppingQuery(s).category) return parseSearch(s, ctx);
  return parseDetails(s, ws) ?? parseSearch(s, ctx);
}
