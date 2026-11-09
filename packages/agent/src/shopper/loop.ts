/**
 * The shopping agent: a Claude tool-use loop for open shopping requests ("a gift for my sister
 * who hikes, under $50", "something warm but not scratchy", questions about the options).
 *
 * What the model can and cannot do:
 * - It chooses searches, reads listings, compares, and ends the turn with one finishing tool.
 * - Every product it names must have come back from a tool this turn (or be on screen); ids it
 *   makes up are refused.
 * - Every line it writes is grounding-checked against those listings; a line that states a fact
 *   the listings don't give is not spoken.
 * - It never sets a price, total, payee or confirmation. start_readback hands one listing to the
 *   app's template readback; paying still needs the buyer's two keys.
 * - A memory it proposes is checked against the buyer's words, then asked about before saving.
 *
 * The loop is capped (tool calls and wall-clock time). Any failure, refusal, timeout or bad output
 * ends in a fallback the app handles with its grammar and templates. Pure: the model client, the
 * catalog search and the order history are passed in.
 */
import type Anthropic from '@anthropic-ai/sdk';
import { z } from 'zod';
import { formatMoney, money, spokenDate, type ProductSnapshot, type Verbosity } from '@sightline/core';
import { checkFreeText, type FactValue } from '../grounding';
import { describeQuery, presentComparison } from '../present';
import { canonicalColour, categoryOf, findPhrases, MATERIALS, normaliseSize, SIZE_WORDS } from '../lexicon';
import { parseShoppingQuery, type ShoppingQuery } from '../grammar';
import { applyPreferences, describeMemory, draftFromProposal, type MemoryDraft } from '../memory';
import type { MoneyAsk, MoneyPeriod, MoneyQuestion } from '../money';
import { readMoneyAt, readNumber } from '../numbers';
import { returnsShort } from '../copy/en';
import { type RankedOption } from '../ranking';
import { leftOutCounts, searchStepSummary, type ListingSearchResult } from '../search';
import { expandContractions, words } from '../text';
import { shopperSystemPrompt } from './prompt';
import { SHOPPER_TOOLS, TERMINAL_TOOLS, ToolInputs, type ToolName } from './tools';

// ---------------------------------------------------------------------------------------------
// Types

/** Creates one message. The web app passes the SDK client; tests pass a script. */
export type CreateMessage = (body: Anthropic.MessageCreateParamsNonStreaming, options: { timeout: number; maxRetries: number }) => Promise<Anthropic.Message>;

export interface ShopperPreferences {
  memories: Pick<MemoryDraft, 'kind' | 'value' | 'scope'>[];
  avoidColours?: string[];
  savedSizes?: Record<string, string>;
}

export interface PastOrder {
  snapshot: ProductSnapshot;
  times: number;
  lastOrderedAt: string;
  /** What the buyer paid, integer cents. */
  paidCents: number;
}

export interface ShopperInput {
  utterance: string;
  now: Date;
  verbosity: Verbosity;
  /** The options the buyer can hear now, in order (handles o1, o2, o3). */
  onScreen: Array<{ snapshot: ProductSnapshot; why: string[] }>;
  /** 1-based option the buyer is looking at. */
  focus?: number;
  lastQuery?: ShoppingQuery;
  preferences: ShopperPreferences;
  /** The question the agent asked last turn, if it asked one. */
  askedLastTurn?: string;
  /** Recent turns, oldest first. */
  recent: Array<{ role: 'buyer' | 'assistant'; text: string }>;
}

export interface ShopperDeps {
  create: CreateMessage;
  model: string;
  /** One catalog search, with the preferences already applied to the query. */
  search: (query: ShoppingQuery, text: string, prefs: { avoidMaterials: string[]; avoidColours: string[]; likeColours: string[] }) => Promise<ListingSearchResult>;
  orderHistory?: () => Promise<PastOrder[]>;
  limits?: { maxToolCalls?: number; maxModelCalls?: number; deadlineMs?: number; callTimeoutMs?: number };
  /** Milliseconds now; for tests. */
  clock?: () => number;
}

