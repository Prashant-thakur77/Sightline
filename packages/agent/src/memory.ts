/**
 * Memory of sizes and likes, with consent. A lasting preference the buyer states ("I'm a medium in
 * sweaters", "nothing with wool", "I prefer navy", "keep it under $60") becomes a draft; nothing is
 * stored until the buyer says yes to "Shall I remember that ...?" (or asked to be remembered in the
 * same breath). Every value must come from the buyer's own words: a model can propose a memory,
 * but a draft whose value isn't in what the buyer said is refused. Deterministic and pure.
 */
import { formatMoneyShort, money, type Money, type Preferences } from '@sightline/core';
import type { ShoppingQuery } from './grammar';
import { CATEGORIES, COLOURS, MATERIALS, SIZE_WORDS, categoryOf, categoryPlural, findPhrases, normaliseSize, type SizeDomain } from './lexicon';
import { readMoneyAt, readNumber } from './numbers';
import { capitalise, expandContractions, joinAnd, normaliseText, words } from './text';

export type MemoryKind = 'size' | 'avoid_material' | 'like_material' | 'avoid_colour' | 'like_colour' | 'budget';

export const MEMORY_KINDS: readonly MemoryKind[] = ['size', 'avoid_material', 'like_material', 'avoid_colour', 'like_colour', 'budget'];

export interface MemoryDraft {
  kind: MemoryKind;
  /** Canonical value: a size ("M", "9"), a material or colour name, or a budget in integer cents. */
  value: string;
  /** A category ("sweater") or size domain ("tops") for sizes and budgets; none means everything. */
  scope?: string;
  /** The buyer's words it came from. */
  said: string;
}

export interface Memory extends MemoryDraft {
  id: string;
  createdAt: string;
}

const DOMAINS: readonly SizeDomain[] = ['tops', 'bottoms', 'shoes', 'rings'];
const DOMAIN_WORDS: Record<SizeDomain, string> = { tops: 'tops', bottoms: 'trousers and jeans', shoes: 'shoes', rings: 'rings' };

/** The size domain a scope belongs to: "sweater" is tops, "tops" is tops. */
export function domainOf(scope: string | undefined): SizeDomain | undefined {
  if (!scope) return undefined;
  if ((DOMAINS as readonly string[]).includes(scope)) return scope as SizeDomain;
  return CATEGORIES.find((c) => c.canonical === scope)?.sizeDomain;
}

// ---------------------------------------------------------------------------------------------
// Words

const LETTER_PHRASE: Record<string, string> = {
  XXS: 'a double extra small',
  XS: 'an extra small',
  S: 'a small',
  M: 'a medium',
  L: 'a large',
  XL: 'an extra large',
  XXL: 'a double extra large',
  XXXL: 'a triple extra large',
};

function scopeWords(scope: string | undefined): string | undefined {
  if (!scope) return undefined;
  if ((DOMAINS as readonly string[]).includes(scope)) return DOMAIN_WORDS[scope as SizeDomain];
  return categoryPlural(scope);
}

/** "you're a medium in sweaters", "you avoid wool", "you keep it under $60". */
export function describeMemory(m: Pick<MemoryDraft, 'kind' | 'value' | 'scope'>): string {
  const where = scopeWords(m.scope);
  switch (m.kind) {
    case 'size': {
      const size = LETTER_PHRASE[m.value] ?? `size ${m.value}`;
      return where ? `you're ${size} in ${where}` : `you're ${size}`;
    }
    case 'avoid_material':
      return `you avoid ${m.value}`;
    case 'like_material':
      return `you like ${m.value}`;
    case 'avoid_colour':
      return `you avoid ${m.value}`;
    case 'like_colour':
      return `you like ${m.value}`;
    case 'budget': {
      const amount = formatMoneyShort(money(Number(m.value)));
      return where ? `you keep ${where} under ${amount}` : `you keep it under ${amount}`;
    }
  }
}

