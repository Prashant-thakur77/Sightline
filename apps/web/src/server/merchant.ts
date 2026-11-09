import 'server-only';
import { randomInt } from 'node:crypto';
import { asc, desc, eq, inArray, sql, and } from 'drizzle-orm';
import { tables } from '@sightline/db';
import {
  addBusinessDays,
  shortRef,
  CONFIDENCE_WORD,
  FINDING,
  MODULE_LABEL,
  caseStatus,
  formatMoney,
  newId,
  paymentStatus,
  reasonForSeller,
  shipmentStatus,
  spokenDate,
  verdictStatus,
  type ProductSnapshot,
  type ShippedVariant,
  type StatusWord,
  type Verdict,
  type VerdictReason,
} from '@sightline/core';
import { paypalRequestId } from '@sightline/evidence';
import {
  hasAction,
  PayPalActionUnavailableError,
  type Dispute,
  type OfferType,
  type PortableAddress,
} from '@sightline/paypal';
import { currentUser } from './session';
import { db, INTEGRATIONS } from './runtime';
import { paypal, PayPalNotConfiguredError } from './paypal';
import { audit } from './audit';
import { notify } from './cases';

/*
 * The Demo Store side of the sandbox: what the test merchant sees and does. Every action here
 * runs only from an explicit, confirmed click in the merchant console. Nothing is accepted,
 * refunded or offered automatically.
 */

export type ShipChoice = ShippedVariant;
export const SHIP_CHOICES: readonly ShipChoice[] = [
  'correct',
  'wrong_colour',
  'wrong_size',
  'damaged',
  'nothing',
];

/** Where a merchant action landed with PayPal, said plainly in the console. */
export type PayPalSync = 'sent' | 'local-only' | 'not-configured' | 'failed' | 'not-needed';

export interface MerchantResult {
  ok: boolean;
  message: string;
  paypal: PayPalSync;
}

export class MerchantError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export function paypalConfigured(): boolean {
  return Boolean(INTEGRATIONS.paypal);
}

/** One reference format for buyer and store (core shortRef). */
export { shortRef };

const money = (cents: number, currency: string) => formatMoney({ cents, currency });

// ---------------------------------------------------------------------------------------------
// Words. Every status comes from the shared vocabulary in @sightline/core, so the console says
// exactly what the buyer's pages say, with the same glyphs and tones.

type OrderRow = typeof tables.orders.$inferSelect;
type ShipmentRow = typeof tables.shipments.$inferSelect;

export type { StatusWord };

/** What the demo controls sent, in words. Used in messages and in the shipment detail. */
const VARIANT_WORD: Record<string, string> = {
  correct: 'the right item',
  wrong_colour: 'the wrong colour (black)',
  wrong_size: 'the wrong size (L)',
  damaged: 'a damaged item',
  nothing: 'nothing',
};

const lowerFirst = (s: string) => s.charAt(0).toLowerCase() + s.slice(1);

/**
 * The demo choice behind a shipment, as a detail beside the delivery status. A wrong or damaged
 * item is flagged with "!", never "✓", even once the carrier has delivered it.
 */
function sentWord(s: ShipmentRow | null): StatusWord | null {
  if (!s || s.status === 'awaiting_shipment' || s.shippedVariant === 'nothing') return null;
  const what = VARIANT_WORD[s.shippedVariant] ?? s.shippedVariant.replace(/_/g, ' ');
  return s.shippedVariant === 'correct'
    ? { word: `Sent ${what}`, glyph: '✓', tone: 'good' }
    : { word: `Sent ${what}`, glyph: '!', tone: 'bad' };
}

/** A check's reason as one row of the merchant's table: the buyer's words, told in the third person. */
export interface ReasonRow {
  module: VerdictReason['module'];
  label: string;
  finding: VerdictReason['finding'];
  result: StatusWord;
  confidence: string;
  text: string;
}

/**
 * What one check found, for a table row that already names the check and has its own "How sure"
 * column: the seller's sentence without the module name in front and without the confidence.
 */
function reasonCell(r: VerdictReason): string {
  if (r.finding === 'unknown') return 'Could not be checked from the photos.';
  const text = reasonForSeller({ ...r, confidence: 'sure' });
  const prefix = `${MODULE_LABEL[r.module]}: `;
  return text.startsWith(prefix) ? text.charAt(prefix.length).toUpperCase() + text.slice(prefix.length + 1) : text;
}

function reasonRows(v: Verdict): ReasonRow[] {
  return v.reasons.map((r) => ({
    module: r.module,
    label: MODULE_LABEL[r.module] ?? r.module,
    finding: r.finding,
    result: FINDING[r.finding],
    confidence: CONFIDENCE_WORD[r.confidence] ?? r.confidence,
    text: reasonCell(r),
  }));
}

/**
 * A case's status as the store sees it. The shared words are the buyer's ("Waiting for the store",
 * "Offer to answer"); on the store's own console the same stages say whose move it is.
 */
function storeCaseStatus(stage: string | null | undefined, buyer: string): StatusWord {
  if (stage === 'seller_contacted') return { word: 'Needs your reply', glyph: '!', tone: 'waiting' };
  if (stage === 'offer_received') return { word: `Waiting for ${buyer}'s answer`, glyph: '…', tone: 'waiting' };
  return caseStatus(stage);
}

/** One third-person sentence on what the buyer's check found, for the order panel. */
function verdictSummary(v: Verdict | null): string | null {
  if (!v) return null;
  if (v.kind === 'match') return 'Every check matched the order.';
  // Differences first, then what matched and what could not be checked, so one unknown module
  // never reads as the whole story.
  const names = (f: VerdictReason['finding']) => v.reasons.filter((r) => r.finding === f).map((r) => MODULE_LABEL[r.module].toLowerCase());
  const list = (xs: string[]) => (xs.length < 2 ? xs.join('') : `${xs.slice(0, -1).join(', ')} and ${xs.at(-1)}`);
  const cap = (t: string) => t.charAt(0).toUpperCase() + t.slice(1);
  const parts = v.reasons.filter((r) => r.finding === 'disagree').map(reasonForSeller);
  const agreed = names('agree');
  const unknown = names('unknown');
  if (agreed.length) parts.push(`${cap(list(agreed))} matched.`);
  if (unknown.length) parts.push(`${cap(list(unknown))} could not be checked.`);
  return parts.length ? parts.join(' ') : null;
}

const REASON_MODULE: Record<string, VerdictReason['module'] | undefined> = {
  wrong_colour: 'colour',
  wrong_size: 'size',
  wrong_item: 'identity',
  damaged: 'damage',
};

