/**
 * What the buyer asked for, read by code from the buyer's own words.
 *
 * `buyerAsked` runs the grammar (parseIntent) over the buyer's utterances in the order they were
 * said and keeps the colour, size and material the buyer stated. Only the buyer's utterances go
 * in; model text never does. The latest statement wins, so an explicit change of mind ("actually
 * charcoal is fine") replaces the earlier "navy". A new search starts the request again.
 *
 * `askedConflicts` compares that request with the variant in the cart. The payment gate uses both
 * (IntentGuard), so a buyer who said "navy" is not charged for charcoal even after saying
 * "confirm purchase".
 */
import { parseIntent } from './grammar';
import { COLOURS, MATERIALS, SIZE_WORDS, colourSupport, findPhrases, materialSupport, normaliseSize } from './lexicon';
import { expandContractions, words } from './text';

export type AskedAttribute = 'colour' | 'size' | 'material';

export interface AskedValue {
  /** Canonical value from the lexicon ("navy", "M", "merino"). */
  value: string;
  /** The buyer's own words it was read from. */
  utterance: string;
  at?: string;
}

export type BuyerAsked = Partial<Record<AskedAttribute, AskedValue>>;

export interface BuyerUtterance {
  text: string;
  at?: string;
}

/**
 * Words that, right before a colour, size or material, turn it into something other than a
 * request for it ("anything but navy", "not navy", "no wool"). Such an utterance states nothing;
 * it does not clear an earlier request either.
 */
const EXCLUDING = new Set(['not', 'no', 'except', 'but', 'without', 'never']);
const EXCLUDING_PAIRS = ['other than', 'instead of'];

function excludes(text: string): boolean {
  const ws = expandContractions(words(text));
  const named = [...findPhrases(ws, COLOURS), ...findPhrases(ws, MATERIALS), ...findPhrases(ws, SIZE_WORDS)];
  return named.some((m) => EXCLUDING.has(ws[m.start - 1] ?? '') || EXCLUDING_PAIRS.includes(`${ws[m.start - 2]} ${ws[m.start - 1]}`));
}

/** Read the colour, size and material the buyer asked for from their own utterances, oldest first. */
export function buyerAsked(utterances: readonly BuyerUtterance[]): BuyerAsked {
  let asked: BuyerAsked = {};
  for (const u of utterances) {
    const text = typeof u?.text === 'string' ? u.text.slice(0, 500) : '';
    if (!text.trim()) continue;
    const said = (value: string | undefined): AskedValue | undefined => (value ? { value, utterance: text, ...(u.at ? { at: u.at } : {}) } : undefined);
    const p = parseIntent(text);
    const negated = excludes(text);
    switch (p.intent) {
      case 'search': {
        // A new search is a new request: what was asked before no longer applies.
        asked = {};
        if (negated) break;
        const q = p.slots.query;
        const colour = said(q.colour);
        const size = q.sizeSource === 'spoken' ? said(q.size) : undefined;
        const material = said(q.attributes.material);
        if (colour) asked.colour = colour;
        if (size) asked.size = size;
        if (material) asked.material = material;
        break;
      }
      case 'refine': {
        const r = p.slots;
        if (r.anyColour) delete asked.colour;
        if (r.anySize) delete asked.size;
        if (negated) break;
        const colour = said(r.colour);
        const size = said(r.size);
        const material = said(r.attributes?.material);
        if (colour) asked.colour = colour;
        if (size) asked.size = size;
        if (material) asked.material = material;
        break;
      }
      case 'cart': {
        if (negated) break;
        const colour = said(p.slots.changes?.colour);
        const size = said(p.slots.changes?.size);
        if (colour) asked.colour = colour;
        if (size) asked.size = size;
        break;
      }
      case 'choose': {
        // "The charcoal one": choosing by colour is stating it.
        if (!negated && p.slots.by === 'colour') {
          const colour = said(p.slots.value);
          if (colour) asked.colour = colour;
        }
        break;
      }
      default:
        break;
    }
  }
  return asked;
}

// ---------------------------------------------------------------------------------------------
// Comparing with the cart

