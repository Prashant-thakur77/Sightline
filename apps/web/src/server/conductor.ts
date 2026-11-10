import 'server-only';
import { and, desc, eq, inArray, isNull } from 'drizzle-orm';
import { tables } from '@sightline/db';
import { formatMoney, formatMoneyShort, money, newId, type Cart, type ProductSnapshot, type Verbosity } from '@sightline/core';
import { hashCart, hashReadbackText } from '@sightline/evidence';
import { computeTotals, deliveryEstimate } from '@sightline/catalog';
import {
  answerReadbackQuestion,
  applyPreferences,
  describeMemory,
  interpretListing,
  isForSomeoneElse,
  memoriesToForget,
  memoryWords,
  moneyQuestionWords,
  normaliseSize,
  optionsHeading,
  pageOf,
  parsePreferenceStatement,
  recallSpeech,
  sameSize,
  searchListings,
  searchStepSummary,
  type ForgetTarget,
  type Known,
  type ListingSearchResult,
  type MemoryDraft,
  type MemorySlots,
  type MoneyAsk,
  type RankedOption as AgentRankedOption,
  type ShopperResult,
  type UtteranceCapture,
  domainOf,
  joinAnd,
  joinOr,
  findPhrases,
  SIZE_WORDS,
  words,
  categoryOf,
  checkGrounding,
  composeReadback,
  decideConfirmation,
  en,
  initialConfirmationState,
  listingWarnings,
  normaliseText,
  parseIntent,
  parseShoppingQuery,
  parseYesNo,
  presentComparison,
  presentDetails,
  presentNone,
  describeQuery,
  presentOfferAnswer,
  presentOfferChoice,
  presentOptions,
  presentPaid,
  presentWhy,
  type ConfirmationState,
  type DetailsTopic,
  type NoneSuggestion,
  type OfferChoice,
  type OptionContext,
  type ParsedIntent,
  type SettingsSlots,
  type ShoppingQuery,
} from '@sightline/agent';
import type { Card, ChatMessage, OptionItem, TurnRequest, TurnResponse } from '@/components/conversation/types';
import { db, demoSeller, ENV, INTEGRATIONS } from './runtime';
import { aiAvailable, answerAboutListing, confirmationClassifier, extractShoppingQuery } from './ai';
import { payForReadback, completeApprovedOrder, reconcileUnknownOrders, type PayOutcome } from './payments';
import { audit } from './audit';
import { answerOffer, findOpenOffer, isOfferNotice, markOfferNoticesRead, type OpenOffer } from './offers';
import { offerKind, type OfferAnswer } from './offer-plan';
import { catalog, freeze } from './catalog';
import { forgetAllMemories, forgetMemories, listMemories, saveMemory } from './memories';
import { answerMoney } from './money-answers';
import { recordReadbackProposed, recordStep, startThread, type Thread } from './agent-steps';
import { pastOrders, prewarmShopper, runShopperTurn, shopperAvailable } from './shopper';

const SNAPSHOT_MAX_AGE_MS = 12 * 60 * 1000;

interface StoredOption extends OptionContext {
  productId: string;
  snapshotId: string;
  selection: Record<string, string>;
  why: string[];
  /** The caveats within why, so "why these?" can lead with the reasons. */
  caveats?: string[];
  /** False when the asked-for size was out of stock, so a restored card keeps "Buy this" off. */
  available?: boolean;
  /** The listing to buy from for the chosen size, when the store sells that size as its own listing. */
  sizeProductId?: string;
  /** The shopping agent's grounded line about this option, shown on the card. */
  pick?: string;
}

/**
 * What "yes" does after a question the assistant just asked ("Want me to try up to $45?"). Never
 * a purchase: paying always goes through the readback and its two-key confirmation.
 */
type Pending =
  | { kind: 'search'; query: ShoppingQuery; said: string }
  | { kind: 'ask'; said: string }
  | { kind: 'check'; said: string }
  | { kind: 'verbosity'; verbosity: Verbosity; said: string }
  /** "Shall I remember that ...?": only "yes" stores it. */
  | { kind: 'remember'; drafts: MemoryDraft[]; said: string }
  /** "Which size?" before a readback: a size the listing offers answers it. */
  | { kind: 'buy_size'; index: number; sizes: string[]; said: string; by?: 'claude' | 'app' };

interface ConvoState {
  phase: 'browsing' | 'readback' | 'offer';
  query?: ShoppingQuery;
  offset?: number;
  options?: StoredOption[];
  focus?: number;
  readbackId?: string;
  confirm?: ConfirmationState;
  lastSay?: string;
  /** The offers in the question just asked; cleared on every turn that does not answer it. */
  pending?: Pending[];
  /** The store's offer that was just read out, while phase is 'offer'. */
  offer?: {
    caseId: string;
    offerId: string;
    /** When Accept was first pressed; only the very next turn can be the second press. */
    armedAt?: number;
  };
  /** The options card's heading, which claims only what every option confirms. */
  heading?: string;
  /** Snapshot ids the shopping agent found but didn't present, best first, for "more". */
  pool?: string[];
  /** The question the shopping agent asked last turn, so the answer is read in its light. */
  agentAsked?: string;
  /** The current shopping thread, for the agent's step log. */
  thread?: Thread;
}

interface Ctx {
  userId: string;
  firstName: string;
  conversationId: string;
  /** When the conversation last changed, so a stale one isn't picked up again. */
  updatedAt: string;
  state: ConvoState;
  prefs: typeof tables.preferences.$inferSelect;
  out: { messages: ChatMessage[] };
  /** How this turn's words were captured. Only held or typed words can be key 1 of a confirmation. */
  capture: UtteranceCapture;
}

type Reply = Omit<TurnResponse, 'messages' | 'phase'>;

const HELP_CARD: Card = {
  kind: 'help',
  heading: 'Things you can say',
  groups: [
    { title: 'Shopping', phrases: ['I need a navy crew-neck sweater, medium, under forty dollars', 'a gift for my sister who hikes, under $50', 'cheaper', 'more'] },
    { title: 'Choosing', phrases: ['two', 'tell me more about one', 'which one is warmest?', 'compare them', 'why these?'] },
    { title: 'Buying', phrases: ['buy number one', 'buy my usual again', 'confirm purchase', 'wait', 'cancel'] },
    { title: 'Money', phrases: ["what's on hold?", 'how much did I spend this month?', 'did I get my refund?'] },
    { title: 'What I remember', phrases: ["I'm a medium in sweaters", 'what do you remember about me?', 'forget my size'] },
    { title: 'After you buy', phrases: ["where's my order", 'it arrived', 'this is wrong'] },
  ],
};

function snapshotRowToSnapshot(row: typeof tables.productSnapshots.$inferSelect): ProductSnapshot {
  return row.body as ProductSnapshot;
}

async function loadSnapshots(ids: string[]): Promise<Map<string, ProductSnapshot>> {
  if (ids.length === 0) return new Map();
  const rows = await db().select().from(tables.productSnapshots).where(inArray(tables.productSnapshots.id, ids));
  return new Map(rows.map((r) => [r.id, snapshotRowToSnapshot(r)]));
}

async function saveSnapshot(s: ProductSnapshot): Promise<void> {
  await db()
    .insert(tables.productSnapshots)
    .values({ id: s.id, productId: s.productId, variantId: s.variantId, source: s.source, body: s, hash: s.hash, capturedAt: s.capturedAt })
    .onConflictDoNothing();
}

function returnsLabel(s: ProductSnapshot): string {
  const r = s.returnPolicy;
  if (!r) return 'Not listed';
  if (r.windowDays) return `${r.free ? 'Free, ' : ''}${r.windowDays} days`;
  return r.free ? 'Free' : 'Listed, see details';
}

/** The colour as the card shows it: the plain colour, or only the store's own name for it. */
function colourLabel(s: ProductSnapshot): string | undefined {
  const { colour, colourName } = s.attributes;
  if (colour && colourName && colourName.toLowerCase() !== colour.toLowerCase()) return `${colour} (listed as “${colourName}”)`;
  return colour ?? (colourName ? `Listed as “${colourName}”` : undefined);
}

function optionItem(index: number, s: ProductSnapshot, why: string[], available = true, pick?: string, size?: string): OptionItem {
  return {
    index,
    productId: s.productId,
    title: s.title,
    brand: s.brand,
    colour: colourLabel(s),
    size: size ?? s.attributes.size ?? (s.attributes.sizes ? `Choose from ${s.attributes.sizes}` : undefined),
    price: formatMoneyShort(s.price),
    returns: returnsLabel(s),
    available,
    imageUrl: s.images[0]?.url,
    imageAlt: s.images[0]?.alt,
    why,
    ...(pick ? { pick } : {}),
  };
}

const selectionOf = (s: ProductSnapshot): Record<string, string> =>
  Object.fromEntries(s.variantId.split(';').filter((kv) => kv.includes('=')).map((kv) => kv.split('=') as [string, string]));

/** Ranked options as stored conversation options, with what the grammar needs next turn. */
function storeOptions(options: AgentRankedOption[], context: OptionContext[], picks: Array<string | undefined> = []): StoredOption[] {
  return options.map((o, i) => ({
    ...context[i]!,
    productId: o.snapshot.productId,
    snapshotId: o.snapshot.id,
    selection: selectionOf(o.snapshot),
    why: o.why,
    caveats: o.caveats,
    available: o.sizeInStock !== false,
    ...(o.sizeProductId ? { sizeProductId: o.sizeProductId } : {}),
    ...(picks[i] ? { pick: picks[i] } : {}),
  }));
}

/** Sentences for what saved preferences left out ("I left out 2 with wool, as you asked."). */
function leftOutNotes(result: ListingSearchResult, avoided: string[]): string[] {
  const n = result.excluded.filter((e) => e.reason === 'avoided_material').length;
  return n && avoided.length ? [memoryWords.leftOut(n, avoided.join(' or '))] : [];
}

function suggestionsFor(phase: ConvoState['phase'], hasOptions: boolean): Reply['suggestions'] {
  // The readback card has its own Confirm, Wait and Cancel buttons; repeating them here would
  // mean two Confirm controls. These are questions the readback can answer instead.
  if (phase === 'readback')
    return [
      { label: 'What’s the total?', utterance: "what's the total" },
      { label: 'When does it arrive?', utterance: 'when does it arrive' },
      { label: 'Read it again', utterance: 'read it again' },
    ];
  // The offer card has its own Accept and Decline buttons; these leave the offer open.
  if (phase === 'offer')
    return [
      { label: 'Hear the offer again', utterance: 'what did they offer' },
      { label: 'Not now', utterance: 'not now' },
    ];
  if (hasOptions)
    return [
      { label: 'Tell me more about one', utterance: 'tell me more about one' },
      { label: 'Compare them', utterance: 'compare them' },
      { label: 'Why these?', utterance: 'why these' },
      { label: 'More options', utterance: 'more' },
    ];
  return [
    { label: 'Navy crew-neck sweater, medium, under $40', utterance: 'I need a navy crew-neck sweater, medium, under forty dollars' },
    { label: "Where's my order?", utterance: "where's my order" },
    { label: 'Help', utterance: 'help' },
  ];
}

// ---------------------------------------------------------------------------------------------
// Shopping

/**
 * The grammar's fast path for a search: saved preferences applied and said in words, the merged
 * catalog asked once, each listing read honestly, and at most three options read out under a
 * heading that claims only what every option confirms.
 */
async function search(ctx: Ctx, query: ShoppingQuery, offset = 0, opts: { remember?: MemoryDraft[] } = {}): Promise<Reply> {
  const memories = offset === 0 ? await listMemories(ctx.userId) : [];
  const applied = applyPreferences(query, memories, { avoidColours: ctx.prefs.avoidColours }, { forSomeoneElse: isForSomeoneElse(query.text) });
  if (offset === 0) startThread(ctx);
  let result: ListingSearchResult;
  try {
    result = await searchListings({
      query: applied.query,
      source: catalog(ctx.userId),
      freeze,
      avoidColours: applied.avoidColours,
      avoidMaterials: applied.avoidMaterials,
      likeColours: applied.likeColours,
    });
  } catch (e) {
    console.error('[conductor] catalog search failed', e);
    return { say: 'The store catalog is not answering right now. Nothing has changed. Please try again in a moment.', politeness: 'assertive', cue: 'error', card: null, suggestions: suggestionsFor('browsing', false) };
  }
  if (offset === 0) await recordStep(ctx, { tool: result.source === 'demo-store' ? 'catalog' : 'channel3', step: 'searched', summary: searchStepSummary(result, pageOf(result).options.length) });
  const notes = offset === 0 ? [...applied.notes, ...leftOutNotes(result, applied.avoidMaterials)] : [];
  return renderSearch(ctx, result, notes, offset, opts);
}