/** The same fact as a short label for the Settings list: "Size M in sweaters". */
export function memoryLabel(m: Pick<MemoryDraft, 'kind' | 'value' | 'scope'>): string {
  const where = scopeWords(m.scope);
  switch (m.kind) {
    case 'size':
      return `Size ${m.value}${where ? ` in ${where}` : ''}`;
    case 'avoid_material':
      return `Avoid ${m.value}`;
    case 'like_material':
      return `Likes ${m.value}`;
    case 'avoid_colour':
      return `Avoid ${m.value}`;
    case 'like_colour':
      return `Likes ${m.value}`;
    case 'budget':
      return `Under ${formatMoneyShort(money(Number(m.value)))}${where ? ` for ${where}` : ''}`;
  }
}

export const memoryWords = {
  ask: (m: Pick<MemoryDraft, 'kind' | 'value' | 'scope'>): string => `Shall I remember that ${describeMemory(m)}?`,
  stored: (m: Pick<MemoryDraft, 'kind' | 'value' | 'scope'>): string =>
    `Okay, I'll remember that ${describeMemory(m)}. To undo it, say 'forget ${forgetPhrase(m)}'.`,
  declined: "Okay, I won't remember that.",
  nothing:
    "I don't remember anything about you yet. When you tell me your size, or something you avoid, I'll ask before I remember it.",
  recallLead: (n: number): string => (n === 1 ? "Here's what I remember." : `Here are the ${n} things I remember.`),
  recallTail: "To change one, say 'forget' and what to forget, or use Settings.",
  settingsSizes: (list: string): string => `Your Settings also have ${list}.`,
  settingsAvoid: (list: string): string => `Settings say you avoid ${list}.`,
  forgot: (list: string): string => `Done. I've forgotten that ${list}.`,
  forgotUndo: (m: Pick<MemoryDraft, 'kind' | 'value' | 'scope'>): string => `To set it again, say '${restatePhrase(m)}'.`,
  forgotSettingsSizes: (list: string): string => `I also cleared ${list} from Settings.`,
  forgotAll: (n: number): string =>
    n === 0 ? "There was nothing to forget. I don't remember anything about you." : `Done. I've forgotten all ${n === 1 ? 'one thing' : `${n} things`} I remembered. Your orders and Settings are unchanged.`,
  nothingToForget: (what: string): string => `I don't remember ${what}, so there's nothing to forget.`,
  usingSize: (size: string): string => `Using your usual size ${size}.`,
  usingBudget: (amount: Money): string => `Keeping it under ${formatMoneyShort(amount)}, as you asked me to remember.`,
  leftOut: (n: number, what: string): string => `I left out ${n === 1 ? 'one' : n} with ${what}, as you asked.`,
  notForYou: "It's for someone else, so I didn't use your own sizes.",
};

/** What to say to forget it: "my size in sweaters", "that I avoid wool". */
function forgetPhrase(m: Pick<MemoryDraft, 'kind' | 'value' | 'scope'>): string {
  switch (m.kind) {
    case 'size':
      return m.scope && !(DOMAINS as readonly string[]).includes(m.scope) ? `my ${m.scope} size` : 'my size';
    case 'budget':
      return 'my budget';
    default:
      return m.value;
  }
}

