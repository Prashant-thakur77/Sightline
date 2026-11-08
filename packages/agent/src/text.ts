/**
 * Text normalisation shared by the grammar, the confirmation matcher and the grounding guard.
 * Everything here is deterministic and locale-free.
 */

/** Lowercase, NFKC, straight quotes, dashes as pauses, single spaces. */
export function normaliseText(input: string): string {
  return input
    .normalize('NFKC')
    .replace(/[‘’‛′`]/g, "'")
    .replace(/[“”‟″]/g, '"')
    .replace(/[‐‑‒]/g, '-')
    .replace(/[–—―]/g, ' - ')
    .replace(/…/g, '...')
    .replace(/[  -​  　]/g, ' ')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Tokens: numbers (with thousands separators, decimals and a letter suffix such as "2xl"),
 * words (with inner apostrophes, dots and hyphens) and currency or percent signs.
 */
const TOKEN_RE =
  /\d+(?:,\d{3})*(?:\.\d+)?\p{L}*(?:-[\p{L}\p{N}]+)*|[\p{L}\p{N}]+(?:['.\-][\p{L}\p{N}]+)*|[$£€₹%]/gu;

export function tokenize(text: string): string[] {
  return normaliseText(text).match(TOKEN_RE) ?? [];
}

/** Tokens with hyphenated words split into parts: "crew-neck" becomes "crew", "neck". */
export function words(text: string): string[] {
  const out: string[] = [];
  for (const t of tokenize(text)) {
    if (/^[\d,]+(?:\.\d+)?$/.test(t)) {
      out.push(t);
      continue;
    }
    for (const p of t.split('-')) if (p.length > 0) out.push(p.replace(/\.$/, ''));
  }
  return out;
}

/** Whitespace, case, quote and dash normalisation used for verbatim quote checks. */
export function normaliseForQuote(text: string): string {
  return normaliseText(text)
    .replace(/["']/g, '')
    .replace(/\s*-\s*/g, '-')
    .replace(/\s+([.,;:!?])/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Split text into sentences on terminal punctuation followed by a space. */
export function sentences(text: string): string[] {
  return text
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

export function capitalise(s: string): string {
  return s.length === 0 ? s : s[0]!.toUpperCase() + s.slice(1);
}

/** "a, b and c" */
export function joinAnd(items: string[]): string {
  if (items.length === 0) return '';
  if (items.length === 1) return items[0]!;
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
}

/** "a, b or c" */
export function joinOr(items: string[]): string {
  if (items.length === 0) return '';
  if (items.length === 1) return items[0]!;
  return `${items.slice(0, -1).join(', ')} or ${items[items.length - 1]}`;
}

const CONTRACTIONS: Record<string, string[]> = {
  "can't": ['can', 'not'],
  cant: ['can', 'not'],
  "won't": ['will', 'not'],
  wont: ['will', 'not'],
  dont: ['do', 'not'],
  doesnt: ['does', 'not'],
  didnt: ['did', 'not'],
  isnt: ['is', 'not'],
  "i'm": ['i', 'am'],
  im: ['i', 'am'],
  "i'll": ['i', 'will'],
  "i'd": ['i', 'would'],
  "let's": ['let', 'us'],
  lets: ['let', 'us'],
  "it's": ['it', 'is'],
  "that's": ['that', 'is'],
  thats: ['that', 'is'],
  "what's": ['what', 'is'],
  whats: ['what', 'is'],
  "where's": ['where', 'is'],
  "how's": ['how', 'is'],
  "there's": ['there', 'is'],
  "he's": ['he', 'is'],
  "she's": ['she', 'is'],
  "they're": ['they', 'are'],
  "you're": ['you', 'are'],
  gonna: ['going', 'to'],
  wanna: ['want', 'to'],
  gimme: ['give', 'me'],
};

/** "don't" to "do not", "i'll" to "i will" and so on, for word-level matching. */
export function expandContractions(ws: string[]): string[] {
  const out: string[] = [];
  for (const w of ws) {
    const mapped = CONTRACTIONS[w];
    if (mapped) out.push(...mapped);
    else if (w.endsWith("n't")) out.push(w.slice(0, -3), 'not');
    else out.push(w);
  }
  return out;
}