/** Read out a page of a search's options (or say plainly that nothing fits), by template. */
async function renderSearch(ctx: Ctx, result: ListingSearchResult, notes: string[], offset: number, opts: { remember?: MemoryDraft[] } = {}): Promise<Reply> {
  const page = pageOf(result, offset);
  const q = result.query;
  if (page.options.length === 0) {
    const none = presentNone(q, page, { store: demoSeller().name });
    ctx.state.options = [];
    // Refinements and "yes" apply to what was just asked.
    ctx.state.query = q;
    ctx.state.offset = 0;
    ctx.state.focus = undefined;
    ctx.state.pool = undefined;
    ctx.state.pending = none.suggestions.map((sg) => pendingForNone(q, sg));
    return { say: [...notes, none.text].join(' '), politeness: 'polite', card: null, suggestions: pendingChips(ctx.state.pending) };
  }
  for (const o of page.options) await saveSnapshot(o.snapshot);
  const presentation = presentOptions(page, { query: q, verbosity: ctx.prefs.verbosity as Verbosity, firstPage: offset === 0, notes });
  const heading = optionsHeading(q, page.options);
  ctx.state.query = q;
  ctx.state.heading = heading;
  ctx.state.offset = offset;
  ctx.state.focus = undefined;
  ctx.state.pool = undefined;
  ctx.state.options = storeOptions(page.options, presentation.context);
  let say = presentation.text;
  // A lasting preference said with the search ("I'm a medium in sweaters, find me ..."): ask once.
  if (opts.remember?.length) {
    say = `${say} ${rememberQuestion(opts.remember)}`;
    ctx.state.pending = [{ kind: 'remember', drafts: opts.remember, said: 'remember' }];
  }
  return {
    say,
    politeness: 'polite',
    card: { kind: 'options', heading, items: page.options.map((o, i) => optionItem(i + 1, o.snapshot, o.why, o.sizeInStock !== false, undefined, o.displaySize)) },
    suggestions: opts.remember?.length ? rememberChips() : suggestionsFor('browsing', true),
  };
}

/** "Shall I remember that you're a medium in sweaters, and that you avoid wool?" */
function rememberQuestion(drafts: MemoryDraft[]): string {
  const [first, ...rest] = drafts;
  if (!first) return '';
  const ask = memoryWords.ask(first);
  return rest.length ? `${ask.replace(/\?$/, '')}, and that ${rest.map(describeMemory).join(', and that ')}?` : ask;
}

function rememberChips(): Reply['suggestions'] {
  return [
    { label: 'Yes, remember it', utterance: 'yes' },
    { label: 'No, thanks', utterance: 'no thanks' },
  ];
}

/** "More" after the shopping agent's picks: the next listings it found, best first. */
async function morefromPool(ctx: Ctx): Promise<Reply> {
  const ids = (ctx.state.pool ?? []).slice(0, 3);
  const snaps = await loadSnapshots(ids);
  const shown = ids.map((id) => snaps.get(id)).filter((s): s is ProductSnapshot => Boolean(s));
  if (!shown.length) {
    ctx.state.pool = undefined;
    return { say: en.search.noMore, politeness: 'polite', card: null, suggestions: suggestionsFor('browsing', Boolean(ctx.state.options?.length)) };
  }
  const options: AgentRankedOption[] = shown.map((s, i) => ({ rank: i + 1, snapshot: s, score: 0, why: [], caveats: [], verifiable: Boolean(s.attributes.colour && s.images.length), missing: [] }));
  ctx.state.pool = (ctx.state.pool ?? []).slice(3);
  const query = ctx.state.query;
  const presentation = presentOptions({ options, remaining: ctx.state.pool.length }, { query, verbosity: ctx.prefs.verbosity as Verbosity, firstPage: false });
  const heading = query ? optionsHeading(query, options) : `${options.length === 1 ? 'One more option' : `${options.length} more options`}`;
  ctx.state.options = storeOptions(options, presentation.context);
  ctx.state.heading = heading;
  ctx.state.focus = undefined;
  return { say: presentation.text, politeness: 'polite', card: { kind: 'options', heading, items: options.map((o, i) => optionItem(i + 1, o.snapshot, o.why)) }, suggestions: suggestionsFor('browsing', true) };
}

async function optionSnapshot(ctx: Ctx, index: number): Promise<{ opt: StoredOption; snap: ProductSnapshot } | null> {
  const opt = ctx.state.options?.find((o) => o.index === index);
  if (!opt) return null;
  const snaps = await loadSnapshots([opt.snapshotId]);
  const snap = snaps.get(opt.snapshotId);
  return snap ? { opt, snap } : null;
}

async function details(ctx: Ctx, index: number | undefined, topic: DetailsTopic, question?: string): Promise<Reply> {
  const i = index ?? ctx.state.focus ?? (ctx.state.options?.length === 1 ? 1 : undefined);
  if (!i) return { say: 'Which one? Say a number.', politeness: 'polite', card: null, suggestions: suggestionsFor('browsing', Boolean(ctx.state.options?.length)) };
  const found = await optionSnapshot(ctx, i);
  if (!found) return { say: `I don't have an option ${i}. Say what you're looking for.`, politeness: 'polite', card: null, suggestions: suggestionsFor('browsing', false) };
  ctx.state.focus = i;
  const { snap } = found;
  let spoken = presentDetails(snap, topic, ctx.prefs.verbosity as Verbosity).text;

  // Review questions are answered only with verbatim quotes from the frozen listing.
  if (['reviews', 'sizing', 'fit', 'size_chart'].includes(topic)) {
    const reviews = snap.reviews ?? [];
    const wanted = topic === 'reviews' ? null : /\b(size|sized|sizing|fit|fits|runs|small|large|big|tight|loose|length|short|long)\b/i;
    const picked = reviews.filter((r) => !wanted || wanted.test(r.quote)).slice(0, 2);
    if (picked.length > 0) {
      const lead = topic === 'reviews' ? 'Here is what reviewers say, quoted.' : 'About sizing, reviewers say, quoted:';
      spoken = `${lead} ${picked.map((r) => `“${r.quote}”`).join(' ')}`;
    } else {
      spoken = topic === 'reviews' ? 'The listing has no reviews I can quote.' : "The reviews I have don't mention sizing.";
    }
  }

  // A question the templates don't cover goes to the model, then through the grounding guard.
  if (question && topic === 'general' && aiAvailable()) {
    try {
      const answer = await answerAboutListing(question, snap);
      if (answer) {
        const report = checkGrounding({
          segments: answer.segments,
          snapshots: [snap],
          archives: { reviews: (snap.reviews ?? []).map((r) => r.quote).join('\n') },
          now: new Date(),
        });
        if (report.text.trim()) spoken = report.text;
        await audit({
          userId: ctx.userId,
          actor: 'agent',
          action: 'answer.grounded',
          subjectId: snap.id,
          payload: { question, supported: report.supported, replaced: report.replaced, unsupported: report.unsupported.map((u) => u.text) },
        });
      }
    } catch (e) {
      console.error('[conductor] grounded answer failed', e);
    }
  }

  const facts = [
    { label: 'Price', value: formatMoney(snap.price), source: 'listing' },
    { label: 'Colour', value: snap.attributes.colour ?? 'The listing doesn’t say', source: snap.attributes.colour ? 'listing' : undefined },
    { label: 'Size', value: snap.attributes.size ?? 'The listing doesn’t say', source: snap.attributes.size ? 'listing' : undefined },
    { label: 'Material', value: snap.attributes.material ?? 'The listing doesn’t say', source: snap.attributes.material ? 'listing' : undefined },
    { label: 'Fit', value: snap.attributes.fit ?? 'The listing doesn’t say', source: snap.attributes.fit ? 'listing' : undefined },
    { label: 'Care', value: snap.attributes.care ?? 'The listing doesn’t say', source: snap.attributes.care ? 'listing' : undefined },
    { label: 'Returns', value: snap.returnPolicy?.text ?? 'The listing doesn’t say', source: snap.returnPolicy ? 'listing' : undefined },
    { label: 'Seller', value: snap.seller.name, source: 'order' },
  ];
  return {
    say: spoken,
    politeness: 'polite',
    card: {
      kind: 'details',
      heading: `Option ${i}: ${snap.title}`,
      item: optionItem(i, snap, found.opt.why),
      facts,
      quotes: (snap.reviews ?? []).map((r) => ({ text: r.quote, source: `Review${r.rating ? `, ${r.rating} of 5` : ''}` })),
    },
    suggestions: [
      { label: `Buy option ${i}`, utterance: `buy number ${i}` },
      { label: 'What do reviews say about sizing?', utterance: 'what do reviews say about sizing' },
      { label: 'Back to the options', utterance: 'read the options again' },
    ],
  };
}

async function compare(ctx: Ctx, indices: number[] | 'all', aspect?: string): Promise<Reply> {
  const opts = ctx.state.options ?? [];
  const chosen = indices === 'all' ? opts : opts.filter((o) => indices.includes(o.index));
  if (chosen.length < 2) return { say: 'There is nothing to compare yet. Say what you are looking for first.', politeness: 'polite', card: null, suggestions: suggestionsFor('browsing', opts.length > 0) };
  const snaps = await loadSnapshots(chosen.map((o) => o.snapshotId));
  const items = chosen.map((o) => ({ label: o.index, snapshot: snaps.get(o.snapshotId)! })).filter((x) => x.snapshot);
  const c = presentComparison(items, aspect, ctx.prefs.verbosity as Verbosity);
  return {
    say: c.text,
    politeness: 'polite',
    card: {
      kind: 'compare',
      heading: 'Side by side',
      columns: items.map((x) => `Option ${x.label}`),
      rows: c.rows.map((r) => ({ label: r.label, values: r.values })),
    },
    suggestions: suggestionsFor('browsing', true),
  };
}

// ---------------------------------------------------------------------------------------------
// Buying

/** The listing's sizes, when it offers several, from its frozen snapshot. */
function offeredSizes(s: ProductSnapshot): string[] {
  return (s.attributes.sizes ?? '').split(/\s*,\s*/).filter(Boolean);
}

/**
 * The snapshot to read back: the same one while it is fresh, else the listing again, read through
 * the same interpreter as search, with the chosen size. A size the store sells as its own listing
 * is bought from that listing.
 */
async function freshSnapshot(
  snap: ProductSnapshot,
  selection: Record<string, string>,
  changes?: { size?: string; colour?: string },
  sizeProductId?: string,
): Promise<ProductSnapshot | 'sold_out' | 'not_offered' | null> {
  const age = Date.now() - Date.parse(snap.capturedAt);
  if (!changes && !sizeProductId && age < SNAPSHOT_MAX_AGE_MS) return snap;
  const sel = { ...selection };
  // The listing's own label for the size ("S/M", "Medium"), not a guess at it.
  const label = changes?.size ? (offeredSizes(snap).find((s) => sameSize(s, changes.size) || s.split('/').some((p) => sameSize(p, changes.size))) ?? changes.size.toUpperCase()) : sel.Size;
  if (label) sel.Size = label;
  if (changes?.colour) sel.Colour = changes.colour.toLowerCase();
  const product = await catalog().get(sizeProductId ?? snap.productId, sel);
  if (!product) return null;
  let read = interpretListing(product, { size: label });
  // That size is the store's own listing: freeze that listing, not this one.
  if (read.size.fit === 'other_listing' && read.size.productId) {
    const own = await catalog().get(read.size.productId, sel);
    if (!own) return null;
    read = interpretListing(own, { size: label });
  }
  if (label && read.size.fit === 'sold_out') return 'sold_out';
  if (label && read.size.fit === 'not_offered') return 'not_offered';
  // A size the buyer just chose must be one the listing confirms; a size kept from before may now be unstated.
  if (label && changes?.size && !['in_stock', 'offered', 'listed'].includes(read.size.fit)) return 'not_offered';
  const fresh = freeze(read.product);
  await saveSnapshot(fresh);
  return fresh;
}