const REASON_PHRASE: Record<string, string> = {
  wrong_colour: 'the wrong colour',
  wrong_size: 'the wrong size',
  wrong_item: 'the wrong item',
  damaged: 'damaged',
};

/**
 * The case title follows the check's confidence: it only asserts what the check is sure of.
 * "is the wrong size" when sure, "is probably the wrong size" when fairly sure, otherwise
 * "may be the wrong size".
 */
function caseTitle(reason: string, item: string, buyer: string, v: Verdict | null): string {
  if (reason === 'not_received') return `${buyer} says the ${item} has not arrived`;
  if (reason === 'unclear') return `${buyer} isn't sure the ${item} is what was ordered`;
  const phrase = REASON_PHRASE[reason] ?? reason.replace(/_/g, ' ');
  const module = REASON_MODULE[reason];
  const bad = v?.reasons.filter((r) => r.finding === 'disagree') ?? [];
  const lead = bad.find((r) => r.module === module) ?? bad[0];
  const verb =
    v?.kind === 'mismatch' && lead?.confidence === 'sure'
      ? 'is'
      : v?.kind === 'mismatch' && lead?.confidence === 'fairly_sure'
        ? 'is probably'
        : 'may be';
  return `${buyer}'s ${item} ${verb} ${phrase}`;
}

/** Demo Store's own record, in one sentence. Sizes keep their case: "Sent the wrong size (L), delivered." */
function shippingRecord(s: ShipmentRow | null): string | null {
  if (!s || s.status === 'awaiting_shipment') return null;
  const status = shipmentStatus(s).word;
  const sent = sentWord(s);
  return sent ? `${sent.word}, ${lowerFirst(status)}.` : `${status}.`;
}

// ---------------------------------------------------------------------------------------------
// Orders

export interface MerchantOrderRow {
  id: string;
  ref: string;
  createdAt: string;
  buyer: string;
  item: string;
  colour: string | null;
  size: string | null;
  amount: string;
  amountCents: number;
  intent: string;
  status: string;
  payment: StatusWord;
  /** PayPal holds the money until the buyer's check (pay after check). */
  held: boolean;
  shipment: StatusWord & {
    state: 'ready' | 'not_shipped' | 'in_transit' | 'delivered';
    /** What the demo controls sent; a wrong item is flagged with "!", never "✓". */
    sent: StatusWord | null;
    carrier: string | null;
    trackingNumber: string | null;
    trackerId: string | null;
    shippedAt: string | null;
    deliveredAt: string | null;
  };
  verdict: StatusWord & { kind: Verdict['kind'] | 'none'; summary: string | null };
  case: StatusWord & { id: string | null; stage: string | null };
  can: { ship: boolean; deliver: boolean; sendTracking: boolean };
  /** Why shipping or delivery is not available right now, one plain sentence each. */
  why: { ship: string | null; deliver: string | null };
  /** When no demo action is possible: the one line shown instead of the controls. */
  blocked: string | null;
  /** PayPal holds the money and may still capture it: tracking goes to PayPal after the capture. */
  awaitingCapture: boolean;
}

function canShip(o: OrderRow, s: ShipmentRow | null): boolean {
  if (!['authorized', 'captured', 'shipped'].includes(o.status)) return false;
  return !s || s.status === 'awaiting_shipment' || s.status === 'not_shipped';
}

function blockedReason(o: OrderRow, s: ShipmentRow | null): string | null {
  if (s?.deliveredAt) return 'Delivered. Shipping can no longer change.';
  if (s?.status === 'shipped') return 'Shipped. The next step is delivery.';
  if (['voided', 'resolved_refund', 'resolved_replacement', 'closed'].includes(o.status))
    return 'This order is closed.';
  if (o.status === 'failed') return 'This order was never placed, so there is nothing to ship.';
  if (['readback_pending', 'confirmed', 'approval_pending'].includes(o.status))
    return 'The buyer has not approved the payment yet, so it cannot ship.';
  return null;
}

function deliverBlockedReason(o: OrderRow, s: ShipmentRow | null): string {
  if (s?.deliveredAt) return 'Already delivered.';
  if (s?.status === 'not_shipped') return 'Nothing was shipped, so nothing can be delivered.';
  return blockedReason(o, s) ?? 'Ship it first. Nothing is on its way yet.';
}

export async function listMerchantOrders(scopeUserId?: string): Promise<MerchantOrderRow[]> {
  const orders = await db()
    .select()
    .from(tables.orders)
    .where(scopeUserId ? eq(tables.orders.userId, scopeUserId) : undefined)
    .orderBy(desc(tables.orders.createdAt))
    .limit(200);
  if (orders.length === 0) return [];
  const ids = orders.map((o) => o.id);
  const [users, snaps, ships, vers, kases] = await Promise.all([
    db()
      .select({ id: tables.users.id, name: tables.users.displayName })
      .from(tables.users)
      .where(inArray(tables.users.id, [...new Set(orders.map((o) => o.userId))])),
    db()
      .select({ id: tables.productSnapshots.id, body: tables.productSnapshots.body })
      .from(tables.productSnapshots)
      .where(inArray(tables.productSnapshots.id, [...new Set(orders.map((o) => o.snapshotId))])),
    db().select().from(tables.shipments).where(inArray(tables.shipments.orderId, ids)),
    db()
      .select({
        orderId: tables.verifications.orderId,
        verdict: tables.verifications.verdict,
        createdAt: tables.verifications.createdAt,
      })
      .from(tables.verifications)
      .where(inArray(tables.verifications.orderId, ids))
      .orderBy(desc(tables.verifications.createdAt)),
    db()
      .select()
      .from(tables.cases)
      .where(inArray(tables.cases.orderId, ids))
      .orderBy(desc(tables.cases.createdAt)),
  ]);
  const nameOf = new Map(users.map((u) => [u.id, u.name]));
  const snapOf = new Map(snaps.map((s) => [s.id, s.body as ProductSnapshot]));
  const shipOf = new Map(ships.map((s) => [s.orderId, s]));
  const verdictOf = new Map<string, Verdict>();
  for (const v of vers)
    if (v.verdict && !verdictOf.has(v.orderId)) verdictOf.set(v.orderId, v.verdict as Verdict);
  const caseOf = new Map<string, typeof tables.cases.$inferSelect>();
  for (const c of kases) if (!caseOf.has(c.orderId)) caseOf.set(c.orderId, c);

  return orders.map((o) => {
    const snap = snapOf.get(o.snapshotId);
    const s = shipOf.get(o.id) ?? null;
    const v = verdictOf.get(o.id) ?? null;
    const c = caseOf.get(o.id) ?? null;
    const visibleCase = c && c.stage !== 'draft' && c.stage !== 'evidence_built' ? c : null;
    const state: MerchantOrderRow['shipment']['state'] = s?.deliveredAt
      ? 'delivered'
      : s?.status === 'shipped'
        ? 'in_transit'
        : s?.status === 'not_shipped'
          ? 'not_shipped'
          : 'ready';
    const ship = canShip(o, s);
    const deliver = s?.status === 'shipped' && !s.deliveredAt;
    const sendTracking = Boolean(o.captureId && s?.trackingNumber && !s.trackerId);
    const payment = paymentStatus(o);
    const why = {
      ship: ship ? null : (blockedReason(o, s) ?? 'This order cannot ship right now.'),
      deliver: deliver ? null : deliverBlockedReason(o, s),
    };
    return {
      id: o.id,
      ref: shortRef(o.id),
      createdAt: o.createdAt,
      buyer: nameOf.get(o.userId) ?? 'Buyer',
      item: snap?.title ?? o.title,
      colour: snap?.attributes.colour ?? null,
      size: snap?.attributes.size ?? null,
      amount: money(o.amountCents, o.currency),
      amountCents: o.amountCents,
      intent: o.intent,
      status: o.status,
      payment,
      held: payment.word === 'On hold',
      shipment: {
        ...shipmentStatus(s),
        state,
        sent: sentWord(s),
        carrier: s?.carrier ?? null,
        trackingNumber: s?.trackingNumber ?? null,
        trackerId: s?.trackerId ?? null,
        shippedAt: s?.shippedAt ?? null,
        deliveredAt: s?.deliveredAt ?? null,
      },
      verdict: { ...verdictStatus(v?.kind), kind: v?.kind ?? 'none', summary: verdictSummary(v) },
      case: { ...storeCaseStatus(visibleCase?.stage, nameOf.get(o.userId) ?? 'the buyer'), id: visibleCase?.id ?? null, stage: visibleCase?.stage ?? null },
      can: { ship, deliver, sendTracking },
      why,
      blocked: ship || deliver || sendTracking ? null : (why.ship ?? why.deliver),
      awaitingCapture: holdAwaitingCapture(o),
    };
  });
}

