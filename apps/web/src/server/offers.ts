import 'server-only';
import { and, desc, eq, isNull, like, or } from 'drizzle-orm';
import { tables } from '@sightline/db';
import { paypalRequestId } from '@sightline/evidence';
import type { PayPalClient } from '@sightline/paypal';
import { db, ENV, INTEGRATIONS } from './runtime';
import { paypal, PayPalNotConfiguredError } from './paypal';
import { audit } from './audit';
import { dbReservations } from './gate-ports';
import { isHeld } from './after-check';
import { withCaseLock, type CaseOffer } from './merchant';
import { planOfferAnswer, type OfferAnswer, type OfferPlan } from './offer-plan';
import { scheduleStoreAgent } from './store-agent';

/**
 * The buyer's side of a store's offer on a case: find the offer waiting for an answer, and answer
 * it. The conversation reads the offer, the store agent's reasons and what accepting means first;
 * only a spoken "accept" or "decline" after that, or the offer card's buttons (Accept takes two
 * presses), reach answerOffer.
 */

export interface OpenOffer {
  caseId: string;
  orderId: string;
  /** The order's item title. */
  title: string;
  /** The offered amount in integer cents, or the order amount when the offer names none. */
  amountCents: number;
  /** What the order cost, in integer cents. */
  paidCents: number;
  currency: string;
  /** PayPal still holds the money: nothing was taken, so nothing is refunded. */
  held: boolean;
  offer: CaseOffer;
  disputeId: string | null;
}

/** The newest offer still waiting for this buyer's answer, if any. */
export async function findOpenOffer(userId: string): Promise<OpenOffer | null> {
  const [c] = await db()
    .select()
    .from(tables.cases)
    .where(and(eq(tables.cases.userId, userId), eq(tables.cases.stage, 'offer_received')))
    .orderBy(desc(tables.cases.updatedAt))
    .limit(1);
  if (!c) return null;
  const offers = (c.offers as CaseOffer[] | null) ?? [];
  const offer = offers[offers.length - 1];
  if (!offer) return null;
  const [o] = await db().select().from(tables.orders).where(eq(tables.orders.id, c.orderId)).limit(1);
  if (!o) return null;
  return {
    caseId: c.id,
    orderId: o.id,
    title: o.title,
    amountCents: offer.amountCents ?? o.amountCents,
    paidCents: o.amountCents,
    currency: o.currency,
    held: isHeld(o) && !c.paypalDisputeId,
    offer,
    disputeId: c.paypalDisputeId ?? null,
  };
}

/**
 * Every notice of a store's offer ends "Nothing changes until you answer." Once the offer has been
 * read out or answered, that notice is spent: the greeting must not read it again.
 */
const OFFER_NOTICE_MARK = 'until you answer';

export function isOfferNotice(n: { kind: string; text: string }): boolean {
  // New offer notices have their own kind; older ones (kind 'case') are matched by their wording.
  return n.kind === 'offer' || (n.kind === 'case' && n.text.includes(OFFER_NOTICE_MARK));
}

/** Mark this order's unread offer notices read: the offer was just read out or answered. */
export async function markOfferNoticesRead(userId: string, orderId: string): Promise<void> {
  const n = tables.notifications;
  await db()
    .update(n)
    .set({ readAt: new Date().toISOString() })
    .where(
      and(
        eq(n.userId, userId),
        isNull(n.readAt),
        like(n.link, `/app/orders/${orderId}%`),
        or(eq(n.kind, 'offer'), and(eq(n.kind, 'case'), like(n.text, `%${OFFER_NOTICE_MARK}%`))),
      ),
    );
}

export type OfferAnswerResult =
  | { ok: true; plan: OfferPlan; offer: OpenOffer }
  | { ok: false; reason: 'gone' | 'paypal-unavailable' | 'paypal-failed' | 'not-connected' };

type Payments = Pick<PayPalClient['payments'], 'captureAuthorization' | 'refundCapture'>;
type Order = typeof tables.orders.$inferSelect;