async function startReadback(ctx: Ctx, index: number | undefined, changes?: { size?: string; colour?: string; quantity?: number }): Promise<Reply> {
  const i = index ?? ctx.state.focus ?? (ctx.state.options?.length === 1 ? 1 : undefined);
  if (!i) return { say: 'Which one would you like? Say a number.', politeness: 'polite', card: null, suggestions: suggestionsFor('browsing', true) };
  const found = await optionSnapshot(ctx, i);
  if (!found) return { say: `I don't have an option ${i}.`, politeness: 'polite', card: null, suggestions: suggestionsFor('browsing', false) };
  // A listing that offers several sizes is never bought in a size nobody chose: ask which.
  const sizes = offeredSizes(found.snap);
  if (!changes?.size && !found.snap.attributes.size && sizes.length > 1) {
    ctx.state.focus = i;
    ctx.state.pending = [{ kind: 'buy_size', index: i, sizes, said: 'size', by: readbackTool.get(ctx) ?? 'app' }];
    const say = en.readback.whichSize(joinOr(sizes));
    return { say, politeness: 'polite', card: null, suggestions: sizes.slice(0, 4).map((s) => ({ label: `Size ${s}`, utterance: `size ${s}` })) };
  }
  const fresh = await freshSnapshot(found.snap, found.opt.selection, changes, changes?.size ? undefined : found.opt.sizeProductId);
  if (fresh === 'sold_out')
    return { say: en.readback.sizeSoldOut(changes?.size ?? found.snap.attributes.size ?? ''), politeness: 'assertive', cue: 'error', card: null, suggestions: suggestionsFor('browsing', true) };
  if (fresh === 'not_offered')
    return { say: en.readback.sizeGone(changes?.size ?? found.snap.attributes.size ?? ''), politeness: 'assertive', cue: 'error', card: null, suggestions: suggestionsFor('browsing', true) };
  const snap = fresh;
  if (!snap) return { say: 'That item is no longer listed, so I stopped. Nothing was charged.', politeness: 'assertive', cue: 'error', card: null, suggestions: suggestionsFor('browsing', true) };
  const quantity = changes?.quantity ?? 1;
  const totals = computeTotals([{ price: snap.price, quantity }]);
  const cartId = newId('crt');
  const lines = [{ snapshot: snap, quantity }];
  const cart: Cart = { id: cartId, userId: ctx.userId, lines, totals, hash: hashCart({ userId: ctx.userId, lines, totals }), createdAt: new Date().toISOString() };
  await db().insert(tables.carts).values({ id: cart.id, userId: ctx.userId, body: cart, hash: cart.hash });
  const vault = await db()
    .select({ id: tables.vaultTokens.id })
    .from(tables.vaultTokens)
    .where(and(eq(tables.vaultTokens.userId, ctx.userId), eq(tables.vaultTokens.status, 'ACTIVE')))
    .limit(1);
  const composedBase = composeReadback({
    cart,
    paymentSource: vault[0] ? { kind: 'vault', label: 'your saved PayPal' } : { kind: 'paypal-popup', label: 'PayPal' },
    deliveryEstimate: deliveryEstimate(new Date()),
    locale: 'en-US',
    verbosity: ctx.prefs.verbosity as Verbosity,
    now: new Date(),
    payAfterCheck: ctx.prefs.payAfterCheck,
  });
  // Contradictions inside the listing are spoken as part of the readback, before "To pay".
  const warnings = listingWarnings(snap);
  const withWarnings = warnings.length ? composedBase.text.replace(/(To pay, say)/, `${warnings.join(' ')} $1`) : composedBase.text;
  const composed = {
    ...composedBase,
    text: withWarnings,
    textHash: hashReadbackText(withWarnings),
    fields: warnings.length ? [...composedBase.fields, { key: 'warning', label: 'Note', value: warnings.join(' ') }] : composedBase.fields,
  };
  const readbackId = newId('rdb');
  await db().insert(tables.readbacks).values({
    id: readbackId,
    cartId: cart.id,
    cartHash: cart.hash,
    text: composed.text,
    fields: composed.fields,
    textHash: composed.textHash,
    spokenAt: new Date().toISOString(),
  });
  await audit({ userId: ctx.userId, actor: 'agent', action: 'readback.spoken', subjectId: readbackId, payload: { cartHash: cart.hash, textHash: composed.textHash, total: cart.totals.total } });
  await recordReadbackProposed(
    ctx,
    readbackId,
    `Read back ${snap.title}${snap.attributes.size ? `, size ${snap.attributes.size}` : ''}, total ${formatMoney(cart.totals.total)}, from the listing and the store's rules. Nothing is paid until the buyer confirms twice.`,
    readbackTool.get(ctx) ?? 'app',
  );
  ctx.state.phase = 'readback';
  ctx.state.readbackId = readbackId;
  ctx.state.confirm = initialConfirmationState(composed.textHash);
  ctx.state.focus = i;
  return readbackReply(composed.text, composed.fields, readbackId, cart, Boolean(vault[0]), false, false);
}

/** Which actor chose the item for this turn's readback: the shopping agent, or the app's grammar. */
const readbackTool = new WeakMap<Ctx, 'claude' | 'app'>();

/**
 * Said with a readback, before any press, when this server has no PayPal keys. Not part of the
 * readback text: that text is the signed record of what was read, so the note goes beside it.
 */
const PAYPAL_OFF = "PayPal isn't connected on this server, so confirming won't charge anything.";

function readbackReply(
  text: string,
  fields: { key: string; label: string; value: string }[],
  readbackId: string,
  cart: Cart,
  vaulted: boolean,
  needsSecondPress: boolean,
  held: boolean,
  sayOverride?: string,
): Reply {
  const paypalConnected = INTEGRATIONS.paypal;
  return {
    say: sayOverride ?? (paypalConnected ? text : `${text} ${PAYPAL_OFF}`),
    politeness: 'polite',
    cue: 'attention',
    card: {
      kind: 'readback',
      heading: 'Readback: check before you pay',
      readbackId,
      fields,
      text,
      total: formatMoney(cart.totals.total),
      payWith: vaulted ? 'your saved PayPal' : 'PayPal (you log in once)',
      paypalConnected,
      needsSecondPress,
      held,
    },
    suggestions: suggestionsFor('readback', false),
  };
}

async function loadReadbackRow(readbackId: string) {
  const [rb] = await db().select().from(tables.readbacks).where(eq(tables.readbacks.id, readbackId)).limit(1);
  if (!rb) return null;
  const [cartRow] = await db().select().from(tables.carts).where(eq(tables.carts.id, rb.cartId)).limit(1);
  return cartRow ? { rb, cart: cartRow.body as Cart } : null;
}

function payReply(ctx: Ctx, outcome: PayOutcome, cart: Cart): Reply {
  ctx.state.phase = 'browsing';
  switch (outcome.kind) {
    case 'paid': {
      const spoken = presentPaid({ total: cart.totals.total, merchant: 'Demo Store', authorised: outcome.status === 'authorized' });
      return {
        say: spoken.text,
        politeness: 'assertive',
        cue: 'paid',
        card: {
          kind: 'paid',
          heading: outcome.status === 'authorized' ? 'On hold until you check it' : 'Paid',
          orderId: outcome.orderId,
          amount: formatMoney(outcome.amount),
          merchant: 'Demo Store',
          receiptId: outcome.receiptId,
          payAfterCheck: outcome.status === 'authorized',
        },
        suggestions: [
          { label: "Where's my order?", utterance: "where's my order" },
          { label: 'Shop for something else', utterance: 'help' },
        ],
      };
    }
    case 'needs-approval':
      ctx.state.phase = 'readback';
      return {
        say: `Confirmed. PayPal needs you to log in once to approve ${formatMoney(cart.totals.total)}. Press Pay with PayPal. After this, your PayPal is saved.`,
        politeness: 'assertive',
        cue: 'attention',
        card: {
          kind: 'paypal',
          heading: 'Approve in PayPal, once',
          readbackId: ctx.state.readbackId!,
          paypalOrderId: outcome.paypalOrderId,
          total: formatMoney(cart.totals.total),
          clientId: ENV.PAYPAL_CLIENT_ID ?? '',
          orderIntent: outcome.intent,
        },
        suggestions: [{ label: 'Cancel', utterance: 'cancel' }],
      };
    case 'refused':
      return {
        say: outcome.say,
        politeness: 'assertive',
        cue: 'error',
        card: { kind: 'refusal', heading: 'I didn’t pay', reason: outcome.say, code: outcome.code },
        suggestions: suggestionsFor('browsing', true),
      };
    case 'unknown':
      return {
        say: outcome.say,
        politeness: 'assertive',
        cue: 'attention',
        card: { kind: 'link', heading: 'Checking with PayPal', text: outcome.say, href: `/app/orders/${outcome.orderId}`, label: 'See this order' },
        suggestions: [{ label: "Where's my order?", utterance: "where's my order" }],
      };
    case 'error':
      // No PayPal keys on this server: paying can't work, so the reply says what still can, and
      // where to see what is connected, instead of suggesting the next step of a purchase.
      if (outcome.notConnected) {
        const say = `${outcome.say} You can keep browsing and hear readbacks, but paying needs PayPal. To see what's connected, open the judge page.`;
        return {
          say,
          politeness: 'assertive',
          cue: 'error',
          card: { kind: 'link', heading: 'PayPal isn’t connected', text: 'Nothing was charged. You can keep browsing and hear readbacks, but paying needs PayPal.', href: '/judge', label: 'See what’s connected on the judge page' },
          suggestions: ctx.state.options?.length
            ? [
                { label: 'More options', utterance: 'more' },
                { label: 'Shop for something else', utterance: 'help' },
                { label: "Where's my order?", utterance: "where's my order" },
              ]
            : suggestionsFor('browsing', false),
        };
      }
      return { say: outcome.say, politeness: 'assertive', cue: 'error', card: { kind: 'refusal', heading: 'Nothing was charged', reason: outcome.say, code: outcome.kind }, suggestions: suggestionsFor('browsing', true) };
    case 'declined':
      return { say: outcome.say, politeness: 'assertive', cue: 'error', card: { kind: 'refusal', heading: 'Nothing was charged', reason: outcome.say, code: outcome.kind }, suggestions: suggestionsFor('browsing', true) };
  }
}

function payStepKind(o: PayOutcome): string {
  switch (o.kind) {
    case 'paid':
      return o.status === 'authorized' ? 'held' : 'paid';
    case 'needs-approval':
      return 'approval_needed';
    case 'refused':
      return 'refused';
    case 'unknown':
      return 'outcome_unknown';
    case 'declined':
      return 'declined';
    case 'error':
      return o.notConnected ? 'not_connected' : 'failed';
  }
}

/** One sentence about what PayPal did, from the outcome and the cart: never from model text. */
function payStepSummary(o: PayOutcome, cart: Cart, vaulted: boolean): string {
  const total = formatMoney(cart.totals.total);
  const how = vaulted ? ' with the saved PayPal' : '';
  switch (o.kind) {
    case 'paid':
      return o.status === 'authorized'
        ? `After both confirmations, PayPal put ${total} on hold${how} for ${demoSeller().name}, to be paid only after the parcel check.`
        : `After both confirmations, PayPal paid ${total}${how} to ${demoSeller().name}.`;
    case 'needs-approval':
      return `After both confirmations, PayPal asked the buyer to approve ${total} in its own window, once.`;
    case 'refused':
      return `The payment gate refused (${o.code}), so nothing was charged.`;
    case 'unknown':
      return `PayPal did not answer in time; the purchase is paused so it can't be charged twice.`;
    case 'declined':
      return 'PayPal declined the payment method, so nothing was charged.';
    case 'error':
      return o.notConnected ? "PayPal isn't connected on this server, so nothing was charged." : 'PayPal could not take the payment, so nothing was charged.';
  }
}

/** Gate refusals whose wording promises to read the order again. */
const REREAD_AFTER = new Set([
  'CART_TAMPERED',
  // Not what the buyer asked for: the refusal says so, then the readback is read again, so the
  // buyer can say "charcoal is fine" (a change) or ask for what they wanted.
  'INTENT_MISMATCH',
  'CONFIRMATION_OUT_OF_ORDER',
  'CONFIRMATION_EXPIRED',
  'INVALID_QUANTITY',
  'CURRENCY_MISMATCH',
  'AMOUNT_INVALID',
  'TOTALS_MISMATCH',
  'AMOUNT_MISMATCH',
  'PAYEE_MISMATCH',
  'SNAPSHOT_STALE',
  'SNAPSHOT_TIME_INVALID',
  'PRICE_CHANGED',
  'LISTING_CHANGED',
]);