async function loadOrder(orderId: string) {
  const [o] = await db().select().from(tables.orders).where(eq(tables.orders.id, orderId)).limit(1);
  if (!o) throw new MerchantError(404, 'That order was not found.');
  const [s] = await db()
    .select()
    .from(tables.shipments)
    .where(eq(tables.shipments.orderId, orderId))
    .limit(1);
  return { o, s: s ?? null };
}

/** USPS-style 22-digit tracking number for the sandbox. */
function trackingNumber(): string {
  let n = '9400';
  for (let i = 0; i < 18; i++) n += String(randomInt(10));
  return n;
}

type TrackingOutcome = { sync: PayPalSync; trackerId: string | null };

/** Adds tracking to PayPal when the order has a capture. Never throws: the shipment is already recorded. */
async function sendTracking(o: OrderRow, number: string, carrier: string): Promise<TrackingOutcome> {
  if (!o.captureId) return { sync: 'local-only', trackerId: null };
  try {
    const res = await paypal().tracking.addTracking({
      strategy: o.paypalOrderId ? 'orders-track' : 'trackers-batch',
      orderId: o.paypalOrderId ?? undefined,
      captureId: o.captureId,
      trackingNumber: number,
      carrier,
      notifyPayer: false,
      items: o.paypalOrderId ? [{ name: o.title.slice(0, 127), quantity: 1 }] : undefined,
      shipmentDate: o.paypalOrderId ? undefined : new Date().toISOString().slice(0, 10),
    });
    return { sync: 'sent', trackerId: res.trackerId ?? `${o.captureId}-${number}` };
  } catch (e) {
    if (e instanceof PayPalNotConfiguredError) return { sync: 'not-configured', trackerId: null };
    console.error('[merchant] add tracking failed', e);
    return { sync: 'failed', trackerId: null };
  }
}

/** PayPal holds this order's money and may still capture it, so tracking can go to PayPal later. */
function holdAwaitingCapture(o: OrderRow): boolean {
  return Boolean(o.paypalOrderId && o.authorizationId && !o.captureId);
}

function trackingSentence(sync: PayPalSync, awaitingCapture: boolean, hasPayPalOrder = true): string {
  switch (sync) {
    case 'sent':
      return 'Tracking added to the PayPal order.';
    case 'not-configured':
      return 'PayPal sandbox keys are not set on this server, so the tracking is recorded here only.';
    case 'failed':
      return 'PayPal did not accept the tracking just now. It is recorded here, and you can send it again.';
    default:
      if (awaitingCapture) return "PayPal tracking is attached when the payment is captured after the buyer's check.";
      return hasPayPalOrder
        ? 'This order has no PayPal capture, so the tracking is recorded here only.'
        : 'This order has no PayPal order, so the tracking is recorded here only.';
  }
}

/** Demo control: ship the right item, a wrong one, a damaged one, or nothing at all. */
export async function shipOrder(orderId: string, variant: ShipChoice): Promise<MerchantResult> {
  if (!SHIP_CHOICES.includes(variant)) throw new MerchantError(400, 'Unknown shipping choice.');
  const { o, s } = await loadOrder(orderId);
  if (!canShip(o, s))
    throw new MerchantError(409, blockedReason(o, s) ?? 'This order cannot ship right now.');
  const now = new Date().toISOString();
  const ref = shortRef(o.id);

  if (variant === 'nothing') {
    await db()
      .insert(tables.shipments)
      .values({ orderId: o.id, status: 'not_shipped', shippedVariant: 'nothing' })
      .onConflictDoUpdate({
        target: tables.shipments.orderId,
        set: {
          status: 'not_shipped',
          shippedVariant: 'nothing',
          carrier: null,
          trackingNumber: null,
          trackerId: null,
          shippedAt: null,
          deliveredAt: null,
        },
      });
    await audit({
      userId: o.userId,
      actor: 'merchant',
      action: 'shipment.not_shipped',
      subjectId: o.id,
      payload: { variant },
    });
    return {
      ok: true,
      paypal: 'not-needed',
      message: `Order ${ref} is marked as not shipped. Nothing goes to PayPal. The buyer's parcel will never arrive.`,
    };
  }

  const carrier = 'USPS';
  const number = trackingNumber();
  await db()
    .insert(tables.shipments)
    .values({
      orderId: o.id,
      status: 'shipped',
      shippedVariant: variant,
      carrier,
      trackingNumber: number,
      shippedAt: now,
    })
    .onConflictDoUpdate({
      target: tables.shipments.orderId,
      set: {
        status: 'shipped',
        shippedVariant: variant,
        carrier,
        trackingNumber: number,
        trackerId: null,
        shippedAt: now,
        deliveredAt: null,
      },
    });
  const awaitingCapture = holdAwaitingCapture(o);
  const t = await sendTracking(o, number, carrier);
  if (t.trackerId)
    await db()
      .update(tables.shipments)
      .set({ trackerId: t.trackerId })
      .where(eq(tables.shipments.orderId, o.id));
  await audit({
    userId: o.userId,
    actor: 'merchant',
    action: 'shipment.shipped',
    subjectId: o.id,
    payload: { variant, carrier, trackingNumber: number, trackerId: t.trackerId, paypal: t.sync },
  });
  return {
    ok: true,
    paypal: t.sync,
    message: `Order ${ref} shipped with ${carrier}: ${VARIANT_WORD[variant]}. Tracking number ${number}. ${trackingSentence(t.sync, awaitingCapture, Boolean(o.paypalOrderId))}`,
  };
}