/** Shades that belong to a plain colour word: asking for "blue" accepts navy; asking for navy does not accept royal blue. */
const COLOUR_FAMILIES: Record<string, string[]> = {
  blue: ['navy', 'light blue', 'dark blue', 'sky blue', 'royal blue', 'cobalt'],
  grey: ['light grey', 'dark grey', 'heather grey', 'charcoal', 'silver'],
  green: ['dark green', 'forest green', 'olive', 'sage', 'mint', 'emerald'],
  red: ['burgundy', 'maroon', 'wine'],
  pink: ['blush', 'hot pink', 'fuchsia', 'magenta'],
  purple: ['lilac', 'lavender', 'violet', 'plum'],
  brown: ['chocolate', 'tan', 'camel', 'taupe'],
  white: ['off-white', 'cream', 'ivory', 'natural'],
  yellow: ['mustard', 'gold'],
};

function family(colour: string): string {
  if (COLOUR_FAMILIES[colour]) return colour;
  for (const [base, shades] of Object.entries(COLOUR_FAMILIES)) if (shades.includes(colour)) return base;
  return colour;
}

/**
 * Whether a cart colour (the listing's own colour name) can be what the buyer asked for.
 * Same canonical colour, or one side is the plain family word of the other ("blue" and navy).
 * Returns null when the cart colour names no colour the lexicon knows: it can't be compared.
 */
export function colourMatches(asked: string, cartColour: string): boolean | null {
  const support = colourSupport(cartColour);
  if (support.size === 0) return null;
  if (support.has(asked)) return true;
  // Whole colour names only: "Royal Blue" is royal blue, not plain "blue".
  for (const m of findPhrases(words(cartColour), COLOURS)) {
    if (family(m.canonical) === asked) return true; // asked "blue", cart navy
    if (family(asked) === m.canonical) return true; // asked navy, cart just "blue"
  }
  return false;
}

const PLAIN_SIZE = /^(?:XXS|XS|S|M|L|XL|XXL|XXXL|ONE SIZE|\d+(?:\.\d+)?)$/;

/**
 * One canonical size for a listing's size label, or undefined when it can't be told:
 * "M" and "Medium (M)" are M; "M/L", "9 (women's)" or "Regular" are not compared.
 */
export function sizeOf(label: string | undefined): string | undefined {
  const n = normaliseSize(label);
  if (n === undefined || PLAIN_SIZE.test(n)) return n;
  if (/\d/.test(label ?? '')) return undefined;
  const ws = words(label ?? '');
  // Whole size words only: a lone letter in brackets ("(M)") repeats the word next to it.
  const named = new Set(findPhrases(ws, SIZE_WORDS).filter((m) => ws.slice(m.start, m.end).join(' ').length > 1).map((m) => m.canonical));
  return named.size === 1 ? [...named][0] : undefined;
}

export interface AskedConflict {
  attribute: AskedAttribute;
  asked: AskedValue;
  /** The cart variant's own value, from the listing snapshot. */
  cart: string;
}

export interface AskedComparison {
  attribute: AskedAttribute;
  asked: string;
  cart: string | null;
  /** match, conflict, or unknown when the cart does not say or names something unknown. */
  result: 'match' | 'conflict' | 'unknown';
}

/** Compare what the buyer asked for with one cart variant's attributes. */
export function compareAsked(asked: BuyerAsked, attrs: { colour?: string; size?: string; material?: string }): AskedComparison[] {
  const out: AskedComparison[] = [];
  if (asked.colour) {
    const cart = attrs.colour ?? null;
    const m = cart ? colourMatches(asked.colour.value, cart) : null;
    out.push({ attribute: 'colour', asked: asked.colour.value, cart, result: m === null ? 'unknown' : m ? 'match' : 'conflict' });
  }
  if (asked.size) {
    const cart = attrs.size ?? null;
    const a = sizeOf(asked.size.value);
    const c = sizeOf(cart ?? undefined);
    out.push({ attribute: 'size', asked: asked.size.value, cart, result: !c || !a ? 'unknown' : a === c ? 'match' : 'conflict' });
  }
  if (asked.material) {
    const cart = attrs.material ?? null;
    const support = materialSupport(cart ?? undefined);
    out.push({ attribute: 'material', asked: asked.material.value, cart, result: support.size === 0 ? 'unknown' : support.has(asked.material.value) ? 'match' : 'conflict' });
  }
  return out;
}

/** The conflicts only, with the buyer's words attached. */
export function askedConflicts(asked: BuyerAsked, attrs: { colour?: string; size?: string; material?: string }): AskedConflict[] {
  return compareAsked(asked, attrs)
    .filter((c) => c.result === 'conflict')
    .map((c) => ({ attribute: c.attribute, asked: asked[c.attribute]!, cart: c.cart! }));
}