/**
 * "Keep it for less", accepted: on a hold, PayPal captures only the rest (final capture, so PayPal
 * releases the part); on a payment, PayPal refunds the part. Which one was fixed when the offer was
 * made, and both amounts come from the order and that offer, never from model text. Request ids
 * are derived from the offer, so a retry asks PayPal for the same thing and never moves money twice.
 */
export async function settleKeepForLess(o: Order, offer: CaseOffer, pp: Payments, now: string): Promise<{ via: 'capture' | 'refund'; paypalId: string; status: string | null }> {
  const part = offer.amountCents ?? 0;
  if (!Number.isInteger(part) || part < 1 || part >= o.amountCents) throw new Error('part refund amount out of range');
  const note = `You kept the ${o.title} for less, as agreed with Demo Store.`.slice(0, 255);
  const held = offer.partial?.held ?? isHeld(o);
  // Already settled (an earlier try got through PayPal but not to the end): nothing moves again.
  if (o.status === 'resolved_partial_refund' && o.captureId) return { via: held ? 'capture' : 'refund', paypalId: o.captureId, status: null };
  if (held) {
    if (!isHeld(o)) throw new Error('the hold is gone');
    const cap = await pp.captureAuthorization(o.authorizationId!, {
      requestId: paypalRequestId('capture', o.authorizationId!, 'keep-for-less', offer.id),
      amount: { cents: o.amountCents - part, currency: o.currency },
      finalCapture: true,
      invoiceId: o.id,
      noteToPayer: note,
    });
    await db().update(tables.orders).set({ captureId: cap.id, status: 'resolved_partial_refund', updatedAt: now }).where(eq(tables.orders.id, o.id));
    const [rsv] = await db().select().from(tables.reservations).where(eq(tables.reservations.key, o.paypalRequestId)).limit(1);
    if (rsv && rsv.status === 'reserved') await dbReservations.commit(rsv.id, new Date(now));
    return { via: 'capture', paypalId: cap.id, status: cap.status ?? null };
  }
  if (!o.captureId) throw new Error('nothing to refund');
  const refund = await pp.refundCapture(o.captureId, {
    requestId: paypalRequestId('refund', o.captureId, 'keep-for-less', offer.id),
    amount: { cents: part, currency: o.currency },
    noteToPayer: note,
    invoiceId: `${o.id}-part`.slice(0, 127),
  });
  await db().update(tables.orders).set({ status: 'resolved_partial_refund', updatedAt: now }).where(eq(tables.orders.id, o.id));
  return { via: 'refund', paypalId: refund.id, status: refund.status ?? null };
}

/**
 * Accept or decline the offer the buyer just heard. The offer must still be the open one (same
 * case and offer id), so an answer can never land on a newer offer the buyer has not heard. A
 * decline lets the store's agent make one revised offer; it runs after the reply is sent.
 */
export async function answerOffer(
  userId: string,
  caseId: string,
  offerId: string,
  answer: OfferAnswer,
  deps: { payments?: Payments } = {},
): Promise<OfferAnswerResult> {
  // Under the case lock: the store's reply and the buyer's answer never cross.
  const result = await withCaseLock(caseId, () => answerLocked(userId, caseId, offerId, answer, deps));
  if (result.ok && answer === 'decline') scheduleStoreAgent(caseId, { kind: 'offer_declined', offerId });
  return result;
}