/** Send tracking that was recorded before the payment was captured (or that PayPal refused earlier). */
export async function attachPendingTracking(orderId: string): Promise<MerchantResult> {
  const { o, s } = await loadOrder(orderId);
  if (!s?.trackingNumber) throw new MerchantError(409, 'This order has no tracking number yet.');
  if (s.trackerId)
    return {
      ok: true,
      paypal: 'sent',
      message: `PayPal already has the tracking for order ${shortRef(o.id)}.`,
    };
  if (!o.captureId)
    return {
      ok: false,
      paypal: 'local-only',
      message: trackingSentence('local-only', holdAwaitingCapture(o), Boolean(o.paypalOrderId)),
    };
  const t = await sendTracking(o, s.trackingNumber, s.carrier ?? 'USPS');
  if (t.trackerId)
    await db()
      .update(tables.shipments)
      .set({ trackerId: t.trackerId })
      .where(eq(tables.shipments.orderId, o.id));
  await audit({
    userId: o.userId,
    actor: 'merchant',
    action: 'tracking.sent',
    subjectId: o.id,
    payload: { trackerId: t.trackerId, paypal: t.sync },
  });
  return { ok: t.sync === 'sent', paypal: t.sync, message: trackingSentence(t.sync, false) };
}

/** Demo control: the carrier delivered the parcel. Tells the buyer it can be checked now. */
export async function markDelivered(orderId: string): Promise<MerchantResult> {
  const { o, s } = await loadOrder(orderId);
  if (!s || s.status !== 'shipped' || s.deliveredAt)
    throw new MerchantError(
      409,
      s?.deliveredAt ? 'Already delivered.' : 'Ship it first. Nothing is on its way yet.',
    );
  const now = new Date().toISOString();
  await db()
    .update(tables.shipments)
    .set({ status: 'delivered', deliveredAt: now })
    .where(eq(tables.shipments.orderId, o.id));
  // A pay-after-check order keeps its "authorized" status: the buyer's check reads that status to
  // say the money is still on hold. Orders already further along keep theirs.
  const next = ['captured', 'shipped', 'authorized'].includes(o.status) ? 'delivered' : o.status;
  if (next !== o.status)
    await db().update(tables.orders).set({ status: next, updatedAt: now }).where(eq(tables.orders.id, o.id));
  await audit({
    userId: o.userId,
    actor: 'merchant',
    action: 'shipment.delivered',
    subjectId: o.id,
    payload: { variant: s.shippedVariant, orderStatus: next },
  });
  await notify(
    o.userId,
    'delivery',
    'Your parcel from Demo Store was delivered. Want to check it now?',
    `/app/check/${o.id}`,
  );
  return {
    ok: true,
    paypal: 'not-needed',
    message: `Order ${shortRef(o.id)} is delivered. The buyer was told the parcel arrived and can check it now.`,
  };
}

// ---------------------------------------------------------------------------------------------
// Cases

export interface Suggestion {
  /** Always one of the reply buttons, so the suggestion can be acted on as shown. */
  action: CaseAction;
  title: string;
  why: string;
}

/**
 * The suggested fair response. Deterministic, shown, never sent. It only suggests a reply that has
 * a button on the cases desk, and it starts from Demo Store's own shipping record: what the store
 * says it sent outweighs a check that is not sure. Reasons are told in the third person.
 */
export function suggestResponse(
  v: Verdict | null,
  shippedVariant: string | null,
  amount: string,
  opts: { reason?: string; refundPath: 'refund' | 'void' | 'none'; dispute: boolean } = { refundPath: 'refund', dispute: false },
): Suggestion {
  const canRefund = opts.dispute || opts.refundPath !== 'none';
  const sure = v?.reasons.find((r) => r.finding === 'disagree' && r.confidence === 'sure');
  const doubt = v?.reasons.find((r) => r.finding === 'disagree') ?? v?.reasons.find((r) => r.finding !== 'agree');
  const check = !v
    ? 'The buyer has not checked the parcel with the camera.'
    : v.kind === 'match'
      ? "The buyer's check matched the listing."
      : v.kind === 'mismatch' && sure
        ? `The buyer's check is sure. ${reasonForSeller(sure)}`
        : `The buyer's check is not sure.${doubt ? ` ${reasonForSeller(doubt)}` : ''}`;
  const sent = shippedVariant ? VARIANT_WORD[shippedVariant] : undefined;
  const record =
    shippedVariant === 'nothing' ? 'Your shipping record says nothing was shipped.' : sent ? `Your shipping record says you sent ${sent}.` : '';
  const refund = (why: string): Suggestion =>
    canRefund
      ? {
          action: 'refund',
          title: opts.refundPath === 'void' && !opts.dispute ? `Release the ${amount} hold` : `Refund ${amount} in full`,
          why,
        }
      : {
          action: 'replacement',
          title: 'Offer a replacement',
          why: `${why} This order has no PayPal payment to refund, so a replacement is the fair reply.`,
        };

  // The store's own record says it got the order wrong: no need to wait for anything else.
  if (shippedVariant === 'nothing') return refund(record);
  if (shippedVariant && shippedVariant !== 'correct') return refund(`${record} ${check}`);
  if (opts.reason === 'not_received')
    return {
      action: 'replacement',
      title: 'Offer a replacement',
      why: `${record ? `${record} ` : ''}The buyer says it has not arrived. A replacement settles it without a refund.`,
    };
  // No record of a wrong item: a sure check is enough on its own; otherwise see the item first.
  if (v?.kind === 'mismatch' && sure && !record) return refund(check);
  return {
    action: 'return',
    title: 'Ask for the item back first',
    why: `${check}${record ? ` ${record}` : ''} Seeing the item settles it: ${opts.refundPath === 'void' && !opts.dispute ? `you release the ${amount} hold` : `you refund ${amount}`} when it is back.`,
  };
}