async function confirmStep(ctx: Ctx, opts: { phrase?: string; button: boolean; answer?: string }): Promise<Reply> {
  const readbackId = ctx.state.readbackId;
  const loaded = readbackId ? await loadReadbackRow(readbackId) : null;
  if (!loaded || ctx.state.phase !== 'readback') {
    ctx.state.phase = 'browsing';
    return { say: "There's nothing to confirm right now. Nothing was charged.", politeness: 'polite', card: null, suggestions: suggestionsFor('browsing', false) };
  }
  const { rb, cart } = loaded;
  const decision = await decideConfirmation({
    phrase: opts.phrase ?? null,
    buttonPressed: opts.button,
    classifier: confirmationClassifier,
    readback: { text: rb.text, textHash: rb.textHash, total: cart.totals.total },
    state: ctx.state.confirm ?? initialConfirmationState(rb.textHash),
    now: Date.now(),
    capture: ctx.capture,
  });
  ctx.state.confirm = decision.state;
  const vaulted = rb.text.includes('saved PayPal');
  switch (decision.outcome) {
    case 'confirmed': {
      const ev = decision.evidence!;
      await db()
        .update(tables.readbacks)
        .set({
          confirmedAt: new Date().toISOString(),
          confirmation: {
            phraseMatched: ev.key1.source === 'phrase' || ev.key1.source === 'button',
            classifierAgreed: ev.key2.source === 'classifier' || ev.key2.source === 'second_press',
            utterance: ev.utterance ?? (opts.button ? '[Confirm button]' : ''),
            at: new Date(ev.key2.at).toISOString(),
            keys: [ev.key1, ev.key2],
          },
        })
        .where(eq(tables.readbacks.id, rb.id));
      await audit({ userId: ctx.userId, actor: 'user', action: 'readback.confirmed', subjectId: rb.id, payload: { key1: ev.key1.source, key2: ev.key2.source } });
      const outcome = await payForReadback({ userId: ctx.userId, readbackId: rb.id, mode: 'auto' });
      await recordStep(ctx, { tool: 'paypal', step: payStepKind(outcome), summary: payStepSummary(outcome, cart, vaulted) }, { readbackId: rb.id });
      // These refusals promise "I'll read it again": keep that promise with a fresh readback (new
      // price check, same item, size, colour and quantity), so a late or stale yes costs nothing.
      if (outcome.kind === 'refused' && REREAD_AFTER.has(outcome.code) && ctx.state.focus) {
        await db().update(tables.readbacks).set({ invalidatedAt: new Date().toISOString() }).where(eq(tables.readbacks.id, rb.id));
        const line = cart.lines[0]!;
        const again = await startReadback(ctx, ctx.state.focus, {
          size: line.snapshot.attributes.size,
          colour: line.snapshot.attributes.colour,
          quantity: line.quantity,
        });
        if (again.card?.kind === 'readback') return { ...again, say: `${outcome.say} ${again.say}`, politeness: 'assertive', cue: 'error' };
        return { ...again, say: `${outcome.say} ${again.say}` };
      }
      return payReply(ctx, outcome, cart);
    }
    case 'awaiting_second_press':
      return readbackReply(rb.text, rb.fields as never, rb.id, cart, vaulted, true, false, decision.say);
    case 'hold':
      await db().update(tables.readbacks).set({ holdOpen: true }).where(eq(tables.readbacks.id, rb.id));
      return readbackReply(rb.text, rb.fields as never, rb.id, cart, vaulted, false, true, decision.say);
    case 'cancel':
      ctx.state.phase = 'browsing';
      await db().update(tables.readbacks).set({ invalidatedAt: new Date().toISOString() }).where(eq(tables.readbacks.id, rb.id));
      return { say: decision.say || 'Cancelled. Nothing was charged.', politeness: 'assertive', card: null, suggestions: suggestionsFor('browsing', Boolean(ctx.state.options?.length)) };
    case 'change': {
      const parsed = parseIntent(opts.phrase ?? '', grammarCtx(ctx));
      const changes = parsed.intent === 'cart' ? parsed.slots.changes : parsed.intent === 'refine' ? { size: parsed.slots.size, colour: parsed.slots.colour } : undefined;
      await db().update(tables.readbacks).set({ invalidatedAt: new Date().toISOString() }).where(eq(tables.readbacks.id, rb.id));
      if (changes && (changes.size || changes.colour || ('quantity' in changes && changes.quantity))) return startReadback(ctx, ctx.state.focus, changes);
      ctx.state.phase = 'browsing';
      return { say: "Okay, I haven't paid. What would you like to change?", politeness: 'polite', card: null, suggestions: suggestionsFor('browsing', true) };
    }
    default: {
      // A question about the readback gets its answer from the readback, then how to pay; one the
      // readback can't answer says what it can answer. Neither is ever just "Nothing is paid yet".
      const say =
        decision.outcome === 'not_confirmed' && opts.answer
          ? opts.answer
          : decision.outcome === 'not_confirmed' && decision.phraseMatch?.reason === 'question'
            ? en.readback.answers.notInReadback
            : decision.say || en.help.readback;
      const awaiting = decision.state.kind === 'awaiting_second_press';
      return readbackReply(rb.text, rb.fields as never, rb.id, cart, vaulted, awaiting, rb.holdOpen, say);
    }
  }
}

/** "What's the total?" and other questions during a readback, answered from its own fields. */
async function readbackQuestion(ctx: Ctx, raw: string): Promise<Reply | null> {
  const loaded = ctx.state.readbackId ? await loadReadbackRow(ctx.state.readbackId) : null;
  if (!loaded) return null;
  const answer = answerReadbackQuestion({
    utterance: raw,
    fields: loaded.rb.fields as never,
    text: loaded.rb.text,
    verbosity: ctx.prefs.verbosity as Verbosity,
  });
  if (!answer) return null;
  return confirmStep(ctx, { phrase: raw, button: false, answer: answer.text });
}

// ---------------------------------------------------------------------------------------------
// After buying

async function latestOrders(userId: string) {
  return db().select().from(tables.orders).where(eq(tables.orders.userId, userId)).orderBy(desc(tables.orders.createdAt)).limit(5);
}

const STATUS_WORDS: Record<string, string> = {
  confirmed: 'being placed',
  approval_pending: 'waiting for your PayPal approval',
  authorized: 'paid on hold, waiting for delivery',
  captured: 'paid, waiting to ship',
  shipped: 'on its way',
  delivered: 'delivered, ready to check',
  verified_match: 'checked and matches',
  verified_mismatch: 'checked and does not match',
  verified_unsure: 'checked, not sure yet',
  case_open: 'with an open case',
  resolved_refund: 'refunded',
  resolved_partial_refund: 'kept for less, as agreed with the store',
  resolved_replacement: 'settled with a replacement',
  voided: 'cancelled, the hold was released',
  failed: 'not placed, nothing charged',
};

async function status(ctx: Ctx): Promise<Reply> {
  const orders = await latestOrders(ctx.userId);
  if (orders.length === 0)
    return { say: "You haven't bought anything yet. Say what you're looking for.", politeness: 'polite', card: null, suggestions: suggestionsFor('browsing', false) };
  const lines = orders.slice(0, 3).map((o) => `${o.title}, ${formatMoney(money(o.amountCents, o.currency))}: ${STATUS_WORDS[o.status] ?? o.status}.`);
  return {
    say: `Your latest ${orders.length === 1 ? 'order' : 'orders'}. ${lines.join(' ')}`,
    politeness: 'polite',
    card: { kind: 'link', heading: 'Your orders and money', text: lines.join(' '), href: '/app/orders', label: 'Open orders and money' },
    suggestions: [{ label: 'It arrived', utterance: 'it arrived' }],
  };
}

async function check(ctx: Ctx): Promise<Reply> {
  const orders = await latestOrders(ctx.userId);
  const target = orders.find((o) => ['delivered', 'shipped', 'authorized', 'captured', 'verified_unsure'].includes(o.status));
  if (!target) return { say: "I don't see a delivery to check yet.", politeness: 'polite', card: null, suggestions: suggestionsFor('browsing', false) };
  return {
    say: `Let's check your ${target.title}. The link 'Open the camera check' is under the heading 'Check your parcel'. Open it, and I'll guide you with my voice there.`,
    politeness: 'polite',
    card: { kind: 'link', heading: 'Check your parcel', text: `Compare what arrived with the ${target.title} you ordered.`, href: `/app/check/${target.id}`, label: 'Open the camera check' },
    suggestions: [],
  };
}

async function moneyBack(ctx: Ctx): Promise<Reply> {
  const orders = await latestOrders(ctx.userId);
  const target = orders.find((o) => ['verified_mismatch', 'verified_unsure', 'delivered', 'captured', 'case_open'].includes(o.status));
  if (!target) return { say: "I don't see an order that needs money back. Say 'where's my order' to hear your orders.", politeness: 'polite', card: null, suggestions: suggestionsFor('browsing', false) };
  return {
    say: `I can get your money back for the ${target.title}. The link 'Open the case' is under the heading 'Get your money back'. There I read you the evidence first, and nothing is sent until you confirm.`,
    politeness: 'polite',
    card: { kind: 'link', heading: 'Get your money back', text: `Start a case for the ${target.title}.`, href: `/app/orders/${target.id}#money-back`, label: 'Open the case' },
    suggestions: [],
  };
}

// ---------------------------------------------------------------------------------------------
// Offers from the store on an open case

const SETTINGS_CARD: Card = { kind: 'link', heading: 'Settings', text: 'Speech, sizes and spending limits.', href: '/app/settings', label: 'Open settings' };

function offerChoice(open: OpenOffer): OfferChoice {
  return {
    merchant: demoSeller().name,
    kind: offerKind(open.offer.type, open.offer.partial),
    amount: money(open.amountCents, open.currency),
    paid: money(open.paidCents, open.currency),
    held: open.held,
    itemNoun: categoryOf(open.title)?.canonical ?? en.check.defaultNoun,
    byAgent: open.offer.by === 'store_agent',
    // Checked against the case's facts before they were stored; read as they are.
    reasons: open.offer.reasons?.length ? open.offer.reasons : undefined,
  };
}

/** The offer as a card: what was offered, why, what accepting means, and its Accept and Decline buttons. */
function offerCard(open: OpenOffer, needsSecondPress: boolean): Card {
  const choice = offerChoice(open);
  return {
    kind: 'offer',
    heading: `${choice.merchant}’s offer`,
    offerId: open.offer.id,
    orderId: open.orderId,
    text: presentOfferChoice({ ...choice, reasons: undefined }).sentences.slice(0, 3).join(' '),
    ...(choice.reasons ? { reasons: choice.reasons } : {}),
    ...(choice.byAgent ? { byAgent: true } : {}),
    needsSecondPress,
  };
}

/** Read the open offer like a readback: what it is, what accepting means, how to answer. */
async function offerTurn(ctx: Ctx): Promise<Reply> {
  const open = await findOpenOffer(ctx.userId);
  if (!open) {
    leaveOffer(ctx);
    return { say: en.offers.none, politeness: 'polite', card: null, suggestions: suggestionsFor('browsing', Boolean(ctx.state.options?.length)) };
  }
  const spoken = presentOfferChoice(offerChoice(open));
  ctx.state.phase = 'offer';
  ctx.state.offer = { caseId: open.caseId, offerId: open.offer.id };
  // Heard now, so the greeting doesn't read its notice again.
  await markOfferNoticesRead(ctx.userId, open.orderId);
  return { say: spoken.text, politeness: 'polite', cue: 'attention', card: offerCard(open, false), suggestions: suggestionsFor('offer', false) };
}

/** A second press sooner than this after the first is a double-click, not a second decision. */
const SECOND_PRESS_MIN_MS = 500;

const OFFER_PRESS_AGAIN = "Press Accept again to accept. You can't undo accepting. To leave the offer open, say 'not now'.";

/**
 * The offer card's buttons. Decline answers at once and keeps the case open. Accepting can't be
 * undone, so like paying it takes two presses: the first only asks for the second.
 */
