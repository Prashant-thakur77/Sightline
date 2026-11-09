import 'server-only';
import { and, desc, eq, inArray, isNull } from 'drizzle-orm';
import { tables } from '@sightline/db';
import { formatMoney, formatMoneyShort, money, newId, type Cart, type ProductSnapshot, type Verbosity } from '@sightline/core';
import { hashCart, hashReadbackText } from '@sightline/evidence';
import { catalogFromEnv, computeTotals, deliveryEstimate, snapshotOf, type CatalogProduct } from '@sightline/catalog';
import {
  answerReadbackQuestion,
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
  queryToSearchText,
  rankProducts,
  type ConfirmationState,
  type DetailsTopic,
  type NoneSuggestion,
  type OfferChoice,
  type OptionContext,
  type ParsedIntent,
  type RankedOption,
  type SettingsSlots,
  type ShoppingQuery,
} from '@sightline/agent';
import type { Card, ChatMessage, OptionItem, TurnRequest, TurnResponse } from '@/components/conversation/types';
import { appUrl, db, demoSeller, ENV, INTEGRATIONS } from './runtime';
import { aiAvailable, answerAboutListing, confirmationClassifier, extractShoppingQuery } from './ai';
import { payForReadback, completeApprovedOrder, reconcileUnknownOrders, type PayOutcome } from './payments';
import { audit } from './audit';
import { answerOffer, findOpenOffer, isOfferNotice, markOfferNoticesRead, type OpenOffer } from './offers';
import { offerKind, type OfferAnswer } from './offer-plan';

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
}

/**
 * What "yes" does after a question the assistant just asked ("Want me to try up to $45?"). Never
 * a purchase: paying always goes through the readback and its two-key confirmation.
 */
type Pending =
  | { kind: 'search'; query: ShoppingQuery; said: string }
  | { kind: 'ask'; said: string }
  | { kind: 'check'; said: string }
  | { kind: 'verbosity'; verbosity: Verbosity; said: string };

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
}

type Reply = Omit<TurnResponse, 'messages' | 'phase'>;