export interface CaseOffer {
  id: string;
  type: OfferType;
  note: string;
  amountCents?: number;
  at: string;
  via: 'paypal' | 'local';
}

export interface MerchantCase {
  id: string;
  ref: string;
  orderId: string;
  orderRef: string;
  buyer: string;
  item: string;
  colour: string | null;
  size: string | null;
  amount: string;
  stage: string;
  status: StatusWord;
  open: boolean;
  reason: string;
  /** "Sam's Linen shirt may be the wrong size": asserts only what the check is sure of. */
  title: string;
  createdAt: string;
  dueAt: string | null;
  dueWords: string | null;
  overdue: boolean;
  evidencePackId: string | null;
  evidenceSummary: string | null;
  readbackText: string | null;
  verdict: {
    kind: Verdict['kind'];
    word: StatusWord;
    reasons: ReasonRow[];
  } | null;
  /** Demo Store's own shipping record in one sentence, e.g. "Sent the wrong size (L), delivered." */
  shippingRecord: string | null;
  payment: StatusWord;
  refundPath: 'refund' | 'void' | 'none';
  offers: CaseOffer[];
  outcome: string | null;
  suggestion: Suggestion;
  dispute: {
    id: string;
    state: string | null;
    status: string | null;
    dueDate: string | null;
    makeOffer: string[];
    acceptClaim: string[];
    actions: string[];
    error: string | null;
  } | null;
}

function dueWords(dueAt: string | null, now = new Date()): { words: string | null; overdue: boolean } {
  if (!dueAt) return { words: null, overdue: false };
  const due = new Date(dueAt);
  const days = Math.round(
    (Date.UTC(due.getUTCFullYear(), due.getUTCMonth(), due.getUTCDate()) -
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())) /
      86_400_000,
  );
  const when = spokenDate(due);
  if (due.getTime() < now.getTime()) return { words: `Overdue since ${when}`, overdue: true };
  if (days === 0) return { words: `Reply by today, ${when}`, overdue: false };
  if (days === 1) return { words: `Reply by tomorrow, ${when}`, overdue: false };
  return { words: `Reply by ${when}, in ${days} days`, overdue: false };
}

function outcomeWords(outcome: unknown, currency: string): string | null {
  const o = outcome as { kind?: string; amount?: number; amountCents?: number; via?: string; by?: string } | null;
  if (!o?.kind) return null;
  const amt = o.amountCents ?? o.amount;
  const a = typeof amt === 'number' ? money(amt, currency) : 'the payment';
  if (o.kind === 'voided')
    return o.by === 'deadline'
      ? `No reply by the deadline, so the ${a} hold was released. Demo Store was never paid.`
      : o.by === 'merchant'
        ? `You accepted the return and released the ${a} hold. Demo Store was never paid.`
        : `The ${a} hold was released. Demo Store was never paid.`;
  if (o.kind === 'refunded')
    return `Refunded ${a}${o.via === 'dispute' ? ' through the PayPal dispute' : ' through PayPal'}.`;
  if (o.kind === 'replacement' || o.kind === 'REPLACEMENT_WITHOUT_REFUND') return 'The buyer accepted the replacement. No refund is due.';
  return `Closed: ${o.kind.replace(/_/g, ' ').toLowerCase()}.`;
}

function disputeOptions(d: Dispute) {
  return {
    makeOffer: d.allowed_response_options?.make_offer?.offer_types ?? [],
    acceptClaim: d.allowed_response_options?.accept_claim?.accept_claim_types ?? [],
    actions: (d.links ?? []).filter((l) => (l.method ?? 'GET').toUpperCase() !== 'GET').map((l) => l.rel),
  };
}