async function offerButton(ctx: Ctx, answer: OfferAnswer, offerId: string, armedAt: number | undefined): Promise<Reply> {
  const gone = (): Reply => {
    leaveOffer(ctx);
    return { say: en.offers.gone, politeness: 'assertive', cue: 'error', card: null, suggestions: suggestionsFor('browsing', Boolean(ctx.state.options?.length)) };
  };
  if (ctx.state.phase !== 'offer' || ctx.state.offer?.offerId !== offerId) return gone();
  if (answer === 'decline') return answerTheOffer(ctx, 'decline');
  const now = Date.now();
  if (armedAt !== undefined && now - armedAt >= SECOND_PRESS_MIN_MS) return answerTheOffer(ctx, 'accept');
  const open = await findOpenOffer(ctx.userId);
  if (!open || open.offer.id !== offerId) return gone();
  // A double-click is one press: the first press keeps its time.
  ctx.state.offer.armedAt = armedAt ?? now;
  return { say: OFFER_PRESS_AGAIN, politeness: 'polite', cue: 'attention', card: offerCard(open, true), suggestions: suggestionsFor('offer', false) };
}

function leaveOffer(ctx: Ctx) {
  if (ctx.state.phase === 'offer') ctx.state.phase = 'browsing';
  ctx.state.offer = undefined;
}

async function answerTheOffer(ctx: Ctx, answer: OfferAnswer): Promise<Reply> {
  const held = ctx.state.offer!;
  const result = await answerOffer(ctx.userId, held.caseId, held.offerId, answer);
  leaveOffer(ctx);
  const after = suggestionsFor('browsing', Boolean(ctx.state.options?.length));
  if (!result.ok) {
    const say =
      result.reason === 'gone'
        ? en.offers.gone
        : result.reason === 'paypal-unavailable'
          ? en.offers.paypalUnavailable
          : result.reason === 'not-connected'
            ? en.offers.notConnected
            : en.offers.paypalFailed;
    return { say, politeness: 'assertive', cue: 'error', card: null, suggestions: after };
  }
  const spoken = presentOfferAnswer({ ...offerChoice(result.offer), answer });
  return {
    say: spoken.text,
    politeness: 'polite',
    cue: 'done',
    card: { kind: 'link', heading: answer === 'accept' ? 'Offer accepted' : 'Offer declined', text: spoken.text, href: `/app/orders/${result.offer.orderId}#money-back`, label: 'See the order' },
    suggestions: after,
  };
}

/**
 * While an offer is being answered. Only an accept phrase or the word decline (or reject, refuse)
 * answers it; "no", "wait" or "cancel" leave it open. Returns null to route the turn normally.
 */
async function offerPhase(ctx: Ctx, parsed: ParsedIntent, raw: string): Promise<Reply | null> {
  // The offer stays open and its card stays, so its buttons are still there to answer with.
  const stay = async (say: string): Promise<Reply> => {
    const open = await findOpenOffer(ctx.userId);
    const card = open && open.offer.id === ctx.state.offer?.offerId ? offerCard(open, false) : null;
    return { say, politeness: 'polite', card, suggestions: suggestionsFor('offer', false) };
  };
  const notAnswered = (): Reply => {
    leaveOffer(ctx);
    return { say: en.offers.notAnswered, politeness: 'polite', card: null, suggestions: suggestionsFor('browsing', Boolean(ctx.state.options?.length)) };
  };
  if (!ctx.state.offer) {
    leaveOffer(ctx);
    return null;
  }
  if (parsed.intent === 'offer') {
    if (parsed.slots.action === 'accept') return answerTheOffer(ctx, 'accept');
    if (parsed.slots.action === 'decline') return /\b(decline|declined|reject|refuse)\b/i.test(raw) ? answerTheOffer(ctx, 'decline') : notAnswered();
    leaveOffer(ctx);
    return offerTurn(ctx);
  }
  if (parsed.intent === 'cancel' || parsed.intent === 'hold') return notAnswered();
  if (parsed.intent === 'help') return null;
  const yn = parseYesNo(raw);
  if (yn === 'no') return notAnswered();
  if (yn === 'yes' || parsed.intent === 'confirm' || parsed.intent === 'freeform') return stay(en.help.offer);
  leaveOffer(ctx);
  return null;
}

// ---------------------------------------------------------------------------------------------
// Settings by voice

const RATE_STEP = 25;
const RATE_MIN = 50;
const RATE_MAX = 250;

async function setVerbosity(ctx: Ctx, next: Verbosity): Promise<Reply> {
  const prev = (ctx.prefs.verbosity as Verbosity) ?? 'standard';
  const after = suggestionsFor(ctx.state.phase === 'offer' ? 'browsing' : ctx.state.phase, Boolean(ctx.state.options?.length));
  const P = en.settings.verbosityPhrase;
  if (prev === next) {
    const others = (['brief', 'standard', 'detailed'] as const).filter((v) => v !== next).map((v) => P[v]);
    return { say: en.settings.alreadyVerbosity(others), politeness: 'polite', card: null, suggestions: after };
  }
  await db().update(tables.preferences).set({ verbosity: next }).where(eq(tables.preferences.userId, ctx.userId));
  ctx.prefs.verbosity = next;
  await audit({ userId: ctx.userId, actor: 'user', action: 'settings.saved', subjectId: ctx.userId, payload: { verbosity: next, by: 'voice' } });
  return { say: en.settings[next](P[prev]), politeness: 'polite', card: null, suggestions: after };
}

async function setSpeechRate(ctx: Ctx, change: 'faster' | 'slower'): Promise<Reply> {
  const after = suggestionsFor(ctx.state.phase === 'offer' ? 'browsing' : ctx.state.phase, Boolean(ctx.state.options?.length));
  // With a screen reader reading the replies, only the screen reader can change the speed.
  if (ctx.prefs.voiceMode === 'screen-reader') {
    if (ctx.prefs.verbosity === 'brief') return { say: en.settings.rateIsScreenReaders, politeness: 'polite', card: null, suggestions: after };
    ctx.state.pending = [{ kind: 'verbosity', verbosity: 'brief', said: en.settings.verbosityPhrase.brief }];
    return {
      say: `${en.settings.rateIsScreenReaders} ${en.settings.offerBrief}`,
      politeness: 'polite',
      card: null,
      suggestions: [
        { label: 'Yes, keep it brief', utterance: 'yes' },
        { label: 'No, thanks', utterance: 'no thanks' },
      ],
    };
  }
  const current = ctx.prefs.speechRate ?? 100;
  const next = Math.min(RATE_MAX, Math.max(RATE_MIN, current + (change === 'faster' ? RATE_STEP : -RATE_STEP)));
  if (next === current)
    return { say: change === 'faster' ? en.settings.fastest : en.settings.slowest, politeness: 'polite', card: null, suggestions: after, settings: { speechRate: current } };
  await db().update(tables.preferences).set({ speechRate: next }).where(eq(tables.preferences.userId, ctx.userId));
  ctx.prefs.speechRate = next;
  await audit({ userId: ctx.userId, actor: 'user', action: 'settings.saved', subjectId: ctx.userId, payload: { speechRate: next, by: 'voice' } });
  return { say: en.settings[change], politeness: 'polite', card: null, suggestions: after, settings: { speechRate: next } };
}

async function settingsTurn(ctx: Ctx, slots: SettingsSlots): Promise<Reply> {
  if (slots.setting === 'verbosity' && slots.verbosity) return setVerbosity(ctx, slots.verbosity);
  if (slots.setting === 'speech_rate' && slots.change) return setSpeechRate(ctx, slots.change);
  // Limits, sizes and the voice are changed on the Settings page, where they can be checked.
  return { say: en.settings.inSettings, politeness: 'polite', card: SETTINGS_CARD, suggestions: [] };
}

// ---------------------------------------------------------------------------------------------
// "Yes" and "no" to the question just asked

function pendingForNone(query: ShoppingQuery, sg: NoneSuggestion): Pending {
  switch (sg.kind) {
    case 'max_price':
      return { kind: 'search', query: { ...query, maxPrice: sg.amount }, said: sg.said };
    case 'any_colour':
      return { kind: 'search', query: { ...query, colour: undefined }, said: sg.said };
    case 'any_returns':
      return { kind: 'search', query: { ...query, freeReturns: undefined }, said: sg.said };
    default:
      return { kind: 'ask', said: sg.said };
  }
}

/** Chips for the offers just made: each sends its own words, which pick it. */
function pendingChips(pending: Pending[] | undefined): Reply['suggestions'] {
  const chips = (pending ?? [])
    .filter((p) => p.kind === 'search')
    .map((p) => ({ label: `Try ${p.said}`, utterance: p.said }));
  if (pending?.length === 1) return [{ label: 'Yes', utterance: 'yes' }, { label: 'No', utterance: 'no' }];
  return [...chips, { label: 'Help', utterance: 'help' }];
}

async function runPending(ctx: Ctx, p: Pending): Promise<Reply> {
  switch (p.kind) {
    case 'search':
      return search(ctx, p.query);
    case 'check':
      return check(ctx);
    case 'verbosity':
      return setVerbosity(ctx, p.verbosity);
    case 'ask':
      return { say: en.general.askWhat, politeness: 'polite', card: null, suggestions: suggestionsFor('browsing', false) };
    case 'remember':
      return rememberNow(ctx, p.drafts);
    case 'buy_size':
      return { say: en.readback.whichSize(joinOr(p.sizes)), politeness: 'polite', card: null, suggestions: [] };
  }
}

/** Store what the buyer said yes to, and say how to undo it. */
async function rememberNow(ctx: Ctx, drafts: MemoryDraft[]): Promise<Reply> {
  for (const d of drafts) {
    await saveMemory(ctx.userId, d);
    await recordStep(ctx, { tool: 'memory', step: 'remembered', decided: 'person', summary: `With the buyer's yes, remembered that ${describeMemory(d).replace(/^you're /, 'they are ').replace(/^you /, 'they ')}.` });
  }
  const say = drafts.length === 1 ? memoryWords.stored(drafts[0]!) : `${memoryWords.stored(drafts[0]!).split('. ')[0]}, and that ${drafts.slice(1).map(describeMemory).join(', and that ')}. To undo it, say 'what do you remember about me', then 'forget' and what to forget.`;
  return { say, politeness: 'polite', cue: 'done', card: null, suggestions: suggestionsFor('browsing', Boolean(ctx.state.options?.length)) };
}

/** A "yes" or "no" (or the words of one offer) after a question; null when the turn is something else. */
async function answerPending(ctx: Ctx, raw: string, pending: Pending[] | undefined): Promise<Reply | null> {
  const said = normaliseText(raw).replace(/[.!?]+$/, '').trim();
  // "Which size?": a size the listing offers answers it ("medium", "size M", "the large").
  const sizeAsk = pending?.find((p): p is Extract<Pending, { kind: 'buy_size' }> => p.kind === 'buy_size');
  if (sizeAsk) {
    const filler = new Set(['the', 'a', 'an', 'size', 'in', 'please', 'one', 'i', 'will', 'take', 'would', 'like', 'want', 'it', "i'll", 'make']);
    const spoken = normaliseSize(said.split(/\s+/).filter((w) => !filler.has(w)).join(' '));
    const label = spoken ? sizeAsk.sizes.find((s) => sameSize(s, spoken) || s.split('/').some((p) => sameSize(p, spoken))) : undefined;
    if (label) {
      // The item was chosen by whoever chose it before the size question (the agent, or the buyer's words).
      readbackTool.set(ctx, sizeAsk.by ?? 'app');
      return startReadback(ctx, sizeAsk.index, { size: label });
    }
    // A size, but not one this listing offers: say which it does, and keep the question open.
    if (spoken && findPhrases(words(said), SIZE_WORDS).length + (/\d/.test(said) ? 1 : 0) > 0) {
      ctx.state.pending = [sizeAsk];
      return {
        say: en.readback.sizeNotOffered(spoken, joinOr(sizeAsk.sizes)),
        politeness: 'polite',
        card: null,
        suggestions: sizeAsk.sizes.slice(0, 4).map((s) => ({ label: `Size ${s}`, utterance: `size ${s}` })),
      };
    }
  }
  const picked = pending?.find((p) => normaliseText(p.said) === said);
  if (picked) return runPending(ctx, picked);
  const yn = parseYesNo(raw);
  if (!yn) return null;
  const after = suggestionsFor('browsing', Boolean(ctx.state.options?.length));
  if (!pending?.length) return { say: yn === 'no' ? en.general.noThanks : en.general.nothingAsked, politeness: 'polite', card: null, suggestions: after };
  if (yn === 'no' && pending.some((p) => p.kind === 'remember')) return { say: memoryWords.declined, politeness: 'polite', card: null, suggestions: after };
  if (yn === 'no') return { say: en.general.noThanks, politeness: 'polite', card: null, suggestions: after };
  if (pending.length === 1) return runPending(ctx, pending[0]!);
  ctx.state.pending = pending;
  return { say: en.general.whichOne(pending.map((p) => p.said)), politeness: 'polite', card: null, suggestions: pendingChips(pending) };
}