const HELP_CARD: Card = {
  kind: 'help',
  heading: 'Things you can say',
  groups: [
    { title: 'Shopping', phrases: ['I need a navy crew-neck sweater, medium, under forty dollars', 'cheaper', 'in black', 'more'] },
    { title: 'Choosing', phrases: ['two', 'tell me more about one', 'what do reviews say about sizing', 'compare them', 'why these?'] },
    { title: 'Buying', phrases: ['buy number one', 'confirm purchase', 'wait', 'cancel'] },
    { title: 'After you buy', phrases: ["where's my order", 'where is my money', 'it arrived', 'this is wrong'] },
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

function freeze(p: CatalogProduct): ProductSnapshot {
  return snapshotOf(p, demoSeller(), new Date(), appUrl());
}

function returnsLabel(s: ProductSnapshot): string {
  const r = s.returnPolicy;
  if (!r) return 'Not listed';
  if (r.windowDays) return `${r.free ? 'Free, ' : ''}${r.windowDays} days`;
  return r.free ? 'Free' : 'Listed, see details';
}

function optionItem(index: number, s: ProductSnapshot, why: string[], available = true): OptionItem {
  return {
    index,
    productId: s.productId,
    title: s.title,
    brand: s.brand,
    colour: s.attributes.colour,
    size: s.attributes.size,
    price: formatMoneyShort(s.price),
    returns: returnsLabel(s),
    available,
    imageUrl: s.images[0]?.url,
    imageAlt: s.images[0]?.alt,
    why,
  };
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

async function search(ctx: Ctx, query: ShoppingQuery, offset = 0): Promise<Reply> {
  const catalog = catalogFromEnv(ENV, ctx.userId);
  let products: CatalogProduct[] = [];
  try {
    products = await catalog.search({
      text: queryToSearchText(query),
      category: query.category,
      colour: query.colour,
      size: query.size,
      maxPrice: query.maxPrice,
      minPrice: query.minPrice,
      limit: 12,
    });
  } catch (e) {
    console.error('[conductor] catalog search failed', e);
    return { say: 'The store catalog is not answering right now. Nothing has changed. Please try again in a moment.', politeness: 'assertive', cue: 'error', card: null, suggestions: suggestionsFor('browsing', false) };
  }
  const snapshots = products.map(freeze);
  const ranked = rankProducts({
    candidates: snapshots.map((s, i) => ({ snapshot: s, inStock: products[i]!.available })),
    query,
    avoidColours: ctx.prefs.avoidColours,
    limit: 3,
    offset,
  });
  if (ranked.options.length === 0) {
    const none = presentNone(query, ranked, { store: demoSeller().name });
    ctx.state.options = [];
    // Refinements and "yes" apply to what was just asked.
    ctx.state.query = query;
    ctx.state.offset = 0;
    ctx.state.focus = undefined;
    ctx.state.pending = none.suggestions.map((sg) => pendingForNone(query, sg));
    return { say: none.text, politeness: 'polite', card: null, suggestions: pendingChips(ctx.state.pending) };
  }
  for (const o of ranked.options) await saveSnapshot(o.snapshot);
  const presentation = presentOptions(ranked, { query, verbosity: ctx.prefs.verbosity as Verbosity, firstPage: offset === 0 });
  ctx.state.query = query;
  ctx.state.offset = offset;
  ctx.state.focus = undefined;
  ctx.state.options = ranked.options.map((o: RankedOption, i: number) => ({
    ...presentation.context[i]!,
    productId: o.snapshot.productId,
    snapshotId: o.snapshot.id,
    selection: Object.fromEntries(o.snapshot.variantId.split(';').filter(Boolean).map((kv) => kv.split('=') as [string, string])),
    why: o.why,
    caveats: o.caveats,
    available: o.sizeInStock !== false,
  }));
  return {
    say: presentation.text,
    politeness: 'polite',
    card: {
      kind: 'options',
      heading: `${ranked.options.length === 1 ? 'One option' : `${ranked.options.length} options`}: ${describeQuery(query)}`,
      items: ranked.options.map((o, i) => optionItem(i + 1, o.snapshot, o.why, o.sizeInStock !== false)),
    },
    suggestions: suggestionsFor('browsing', true),
  };
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

async function freshSnapshot(snap: ProductSnapshot, selection: Record<string, string>, changes?: { size?: string; colour?: string }): Promise<ProductSnapshot | null> {
  const age = Date.now() - Date.parse(snap.capturedAt);
  if (!changes && age < SNAPSHOT_MAX_AGE_MS) return snap;
  const sel = { ...selection };
  if (changes?.size) sel.Size = changes.size.toUpperCase();
  if (changes?.colour) sel.Colour = changes.colour.toLowerCase();
  const product = await catalogFromEnv(ENV).get(snap.productId, sel);
  if (!product) return null;
  const fresh = freeze(product);
  await saveSnapshot(fresh);
  return fresh;
}

async function startReadback(ctx: Ctx, index: number | undefined, changes?: { size?: string; colour?: string; quantity?: number }): Promise<Reply> {
  const i = index ?? ctx.state.focus ?? (ctx.state.options?.length === 1 ? 1 : undefined);
  if (!i) return { say: 'Which one would you like? Say a number.', politeness: 'polite', card: null, suggestions: suggestionsFor('browsing', true) };
  const found = await optionSnapshot(ctx, i);
  if (!found) return { say: `I don't have an option ${i}.`, politeness: 'polite', card: null, suggestions: suggestionsFor('browsing', false) };
  const snap = await freshSnapshot(found.snap, found.opt.selection, changes);
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
  ctx.state.phase = 'readback';
  ctx.state.readbackId = readbackId;
  ctx.state.confirm = initialConfirmationState(composed.textHash);
  ctx.state.focus = i;
  return readbackReply(composed.text, composed.fields, readbackId, cart, Boolean(vault[0]), false, false);
}

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

/** Gate refusals whose wording promises to read the order again. */
const REREAD_AFTER = new Set([
  'CART_TAMPERED',
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
    kind: offerKind(open.offer.type),
    amount: money(open.amountCents, open.currency),
    itemNoun: categoryOf(open.title)?.canonical ?? en.check.defaultNoun,
  };
}

/** The offer as a card: what was offered, what accepting means, and its Accept and Decline buttons. */
function offerCard(open: OpenOffer, needsSecondPress: boolean): Card {
  const choice = offerChoice(open);
  return {
    kind: 'offer',
    heading: `${choice.merchant}’s offer`,
    offerId: open.offer.id,
    orderId: open.orderId,
    text: presentOfferChoice(choice).sentences.slice(0, 3).join(' '),
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
    const say = result.reason === 'gone' ? en.offers.gone : result.reason === 'paypal-unavailable' ? en.offers.paypalUnavailable : en.offers.paypalFailed;
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
  }
}

/** A "yes" or "no" (or the words of one offer) after a question; null when the turn is something else. */
async function answerPending(ctx: Ctx, raw: string, pending: Pending[] | undefined): Promise<Reply | null> {
  const said = normaliseText(raw).replace(/[.!?]+$/, '').trim();
  const picked = pending?.find((p) => normaliseText(p.said) === said);
  if (picked) return runPending(ctx, picked);
  const yn = parseYesNo(raw);
  if (!yn) return null;
  const after = suggestionsFor('browsing', Boolean(ctx.state.options?.length));
  if (!pending?.length) return { say: yn === 'no' ? en.general.noThanks : en.general.nothingAsked, politeness: 'polite', card: null, suggestions: after };
  if (yn === 'no') return { say: en.general.noThanks, politeness: 'polite', card: null, suggestions: after };
  if (pending.length === 1) return runPending(ctx, pending[0]!);
  ctx.state.pending = pending;
  return { say: en.general.whichOne(pending.map((p) => p.said)), politeness: 'polite', card: null, suggestions: pendingChips(pending) };
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
  // "Yes" or "no" to the question just asked.
  if (ctx.state.phase === 'browsing') {
    const answered = await answerPending(ctx, raw, pending);
    if (answered) return answered;
  }
  switch (parsed.intent) {
    case 'search':
      return search(ctx, parsed.slots.query);
    case 'refine': {
      const base = ctx.state.query ?? parseShoppingQuery('', { savedSizes: ctx.prefs.sizes as never });
      const s = parsed.slots;
      if (s.more) return search(ctx, base, (ctx.state.offset ?? 0) + 3);
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
    const items = opts.filter((o) => snaps.has(o.snapshotId)).map((o) => optionItem(o.index, snaps.get(o.snapshotId)!, o.why, o.available !== false));
    if (items.length) {
      const n = items.length;
      return {
        kind: 'options',
        card: { kind: 'options', heading: `${n === 1 ? 'One option' : `${n} options`}: ${describeQuery(state.query)}`, items },
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
    await record(ctx, 'user', text, { source: req.source });
    const parsed = parseIntent(text, grammarCtx(ctx));
    reply = await route(ctx, parsed, text, asked);
  } else {
    // A button press is the buyer's side of the conversation too: written in plain words, so the
    // transcript reads both sides ("Accept the offer", then the reply).
    const pressed = pressedWords(req);
    if (pressed) await record(ctx, 'user', pressed, { source: 'button' });
    switch (req.action) {
      case 'start':
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