export async function listMerchantCases(scopeUserId?: string): Promise<MerchantCase[]> {
  const rows = await db()
    .select()
    .from(tables.cases)
    .where(
      scopeUserId
        ? and(sql`${tables.cases.stage} not in ('draft', 'evidence_built')`, eq(tables.cases.userId, scopeUserId))
        : sql`${tables.cases.stage} not in ('draft', 'evidence_built')`,
    )
    .orderBy(sql`${tables.cases.dueAt} asc nulls last`, asc(tables.cases.createdAt));
  if (rows.length === 0) return [];
  const orderIds = [...new Set(rows.map((c) => c.orderId))];
  const orders = await db().select().from(tables.orders).where(inArray(tables.orders.id, orderIds));
  const orderOf = new Map(orders.map((o) => [o.id, o]));
  const [users, snaps, rbs, vers, ships, packs] = await Promise.all([
    db()
      .select({ id: tables.users.id, name: tables.users.displayName })
      .from(tables.users)
      .where(inArray(tables.users.id, [...new Set(orders.map((o) => o.userId))])),
    db()
      .select({ id: tables.productSnapshots.id, body: tables.productSnapshots.body })
      .from(tables.productSnapshots)
      .where(inArray(tables.productSnapshots.id, [...new Set(orders.map((o) => o.snapshotId))])),
    db()
      .select({ id: tables.readbacks.id, text: tables.readbacks.text })
      .from(tables.readbacks)
      .where(inArray(tables.readbacks.id, [...new Set(orders.map((o) => o.readbackId))])),
    db()
      .select({ orderId: tables.verifications.orderId, verdict: tables.verifications.verdict })
      .from(tables.verifications)
      .where(inArray(tables.verifications.orderId, orderIds))
      .orderBy(desc(tables.verifications.createdAt)),
    db().select().from(tables.shipments).where(inArray(tables.shipments.orderId, orderIds)),
    db()
      .select({ id: tables.evidencePacks.id, narrative: tables.evidencePacks.narrative })
      .from(tables.evidencePacks)
      .where(
        inArray(
          tables.evidencePacks.id,
          rows.map((c) => c.evidencePackId).filter((x): x is string => Boolean(x)),
        ),
      ),
  ]);
  const nameOf = new Map(users.map((u) => [u.id, u.name]));
  const snapOf = new Map(snaps.map((s) => [s.id, s.body as ProductSnapshot]));
  const rbOf = new Map(rbs.map((r) => [r.id, r.text]));
  const verdictOf = new Map<string, Verdict>();
  for (const v of vers)
    if (v.verdict && !verdictOf.has(v.orderId)) verdictOf.set(v.orderId, v.verdict as Verdict);
  const shipOf = new Map(ships.map((s) => [s.orderId, s]));
  const packOf = new Map(packs.map((p) => [p.id, p.narrative]));

  const out: MerchantCase[] = [];
  for (const c of rows) {
    const o = orderOf.get(c.orderId);
    if (!o) continue;
    const snap = snapOf.get(o.snapshotId);
    const v = verdictOf.get(o.id) ?? null;
    const s = shipOf.get(o.id) ?? null;
    const amount = money(o.amountCents, o.currency);
    const buyer = nameOf.get(o.userId) ?? 'Buyer';
    const item = snap?.title ?? o.title;
    const open = c.stage !== 'resolved';
    // "Reply by …" speaks to the store: once it has made an offer, the buyer's answer is awaited instead.
    const due = open && c.stage !== 'offer_received' ? dueWords(c.dueAt) : { words: null, overdue: false };
    let dispute: MerchantCase['dispute'] = null;
    if (c.paypalDisputeId) {
      try {
        const d = await paypal().disputes.get(c.paypalDisputeId);
        dispute = {
          id: d.dispute_id,
          state: d.dispute_state ?? null,
          status: d.status ?? null,
          dueDate: d.seller_response_due_date ?? null,
          ...disputeOptions(d),
          error: null,
        };
      } catch (e) {
        dispute = {
          id: c.paypalDisputeId,
          state: null,
          status: null,
          dueDate: null,
          makeOffer: [],
          acceptClaim: [],
          actions: [],
          error:
            e instanceof PayPalNotConfiguredError
              ? "PayPal sandbox keys are not set on this server, so this dispute's live options cannot be read."
              : 'PayPal did not answer just now, so the live options are not shown. Try again in a minute.',
        };
      }
    }
    out.push({
      id: c.id,
      ref: shortRef(c.id),
      orderId: o.id,
      orderRef: shortRef(o.id),
      buyer,
      item,
      colour: snap?.attributes.colour ?? null,
      size: snap?.attributes.size ?? null,
      amount,
      stage: c.stage,
      status: storeCaseStatus(c.stage, buyer),
      open,
      reason: c.reason,
      title: caseTitle(c.reason, item, buyer, v),
      createdAt: c.createdAt,
      dueAt: c.dueAt,
      dueWords: due.words,
      overdue: due.overdue,
      evidencePackId: c.evidencePackId,
      evidenceSummary: c.evidencePackId ? (packOf.get(c.evidencePackId) ?? null) : null,
      readbackText: rbOf.get(o.readbackId) ?? null,
      verdict: v ? { kind: v.kind, word: verdictStatus(v.kind), reasons: reasonRows(v) } : null,
      shippingRecord: shippingRecord(s),
      payment: paymentStatus(o),
      refundPath: o.captureId ? 'refund' : o.authorizationId && o.status !== 'voided' ? 'void' : 'none',
      offers: (c.offers as CaseOffer[]) ?? [],
      outcome: outcomeWords(c.outcome, o.currency),
      suggestion: suggestResponse(v, s?.shippedVariant ?? null, amount, {
        reason: c.reason,
        refundPath: o.captureId ? 'refund' : o.authorizationId && o.status !== 'voided' ? 'void' : 'none',
        dispute: Boolean(c.paypalDisputeId),
      }),
      dispute,
    });
  }
  return out;
}

export type CaseAction = 'refund' | 'replacement' | 'return' | 'no_response';
export const CASE_ACTIONS: readonly CaseAction[] = ['refund', 'replacement', 'return', 'no_response'];

/** The sandbox test merchant's return address, used only when PayPal needs one for a return offer. */
const DEMO_STORE_RETURN_ADDRESS: PortableAddress = {
  address_line_1: '1 Demo Store Way',
  admin_area_2: 'San Jose',
  admin_area_1: 'CA',
  postal_code: '95131',
  country_code: 'US',
};

function paypalFailure(e: unknown, what: string): MerchantResult {
  if (e instanceof PayPalNotConfiguredError)
    return {
      ok: false,
      paypal: 'not-configured',
      message: `${what} was not sent. PayPal sandbox keys are not set on this server, so nothing changed.`,
    };
  if (e instanceof PayPalActionUnavailableError)
    return {
      ok: false,
      paypal: 'failed',
      message: `PayPal does not allow that on this dispute right now, so nothing was sent.${e.available.length ? ` It allows: ${e.available.join(', ').replace(/_/g, ' ')}.` : ''}`,
    };
  console.error('[merchant] PayPal call failed', e);
  return {
    ok: false,
    paypal: 'failed',
    message: `PayPal did not accept the ${what.toLowerCase()} just now. Nothing changed. Try again in a minute.`,
  };
}

/**
 * The merchant's reply to a case. Runs only after the person at the desk confirmed it. When the
 * case is a real PayPal dispute, PayPal's own merchant actions are used, gated on what the
 * dispute currently allows.
 */