// ---------------------------------------------------------------------------------------------
// The shopping agent, memory, money and "my usual"

/** Commands the grammar always keeps, even while answering the agent's question. */
const GRAMMAR_ONLY = new Set(['confirm', 'hold', 'cancel', 'help', 'settings', 'money', 'memory', 'status', 'check', 'case', 'offer', 'choose', 'cart', 'compare', 'reorder']);

/**
 * An open request goes to the shopping agent: anything the grammar couldn't read, a search with
 * words it couldn't place ("hiking", "warm", "scratchy"), a gift, or an answer to the agent's own
 * question. A search it fully understood ("navy crew-neck sweater, medium, under $40") stays on
 * the fast path.
 */
function isOpenRequest(parsed: ParsedIntent, raw: string, answeringAgent: boolean): boolean {
  if (GRAMMAR_ONLY.has(parsed.intent)) return false;
  if (answeringAgent) return !(parsed.intent === 'refine' && parsed.slots.more);
  switch (parsed.intent) {
    case 'freeform':
      return !/\bwhy\b/i.test(raw);
    case 'search': {
      const q = parsed.slots.query;
      return !q.category || q.keywords.length > 0 || isForSomeoneElse(raw);
    }
    case 'refine':
      return !parsed.slots.more && parsed.confidence !== 'sure';
    default:
      return false;
  }
}

/** The last few turns, oldest first, without the one being answered. */
async function recentTurns(ctx: Ctx, raw: string): Promise<Array<{ role: 'buyer' | 'assistant'; text: string }>> {
  const m = tables.messages;
  const rows = await db().select({ role: m.role, text: m.text }).from(m).where(eq(m.conversationId, ctx.conversationId)).orderBy(desc(m.createdAt), desc(m.id)).limit(7);
  const turns = rows.reverse().map((r) => ({ role: r.role === 'user' ? ('buyer' as const) : ('assistant' as const), text: r.text }));
  if (turns.length && turns[turns.length - 1]!.role === 'buyer' && turns[turns.length - 1]!.text === raw) turns.pop();
  return turns.slice(-6);
}

/** The options card for what is on screen now, so an answer about them keeps them in view. */
async function currentOptionsCard(ctx: Ctx): Promise<Card | null> {
  const opts = ctx.state.options ?? [];
  if (!opts.length) return null;
  const snaps = await loadSnapshots(opts.map((o) => o.snapshotId));
  const items = opts.filter((o) => snaps.has(o.snapshotId)).map((o) => optionItem(o.index, snaps.get(o.snapshotId)!, o.why, o.available !== false, o.pick, o.size));
  if (!items.length) return null;
  const heading = ctx.state.heading ?? (ctx.state.query ? `${items.length === 1 ? 'One option' : `${items.length} options`}: ${describeQuery(ctx.state.query)}` : 'Your options');
  return { kind: 'options', heading, items };
}

/** A lasting preference the agent noticed: asked about once, after the reply. */
function withRemember(ctx: Ctx, reply: Reply, drafts: MemoryDraft[] | undefined): Reply {
  if (!drafts?.length) return reply;
  ctx.state.pending = [{ kind: 'remember', drafts, said: 'remember' }];
  return { ...reply, say: [reply.say, rememberQuestion(drafts)].filter(Boolean).join(' '), suggestions: rememberChips() };
}

/**
 * One turn of the shopping agent, rendered by the same templates as the grammar's path: the
 * options card and its spoken list, the readback, money answers. Null hands the turn back to the
 * grammar (no model, an error or a refusal with nothing found yet).
 */
async function shopperTurn(ctx: Ctx, raw: string, asked?: string): Promise<Reply | null> {
  const memories = await listMemories(ctx.userId);
  const screen = ctx.state.options ?? [];
  const snaps = await loadSnapshots(screen.map((o) => o.snapshotId));
  const onScreen = screen.filter((o) => snaps.has(o.snapshotId)).map((o) => ({ snapshot: snaps.get(o.snapshotId)!, why: o.why }));
  let result: ShopperResult;
  try {
    result = await runShopperTurn(ctx.userId, {
      utterance: raw,
      now: new Date(),
      verbosity: ctx.prefs.verbosity as Verbosity,
      onScreen,
      focus: ctx.state.focus,
      lastQuery: ctx.state.query,
      preferences: { memories, avoidColours: ctx.prefs.avoidColours, savedSizes: ctx.prefs.sizes as Record<string, string> },
      askedLastTurn: asked,
      recent: await recentTurns(ctx, raw),
    });
  } catch (e) {
    console.error('[conductor] shopping agent failed', e);
    return null;
  }
  if (result.steps.some((s) => s.step === 'searched')) startThread(ctx);
  for (const s of result.steps) await recordStep(ctx, s);
  if (result.ungrounded.length) {
    const n = result.ungrounded.length;
    await recordStep(
      ctx,
      { tool: 'claude', step: 'lines_stopped', summary: `Left out ${n === 1 ? 'one line' : `${n} lines`} it wrote that the listings don't back.` },
      { stopped: result.ungrounded },
    );
  }
  const remember = result.remember ? [result.remember] : undefined;
  const o = result.outcome;
  switch (o.kind) {
    case 'present':
      return withRemember(ctx, await presentFromAgent(ctx, o, result.notes), remember);
    case 'ask':
      ctx.state.agentAsked = o.question;
      return { say: o.question, politeness: 'polite', card: await currentOptionsCard(ctx), suggestions: [] };
    case 'answer':
      return withRemember(ctx, { say: o.text, politeness: 'polite', card: await currentOptionsCard(ctx), suggestions: suggestionsFor('browsing', screen.length > 0) }, remember);
    case 'readback':
      return readbackFromAgent(ctx, o.known, o.size);
    case 'recall':
      return memoryTurn(ctx, { action: 'recall' });
    case 'money':
      return moneyTurn(ctx, o.ask);
    case 'fallback': {
      // The agent searched before it ran out of time or steps: present what it found, by template.
      const found = o.searches.find((s) => s.options.length > 0);
      return found ? renderSearch(ctx, found, result.notes, 0) : null;
    }
  }
}

function asOption(k: Known, rank: number): AgentRankedOption {
  if (k.option) return { ...k.option, rank };
  const s = k.snapshot;
  return { rank, snapshot: s, score: 0, why: k.why, caveats: [], verifiable: Boolean(s.attributes.colour && s.images.length), missing: [] };
}

async function presentFromAgent(ctx: Ctx, o: Extract<ShopperResult['outcome'], { kind: 'present' }>, notes: string[]): Promise<Reply> {
  const options = o.picks.map((p, i) => asOption(p.known, i + 1));
  for (const opt of options) await saveSnapshot(opt.snapshot);
  for (const k of o.pool) await saveSnapshot(k.snapshot);
  const reasons = o.picks.map((p) => p.reason);
  const query = o.query ?? ctx.state.query;
  const presentation = presentOptions({ options, remaining: o.pool.length }, { query, verbosity: ctx.prefs.verbosity as Verbosity, notes, lead: o.lead, reasons });
  const heading = query ? optionsHeading(query, options) : `${options.length === 1 ? 'One option' : `${options.length} options`}`;
  ctx.state.query = query;
  ctx.state.heading = heading;
  ctx.state.offset = 0;
  ctx.state.focus = undefined;
  ctx.state.pool = o.pool.map((k) => k.snapshot.id);
  ctx.state.options = storeOptions(options, presentation.context, reasons);
  return {
    say: presentation.text,
    politeness: 'polite',
    card: { kind: 'options', heading, items: options.map((opt, i) => optionItem(i + 1, opt.snapshot, opt.why, opt.sizeInStock !== false, reasons[i], opt.displaySize)) },
    suggestions: suggestionsFor('browsing', true),
  };
}

/** The agent chose an item to buy: the app's own template readback takes over from here. */
async function readbackFromAgent(ctx: Ctx, k: Known, size?: string): Promise<Reply> {
  readbackTool.set(ctx, 'claude');
  if (k.origin === 'screen') return startReadback(ctx, Number(k.handle.slice(1)), size ? { size } : undefined);
  await saveSnapshot(k.snapshot);
  const opt = asOption(k, 1);
  const presentation = presentOptions({ options: [opt], remaining: 0 }, { verbosity: ctx.prefs.verbosity as Verbosity });
  ctx.state.options = storeOptions([opt], presentation.context);
  ctx.state.heading = `One option: ${k.snapshot.title}`;
  ctx.state.pool = undefined;
  return startReadback(ctx, 1, size ? { size } : undefined);
}

async function memoryTurn(ctx: Ctx, slots: MemorySlots): Promise<Reply> {
  const after = suggestionsFor('browsing', Boolean(ctx.state.options?.length));
  switch (slots.action) {
    case 'recall': {
      const memories = await listMemories(ctx.userId);
      await recordStep(ctx, { tool: 'memory', step: 'recalled', summary: `Read back ${memories.length === 1 ? 'one remembered preference' : `${memories.length} remembered preferences`} to the buyer.` });
      const say = recallSpeech(memories, { sizes: ctx.prefs.sizes as Record<string, string>, avoidColours: ctx.prefs.avoidColours });
      return { say, politeness: 'polite', card: { kind: 'link', heading: 'What I remember', text: say, href: '/app/settings#memory-h', label: 'Change what I remember in Settings' }, suggestions: after };
    }
    case 'forget':
      return forgetTurn(ctx, slots.target);
    case 'state': {
      if (slots.explicit) return rememberNow(ctx, slots.drafts);
      await recordStep(ctx, { tool: 'memory', step: 'remember_asked', summary: `Asked the buyer before remembering that ${slots.drafts.map((d) => describeMemory(d).replace(/^you're /, 'they are ').replace(/^you /, 'they ')).join(', and that ')}.` });
      return withRemember(ctx, { say: '', politeness: 'polite', card: null, suggestions: after }, slots.drafts);
    }
  }
}

async function forgetTurn(ctx: Ctx, target: ForgetTarget): Promise<Reply> {
  const after = suggestionsFor('browsing', Boolean(ctx.state.options?.length));
  if (target.all) {
    const n = await forgetAllMemories(ctx.userId, 'voice');
    await recordStep(ctx, { tool: 'memory', step: 'forgot', decided: 'person', summary: `Forgot everything remembered about the buyer (${n}).` });
    return { say: memoryWords.forgotAll(n), politeness: 'polite', cue: 'done', card: null, suggestions: after };
  }
  const hit = memoriesToForget(await listMemories(ctx.userId), target);
  // "Forget my size" means stop using it: a size saved in Settings for the same kind of clothing
  // would take over otherwise, so it is cleared too, and that is said. Other kinds are left alone.
  const cleared: string[] = [];
  if (target.kind === 'size') {
    const sizes = { ...(ctx.prefs.sizes as Record<string, string>) };
    const domains = target.scope
      ? [domainOf(target.scope)]
      : hit.length
        ? [...new Set(hit.map((m) => domainOf(m.scope)))]
        : Object.keys(sizes);
    for (const key of Object.keys(sizes)) {
      if (!domains.includes(key as never)) continue;
      cleared.push(`size ${sizes[key]} for ${key}`);
      delete sizes[key];
    }
    if (cleared.length) {
      await db().update(tables.preferences).set({ sizes }).where(eq(tables.preferences.userId, ctx.userId));
      ctx.prefs.sizes = sizes;
      await audit({ userId: ctx.userId, actor: 'user', action: 'settings.saved', subjectId: ctx.userId, payload: { sizes: 'cleared', by: 'voice' } });
    }
  }
  if (!hit.length && !cleared.length) return { say: memoryWords.nothingToForget(target.label), politeness: 'polite', card: null, suggestions: after };
  await forgetMemories(ctx.userId, hit.map((m) => m.id), 'voice');
  await recordStep(ctx, { tool: 'memory', step: 'forgot', decided: 'person', summary: `Forgot ${target.label}, as the buyer asked.` });
  const parts = [
    hit.length ? memoryWords.forgot(joinAnd(hit.map(describeMemory))) : 'Done.',
    cleared.length ? memoryWords.forgotSettingsSizes(joinAnd(cleared)) : '',
    hit[0] ? memoryWords.forgotUndo(hit[0]) : '',
  ];
  return { say: parts.filter(Boolean).join(' '), politeness: 'polite', cue: 'done', card: null, suggestions: after };
}