async function answerLocked(userId: string, caseId: string, offerId: string, answer: OfferAnswer, deps: { payments?: Payments }): Promise<OfferAnswerResult> {
  const open = await findOpenOffer(userId);
  if (!open || open.caseId !== caseId || open.offer.id !== offerId) return { ok: false, reason: 'gone' };
  const now = new Date().toISOString();
  const plan = planOfferAnswer(open.offer, answer, now);

  if (plan.paypal) {
    // Offers made on a PayPal dispute are answered with the buyer's own PayPal identity.
    const buyerEmail = ENV.PAYPAL_SANDBOX_BUYER_EMAIL;
    if (!INTEGRATIONS.paypal || !open.disputeId || !buyerEmail) return { ok: false, reason: 'paypal-unavailable' };
    try {
      const buyer = paypal().buyer({ email: buyerEmail });
      if (plan.paypal === 'accept-offer')
        await buyer.acceptOffer(open.disputeId, { requestId: paypalRequestId('dispute', open.disputeId, 'accept-offer', offerId) });
      else
        await buyer.denyOffer(open.disputeId, {
          note: 'The buyer declined this offer.',
          requestId: paypalRequestId('dispute', open.disputeId, 'deny-offer', offerId),
        });
    } catch (e) {
      console.error('[offers] PayPal did not take the answer', e);
      return { ok: false, reason: 'paypal-failed' };
    }
  }

  let settled: Awaited<ReturnType<typeof settleKeepForLess>> | null = null;
  if (plan.settle === 'partial_refund') {
    const [o] = await db().select().from(tables.orders).where(eq(tables.orders.id, open.orderId)).limit(1);
    if (!o) return { ok: false, reason: 'gone' };
    // Claim the offer before money moves; a failure puts it back so the buyer can try again.
    const claimed = await db()
      .update(tables.cases)
      .set({ stage: 'accepted', updatedAt: now })
      .where(and(eq(tables.cases.id, caseId), eq(tables.cases.stage, 'offer_received')))
      .returning({ id: tables.cases.id });
    if (!claimed.length) return { ok: false, reason: 'gone' };
    try {
      settled = await settleKeepForLess(o, open.offer, deps.payments ?? paypal().payments, now);
    } catch (e) {
      await db().update(tables.cases).set({ stage: 'offer_received' }).where(and(eq(tables.cases.id, caseId), eq(tables.cases.stage, 'accepted')));
      if (e instanceof PayPalNotConfiguredError) return { ok: false, reason: 'not-connected' };
      console.error('[offers] PayPal did not settle the part refund', e);
      return { ok: false, reason: 'paypal-failed' };
    }
  }

  const outcome = plan.outcome
    ? { ...plan.outcome, ...(settled ? { amountCents: open.amountCents, via: settled.via === 'capture' ? 'capture' : 'refund', paypalId: settled.paypalId } : {}) }
    : null;
  const updated = await db()
    .update(tables.cases)
    .set({ stage: plan.stage, status: plan.status, ...(outcome ? { outcome } : {}), updatedAt: now })
    .where(and(eq(tables.cases.id, caseId), eq(tables.cases.stage, settled ? 'accepted' : 'offer_received')))
    .returning({ id: tables.cases.id });
  if (updated.length === 0) return { ok: false, reason: 'gone' };
  if (plan.orderStatus && !settled) await db().update(tables.orders).set({ status: plan.orderStatus, updatedAt: now }).where(eq(tables.orders.id, open.orderId));
  await audit({
    userId,
    actor: 'user',
    action: answer === 'accept' ? 'case.offer_accepted' : 'case.offer_declined',
    subjectId: open.orderId,
    payload: { caseId, offerId, type: open.offer.type, via: open.offer.via, ...(open.offer.partial ? { partial: open.offer.partial } : {}), by: open.offer.by ?? 'staff' },
  });
  if (settled)
    await audit({
      userId,
      actor: 'paypal',
      action: 'case.partial_refunded',
      subjectId: open.orderId,
      payload: {
        caseId,
        offerId,
        via: settled.via,
        paypalId: settled.paypalId,
        paypalStatus: settled.status,
        amountCents: open.amountCents,
        keptCents: open.paidCents - open.amountCents,
        held: settled.via === 'capture',
      },
    });
  await markOfferNoticesRead(userId, open.orderId);
  // Whatever the store's agent proposed before this answer is out of date now.
  await db()
    .update(tables.storeAgentProposals)
    .set({ status: 'superseded', result: 'The buyer answered an offer since.', decidedAt: now })
    .where(and(eq(tables.storeAgentProposals.caseId, caseId), eq(tables.storeAgentProposals.status, 'proposed')));
  return { ok: true, plan, offer: open };
}