/** One product the agent may name this turn. */
export interface Known {
  handle: string;
  snapshot: ProductSnapshot;
  origin: 'result' | 'screen' | 'order';
  why: string[];
  option?: RankedOption;
  search?: ListingSearchResult;
  past?: PastOrder;
}

export type FallbackReason = 'no_key' | 'timeout' | 'error' | 'refusal' | 'cut_off' | 'cap' | 'no_finish';

export type ShopperOutcome =
  | { kind: 'present'; picks: Array<{ known: Known; reason?: string }>; lead?: string; query?: ShoppingQuery; notes: string[]; pool: Known[] }
  | { kind: 'ask'; question: string }
  | { kind: 'answer'; text: string; about: Known[] }
  | { kind: 'readback'; known: Known; size?: string }
  | { kind: 'recall' }
  | { kind: 'money'; ask: MoneyAsk }
  | { kind: 'fallback'; reason: FallbackReason; searches: ListingSearchResult[] };

/** One step for the visible "what your agent did" timeline. */
export interface AgentStep {
  tool: 'claude' | 'channel3' | 'catalog' | 'memory' | 'money';
  step: string;
  summary: string;
}

export interface ShopperResult {
  outcome: ShopperOutcome;
  /** A lasting preference to ask about, checked against the buyer's words. */
  remember?: MemoryDraft;
  /** Applied-preference notes from the searches ("Using your usual size M."). */
  notes: string[];
  steps: AgentStep[];
  usage: { inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number };
  modelCalls: number;
  toolCalls: number;
  ms: number;
  /** Lines the grounding check stopped, for the audit log. */
  ungrounded: string[];
}

// ---------------------------------------------------------------------------------------------
// Helpers

// A cold first call (the tool schemas compile once a day) can take about 8 seconds; warm calls take 1 to 3.
const DEFAULTS = { maxToolCalls: 6, maxModelCalls: 6, deadlineMs: 16_000, callTimeoutMs: 10_000 };
const MIN_CALL_MS = 1_500;

