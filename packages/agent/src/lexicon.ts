/**
 * Shared vocabularies: colours, materials, sizes, categories, garment attributes and policy terms.
 * The grammar uses them to read queries, ranking to compare listings, and the grounding guard to
 * find product-specific words that must be backed by a listing field or a quote.
 */
import { words } from './text';

export interface LexEntry {
  canonical: string;
  aliases: string[];
  /** When true, words inside the phrase do not count on their own ("off-white" is not "white"). */
  atomic?: boolean;
}

export type SizeDomain = 'tops' | 'bottoms' | 'shoes' | 'rings';

export interface CategoryEntry extends LexEntry {
  sizeDomain?: SizeDomain;
}

const e = (canonical: string, ...aliases: string[]): LexEntry => ({ canonical, aliases: [canonical, ...aliases] });
const atomic = (canonical: string, ...aliases: string[]): LexEntry => ({ ...e(canonical, ...aliases), atomic: true });

export const COLOURS: LexEntry[] = [
  e('black', 'jet black'),
  e('white', 'bright white', 'optic white'),
  atomic('off-white', 'off white', 'offwhite', 'ecru'),
  e('cream'),
  e('ivory'),
  e('beige'),
  e('tan'),
  e('camel'),
  e('khaki'),
  e('brown'),
  e('chocolate'),
  e('taupe'),
  e('grey', 'gray'),
  e('light grey', 'light gray', 'pale grey', 'pale gray'),
  e('dark grey', 'dark gray'),
  e('heather grey', 'heather gray', 'grey heather', 'gray heather'),
  e('charcoal', 'charcoal grey', 'charcoal gray'),
  e('silver'),
  e('navy', 'navy blue', 'dark navy'),
  e('blue'),
  e('light blue', 'pale blue', 'baby blue'),
  e('dark blue'),
  e('sky blue'),
  e('royal blue'),
  e('cobalt', 'cobalt blue'),
  e('teal'),
  e('turquoise'),
  e('aqua'),
  e('green'),
  e('dark green'),
  e('forest green'),
  e('olive', 'olive green'),
  e('sage', 'sage green'),
  e('mint', 'mint green'),
  e('emerald', 'emerald green'),
  e('yellow'),
  e('mustard', 'mustard yellow'),
  e('gold'),
  e('orange'),
  e('rust'),
  e('coral'),
  e('peach'),
  e('red'),
  e('burgundy'),
  e('maroon'),
  e('wine'),
  e('pink'),
  e('blush', 'blush pink'),
  e('hot pink'),
  e('fuchsia'),
  e('magenta'),
  e('purple'),
  e('lilac'),
  e('lavender'),
  e('violet'),
  e('plum'),
  atomic('multicolour', 'multicolor', 'multi colour', 'multi color', 'multicoloured', 'multicolored'),
];

export const MATERIALS: LexEntry[] = [
  e('cotton'),
  e('organic cotton'),
  e('wool'),
  e('merino', 'merino wool'),
  e('lambswool', 'lambs wool'),
  e('cashmere'),
  e('alpaca'),
  e('mohair'),
  e('linen'),
  e('silk'),
  e('polyester'),
  e('recycled polyester'),
  e('nylon'),
  e('acrylic'),
  e('viscose'),
  e('rayon'),
  e('elastane'),
  e('spandex'),
  e('lycra'),
  e('modal'),
  e('lyocell'),
  e('tencel'),
  e('bamboo'),
  e('leather'),
  atomic('faux leather', 'vegan leather', 'pu leather'),
  e('suede'),
  e('denim'),
  e('fleece'),
  // Bare "down" is too common a word to count; only explicit fills do.
  { canonical: 'down', aliases: ['goose down', 'duck down', 'down filled', 'down fill', 'down insulation'] },
  e('corduroy'),
  e('velvet'),
  e('canvas'),
  e('rubber'),
  e('stainless steel'),
  e('steel'),
  e('aluminium', 'aluminum'),
  e('ceramic'),
  e('porcelain'),
  e('glass'),
  e('wood', 'wooden'),
  e('plastic'),
];

export const NECKLINES: LexEntry[] = [
  e('crew-neck', 'crew neck', 'crewneck'),
  e('v-neck', 'v neck', 'vneck'),
  e('turtleneck', 'turtle neck', 'roll neck', 'rollneck', 'polo neck'),
  e('mock neck', 'mockneck', 'funnel neck'),
  e('round neck'),
  e('scoop neck'),
  e('boat neck'),
  e('cowl neck'),
  e('henley'),
  e('hooded'),
  e('collared'),
];

export const FITS: LexEntry[] = [
  e('slim', 'slim fit', 'slim fitting', 'skinny'),
  e('regular', 'regular fit', 'classic fit'),
  e('relaxed', 'relaxed fit'),
  e('oversized', 'oversize'),
  e('loose', 'loose fit', 'loose fitting'),
  e('tailored', 'tailored fit'),
];

