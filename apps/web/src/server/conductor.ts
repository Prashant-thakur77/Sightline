import 'server-only';
import { and, desc, eq, inArray, isNull } from 'drizzle-orm';
import { tables } from '@sightline/db';
import { formatMoney, formatMoneyShort, money, newId, type Cart, type ProductSnapshot, type Verbosity } from '@sightline/core';
import { hashCart, hashReadbackText } from '@sightline/evidence';
import { catalogFromEnv, computeTotals, deliveryEstimate, snapshotOf, type CatalogProduct } from '@sightline/catalog';
import {
  checkGrounding,
  composeReadback,
  decideConfirmation,
  en,
  initialConfirmationState,
  listingWarnings,
  parseIntent,
  parseShoppingQuery,
  presentComparison,
  presentDetails,
  presentNone,
  describeQuery,
  presentOptions,
  presentPaid,
  presentWhy,
  queryToSearchText,
  rankProducts,
  type ConfirmationState,
  type DetailsTopic,
  type OptionContext,
  type ParsedIntent,
  type RankedOption,
  type ShoppingQuery,
} from '@sightline/agent';
import type { Card, ChatMessage, OptionItem, TurnRequest, TurnResponse } from '@/components/conversation/types';
import { appUrl, db, demoSeller, ENV, INTEGRATIONS } from './runtime';
import { aiAvailable, answerAboutListing, confirmationClassifier, extractShoppingQuery } from './ai';
import { payForReadback, completeApprovedOrder, reconcileUnknownOrders, type PayOutcome } from './payments';
import { audit } from './audit';

const SNAPSHOT_MAX_AGE_MS = 12 * 60 * 1000;

interface StoredOption extends OptionContext {
  productId: string;
  snapshotId: string;
  selection: Record<string, string>;
  why: string[];
}

interface ConvoState {
  phase: 'browsing' | 'readback';
  query?: ShoppingQuery;
  offset?: number;
  options?: StoredOption[];
  focus?: number;
  readbackId?: string;
  confirm?: ConfirmationState;
  lastSay?: string;
}

interface Ctx {
  userId: string;
  firstName: string;
  conversationId: string;
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
  if (phase === 'readback')
    return [
      { label: 'Confirm purchase', utterance: 'confirm purchase' },
      { label: 'Wait', utterance: 'wait' },
      { label: 'Cancel', utterance: 'cancel' },
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
    const none = presentNone(query, ranked);
    ctx.state.options = [];
    return { say: none.text, politeness: 'polite', card: null, suggestions: suggestionsFor('browsing', false) };
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
  const c = presentComparison(items, aspect);
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
  return {
    say: sayOverride ?? text,
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
          total: formatMoney(cart.totals.total),
          clientId: ENV.PAYPAL_CLIENT_ID ?? '',
          orderIntent: ctx.prefs.payAfterCheck ? 'AUTHORIZE' : 'CAPTURE',
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
    case 'declined':
    case 'error':
      return { say: outcome.say, politeness: 'assertive', cue: 'error', card: { kind: 'refusal', heading: 'Nothing was charged', reason: outcome.say, code: outcome.kind }, suggestions: suggestionsFor('browsing', true) };
  }
}

async function confirmStep(ctx: Ctx, opts: { phrase?: string; button: boolean }): Promise<Reply> {
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
    default:
      return readbackReply(rb.text, rb.fields as never, rb.id, cart, vaulted, false, rb.holdOpen, decision.say || en.help.readback);
  }
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
    say: `Let's check your ${target.title}. I'll open the camera page. I'll guide you with my voice.`,
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
    say: `I'll get your money back for the ${target.title}. I'll show you the evidence first, and nothing is sent until you confirm.`,
    politeness: 'polite',
    card: { kind: 'link', heading: 'Get your money back', text: `Start a case for the ${target.title}.`, href: `/app/orders/${target.id}#money-back`, label: 'Open the case' },
    suggestions: [],
  };
}

// ---------------------------------------------------------------------------------------------

function grammarCtx(ctx: Ctx) {
  return {
    phase: ctx.state.phase === 'readback' ? ('readback' as const) : ('browsing' as const),
    options: ctx.state.options,
    savedSizes: ctx.prefs.sizes as never,
    currency: 'USD',
  };
}