async function moneyTurn(ctx: Ctx, ask: MoneyAsk): Promise<Reply> {
  const answer = await answerMoney(ctx.userId, ask);
  await recordStep(ctx, {
    tool: 'money',
    step: 'answered',
    summary: `Answered ${moneyQuestionWords(ask)} from the buyer's order and payment records${answer.orderIds.length ? `, about ${answer.orderIds.length === 1 ? 'one order' : `${answer.orderIds.length} orders`}` : ''}.`,
  });
  return {
    say: answer.text,
    politeness: 'polite',
    card: { kind: 'link', heading: 'Your orders and money', text: answer.text, href: '/app/orders', label: 'Open orders and money' },
    suggestions: [
      { label: 'What’s on hold?', utterance: "what's on hold" },
      { label: 'How much this month?', utterance: 'how much did I spend this month' },
      { label: 'Did I get my refund?', utterance: 'did I get my refund' },
    ],
  };
}

/** "Buy my usual again": the most often bought item (or the last, or the one named), read back fresh. */
async function reorderTurn(ctx: Ctx, what: string): Promise<Reply> {
  const past = await pastOrders(ctx.userId);
  const after = suggestionsFor('browsing', false);
  if (!past.length) return { say: en.reorder.none, politeness: 'polite', card: null, suggestions: after };
  const named = categoryOf(what)?.canonical;
  const pick =
    what === 'usual'
      ? past[0]
      : what === 'last'
        ? [...past].sort((a, b) => Date.parse(b.lastOrderedAt) - Date.parse(a.lastOrderedAt))[0]
        : past.find((p) => (named ? categoryOf(p.snapshot.category ?? p.snapshot.title)?.canonical === named || categoryOf(p.snapshot.title)?.canonical === named : normaliseText(p.snapshot.title).includes(normaliseText(what))));
  if (!pick) return { say: en.reorder.notFound(what), politeness: 'polite', card: null, suggestions: [{ label: 'What did I order?', utterance: 'what did I order' }] };
  startThread(ctx);
  const s = pick.snapshot;
  await recordStep(ctx, {
    tool: 'app',
    step: 'found_usual',
    summary: `Found the buyer's ${what === 'usual' ? 'usual' : what === 'last' ? 'last order' : what} in their order history: ${s.title} (bought ${pick.times === 1 ? 'once' : `${pick.times} times`}).`,
  });
  await saveSnapshot(s);
  const opt = asOption({ handle: 'h1', snapshot: s, origin: 'order', why: [] }, 1);
  const presentation = presentOptions({ options: [opt], remaining: 0 }, { verbosity: ctx.prefs.verbosity as Verbosity });
  ctx.state.options = storeOptions([opt], presentation.context);
  ctx.state.heading = `One option: ${s.title}`;
  ctx.state.pool = undefined;
  const details = [s.attributes.colour, s.attributes.size && `size ${s.attributes.size}`].filter(Boolean).join(', ');
  const reply = await startReadback(ctx, 1);
  if (reply.card?.kind !== 'readback') return reply;
  const lead = what === 'usual' ? en.reorder.usual(s.title, details, pick.times) : en.reorder.last(s.title, details);
  return { ...reply, say: `${lead} ${reply.say}` };
}

// ---------------------------------------------------------------------------------------------

function grammarCtx(ctx: Ctx) {
  return {
    phase: ctx.state.phase === 'readback' ? ('readback' as const) : ctx.state.phase === 'offer' ? ('offer' as const) : ('browsing' as const),
    options: ctx.state.options,
    savedSizes: ctx.prefs.sizes as never,
    currency: 'USD',
  };
}

async function route(ctx: Ctx, parsed: ParsedIntent, raw: string, pending?: Pending[]): Promise<Reply> {
  // An offer that was just read out: accept, decline, or leave it open.
  if (ctx.state.phase === 'offer') {
    const answered = await offerPhase(ctx, parsed, raw);
    if (answered) return answered;
  }
  // During a readback, confirm, hold, cancel and changes go through the confirmation state machine
  // first; questions are answered from the readback itself, then say how to pay.
  if (ctx.state.phase === 'readback') {
    if (['confirm', 'hold', 'cancel', 'cart', 'refine'].includes(parsed.intent)) return confirmStep(ctx, { phrase: raw, button: false });
    if (!(parsed.intent === 'help' && parsed.slots.topic === 'repeat')) {
      const answered = await readbackQuestion(ctx, raw);
      if (answered) return answered;
    }
    if (parsed.intent === 'freeform') return confirmStep(ctx, { phrase: raw, button: false });
  }
  // The agent's own question, if it asked one last turn: this turn may be its answer.
  const asked = ctx.state.agentAsked;
  ctx.state.agentAsked = undefined;
  // "Yes" or "no" to the question just asked (the agent's question is answered by the agent).
  if (ctx.state.phase === 'browsing' && !(asked && !pending?.length && shopperAvailable())) {
    const answered = await answerPending(ctx, raw, pending);
    if (answered) return answered;
  }
  // Hybrid: the grammar answers what it fully understands at once; open requests (a gift, "warm
  // but not scratchy", a question about the options) go to the shopping agent, and anything the
  // agent can't finish comes back here, to the grammar and templates.
  if (ctx.state.phase === 'browsing' && shopperAvailable() && isOpenRequest(parsed, raw, Boolean(asked))) {
    const r = await shopperTurn(ctx, raw, asked);
    if (r) return r;
  }
  switch (parsed.intent) {
    case 'search': {
      // A lasting preference said with the search is asked about once, after the options.
      const pref = parsePreferenceStatement(raw);
      return search(ctx, parsed.slots.query, 0, pref.lasting && pref.drafts.length ? { remember: pref.drafts } : {});
    }
    case 'memory':
      return memoryTurn(ctx, parsed.slots);
    case 'money':
      return moneyTurn(ctx, parsed.slots);
    case 'reorder':
      return reorderTurn(ctx, parsed.slots.what);
    case 'refine': {
      const base = ctx.state.query ?? parseShoppingQuery('', { savedSizes: ctx.prefs.sizes as never });
      const s = parsed.slots;
      if (s.more) return ctx.state.pool?.length ? morefromPool(ctx) : search(ctx, base, (ctx.state.offset ?? 0) + 3);
      const next: ShoppingQuery = {
        ...base,
        colour: s.anyColour ? undefined : (s.colour ?? base.colour),
        size: s.anySize ? undefined : (s.size ?? base.size),
        maxPrice: s.maxPrice ?? (s.cheaper && ctx.state.options?.length ? money(Math.min(...ctx.state.options.map((o) => o.price?.cents ?? Infinity)) - 1) : base.maxPrice),
        minPrice: s.minPrice ?? base.minPrice,
        freeReturns: s.freeReturns ?? base.freeReturns,
        attributes: { ...base.attributes, ...(s.attributes ?? {}) },
      };
      return search(ctx, next);
    }
    case 'choose': {
      const i = parsed.slots.index;
      if (!i) return { say: 'Which one? Say a number.', politeness: 'polite', card: null, suggestions: suggestionsFor('browsing', true) };
      return details(ctx, i, 'general');
    }
    case 'details':
      return details(ctx, parsed.slots.index, parsed.slots.topic, parsed.slots.topic === 'general' ? raw : undefined);
    case 'compare':
      return compare(ctx, parsed.slots.indices, parsed.slots.aspect);
    case 'cart':
      if (parsed.slots.action === 'buy' || parsed.slots.action === 'add') return startReadback(ctx, parsed.slots.index, parsed.slots.changes);
      return { say: en.general.notNow, politeness: 'polite', card: null, suggestions: suggestionsFor('browsing', true) };
    case 'confirm':
    case 'hold':
      return { say: "There's nothing waiting for a confirmation. Nothing was charged.", politeness: 'polite', card: null, suggestions: suggestionsFor('browsing', Boolean(ctx.state.options?.length)) };
    case 'cancel':
      return { say: 'Okay. Nothing is in progress, and nothing was charged.', politeness: 'polite', card: null, suggestions: suggestionsFor('browsing', false) };
    case 'status':
      return status(ctx);
    case 'check':
      return check(ctx);
    case 'case':
      return moneyBack(ctx);
    case 'offer':
      // Accept or decline is only taken once the offer and what accepting means have been heard.
      return offerTurn(ctx);
    case 'help':
      if (parsed.slots.topic === 'repeat') {
        ctx.state.pending = pending;
        return { say: ctx.state.lastSay ?? en.general.nothingToRepeat, politeness: 'polite', card: null, suggestions: suggestionsFor(ctx.state.phase, Boolean(ctx.state.options?.length)) };
      }
      if (parsed.slots.topic === 'more') return { say: en.help.more, politeness: 'polite', card: HELP_CARD, suggestions: suggestionsFor('browsing', false) };
      return { say: en.help.main, politeness: 'polite', card: HELP_CARD, suggestions: suggestionsFor('browsing', false) };
    case 'settings':
      return settingsTurn(ctx, parsed.slots);
    case 'freeform': {
      if (/\bwhy\b/i.test(raw) && ctx.state.options?.length) {
        const snaps = await loadSnapshots(ctx.state.options.map((o) => o.snapshotId));
        const shown = ctx.state.options.filter((o) => snaps.has(o.snapshotId));
        const why = presentWhy(shown.map((o) => ({ snapshot: snaps.get(o.snapshotId)!, why: o.why, caveats: o.caveats ?? [] })));
        return { say: why.text, politeness: 'polite', card: null, suggestions: suggestionsFor('browsing', true) };
      }
      if (ctx.state.focus && aiAvailable()) return details(ctx, ctx.state.focus, 'general', raw);
      const extracted = await extractShoppingQuery(raw).catch(() => null);
      if (extracted && (extracted.category || extracted.search_text)) {
        const q = parseShoppingQuery(extracted.search_text, { savedSizes: ctx.prefs.sizes as never });
        return search(ctx, {
          ...q,
          category: extracted.category ?? q.category,
          colour: extracted.colour ?? q.colour,
          size: extracted.size ?? q.size,
          maxPrice: extracted.max_price_dollars ? money(Math.round(extracted.max_price_dollars * 100)) : q.maxPrice,
          text: raw,
        });
      }
      return { say: `I can find things, read back what you're buying, and check your parcel. Try: I need a navy crew-neck sweater, medium, under forty dollars.`, politeness: 'polite', card: HELP_CARD, suggestions: suggestionsFor('browsing', false) };
    }
  }
}

// ---------------------------------------------------------------------------------------------
// The greeting, and picking up where the conversation left off

/** How long after the last turn a readback or the options shown are still brought back. */
const RESUME_MS = 30 * 60 * 1000;

type Restored =
  | { kind: 'readback'; card: Card; suggestions: Reply['suggestions']; say: string; readbackHash: string; held: boolean }
  | { kind: 'options'; card: Card; suggestions: Reply['suggestions']; say: string };

/**
 * What a reload, or a trip to another page and back, should find again: a readback still waiting
 * for its confirmation, or the options last shown. Read-only. A restored readback always starts
 * from its first press: a reload never counts as one, and the card says so.
 */
async function restoredTurn(state: ConvoState): Promise<Restored | null> {
  if (state.phase === 'readback' && state.readbackId) {
    const loaded = await loadReadbackRow(state.readbackId);
    if (loaded && !loaded.rb.invalidatedAt && !loaded.rb.confirmedAt) {
      const { rb, cart } = loaded;
      const total = formatMoney(cart.totals.total);
      const title = cart.lines[0]?.snapshot.title ?? 'your item';
      const say = `Your readback is still here: ${title}, ${total}. Nothing is paid until you confirm. Say 'read it again' to hear it all, or 'cancel' to stop.${
        INTEGRATIONS.paypal ? '' : ` ${PAYPAL_OFF}`
      }`;
      const r = readbackReply(rb.text, rb.fields as never, rb.id, cart, rb.text.includes('saved PayPal'), false, Boolean(rb.holdOpen), say);
      return { kind: 'readback', card: r.card!, suggestions: r.suggestions, say, readbackHash: rb.textHash, held: Boolean(rb.holdOpen) };
    }
  }
  const opts = state.options ?? [];
  if (opts.length && state.query) {
    const snaps = await loadSnapshots(opts.map((o) => o.snapshotId));
    const items = opts.filter((o) => snaps.has(o.snapshotId)).map((o) => optionItem(o.index, snaps.get(o.snapshotId)!, o.why, o.available !== false, o.pick, o.size));
    if (items.length) {
      const n = items.length;
      return {
        kind: 'options',
        card: { kind: 'options', heading: state.heading ?? `${n === 1 ? 'One option' : `${n} options`}: ${describeQuery(state.query)}`, items },
        suggestions: suggestionsFor('browsing', true),
        say: `Your ${n === 1 ? 'option' : `${n} options`} from before ${n === 1 ? 'is' : 'are'} still here. Say a number to hear more, or say what else you need.`,
      };
    }
  }
  return null;
}