export const SLEEVES: LexEntry[] = [
  e('long sleeve', 'long sleeved', 'long sleeves'),
  e('short sleeve', 'short sleeved', 'short sleeves'),
  e('sleeveless'),
];

export const PATTERNS: LexEntry[] = [
  e('striped', 'stripe', 'stripes', 'stripy'),
  e('plain', 'solid'),
  e('checked', 'checks', 'checkered'),
  e('plaid', 'tartan'),
  e('floral'),
  e('polka dot', 'polka dots', 'spotted'),
  e('cable knit'),
];

export const POLICY_TERMS: LexEntry[] = [
  e('free returns', 'free return', 'returns are free', 'return it for free', 'free to return'),
  e('no returns', 'non returnable', 'not returnable', 'final sale', 'cannot be returned', "can't be returned"),
  e('free shipping', 'free delivery', 'ships free', 'shipping is free', 'delivery is free'),
  e('free exchanges', 'free exchange', 'exchanges are free'),
];

const cat = (sizeDomain: SizeDomain | undefined, canonical: string, ...aliases: string[]): CategoryEntry => ({
  canonical,
  aliases: [canonical, ...aliases],
  ...(sizeDomain ? { sizeDomain } : {}),
});

export const CATEGORIES: CategoryEntry[] = [
  cat('tops', 'sweater', 'jumper', 'pullover', 'knit sweater'),
  cat('tops', 'cardigan'),
  cat('tops', 'hoodie', 'hooded sweatshirt'),
  cat('tops', 'sweatshirt'),
  cat('tops', 't-shirt', 't shirt', 'tshirt', 'tee'),
  cat('tops', 'shirt', 'button down', 'button up'),
  cat('tops', 'blouse'),
  cat('tops', 'polo shirt', 'polo'),
  cat('tops', 'top'),
  cat('tops', 'jacket'),
  cat('tops', 'coat', 'overcoat', 'parka'),
  cat('tops', 'dress'),
  cat('bottoms', 'jeans'),
  cat('bottoms', 'trousers', 'pants', 'slacks', 'chinos'),
  cat('bottoms', 'shorts'),
  cat('bottoms', 'skirt'),
  cat('bottoms', 'leggings'),
  cat('bottoms', 'joggers', 'sweatpants', 'tracksuit bottoms'),
  cat('shoes', 'running shoes', 'running shoe'),
  cat('shoes', 'sneakers', 'sneaker', 'trainers', 'trainer'),
  cat('shoes', 'boots', 'boot'),
  cat('shoes', 'sandals', 'sandal'),
  cat('shoes', 'slippers', 'slipper'),
  cat('shoes', 'shoes', 'shoe'),
  cat('rings', 'ring'),
  cat(undefined, 'socks', 'sock'),
  cat(undefined, 'hat', 'beanie', 'cap'),
  cat(undefined, 'scarf'),
  cat(undefined, 'gloves', 'glove'),
  cat(undefined, 'backpack', 'rucksack'),
  cat(undefined, 'bag', 'handbag', 'tote', 'tote bag'),
  cat(undefined, 'wallet', 'purse'),
  cat(undefined, 'watch'),
  cat(undefined, 'headphones', 'earbuds', 'earphones'),
  cat(undefined, 'mug', 'cup'),
  cat(undefined, 'kettle'),
  cat(undefined, 'blanket', 'throw blanket'),
  cat(undefined, 'towel'),
  cat(undefined, 'umbrella'),
];

export interface LexMatch<E extends LexEntry = LexEntry> {
  entry: E;
  canonical: string;
  /** Index range [start, end) in the word array. */
  start: number;
  end: number;
}

interface CompiledAlias<E> {
  parts: string[];
  entry: E;
}

const compiled = new WeakMap<object, Map<string, CompiledAlias<LexEntry>[]>>();

function compile<E extends LexEntry>(entries: E[]): Map<string, CompiledAlias<E>[]> {
  const cached = compiled.get(entries);
  if (cached) return cached as Map<string, CompiledAlias<E>[]>;
  const index = new Map<string, CompiledAlias<E>[]>();
  for (const entry of entries) {
    for (const alias of entry.aliases) {
      const parts = words(alias);
      if (parts.length === 0) continue;
      const list = index.get(parts[0]!) ?? [];
      list.push({ parts, entry });
      index.set(parts[0]!, list);
    }
  }
  for (const list of index.values()) list.sort((a, b) => b.parts.length - a.parts.length);
  compiled.set(entries, index as Map<string, CompiledAlias<LexEntry>[]>);
  return index;
}