async function route(ctx: Ctx, parsed: ParsedIntent, raw: string): Promise<Reply> {
  // During a readback, everything goes through the confirmation state machine first.
  if (ctx.state.phase === 'readback' && ['confirm', 'hold', 'cancel', 'cart', 'refine', 'freeform'].includes(parsed.intent)) {
    return confirmStep(ctx, { phrase: raw, button: false });
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
      return moneyBack(ctx);
    case 'help':
      if (parsed.slots.topic === 'repeat') return { say: ctx.state.lastSay ?? en.general.nothingToRepeat, politeness: 'polite', card: null, suggestions: suggestionsFor(ctx.state.phase, Boolean(ctx.state.options?.length)) };
      if (parsed.slots.topic === 'more') return { say: en.help.more, politeness: 'polite', card: HELP_CARD, suggestions: suggestionsFor('browsing', false) };
      return { say: en.help.main, politeness: 'polite', card: HELP_CARD, suggestions: suggestionsFor('browsing', false) };
    case 'settings':
      return {
        say: 'You can change that in Settings. I opened it for you.',
        politeness: 'polite',
        card: { kind: 'link', heading: 'Settings', text: 'Speech, sizes and spending limits.', href: '/app/settings', label: 'Open settings' },
        suggestions: [],
      };
    case 'freeform': {
      if (/\bwhy\b/i.test(raw) && ctx.state.options?.length) {
        const snaps = await loadSnapshots(ctx.state.options.map((o) => o.snapshotId));
        const why = presentWhy(ctx.state.options.map((o, i) => ({ rank: i + 1, snapshot: snaps.get(o.snapshotId)!, score: 0, why: o.why, caveats: [], verifiable: true, missing: [] })));
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

export async function handleTurn(userId: string, req: TurnRequest): Promise<TurnResponse> {
  const ctx = await loadContext(userId);
  let reply: Reply;
  if ('text' in req) {
    const text = req.text.trim().slice(0, 500);
    await record(ctx, 'user', text, { source: req.source });
    const parsed = parseIntent(text, grammarCtx(ctx));
    reply = await route(ctx, parsed, text);
  } else {
    switch (req.action) {
      case 'start': {
        const pending = (await latestOrders(userId)).find((o) => o.status === 'delivered');
        const unread = await db()
          .select()
          .from(tables.notifications)
          .where(and(eq(tables.notifications.userId, userId), isNull(tables.notifications.readAt)))
          .orderBy(desc(tables.notifications.createdAt))
          .limit(3);
        if (unread.length)
          await db()
            .update(tables.notifications)
            .set({ readAt: new Date().toISOString() })
            .where(inArray(tables.notifications.id, unread.map((n) => n.id)));
        const settled = await reconcileUnknownOrders(userId).catch(() => [] as string[]);
        for (const t of settled) unread.unshift({ text: t } as (typeof unread)[number]);
        const updates = unread.length
          ? ` ${unread.length === 1 ? 'One update' : `${unread.length} updates`}. ${unread.map((n) => n.text).join(' ')}`
          : '';
        const greet = `Hi ${ctx.firstName}.${updates} ${en.general.welcome()}`;
        const alreadyTold = unread.some((n) => n.kind === 'delivery');
        reply = pending && !alreadyTold
          ? {
              say: `${greet} Your parcel from Demo Store was delivered. Want to check it now?`,
              politeness: 'polite',
              card: { kind: 'link', heading: 'Your parcel arrived', text: `The ${pending.title} from Demo Store was delivered.`, href: `/app/check/${pending.id}`, label: 'Check it now' },
              suggestions: suggestionsFor('browsing', false),
            }
          : {
              say: `${greet} What do you need today?`,
              politeness: 'polite',
              card: pending
                ? { kind: 'link', heading: 'Your parcel arrived', text: `The ${pending.title} from Demo Store was delivered.`, href: `/app/check/${pending.id}`, label: 'Check it now' }
                : null,
              suggestions: suggestionsFor('browsing', false),
            };
        ctx.state = { phase: 'browsing' };
        break;
      }
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
        reply = ctx.state.phase === 'readback' ? await confirmStep(ctx, { phrase: 'cancel', button: false }) : { say: 'Okay. Nothing was charged.', politeness: 'polite', card: null, suggestions: suggestionsFor('browsing', false) };
        break;
      case 'paypal-approved': {
        const loaded = await loadReadbackRow(req.readbackId);
        const outcome = await completeApprovedOrder({ userId, paypalOrderId: req.paypalOrderId });
        reply = loaded ? payReply(ctx, outcome, loaded.cart) : { say: 'Something went wrong. Nothing was charged.', politeness: 'assertive', card: null, suggestions: [] };
        break;
      }
      case 'repeat':
        reply = { say: ctx.state.lastSay ?? en.general.nothingToRepeat, politeness: 'polite', card: null, suggestions: [] };
        break;
    }
  }
  ctx.state.lastSay = reply.say;
  await record(ctx, 'agent', reply.say);
  await db().update(tables.conversations).set({ state: ctx.state as unknown as Record<string, unknown>, updatedAt: new Date().toISOString() }).where(eq(tables.conversations.id, ctx.conversationId));
  return { ...reply, messages: ctx.out.messages, phase: ctx.state.phase };
}

export const integrationsSummary = () => INTEGRATIONS;