/** What to say to set it again. */
function restatePhrase(m: Pick<MemoryDraft, 'kind' | 'value' | 'scope'>): string {
  const d = describeMemory(m).replace(/^you're /, "I'm ").replace(/^you /, 'I ');
  return `remember ${d}`;
}

// ---------------------------------------------------------------------------------------------
// Reading preferences from the buyer's words

const LASTING = /\b(?:always|never|usually|normally|generally|every time|allergic|itch|itchy|scratchy|prefer|favourite|favorite|my size|my budget)\b/;
const SEARCH_VERBS = /\b(?:find|need|want|looking|show|get|buy|search|order)\b/;
const EXPLICIT = /^(?:please )?(?:remember|note|keep in mind|save|do not forget)(?: that)?\b/;

export interface PreferenceRead {
  drafts: MemoryDraft[];
  /** The buyer asked to be remembered ("remember that ..."): that is the consent. */
  explicit: boolean;
  /** The utterance also asks to find something. */
  hasSearch: boolean;
  /** The wording says it is lasting ("always", "never", "I'm a medium"), not a one-off filter. */
  lasting: boolean;
}

const SIZE_TRIGGERS = [
  ['i', 'am', 'usually'],
  ['i', 'am', 'normally'],
  ['i', 'am', 'always'],
  ['i', 'usually', 'wear'],
  ['i', 'normally', 'wear'],
  ['i', 'always', 'wear'],
  ['i', 'usually', 'take'],
  ['i', 'am'],
  ['i', 'wear'],
  ['i', 'take'],
];
const SIZE_SKIP = new Set(['a', 'an', 'size', 'usually', 'normally', 'always', 'in']);

function startsAt(ws: string[], i: number, phrase: string[]): boolean {
  return phrase.every((p, k) => ws[i + k] === p);
}

/** A size at ws[i]: a size word, or a number (only after "size", or before or after a category). */
function sizeAt(ws: string[], i: number, afterSizeWord: boolean): { size: string; end: number; numeric: boolean } | null {
  const lettered = findPhrases(ws.slice(i), SIZE_WORDS)[0];
  if (lettered && lettered.start === 0) {
    const raw = ws.slice(i, i + lettered.end).join(' ');
    // A single letter ("s", "m", "l") only counts after the word "size".
    if (raw.length <= 2 && !/^x/.test(raw) && !afterSizeWord) return null;
    if (lettered.canonical === 'ONE SIZE') return null;
    return { size: lettered.canonical, end: i + lettered.end, numeric: false };
  }
  const n = readNumber(ws, i);
  if (n && n.value > 0 && n.value < 60) return { size: normaliseSize(String(n.value))!, end: n.end, numeric: true };
  return null;
}

function categoryAt(ws: string[], i: number): { canonical: string; end: number } | null {
  const m = findPhrases(ws.slice(i), CATEGORIES, true)[0];
  return m && m.start === 0 ? { canonical: m.canonical, end: i + m.end } : null;
}

function readSizeStatements(ws: string[], said: string): MemoryDraft[] {
  const out: MemoryDraft[] = [];
  for (let i = 0; i < ws.length; i++) {
    // "my sweater size is medium", "my shoe size is 9", "my size is M"
    if (ws[i] === 'my') {
      const cat = categoryAt(ws, i + 1);
      const j = cat ? cat.end : i + 1;
      if (ws[j] === 'size' && ws[j + 1] === 'is') {
        const s = sizeAt(ws, j + 2, true);
        if (s && (cat || !s.numeric)) out.push({ kind: 'size', value: s.size, scope: cat?.canonical ?? (s.numeric ? undefined : 'tops'), said });
      }
      continue;
    }
    const trig = SIZE_TRIGGERS.find((t) => startsAt(ws, i, t));
    if (!trig) continue;
    let j = i + trig.length;
    let afterSize = false;
    while (j < ws.length && SIZE_SKIP.has(ws[j]!)) {
      if (ws[j] === 'size') afterSize = true;
      j++;
    }
    const s = sizeAt(ws, j, afterSize);
    if (!s) continue;
    // "I'm a medium in sweaters", "I wear size 9 shoes", "I take a medium in tops"
    let k = s.end;
    if (ws[k] === 'in' || ws[k] === 'for') k++;
    const cat = categoryAt(ws, k);
    const domain = !cat && ws[k] === 'tops' ? 'tops' : !cat && ws[k] === 'bottoms' ? 'bottoms' : undefined;
    const atEnd = s.end >= ws.length || ['please', 'usually', 'normally'].includes(ws[s.end]!);
    // Without a category only a letter size at the end counts ("I'm a medium"), never "I am a small business owner".
    if (cat) out.push({ kind: 'size', value: s.size, scope: cat.canonical, said });
    else if (domain) out.push({ kind: 'size', value: s.size, scope: domain, said });
    else if (!s.numeric && atEnd) out.push({ kind: 'size', value: s.size, scope: 'tops', said });
  }
  return out;
}

const AVOID_TRIGGERS = new Set(['nothing', 'no', 'never', 'avoid', 'without', 'hate', 'dislike', 'allergic', 'not']);
const AVOID_SKIP = new Set(['with', 'in', 'made', 'of', 'containing', 'any', 'to', 'more', 'wear', 'wearing', 'like', 'want', 'anything', 'stand']);
const ITCH_AFTER = [['makes', 'me', 'itch'], ['is', 'too', 'itchy'], ['is', 'itchy'], ['is', 'scratchy'], ['is', 'too', 'scratchy'], ['irritates', 'my', 'skin']];
const LIKE_TRIGGERS = [
  ['i', 'prefer'],
  ['i', 'like'],
  ['i', 'love'],
  ['i', 'usually', 'wear'],
  ['i', 'always', 'wear'],
  ['my', 'favourite', 'colour', 'is'],
  ['my', 'favorite', 'color', 'is'],
  ['my', 'favourite', 'color', 'is'],
  ['my', 'favorite', 'colour', 'is'],
];

function readLikesAndAvoids(ws: string[], said: string): MemoryDraft[] {
  const out: MemoryDraft[] = [];
  for (let i = 0; i < ws.length; i++) {
    if (AVOID_TRIGGERS.has(ws[i]!)) {
      let j = i + 1;
      while (j < ws.length && AVOID_SKIP.has(ws[j]!)) j++;
      const mat = findPhrases(ws.slice(j), MATERIALS)[0];
      if (mat && mat.start === 0) out.push({ kind: 'avoid_material', value: mat.canonical, said });
      const col = findPhrases(ws.slice(j), COLOURS)[0];
      if (col && col.start === 0 && ws[i] !== 'not') out.push({ kind: 'avoid_colour', value: col.canonical, said });
    }
    const mat = findPhrases(ws.slice(i), MATERIALS)[0];
    if (mat && mat.start === 0 && ITCH_AFTER.some((p) => startsAt(ws, i + mat.end, p))) out.push({ kind: 'avoid_material', value: mat.canonical, said });
    const like = LIKE_TRIGGERS.find((t) => startsAt(ws, i, t));
    if (like) {
      let j = i + like.length;
      if (ws[j] === 'wearing') j++;
      const col = findPhrases(ws.slice(j), COLOURS)[0];
      if (col && col.start === 0) out.push({ kind: 'like_colour', value: col.canonical, said });
      const m2 = findPhrases(ws.slice(j), MATERIALS)[0];
      if (m2 && m2.start === 0) out.push({ kind: 'like_material', value: m2.canonical, said });
    }
  }
  return out;
}

const BUDGET_TRIGGERS = [
  ['keep', 'it', 'under'],
  ['keep', 'it', 'below'],
  ['keep', 'things', 'under'],
  ['keep', 'everything', 'under'],
  ['my', 'budget', 'is'],
  ['my', 'usual', 'budget', 'is'],
  ['never', 'spend', 'more', 'than'],
  ['do', 'not', 'spend', 'more', 'than'],
  ['nothing', 'over'],
  ['nothing', 'more', 'than'],
  ['i', 'usually', 'spend', 'under'],
  ['i', 'never', 'spend', 'more', 'than'],
];

function readBudget(ws: string[], said: string): MemoryDraft[] {
  for (let i = 0; i < ws.length; i++) {
    const t = BUDGET_TRIGGERS.find((p) => startsAt(ws, i, p));
    if (!t) continue;
    const r = readMoneyAt(ws, i + t.length, 'USD', false);
    if (!r || r.money.cents <= 0) continue;
    const cat = categoryOf(ws.join(' '));
    return [{ kind: 'budget', value: String(r.money.cents), ...(cat ? { scope: cat.canonical } : {}), said }];
  }
  return [];
}

/** Lasting preferences in what the buyer said. */
export function parsePreferenceStatement(text: string): PreferenceRead {
  const said = text.trim();
  const s = normaliseText(said);
  const explicit = EXPLICIT.test(s);
  const ws = expandContractions(words(s.replace(EXPLICIT, '')));
  const drafts = [...readSizeStatements(ws, said), ...readLikesAndAvoids(ws, said), ...readBudget(ws, said)];
  const unique = drafts.filter((d, i) => drafts.findIndex((x) => x.kind === d.kind && x.value === d.value && x.scope === d.scope) === i);
  const hasSearch = SEARCH_VERBS.test(ws.join(' '));
  const lasting = explicit || LASTING.test(ws.join(' ')) || unique.some((d) => d.kind === 'size') || (!hasSearch && unique.length > 0);
  return { drafts: unique, explicit, hasSearch, lasting };
}

/**
 * A memory a model proposed, checked against what the buyer actually said: the value (and the
 * category, if any) must be in the buyer's words. Returns the cleaned draft, or null.
 */
export function draftFromProposal(
  proposal: { kind: string; value: string; category?: string | null },
  utterance: string,
): MemoryDraft | null {
  if (!(MEMORY_KINDS as readonly string[]).includes(proposal.kind)) return null;
  const kind = proposal.kind as MemoryKind;
  const said = utterance.trim();
  const ws = expandContractions(words(said));
  const read = parsePreferenceStatement(said).drafts.filter((d) => d.kind === kind);
  const scope = proposal.category ? (categoryOf(proposal.category)?.canonical ?? (domainOf(proposal.category) ? proposal.category : undefined)) : undefined;
  if (proposal.category && !scope) return null;
  if (scope && !(DOMAINS as readonly string[]).includes(scope) && categoryOf(ws.join(' '))?.canonical !== scope) {
    // The category must be one the buyer named.
    if (!findPhrases(ws, CATEGORIES, true).some((m) => m.canonical === scope)) return null;
  }
  switch (kind) {
    case 'size': {
      const value = normaliseSize(proposal.value);
      if (!value) return null;
      // Any size the buyer said; the buyer still hears it back and says yes before it is stored.
      const spoken = new Set<string>();
      for (let i = 0; i < ws.length; i++) {
        const sz = sizeAt(ws, i, true);
        if (sz) spoken.add(sz.size);
      }
      if (!spoken.has(value)) return null;
      const fromRead = read.find((d) => d.value === value);
      return { kind, value, scope: scope ?? fromRead?.scope ?? (/^\d/.test(value) ? undefined : 'tops'), said };
    }
    case 'avoid_material':
    case 'like_material': {
      const m = findPhrases(words(proposal.value), MATERIALS)[0]?.canonical;
      if (!m || !findPhrases(ws, MATERIALS).some((x) => x.canonical === m)) return null;
      return { kind, value: m, said };
    }
    case 'avoid_colour':
    case 'like_colour': {
      const c = findPhrases(words(proposal.value), COLOURS)[0]?.canonical;
      if (!c || !findPhrases(ws, COLOURS).some((x) => x.canonical === c)) return null;
      return { kind, value: c, said };
    }
    case 'budget': {
      // The proposal gives dollars ("60", "$60", "59.99"); the amount must be one the buyer said.
      const dollars = Number(String(proposal.value).replace(/[^0-9.]/g, ''));
      if (!Number.isFinite(dollars) || dollars <= 0) return null;
      const cents = Math.round(dollars * 100);
      const amounts: number[] = [];
      for (let i = 0; i < ws.length; i++) {
        const r = readMoneyAt(ws, i, 'USD', false);
        if (r) amounts.push(r.money.cents);
      }
      if (!amounts.includes(cents)) return null;
      return { kind, value: String(cents), ...(scope ? { scope } : {}), said };
    }
  }
}

// ---------------------------------------------------------------------------------------------
// Recall and forget

/** "Here's what I remember. You're a medium in sweaters. You avoid wool. ..." */
export function recallSpeech(memories: Pick<MemoryDraft, 'kind' | 'value' | 'scope'>[], settings: { sizes?: Preferences['sizes']; avoidColours?: string[] } = {}): string {
  const parts: string[] = [];
  if (memories.length === 0) parts.push(memoryWords.nothing);
  else {
    parts.push(memoryWords.recallLead(memories.length));
    for (const m of memories) parts.push(`${capitalise(describeMemory(m))}.`);
  }
  const sizes = Object.entries(settings.sizes ?? {}).filter(([, v]) => v);
  if (sizes.length) parts.push(memoryWords.settingsSizes(joinAnd(sizes.map(([k, v]) => `size ${v} for ${DOMAIN_WORDS[k as SizeDomain] ?? k}`))));
  if (settings.avoidColours?.length) parts.push(memoryWords.settingsAvoid(joinAnd(settings.avoidColours)));
  if (memories.length) parts.push(memoryWords.recallTail);
  return parts.join(' ');
}

export type ForgetTarget = { all: true } | { all?: false; kind?: MemoryKind | 'colour' | 'material'; scope?: string; value?: string; label: string };

/**
 * What "forget ..." asks to forget: "forget everything", "forget my size", "forget my sweater size",
 * "forget that I avoid wool", "forget navy", "forget my budget". Null when it isn't about memory.
 */
export function parseForget(text: string): ForgetTarget | null {
  const s = normaliseText(text).replace(/[.!?]+$/, '');
  const m = /^(?:please )?(?:forget|stop remembering|delete|remove|clear)\b(.*)$/.exec(s);
  if (!m) return null;
  const rest = m[1]!.replace(/^\s*(?:about|that|what)\s+/, ' ').trim();
  if (/^(?:it|that|this|it all)?$/.test(rest)) return null;
  if (/^(?:everything|all|all of it|everything you (?:know|remember)(?: about me)?|what you remember(?: about me)?|my preferences|all my preferences|everything about me)$/.test(rest))
    return { all: true };
  const ws = expandContractions(words(rest));
  if (/\bsizes?\b/.test(rest)) {
    const cat = findPhrases(ws, CATEGORIES, true)[0]?.canonical;
    return { kind: 'size', ...(cat ? { scope: cat } : {}), label: cat ? `your size in ${categoryPlural(cat)}` : 'your size' };
  }
  if (/\b(?:budget|spending|price limit)\b/.test(rest)) return { kind: 'budget', label: 'your budget' };
  const mat = findPhrases(ws, MATERIALS)[0]?.canonical;
  if (mat) return { kind: 'material', value: mat, label: mat };
  const col = findPhrases(ws, COLOURS)[0]?.canonical;
  if (col) return { kind: 'colour', value: col, label: col };
  if (/\b(?:colou?rs?)\b/.test(rest)) return { kind: 'colour', label: 'your colours' };
  if (/\b(?:materials?|fabrics?)\b/.test(rest)) return { kind: 'material', label: 'your materials' };
  return null;
}

/** The memories a forget target names. */
export function memoriesToForget<M extends MemoryDraft>(memories: M[], target: ForgetTarget): M[] {
  if (target.all) return memories;
  return memories.filter((m) => {
    if (target.kind === 'colour') return (m.kind === 'avoid_colour' || m.kind === 'like_colour') && (!target.value || m.value === target.value);
    if (target.kind === 'material') return (m.kind === 'avoid_material' || m.kind === 'like_material') && (!target.value || m.value === target.value);
    if (target.kind && m.kind !== target.kind) return false;
    if (target.scope && m.scope !== target.scope && domainOf(m.scope) !== target.scope) return false;
    return true;
  });
}

// ---------------------------------------------------------------------------------------------
// Using memories in a search

export interface AppliedPreferences {
  query: ShoppingQuery;
  /** Said before the options: which memories were used. */
  notes: string[];
  avoidMaterials: string[];
  avoidColours: string[];
  likeColours: string[];
  /** The memories used, for the agent's step log. */
  used: Pick<MemoryDraft, 'kind' | 'value' | 'scope'>[];
}

/**
 * Memories applied to a query, said in words. The buyer's spoken words always win. For someone
 * else (a gift), the buyer's own sizes, budget and likes are not used, and that is said.
 */
export function applyPreferences(
  query: ShoppingQuery,
  memories: Pick<MemoryDraft, 'kind' | 'value' | 'scope'>[],
  settings: { avoidColours?: string[] } = {},
  opts: { forSomeoneElse?: boolean } = {},
): AppliedPreferences {
  if (opts.forSomeoneElse) {
    const hadOwnSize = query.sizeSource === 'saved' || memories.some((m) => m.kind === 'size');
    const q = query.sizeSource === 'saved' ? { ...query, size: undefined, sizeSource: undefined } : query;
    return { query: q, notes: hadOwnSize && !q.size ? [memoryWords.notForYou] : [], avoidMaterials: [], avoidColours: [], likeColours: [], used: [] };
  }
  let q = { ...query };
  const notes: string[] = [];
  const used: AppliedPreferences['used'] = [];
  // A size already taken from memory (a refinement of the same search) is not announced again.
  if (q.sizeSource !== 'spoken' && q.sizeSource !== 'memory' && q.category) {
    const domain = domainOf(q.category);
    const sizes = memories.filter((m) => m.kind === 'size');
    const pick =
      sizes.find((m) => m.scope === q.category) ??
      sizes.find((m) => domain && m.scope === domain) ??
      sizes.find((m) => domain && domainOf(m.scope) === domain);
    if (pick) {
      q = { ...q, size: pick.value, sizeSource: 'memory' };
      notes.push(memoryWords.usingSize(pick.value));
      used.push(pick);
    }
  }
  if (!q.maxPrice) {
    const budget = memories.find((m) => m.kind === 'budget' && (!m.scope || m.scope === q.category));
    if (budget) {
      q = { ...q, maxPrice: money(Number(budget.value)) };
      notes.push(memoryWords.usingBudget(money(Number(budget.value))));
      used.push(budget);
    }
  }
  const avoidMaterials = memories.filter((m) => m.kind === 'avoid_material').map((m) => m.value);
  const avoidColours = [...new Set([...(settings.avoidColours ?? []), ...memories.filter((m) => m.kind === 'avoid_colour').map((m) => m.value)])];
  const likeColours = memories.filter((m) => m.kind === 'like_colour').map((m) => m.value);
  for (const m of memories) if (['avoid_material', 'avoid_colour', 'like_colour'].includes(m.kind)) used.push(m);
  return { query: q, notes, avoidMaterials, avoidColours, likeColours, used };
}

const GIFT = /\b(?:gift|present|for (?:my|a|an|our) (?:sister|brother|mum|mom|mother|dad|father|wife|husband|partner|friend|son|daughter|niece|nephew|aunt|uncle|grandma|grandmother|grandpa|grandfather|boyfriend|girlfriend|colleague|boss|teacher|kid|kids|baby|child|children|cousin|neighbour|neighbor)|for (?:him|her|them))\b/;

/** The request is for someone else, so the buyer's own sizes and likes don't apply. */
export function isForSomeoneElse(text: string): boolean {
  return GIFT.test(normaliseText(text));
}