export async function respondToCase(caseId: string, action: CaseAction): Promise<MerchantResult> {
  if (!CASE_ACTIONS.includes(action)) throw new MerchantError(400, 'Unknown action.');
  const [c] = await db().select().from(tables.cases).where(eq(tables.cases.id, caseId)).limit(1);
  if (!c || c.stage === 'draft' || c.stage === 'evidence_built')
    throw new MerchantError(404, 'That case was not found.');
  if (c.stage === 'resolved') throw new MerchantError(409, 'This case is already resolved.');
  const [o] = await db().select().from(tables.orders).where(eq(tables.orders.id, c.orderId)).limit(1);
  if (!o) throw new MerchantError(404, 'The order for this case was not found.');
  const amount = money(o.amountCents, o.currency);
  const full = { cents: o.amountCents, currency: o.currency };
  const now = new Date().toISOString();
  const ref = shortRef(c.id);
  const orderLink = `/app/orders/${o.id}`;

  if (action === 'no_response') {
    await audit({
      userId: o.userId,
      actor: 'merchant',
      action: 'case.no_response',
      subjectId: o.id,
      payload: { caseId: c.id },
    });
    const due = c.dueAt ? spokenDate(c.dueAt) : null;
    return {
      ok: true,
      paypal: 'not-needed',
      message: `Nothing was sent for case ${ref}. It stays open${due ? `, and after ${due} the buyer can open a case with PayPal` : ''}.`,
    };
  }

  if (action === 'refund') {
    let via: 'dispute' | 'capture' | 'void';
    let paypalId: string | undefined;
    try {
      if (c.paypalDisputeId) {
        const pp = paypal();
        const d = await pp.disputes.get(c.paypalDisputeId);
        const opts = disputeOptions(d);
        const note = `Demo Store accepts the claim and refunds ${amount} in full.`;
        const acceptRefund =
          hasAction(d, 'accept_claim') &&
          (opts.acceptClaim.length === 0 || opts.acceptClaim.includes('REFUND'));
        const offerRefund =
          hasAction(d, 'make_offer') && (opts.makeOffer.length === 0 || opts.makeOffer.includes('REFUND'));
        if (!acceptRefund && offerRefund) {
          // PayPal only lets Demo Store offer the refund here; the buyer still has to accept it.
          await pp.disputes.makeOffer(d, {
            requestId: paypalRequestId('dispute', d.dispute_id, 'offer-refund'),
            offerType: 'REFUND',
            note,
            offerAmount: full,
            invoiceId: o.id,
          });
          const offer: CaseOffer = {
            id: newId('ofr'),
            type: 'REFUND',
            note,
            amountCents: o.amountCents,
            at: now,
            via: 'paypal',
          };
          await db()
            .update(tables.cases)
            .set({
              stage: 'offer_received',
              offers: [...((c.offers as unknown[]) ?? []), offer],
              updatedAt: now,
            })
            .where(eq(tables.cases.id, c.id));
          await audit({
            userId: o.userId,
            actor: 'merchant',
            action: 'case.offer_made',
            subjectId: o.id,
            payload: { caseId: c.id, offerType: 'REFUND', via: 'paypal' },
          });
          await notify(
            o.userId,
            'case',
            `Demo Store offered a full refund of ${amount}. Nothing changes until you answer.`,
            orderLink,
          );
          return {
            ok: true,
            paypal: 'sent',
            message: `PayPal only allows an offer on this dispute, so a full refund of ${amount} was offered for case ${ref}. The buyer decides next.`,
          };
        }
        if (!acceptRefund)
          throw new PayPalActionUnavailableError('accept_claim', d.dispute_id, [
            ...opts.actions,
            ...opts.acceptClaim,
          ]);
        await pp.disputes.acceptClaim(d, {
          requestId: paypalRequestId('dispute', d.dispute_id, 'accept-claim'),
          note,
          acceptClaimType: opts.acceptClaim.includes('REFUND') ? 'REFUND' : undefined,
          invoiceId: o.id,
        });
        via = 'dispute';
        paypalId = d.dispute_id;
      } else if (o.captureId) {
        const refund = await paypal().payments.refundCapture(o.captureId, {
          requestId: paypalRequestId('refund', o.captureId),
          noteToPayer: `Demo Store refunded your ${o.title}.`.slice(0, 255),
          invoiceId: `${o.id}-refund`.slice(0, 127),
        });
        via = 'capture';
        paypalId = refund.id;
      } else if (o.authorizationId && o.status !== 'voided') {
        await paypal().payments.voidAuthorization(o.authorizationId, {
          requestId: paypalRequestId('void', o.authorizationId),
        });
        via = 'void';
        paypalId = o.authorizationId;
      } else {
        return {
          ok: false,
          paypal: 'not-needed',
          message: 'This order has no PayPal payment to refund, so nothing was sent.',
        };
      }
    } catch (e) {
      return paypalFailure(e, 'The refund');
    }
    const voided = via === 'void';
    await db()
      .update(tables.orders)
      .set({ status: voided ? 'voided' : 'resolved_refund', updatedAt: now })
      .where(eq(tables.orders.id, o.id));
    await db()
      .update(tables.cases)
      .set({
        stage: 'resolved',
        status: 'resolved',
        outcome: {
          kind: voided ? 'voided' : 'refunded',
          amountCents: o.amountCents,
          via,
          paypalId,
          by: 'merchant',
          at: now,
        },
        updatedAt: now,
      })
      .where(eq(tables.cases.id, c.id));
    await audit({
      userId: o.userId,
      actor: 'merchant',
      action: voided ? 'case.hold_released' : 'case.refunded',
      subjectId: o.id,
      payload: { caseId: c.id, via, paypalId, amountCents: o.amountCents },
    });
    await notify(
      o.userId,
      'refund',
      voided
        ? `Demo Store released the payment hold of ${amount}. You were never charged.`
        : `Demo Store refunded ${amount}. It should reach your PayPal balance within minutes.`,
      orderLink,
    );
    return {
      ok: true,
      paypal: 'sent',
      message: voided
        ? `PayPal released the ${amount} hold for case ${ref}. Demo Store was never paid. The buyer has been told.`
        : `PayPal refunded ${amount} for case ${ref}. The buyer has been told it should reach their PayPal balance within minutes.`,
    };
  }

  // Offers: a replacement, or the money back once the item is back. On a held payment "money
  // back" means releasing the hold (nothing was ever taken), so the words say that.
  // Held: PayPal authorized at purchase and nothing captured yet (same rule as after-check isHeld).
  const held = o.intent === 'AUTHORIZE' && Boolean(o.authorizationId) && !o.captureId && o.status !== 'voided';
  if (action === 'return' && !held && !o.captureId && !c.paypalDisputeId)
    return { ok: false, paypal: 'not-needed', message: 'This order has no PayPal payment, so there is nothing to give back. Offer a replacement instead.' };
  const offerType: OfferType = action === 'replacement' ? 'REPLACEMENT_WITHOUT_REFUND' : 'REFUND_WITH_RETURN';
  const note =
    action === 'replacement'
      ? `Demo Store will send a replacement ${o.title} at no cost.`
      : held
        ? `Demo Store will release the ${amount} payment hold as soon as the ${o.title} is back with us.`
        : `Demo Store will refund ${amount} as soon as the ${o.title} is back with us.`;
  // A held payment keeps a deadline while an offer is open: time for a return to arrive.
  const offerDue = held ? addBusinessDays(new Date(now), 10).toISOString() : c.dueAt;
  let via: 'paypal' | 'local' = 'local';
  if (c.paypalDisputeId) {
    try {
      const pp = paypal();
      const d = await pp.disputes.get(c.paypalDisputeId);
      await pp.disputes.makeOffer(d, {
        requestId: paypalRequestId(
          'dispute',
          d.dispute_id,
          action === 'replacement' ? 'offer-replacement' : 'offer-return',
        ),
        offerType,
        note,
        offerAmount: offerType === 'REFUND_WITH_RETURN' ? full : undefined,
        returnShippingAddress: offerType === 'REFUND_WITH_RETURN' ? DEMO_STORE_RETURN_ADDRESS : undefined,
        invoiceId: o.id,
      });
      via = 'paypal';
    } catch (e) {
      return paypalFailure(e, 'The offer');
    }
  }
  const offer: CaseOffer = {
    id: newId('ofr'),
    type: offerType,
    note,
    amountCents: offerType === 'REFUND_WITH_RETURN' ? o.amountCents : undefined,
    at: now,
    via,
  };
  await db()
    .update(tables.cases)
    .set({ stage: 'offer_received', offers: [...((c.offers as unknown[]) ?? []), offer], dueAt: offerDue, updatedAt: now })
    .where(eq(tables.cases.id, c.id));
  await audit({
    userId: o.userId,
    actor: 'merchant',
    action: 'case.offer_made',
    subjectId: o.id,
    payload: { caseId: c.id, offerType, via },
  });
  await notify(
    o.userId,
    // Its own kind, so the app can tell an offer notice apart without reading its words.
    'offer',
    action === 'replacement'
      ? `Demo Store offered to send a replacement ${o.title}. Nothing changes until you answer.`
      : held
        ? `Demo Store asked for the ${o.title} back first. They release the ${amount} hold once it arrives, and if it isn't settled by ${spokenDate(offerDue!)}, I'll cancel the hold myself. Nothing changes until you answer.`
        : `Demo Store asked for the ${o.title} back first. They will refund ${amount} once it arrives. Nothing changes until you answer.`,
    orderLink,
  );
  return {
    ok: true,
    paypal: via === 'paypal' ? 'sent' : 'local-only',
    message: `${action === 'replacement' ? 'Replacement offered' : 'Return-first offer made'} for case ${ref}${via === 'paypal' ? ' through the PayPal dispute' : ''}. The buyer has been told and decides what happens next.`,
  };
}