/** Unread updates to say in the greeting, newest first, at most three; marks them read. */
async function unreadUpdates(userId: string) {
  const n = tables.notifications;
  const rows = await db().select().from(n).where(and(eq(n.userId, userId), isNull(n.readAt))).orderBy(desc(n.createdAt)).limit(6);
  if (!rows.length) return [];
  // A store's offer that was answered (or has gone) since its notice was sent is old news.
  const open = rows.some(isOfferNotice) ? await findOpenOffer(userId) : null;
  const stale = rows.filter((r) => isOfferNotice(r) && !(open && r.link?.startsWith(`/app/orders/${open.orderId}`)));
  const said = rows.filter((r) => !stale.includes(r)).slice(0, 3);
  const spent = [...stale, ...said];
  if (spent.length) await db().update(n).set({ readAt: new Date().toISOString() }).where(inArray(n.id, spent.map((r) => r.id)));
  return said;
}

/**
 * Hello, then any updates, then where things stand: a readback or options brought back from
 * before, a parcel to check, or the opening question. The welcome is said on the first visit only.
 */
/** Turns whose reply is spoken but not stored (a plain greeting on a return visit). */
const quietGreetings = new WeakSet<Ctx>();

async function greet(ctx: Ctx): Promise<Reply> {
  const userId = ctx.userId;
  const [earlier] = await db().select({ id: tables.messages.id }).from(tables.messages).where(eq(tables.messages.conversationId, ctx.conversationId)).limit(1);
  const pending = (await latestOrders(userId)).find((o) => o.status === 'delivered');
  const unread = await unreadUpdates(userId);
  const settled = await reconcileUnknownOrders(userId).catch(() => [] as string[]);
  const lines = [...settled, ...unread.map((n) => n.text)];
  const updates = lines.length ? ` ${lines.length === 1 ? 'One update' : `${lines.length} updates`}. ${lines.join(' ')}` : '';
  // Updates come first; the first-visit welcome would sound odd after them.
  const hello = updates ? `Hi ${ctx.firstName}.${updates}${earlier ? '' : " Say 'help' any time."}` : `Hi ${ctx.firstName}.${earlier ? '' : ` ${en.general.welcome()}`}`;
  // A return visit with nothing new is said but never stored, whichever card it restates (a parcel
  // already told about, options or a readback from before), so greetings never pile up in the
  // conversation: a screen reader would read every one, and they would push real history out.
  if (earlier && !updates) quietGreetings.add(ctx);
  const fresh = Date.now() - Date.parse(ctx.updatedAt) < RESUME_MS;
  const restored = fresh ? await restoredTurn(ctx.state) : null;
  const { query, offset, options, focus } = ctx.state;
  const kept = restored ? { query, offset, options, focus } : {};

  if (restored?.kind === 'readback') {
    ctx.state = {
      ...kept,
      phase: 'readback',
      readbackId: ctx.state.readbackId,
      confirm: { kind: 'open', readbackHash: restored.readbackHash, held: restored.held },
    };
    return { say: `${hello} ${restored.say}`, politeness: 'polite', cue: 'attention', card: restored.card, suggestions: restored.suggestions };
  }

  // A delivery told about in this greeting comes first; otherwise the options from before do.
  const deliveryIsNews = unread.some((n) => n.kind === 'delivery');
  if (pending && (deliveryIsNews || !restored)) {
    const card: Card = { kind: 'link', heading: 'Your parcel arrived', text: `The ${pending.title} from Demo Store was delivered.`, href: `/app/check/${pending.id}`, label: 'Check it now' };
    ctx.state = { phase: 'browsing', pending: [{ kind: 'check', said: 'check it now' }] };
    return {
      say: deliveryIsNews ? `${hello} What do you need today?` : `${hello} Your parcel from Demo Store was delivered. Want to check it now?`,
      politeness: 'polite',
      card,
      suggestions: suggestionsFor('browsing', false),
    };
  }
  if (restored) {
    ctx.state = { ...kept, phase: 'browsing' };
    return { say: `${hello} ${restored.say}`, politeness: 'polite', card: restored.card, suggestions: restored.suggestions };
  }
  ctx.state = { phase: 'browsing' };
  return { say: `${hello} What do you need today?`, politeness: 'polite', card: null, suggestions: suggestionsFor('browsing', false) };
}

/**
 * The conversation so far, for the page to show before its greeting arrives: recent messages, and
 * the readback or options still waiting. Read-only; the greeting turn that follows brings the
 * same card back and resets the readback to its first press. Null on a first visit.
 */
export async function resumeTurn(userId: string): Promise<TurnResponse | null> {
  const c = tables.conversations;
  const [convo] = await db().select().from(c).where(eq(c.userId, userId)).orderBy(desc(c.updatedAt)).limit(1);
  if (!convo) return null;
  const m = tables.messages;
  const rows = await db()
    .select({ id: m.id, role: m.role, text: m.text })
    .from(m)
    .where(eq(m.conversationId, convo.id))
    .orderBy(desc(m.createdAt), desc(m.id))
    .limit(40);
  if (!rows.length) return null;
  const state = { phase: 'browsing', ...(convo.state as Partial<ConvoState>) } as ConvoState;
  const restored = Date.now() - Date.parse(convo.updatedAt) < RESUME_MS ? await restoredTurn(state) : null;
  // The same agent line twice in a row (a greeting stored by an older version on each visit) is shown once.
  const ordered = rows.reverse().filter((r, i, all) => !(i > 0 && r.role !== 'user' && all[i - 1]!.role === r.role && all[i - 1]!.text === r.text));
  return {
    messages: ordered.map((r) => ({ id: r.id, role: r.role === 'user' ? 'user' : 'agent', text: r.text })),
    say: '',
    politeness: 'polite',
    card: restored?.card ?? null,
    suggestions: restored?.suggestions ?? [],
    phase: restored?.kind === 'readback' ? 'readback' : 'browsing',
  };
}

async function loadContext(userId: string): Promise<Ctx> {
  const [user] = await db().select().from(tables.users).where(eq(tables.users.id, userId)).limit(1);
  const [prefs] = await db().select().from(tables.preferences).where(eq(tables.preferences.userId, userId)).limit(1);
  let [convo] = await db().select().from(tables.conversations).where(eq(tables.conversations.userId, userId)).orderBy(desc(tables.conversations.updatedAt)).limit(1);
  if (!convo) {
    const id = newId('cnv');
    await db().insert(tables.conversations).values({ id, userId, state: { phase: 'browsing' } });
    [convo] = await db().select().from(tables.conversations).where(eq(tables.conversations.id, id)).limit(1);
  }
  return {
    userId,
    firstName: user?.displayName ?? 'there',
    conversationId: convo!.id,
    updatedAt: convo!.updatedAt,
    state: { phase: 'browsing', ...(convo!.state as Partial<ConvoState>) } as ConvoState,
    prefs: prefs!,
    out: { messages: [] },
    capture: 'open',
  };
}

async function record(ctx: Ctx, role: 'user' | 'agent', text: string, meta?: Record<string, unknown>) {
  const m = { id: newId('msg'), role, text };
  await db().insert(tables.messages).values({ id: m.id, conversationId: ctx.conversationId, role, text, meta: meta ?? null });
  ctx.out.messages.push(m);
}

/** What a card button press says in the transcript; null for actions that aren't a choice. */
function pressedWords(req: Exclude<TurnRequest, { text: string }>): string | null {
  switch (req.action) {
    case 'choose':
    case 'details':
      return `Tell me more about option ${req.index}`;
    case 'buy':
      return `Buy option ${req.index}`;
    case 'confirm-button':
      return 'Confirm';
    case 'hold':
      return 'Wait, hold on';
    case 'cancel':
      return 'Cancel';
    case 'offer-accept':
      return 'Accept the offer';
    case 'offer-decline':
      return 'Decline the offer';
    default:
      return null;
  }
}

export async function handleTurn(userId: string, req: TurnRequest): Promise<TurnResponse> {
  const ctx = await loadContext(userId);
  // A question is only answered by the very next turn; anything else drops it.
  const asked = ctx.state.pending;
  ctx.state.pending = undefined;
  // Likewise a first press of Accept: only the very next turn can be its second press.
  const armedAt = ctx.state.offer?.armedAt;
  if (ctx.state.offer) ctx.state.offer.armedAt = undefined;
  let reply: Reply;
  if ('text' in req) {
    const text = req.text.trim().slice(0, 500);
    // Typed words were sent with a key press. Spoken words count as pressed only when the client
    // says Talk was held down for them; anything else is open-microphone speech.
    ctx.capture = req.source === 'keyboard' ? 'typed' : req.capture === 'held' ? 'held' : 'open';
    await record(ctx, 'user', text, { source: req.source, capture: ctx.capture });
    const parsed = parseIntent(text, grammarCtx(ctx));
    reply = await route(ctx, parsed, text, asked);
  } else {
    // A button press is the buyer's side of the conversation too: written in plain words, so the
    // transcript reads both sides ("Accept the offer", then the reply).
    const pressed = pressedWords(req);
    if (pressed) await record(ctx, 'user', pressed, { source: 'button' });
    switch (req.action) {
      case 'start':
        // The page just opened: warm the agent's prompt cache while the greeting is read.
        prewarmShopper();
        reply = await greet(ctx);
        break;
      case 'offer':
        // A fresh page, like 'start', that goes straight to the offer the order page pointed to.
        ctx.state = { phase: 'browsing' };
        reply = await offerTurn(ctx);
        break;
      case 'choose':
      case 'details':
        reply = await details(ctx, req.index, 'general');
        break;
      case 'buy':
        reply = await startReadback(ctx, req.index);
        break;
      case 'confirm-button':
        reply = req.readbackId === ctx.state.readbackId ? await confirmStep(ctx, { button: true }) : { say: 'That readback is out of date. Nothing was charged.', politeness: 'assertive', card: null, suggestions: suggestionsFor('browsing', true) };
        break;
      case 'hold':
        reply = await confirmStep(ctx, { phrase: 'wait', button: false });
        break;
      case 'cancel':
        if (ctx.state.phase === 'offer') {
          leaveOffer(ctx);
          reply = { say: en.offers.notAnswered, politeness: 'polite', card: null, suggestions: suggestionsFor('browsing', false) };
        } else
          reply = ctx.state.phase === 'readback' ? await confirmStep(ctx, { phrase: 'cancel', button: false }) : { say: 'Okay. Nothing was charged.', politeness: 'polite', card: null, suggestions: suggestionsFor('browsing', false) };
        break;
      case 'offer-accept':
      case 'offer-decline':
        reply = await offerButton(ctx, req.action === 'offer-accept' ? 'accept' : 'decline', req.offerId, armedAt);
        break;
      case 'paypal-approved': {
        const loaded = await loadReadbackRow(req.readbackId);
        const outcome = await completeApprovedOrder({ userId, paypalOrderId: req.paypalOrderId });
        reply = loaded ? payReply(ctx, outcome, loaded.cart) : { say: 'Something went wrong. Nothing was charged.', politeness: 'assertive', card: null, suggestions: [] };
        break;
      }
      case 'repeat':
        ctx.state.pending = asked;
        reply = { say: ctx.state.lastSay ?? en.general.nothingToRepeat, politeness: 'polite', card: null, suggestions: [] };
        break;
    }
  }
  ctx.state.lastSay = reply.say;
  if (quietGreetings.has(ctx)) {
    // Not stored and not counted as activity, so the resume window and history stay as they were.
    await db().update(tables.conversations).set({ state: ctx.state as unknown as Record<string, unknown> }).where(eq(tables.conversations.id, ctx.conversationId));
    return { ...reply, messages: ctx.out.messages, phase: ctx.state.phase };
  }
  await record(ctx, 'agent', reply.say);
  await db().update(tables.conversations).set({ state: ctx.state as unknown as Record<string, unknown>, updatedAt: new Date().toISOString() }).where(eq(tables.conversations.id, ctx.conversationId));
  return { ...reply, messages: ctx.out.messages, phase: ctx.state.phase };
}

export const integrationsSummary = () => INTEGRATIONS;