const PURCHASE = /\b(?:buy|order|purchase|checkout|check out|pay for|take|get me|i will have|i'll have|go with|reorder|re order|again|the usual)\b/;

/** The buyer asked to buy, in their own words: a readback is never started on a mere question. */
export function hasPurchaseIntent(text: string): boolean {
  return PURCHASE.test(expandContractions(words(text)).join(' '));
}

/** Sizes the buyer said, canonical. */
function spokenSizes(text: string): Set<string> {
  const ws = expandContractions(words(text));
  const out = new Set<string>();
  for (const m of findPhrases(ws, SIZE_WORDS)) out.add(m.canonical);
  for (let i = 0; i < ws.length; i++) {
    const n = readNumber(ws, i);
    if (n) out.add(normaliseSize(String(n.value))!);
  }
  return out;
}

/** Amounts the buyer said, in cents. */
function spokenAmounts(text: string): Set<number> {
  const ws = expandContractions(words(text));
  const out = new Set<number>();
  for (let i = 0; i < ws.length; i++) {
    const r = readMoneyAt(ws, i, 'USD', false);
    if (r) out.add(r.money.cents);
  }
  return out;
}

function priceText(s: ProductSnapshot): string {
  return formatMoney(s.price);
}

function sourceWords(s: ProductSnapshot): string {
  return s.source === 'demo-store' ? 'Demo Store' : 'another store, through Channel3';
}

function sizeStatus(o: RankedOption | undefined, s: ProductSnapshot, asked?: string): string {
  if (asked && o?.sizeFit) {
    switch (o.sizeFit) {
      case 'in_stock':
        return `size ${asked} in stock`;
      case 'offered':
      case 'other_listing':
        return `comes in size ${asked}; stock not stated`;
      case 'listed':
        return `size ${asked}`;
      case 'unknown':
        return `sizes not given, so size ${asked} is not confirmed`;
      default:
        return o.sizeFit;
    }
  }
  if (s.attributes.size) return `size ${s.attributes.size}`;
  if (s.attributes.sizes) return `sizes ${s.attributes.sizes}`;
  return 'sizes not given';
}

/** A listing as the model sees it in a search result: facts only, short. */
function resultView(k: Known, asked?: string) {
  const s = k.snapshot;
  return {
    id: k.handle,
    title: s.title,
    brand: s.brand ?? null,
    sold_by: sourceWords(s),
    price: priceText(s),
    colour: s.attributes.colour ?? 'not given',
    ...(s.attributes.colourName ? { colour_as_listed: s.attributes.colourName } : {}),
    size: sizeStatus(k.option, s, asked),
    material: s.attributes.material ?? 'not given',
    fit: s.attributes.fit ?? 'not given',
    for: s.attributes.audience ?? 'not given',
    rating: s.rating && s.rating.count > 0 ? `${s.rating.average} out of 5 from ${s.rating.count}` : 'none',
    returns: returnsShort(s.returnPolicy),
    photos: s.images.length > 0,
    ranking_notes: k.why.slice(0, 5),
  };
}

function detailView(k: Known) {
  const s = k.snapshot;
  return {
    ...resultView(k),
    description: (s.description ?? '').slice(0, 700) || 'none',
    attributes: s.attributes,
    review_quotes: (s.reviews ?? []).slice(0, 3).map((r) => r.quote),
    returns_text: s.returnPolicy?.text ?? 'not given',
  };
}

const leftOut = leftOutCounts;
const searchSummary = searchStepSummary;

function catalogStepTool(search: ListingSearchResult): AgentStep['tool'] {
  return search.source === 'demo-store' ? 'catalog' : 'channel3';
}

/** The context block: what is on screen, what is remembered, what was said. Volatile, per turn. */
export function contextBlock(input: ShopperInput, known: Known[]): string {
  const lines: string[] = [`Today is ${spokenDate(input.now)} ${input.now.getUTCFullYear()}.`];
  const screen = known.filter((k) => k.origin === 'screen');
  if (screen.length)
    lines.push(
      `Options the buyer can hear now: ${screen
        .map((k) => `${k.handle} = ${k.snapshot.title} (${sourceWords(k.snapshot)}), ${k.snapshot.attributes.colour ?? 'colour not given'}, ${sizeStatus(undefined, k.snapshot)}, ${priceText(k.snapshot)}`)
        .join('; ')}.`,
    );
  else lines.push('No options are on screen.');
  if (input.focus && screen[input.focus - 1]) lines.push(`The buyer is looking at ${screen[input.focus - 1]!.handle}.`);
  if (input.lastQuery) lines.push(`The last search was for ${describeQuery(input.lastQuery)}.`);
  const mem = input.preferences.memories;
  lines.push(
    mem.length
      ? `Saved preferences (applied in code unless for_someone_else): ${mem.map((m) => describeMemory(m).replace(/^you're /, 'is ').replace(/^you /, '')).join('; ')}.`
      : 'No saved preferences.',
  );
  if (input.askedLastTurn) lines.push(`You asked last turn: "${input.askedLastTurn}"`);
  if (input.recent.length) lines.push('Recent conversation, oldest first:', ...input.recent.slice(-6).map((r) => `${r.role === 'buyer' ? 'Buyer' : 'Assistant'}: ${r.text.slice(0, 300)}`));
  return lines.join('\n');
}

function textOf(message: Anthropic.Message): string {
  return message.content
    .filter((b): b is Anthropic.TextBlock => b.type === 'text')
    .map((b) => b.text)
    .join(' ')
    .trim();
}

function wordCount(s: string): number {
  return s.split(/\s+/).filter(Boolean).length;
}

// ---------------------------------------------------------------------------------------------
// The loop

/**
 * What every shopping-agent request shares, in one place, so the cached prefix (tools, then the
 * system prompt with its cache breakpoint, then the effort setting) is byte-identical across
 * turns and in the warm-up request.
 */
export function shopperRequestBase(model: string) {
  return {
    model,
    system: [{ type: 'text' as const, text: shopperSystemPrompt(), cache_control: { type: 'ephemeral' as const } }],
    tools: SHOPPER_TOOLS,
    tool_choice: { type: 'auto' as const },
    output_config: { effort: 'low' as const },
  };
}

/**
 * A warm-up request: `max_tokens: 0` writes the prompt cache for the shared prefix and returns at
 * once, with no output billed, so the buyer's first open request doesn't wait for a cold prefix.
 */
export function shopperWarmupRequest(model: string): Anthropic.MessageCreateParamsNonStreaming {
  return { ...shopperRequestBase(model), max_tokens: 0, messages: [{ role: 'user', content: 'warmup' }] };
}

export async function runShopper(input: ShopperInput, deps: ShopperDeps): Promise<ShopperResult> {
  const clock = deps.clock ?? Date.now;
  const started = clock();
  const limits = { ...DEFAULTS, ...deps.limits };
  const deadline = started + limits.deadlineMs;
  const steps: AgentStep[] = [];
  const notes: string[] = [];
  const ungrounded: string[] = [];
  const usage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
  const searches: ListingSearchResult[] = [];
  let remember: MemoryDraft | undefined;
  let modelCalls = 0;
  let toolCalls = 0;

  // Products the agent may name this turn, by handle.
  const known = new Map<string, Known>();
  input.onScreen.forEach((o, i) => known.set(`o${i + 1}`, { handle: `o${i + 1}`, snapshot: o.snapshot, origin: 'screen', why: o.why }));
  let nextResult = 1;
  let nextOrder = 1;
  const byVariant = new Map<string, string>();
  for (const k of known.values()) byVariant.set(`${k.snapshot.productId}|${k.snapshot.variantId}`, k.handle);

  // What the buyer said this turn and recently: the facts their own words support.
  const buyerText = [input.utterance, ...input.recent.filter((r) => r.role === 'buyer').slice(-3).map((r) => r.text)].join(' . ');
  const saidSizes = spokenSizes(buyerText);
  const saidAmounts = spokenAmounts(buyerText);
  const buyerFacts: Record<string, FactValue> = { 'buyer.words': buyerText, 'buyer.memories': input.preferences.memories.map((m) => describeMemory(m)).join('. ') };

  const done = (outcome: ShopperOutcome): ShopperResult => ({
    outcome,
    ...(remember ? { remember } : {}),
    notes: [...new Set(notes)],
    steps,
    usage,
    modelCalls,
    toolCalls,
    ms: clock() - started,
    ungrounded,
  });
  const fallback = (reason: FallbackReason, why: string): ShopperResult => {
    steps.push({ tool: 'claude', step: 'fell_back', summary: why });
    return done({ kind: 'fallback', reason, searches });
  };

  // ---- tools that gather facts ----

  async function search(raw: z.infer<typeof ToolInputs.search_products>): Promise<unknown> {
    // The size saved in Settings for this kind of clothing applies, as on the grammar's path; a gift drops it.
    const parsed = parseShoppingQuery(raw.query, { savedSizes: input.preferences.savedSizes as never });
    const category = raw.category ? (categoryOf(raw.category)?.canonical ?? parsed.category) : parsed.category;
    const colour = raw.colour ? (canonicalColour(raw.colour) ?? parsed.colour) : parsed.colour;
    const ignored: string[] = [];
    // A size, budget or price the buyer didn't say is not used: the model can't invent a filter.
    let size: string | undefined;
    if (raw.size) {
      const n = normaliseSize(raw.size);
      if (n && saidSizes.has(n)) size = n;
      else ignored.push(`size ${raw.size} (the buyer didn't say it)`);
    }
    const priceOk = (d: number | undefined) => d !== undefined && saidAmounts.has(Math.round(d * 100));
    if (raw.max_price_dollars !== undefined && !priceOk(raw.max_price_dollars)) ignored.push(`under $${raw.max_price_dollars} (the buyer didn't say it)`);
    if (raw.min_price_dollars !== undefined && !priceOk(raw.min_price_dollars)) ignored.push(`over $${raw.min_price_dollars} (the buyer didn't say it)`);
    const base: ShoppingQuery = {
      ...parsed,
      // Prices and sizes come only from the buyer's words, never from the model's search wording.
      maxPrice: undefined,
      minPrice: undefined,
      text: input.utterance,
      ...(category ? { category } : {}),
      ...(colour ? { colour } : {}),
      ...(size ? { size, sizeSource: 'spoken' as const } : parsed.sizeSource === 'saved' ? {} : { size: undefined, sizeSource: undefined }),
      ...(priceOk(raw.max_price_dollars) ? { maxPrice: money(Math.round(raw.max_price_dollars! * 100)) } : {}),
      ...(priceOk(raw.min_price_dollars) ? { minPrice: money(Math.round(raw.min_price_dollars! * 100)) } : {}),
    };
    const applied = applyPreferences(base, input.preferences.memories, { avoidColours: input.preferences.avoidColours }, { forSomeoneElse: raw.for_someone_else });
    notes.push(...applied.notes);
    const avoidMaterials = [
      ...new Set([
        ...applied.avoidMaterials,
        ...(raw.avoid_materials ?? []).map((m) => findPhrases(words(m), MATERIALS)[0]?.canonical).filter((m): m is string => Boolean(m)),
      ]),
    ];
    const result = await deps.search(applied.query, raw.query, { avoidMaterials, avoidColours: applied.avoidColours, likeColours: applied.likeColours });
    searches.push(result);
    const shown: Known[] = [];
    for (const o of result.options.slice(0, 8)) {
      const key = `${o.snapshot.productId}|${o.snapshot.variantId}`;
      let handle = byVariant.get(key);
      if (!handle) {
        handle = `p${nextResult++}`;
        byVariant.set(key, handle);
        known.set(handle, { handle, snapshot: o.snapshot, origin: 'result', why: o.why, option: o, search: result });
      }
      shown.push(known.get(handle)!);
    }
    steps.push({ tool: catalogStepTool(result), step: 'searched', summary: searchSummary(result, shown.length) });
    return {
      searched_for: describeQuery(applied.query),
      saved_preferences_used: applied.notes,
      ...(ignored.length ? { filters_not_used: ignored } : {}),
      ...(result.liveFailed ? { note: 'Channel3 did not answer; these are Demo Store items only.' } : {}),
      results: shown.map((k) => resultView(k, applied.query.size)),
      left_out: leftOut(result),
    };
  }

  function details(id: string): unknown {
    const k = known.get(id);
    if (!k) throw new ToolError(`Unknown id ${id}. Use an id from search results, the options on screen, or order history.`);
    steps.push({ tool: 'claude', step: 'read_details', summary: `Read the full listing for ${k.snapshot.title}.` });
    return detailView(k);
  }

  function compare(ids: string[], aspect?: string): unknown {
    const items = ids.map((id) => known.get(id));
    if (items.some((k) => !k)) throw new ToolError(`Unknown id in ${ids.join(', ')}.`);
    const list = items as Known[];
    const c = presentComparison(list.map((k, i) => ({ label: i + 1, snapshot: k.snapshot })), aspect, 'detailed');
    steps.push({ tool: 'claude', step: 'compared', summary: `Compared ${list.map((k) => k.snapshot.title).join(' and ')}${aspect ? ` on ${aspect}` : ''}.` });
    return { columns: list.map((k) => k.handle), rows: c.rows.map((r) => ({ label: r.label, values: r.values })) };
  }

  async function history(): Promise<unknown> {
    const past = deps.orderHistory ? await deps.orderHistory() : [];
    const out = past.slice(0, 6).map((p) => {
      const key = `${p.snapshot.productId}|${p.snapshot.variantId}`;
      let handle = byVariant.get(key);
      if (!handle || !handle.startsWith('h')) {
        handle = `h${nextOrder++}`;
        byVariant.set(key, handle);
        known.set(handle, { handle, snapshot: p.snapshot, origin: 'order', why: [], past: p });
      }
      return {
        id: handle,
        title: p.snapshot.title,
        colour: p.snapshot.attributes.colour ?? 'not given',
        size: p.snapshot.attributes.size ?? 'not given',
        paid: formatMoney(money(p.paidCents, p.snapshot.price.currency)),
        times_ordered: p.times,
        last_ordered: spokenDate(p.lastOrderedAt),
      };
    });
    steps.push({ tool: 'claude', step: 'read_orders', summary: `Read the buyer's order history: ${out.length} ${out.length === 1 ? 'item' : 'items'}.` });
    return { orders: out };
  }

  function proposeMemory(raw: z.infer<typeof ToolInputs.remember_preference>): unknown {
    const draft = draftFromProposal(raw, input.utterance);
    if (!draft) throw new ToolError("That isn't in what the buyer said, so it can't be remembered.");
    if (!remember) remember = draft;
    return { status: 'The app will ask the buyer before saving this.', will_ask: describeMemory(draft) };
  }

  // ---- finishing tools ----

  /** A line the model wrote, kept only if every product fact in it is in these listings or the buyer's words. */
  function grounded(text: string, about: Known[], facts: Record<string, FactValue>): boolean {
    const ok = checkFreeText({ text, snapshots: about.map((k) => k.snapshot), facts }).supported;
    if (!ok) ungrounded.push(text);
    return ok;
  }

  function finish(name: string, raw: unknown): ShopperResult {
    switch (name) {
      case 'ask_clarifying_question': {
        const { question } = ToolInputs.ask_clarifying_question.parse(raw);
        const q = question.trim();
        if (!q.endsWith('?') || wordCount(q) > 30) throw new ToolError('Ask one short question ending with a question mark.');
        if (!grounded(q, [...known.values()], buyerFacts)) throw new ToolError('The question states something the listings or the buyer did not say. Ask without it.');
        steps.push({ tool: 'claude', step: 'asked', summary: `Asked: "${q}"` });
        return done({ kind: 'ask', question: q });
      }
      case 'present_options': {
        const p = ToolInputs.present_options.parse(raw);
        const ids = [...new Set(p.options.map((o) => o.id))];
        const missing = ids.filter((id) => !known.has(id) || known.get(id)!.origin === 'order');
        if (missing.length) throw new ToolError(`Unknown id ${missing.join(', ')}. Present ids from search results or the options on screen.`);
        const picks = ids.map((id) => {
          const k = known.get(id)!;
          const reason = p.options.find((o) => o.id === id)!.reason.trim();
          const facts: Record<string, FactValue> = {
            ...(k.search?.query.maxPrice ? { 'query.maxPrice': k.search.query.maxPrice } : {}),
            ...(k.search?.query.minPrice ? { 'query.minPrice': k.search.query.minPrice } : {}),
          };
          const keep = reason && wordCount(reason) <= 20 && grounded(reason, [k], facts);
          return { known: k, ...(keep ? { reason } : {}) };
        });
        const lead = p.lead?.trim();
        const leadOk = lead && wordCount(lead) <= 16 && grounded(lead, picks.map((x) => x.known), buyerFacts) ? lead : undefined;
        const first = picks.find((x) => x.known.search)?.known.search;
        const presented = new Set(picks.map((x) => x.known.handle));
        const pool = [...known.values()].filter((k) => k.origin === 'result' && !presented.has(k.handle));
        steps.push({ tool: 'claude', step: 'presented', summary: `Chose ${picks.length === 1 ? 'one option' : `${picks.length} options`}: ${picks.map((x) => x.known.snapshot.title).join('; ')}.` });
        return done({ kind: 'present', picks, ...(leadOk ? { lead: leadOk } : {}), ...(first ? { query: first.query } : {}), notes: [...new Set(notes)], pool });
      }
      case 'answer_about_products': {
        const a = ToolInputs.answer_about_products.parse(raw);
        const out: string[] = [];
        const about = new Map<string, Known>();
        for (const s of a.sentences) {
          const ks = s.product_ids.map((id) => known.get(id)).filter((k): k is Known => Boolean(k));
          if (ks.length !== s.product_ids.length) throw new ToolError(`Unknown id in ${s.product_ids.join(', ')}.`);
          ks.forEach((k) => about.set(k.handle, k));
          // A sentence with no product cites only the buyer's own words and memories.
          const ok = grounded(s.text, ks, ks.length ? {} : buyerFacts);
          const line = ok ? s.text.trim() : "The listing doesn't say.";
          if (out[out.length - 1] !== line) out.push(line);
        }
        if (out.every((l) => l === "The listing doesn't say.") && out.length > 0 && ungrounded.length >= 2) throw new ToolError('Those sentences state facts the listings do not give. Answer only from the listings.');
        steps.push({ tool: 'claude', step: 'answered', summary: `Answered from ${about.size === 1 ? 'one listing' : `${about.size} listings`}.` });
        return done({ kind: 'answer', text: out.join(' '), about: [...about.values()] });
      }
      case 'start_readback': {
        const r = ToolInputs.start_readback.parse(raw);
        const k = known.get(r.id);
        if (!k) throw new ToolError(`Unknown id ${r.id}.`);
        if (!hasPurchaseIntent(input.utterance)) throw new ToolError("The buyer hasn't asked to buy anything. Present it or answer instead.");
        let size: string | undefined;
        if (r.size) {
          const n = normaliseSize(r.size);
          if (!n || !saidSizes.has(n)) throw new ToolError(`The buyer didn't say size ${r.size}. Leave the size out; the app asks for it.`);
          size = n;
        }
        steps.push({ tool: 'claude', step: 'chose_to_buy', summary: `Handed ${k.snapshot.title}${size ? `, size ${size},` : ''} to the readback.` });
        return done({ kind: 'readback', known: k, ...(size ? { size } : {}) });
      }
      case 'recall_preferences':
        // The app reads the memories and logs that step; the model only chose to.
        return done({ kind: 'recall' });
      case 'money_question': {
        const m = ToolInputs.money_question.parse(raw);
        return done({ kind: 'money', ask: { question: m.question as MoneyQuestion, ...(m.period ? { period: m.period as MoneyPeriod } : {}) } });
      }
      default:
        throw new ToolError(`${name} does not end the turn.`);
    }
  }

  async function gather(name: string, raw: unknown): Promise<unknown> {
    switch (name as ToolName) {
      case 'search_products':
        return search(ToolInputs.search_products.parse(raw));
      case 'get_product_details':
        return details(ToolInputs.get_product_details.parse(raw).id);
      case 'compare_products': {
        const c = ToolInputs.compare_products.parse(raw);
        return compare(c.ids, c.aspect);
      }
      case 'get_order_history':
        return history();
      case 'remember_preference':
        return proposeMemory(ToolInputs.remember_preference.parse(raw));
      default:
        throw new ToolError(`There is no tool called ${name}.`);
    }
  }

  // ---- the conversation with the model ----

  const messages: Anthropic.MessageParam[] = [
    {
      role: 'user',
      content: `<context>\n${contextBlock(input, [...known.values()])}\n</context>\n<buyer_said>${input.utterance.replace(/</g, '‹')}</buyer_said>`,
    },
  ];
  const base = shopperRequestBase(deps.model);

  while (modelCalls < limits.maxModelCalls) {
    const left = deadline - clock();
    if (left < MIN_CALL_MS) return fallback('timeout', 'Claude ran out of time for this turn, so the built-in search answered instead.');
    let message: Anthropic.Message;
    try {
      modelCalls++;
      message = await deps.create(
        { ...base, max_tokens: 2048, messages },
        { timeout: Math.min(limits.callTimeoutMs, left), maxRetries: 0 },
      );
    } catch (e) {
      const timedOut = e instanceof Error && /timed? ?out|abort/i.test(`${e.name} ${e.message}`);
      return fallback(timedOut ? 'timeout' : 'error', timedOut ? 'Claude took too long, so the built-in search answered instead.' : 'Claude could not be reached, so the built-in search answered instead.');
    }
    usage.inputTokens += message.usage.input_tokens;
    usage.outputTokens += message.usage.output_tokens;
    usage.cacheReadTokens += message.usage.cache_read_input_tokens ?? 0;
    usage.cacheWriteTokens += message.usage.cache_creation_input_tokens ?? 0;
    if (message.stop_reason === 'refusal') return fallback('refusal', 'Claude declined this request, so the built-in search answered instead.');
    if (message.stop_reason === 'max_tokens') return fallback('cut_off', "Claude's answer was cut off, so the built-in search answered instead.");

    const uses = message.content.filter((b): b is Anthropic.ToolUseBlock => b.type === 'tool_use');
    if (uses.length === 0) {
      // Plain text is not a finishing tool. One reminder, then fall back.
      const text = textOf(message);
      messages.push({ role: 'assistant', content: message.content });
      if (modelCalls >= 2 || !text) return fallback('no_finish', 'Claude did not finish with a tool, so the built-in search answered instead.');
      messages.push({ role: 'user', content: 'Finish the turn with one of the finishing tools, not plain text.' });
      continue;
    }
    messages.push({ role: 'assistant', content: message.content });

    const results: Anthropic.ToolResultBlockParam[] = [];
    // Facts first (in parallel), then at most one finishing tool.
    const gathering = uses.filter((u) => !TERMINAL_TOOLS.has(u.name));
    const finishing = uses.filter((u) => TERMINAL_TOOLS.has(u.name));
    await Promise.all(
      gathering.map(async (u) => {
        if (toolCalls >= limits.maxToolCalls) {
          results.push({ type: 'tool_result', tool_use_id: u.id, is_error: true, content: 'Tool limit reached. Finish the turn now with what you have.' });
          return;
        }
        toolCalls++;
        try {
          const out = await gather(u.name, u.input);
          results.push({ type: 'tool_result', tool_use_id: u.id, content: JSON.stringify(out) });
        } catch (e) {
          results.push({ type: 'tool_result', tool_use_id: u.id, is_error: true, content: toolErrorText(e) });
        }
      }),
    );
    for (const u of finishing) {
      if (u !== finishing[0] || gathering.length > 0) {
        results.push({ type: 'tool_result', tool_use_id: u.id, is_error: true, content: 'Finish with one tool, after the facts you need have come back.' });
        continue;
      }
      toolCalls++;
      try {
        return finish(u.name, u.input);
      } catch (e) {
        results.push({ type: 'tool_result', tool_use_id: u.id, is_error: true, content: toolErrorText(e) });
      }
    }
    // Every tool_use gets its result, in the order the model asked.
    results.sort((a, b) => uses.findIndex((u) => u.id === a.tool_use_id) - uses.findIndex((u) => u.id === b.tool_use_id));
    messages.push({ role: 'user', content: results });
    if (toolCalls > limits.maxToolCalls + 1) break;
  }
  return fallback('cap', 'Claude used its limit of steps for one turn, so the built-in search answered instead.');
}

/** A tool input or call that can't be run; the model gets the reason and can correct it. */
export class ToolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ToolError';
  }
}

function toolErrorText(e: unknown): string {
  if (e instanceof ToolError) return e.message;
  if (e instanceof z.ZodError) return `The input doesn't fit the tool: ${e.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`;
  return 'That tool failed. Try another way, or finish with what you have.';
}