// ---------------------------------------------------------------------------------------------
// Summary

export interface MerchantSummary {
  orders: number;
  verifiedDeliveries: number;
  voidedAfterMismatch: number;
  capturedAfterMatch: number;
  casesAvoided: number;
  resolvedCases: number;
  medianResolutionMs: number | null;
}

export async function merchantSummary(): Promise<MerchantSummary> {
  const [counts] = await db()
    .select({
      orders: sql<number>`(select count(*)::int from ${tables.orders})`,
      verified: sql<number>`(select count(distinct ${tables.verifications.orderId})::int from ${tables.verifications} where ${tables.verifications.verdict} is not null)`,
      voided: sql<number>`(select count(distinct ${tables.auditLog.subjectId})::int from ${tables.auditLog} where ${tables.auditLog.action} = 'payment.voided_after_check')`,
      captured: sql<number>`(select count(distinct ${tables.auditLog.subjectId})::int from ${tables.auditLog} where ${tables.auditLog.action} = 'payment.captured_after_check')`,
    })
    .from(sql`(select 1) as one`);
  const resolved = await db()
    .select({ createdAt: tables.cases.createdAt, updatedAt: tables.cases.updatedAt })
    .from(tables.cases)
    .where(eq(tables.cases.stage, 'resolved'));
  const spans = resolved
    .map((r) => new Date(r.updatedAt).getTime() - new Date(r.createdAt).getTime())
    .filter((n) => n >= 0)
    .sort((a, b) => a - b);
  const mid = Math.floor(spans.length / 2);
  const median =
    spans.length === 0
      ? null
      : spans.length % 2
        ? spans[mid]!
        : Math.round((spans[mid - 1]! + spans[mid]!) / 2);
  const voided = counts?.voided ?? 0;
  const captured = counts?.captured ?? 0;
  return {
    orders: counts?.orders ?? 0,
    verifiedDeliveries: counts?.verified ?? 0,
    voidedAfterMismatch: voided,
    capturedAfterMatch: captured,
    casesAvoided: voided + captured,
    resolvedCases: spans.length,
    medianResolutionMs: median,
  };
}

/** "2 hours 5 minutes", "3 days 4 hours", "under a minute". */
export function durationWords(ms: number): string {
  const min = Math.floor(ms / 60_000);
  if (min < 1) return 'under a minute';
  const d = Math.floor(min / 1440);
  const h = Math.floor((min % 1440) / 60);
  const m = min % 60;
  const part = (n: number, w: string) => (n ? `${n} ${w}${n === 1 ? '' : 's'}` : '');
  return (d ? [part(d, 'day'), part(h, 'hour')] : [part(h, 'hour'), part(m, 'minute')])
    .filter(Boolean)
    .join(' ');
}

// ---------------------------------------------------------------------------------------------
// Request guard

/** Merchant actions accept same-origin POSTs only, so another site cannot press the buttons. */
export function assertSameOrigin(req: Request): void {
  const origin = req.headers.get('origin');
  if (!origin) return;
  const host = req.headers.get('x-forwarded-host') ?? req.headers.get('host');
  try {
    if (host && new URL(origin).host === host) return;
  } catch {
    /* fall through */
  }
  throw new MerchantError(403, 'Merchant actions only run from the merchant console.');
}

/** Status and body for a failed merchant route. Unexpected errors never leak details. */
export function merchantFailure(e: unknown, tag: string): { status: number; body: MerchantResult } {
  if (e instanceof MerchantError)
    return { status: e.status, body: { ok: false, paypal: 'not-needed', message: e.message } };
  console.error(`[merchant:${tag}]`, e);
  return {
    status: 500,
    body: {
      ok: false,
      paypal: 'not-needed',
      message: 'Something went wrong on our side. Nothing changed. Try again in a minute.',
    },
  };
}


/**
 * Each visitor plays both sides of the demo: their own demo shopper and the Demo Store. Merchant
 * pages and actions are scoped to the shopper in this browser session, so one visitor can never
 * ship, refund or void another visitor's order.
 */
export async function requireMerchantScope(): Promise<string> {
  const user = await currentUser();
  if (!user) throw new MerchantError(401, 'Start a demo first. The Demo Store console shows the orders from your own demo shopper.');
  return user.id;
}

export async function assertOrderInScope(orderId: string, userId: string): Promise<void> {
  const [o] = await db().select({ userId: tables.orders.userId }).from(tables.orders).where(eq(tables.orders.id, orderId)).limit(1);
  if (!o || o.userId !== userId) throw new MerchantError(404, 'That order is not one of your demo orders.');
}

export async function assertCaseInScope(caseId: string, userId: string): Promise<void> {
  const [c] = await db().select({ userId: tables.cases.userId }).from(tables.cases).where(eq(tables.cases.id, caseId)).limit(1);
  if (!c || c.userId !== userId) throw new MerchantError(404, 'That case is not one of your demo cases.');
}