function partEquals(word: string, part: string, allowPlural: boolean): boolean {
  if (word === part) return true;
  return allowPlural && (word === `${part}s` || word === `${part}es`);
}

/**
 * Greedy, longest-first, non-overlapping phrase matches. With allowPlural the last word of an alias
 * may carry an "s" or "es" ("sweaters", "t-shirts").
 */
export function findPhrases<E extends LexEntry>(ws: string[], entries: E[], allowPlural = false): LexMatch<E>[] {
  const index = compile(entries);
  const out: LexMatch<E>[] = [];
  let i = 0;
  while (i < ws.length) {
    const candidates = index.get(ws[i]!) ?? (allowPlural ? index.get(ws[i]!.replace(/e?s$/, '')) : undefined);
    let matched: CompiledAlias<E> | undefined;
    for (const c of candidates ?? []) {
      if (i + c.parts.length > ws.length) continue;
      let ok = true;
      for (let k = 0; k < c.parts.length; k++) {
        const isLast = k === c.parts.length - 1;
        if (!partEquals(ws[i + k]!, c.parts[k]!, allowPlural && isLast)) {
          ok = false;
          break;
        }
      }
      if (ok) {
        matched = c;
        break;
      }
    }
    if (matched) {
      out.push({ entry: matched.entry, canonical: matched.entry.canonical, start: i, end: i + matched.parts.length });
      i += matched.parts.length;
    } else {
      i++;
    }
  }
  return out;
}

/**
 * Every canonical name the text supports: the longest phrases plus, for non-atomic phrases, the
 * single words inside them. "Navy Blue" supports both "navy" and "blue"; "off-white" supports only
 * "off-white".
 */
export function supportSet(text: string, entries: LexEntry[]): Set<string> {
  const ws = words(text);
  const out = new Set<string>();
  for (const m of findPhrases(ws, entries)) {
    out.add(m.canonical);
    if (m.entry.atomic || m.end - m.start < 2) continue;
    for (let k = m.start; k < m.end; k++) {
      for (const sub of findPhrases([ws[k]!], entries)) out.add(sub.canonical);
    }
  }
  return out;
}

export function canonicalOf(text: string, entries: LexEntry[], allowPlural = false): string | undefined {
  return findPhrases(words(text), entries, allowPlural)[0]?.canonical;
}

export function canonicalColour(text: string): string | undefined {
  return canonicalOf(text, COLOURS);
}

/** Colours a listing colour name supports, e.g. "Navy Heather" supports "navy". */
export function colourSupport(text: string | undefined): Set<string> {
  return text ? supportSet(text, COLOURS) : new Set();
}

export function materialSupport(text: string | undefined): Set<string> {
  return text ? supportSet(text, MATERIALS) : new Set();
}

export function categoryOf(text: string): CategoryEntry | undefined {
  return findPhrases(words(text), CATEGORIES, true)[0]?.entry;
}

// ---------------------------------------------------------------------------------------------
// Sizes

export const LETTER_SIZES = ['XXS', 'XS', 'S', 'M', 'L', 'XL', 'XXL', 'XXXL'] as const;

export const SIZE_WORDS: LexEntry[] = [
  e('XXS', 'xxs', '2xs', 'extra extra small', 'double extra small'),
  e('XS', 'xs', 'extra small', 'x small'),
  e('S', 'small', 's', 'sm'),
  e('M', 'medium', 'm', 'med'),
  e('L', 'large', 'l', 'lg'),
  e('XL', 'xl', 'extra large', 'x large', '1xl'),
  e('XXL', 'xxl', '2xl', 'extra extra large', 'double extra large', 'double xl', 'xx large'),
  e('XXXL', 'xxxl', '3xl', 'triple extra large', 'triple xl', 'xxx large'),
  e('ONE SIZE', 'one size', 'one size fits all', 'os'),
];

/** Canonical size: letter sizes upper-cased ("medium" to "M"), numeric sizes as digits ("9.5"). */
export function normaliseSize(raw: string | undefined): string | undefined {
  if (raw === undefined) return undefined;
  const ws = words(raw).filter((w) => w !== 'size');
  if (ws.length === 0) return undefined;
  const m = findPhrases(ws, SIZE_WORDS);
  if (m.length === 1 && m[0]!.start === 0 && m[0]!.end === ws.length) return m[0]!.canonical;
  if (ws.length === 1 && /^\d+(?:\.\d+)?$/.test(ws[0]!)) return String(Number(ws[0]));
  if (/^\d+(?:\.\d+)?\s*(?:\/\s*\d+)?$/.test(raw.trim())) return raw.trim().replace(/\s+/g, '');
  return raw.trim().toUpperCase();
}

export function sameSize(a: string | undefined, b: string | undefined): boolean {
  const na = normaliseSize(a);
  const nb = normaliseSize(b);
  return na !== undefined && na === nb;
}
