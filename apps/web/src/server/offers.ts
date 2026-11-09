import 'server-only';
import { and, desc, eq, isNull, like, or } from 'drizzle-orm';
import { tables } from '@sightline/db';
import { paypalRequestId } from '@sightline/evidence';
import { db, ENV, INTEGRATIONS } from './runtime';
import { paypal } from './paypal';
import { audit } from './audit';
import type { CaseOffer } from './merchant';
import { planOfferAnswer, type OfferAnswer, type OfferPlan } from './offer-plan';

/**
 * The buyer's side of a store's offer on a case: find the offer waiting for an answer, and answer
 * it. The conversation reads the offer and what accepting means first; only a spoken "accept" or
 * "decline" after that, or the offer card's buttons (Accept takes two presses), reach answerOffer.
 */

export interface OpenOffer {
  caseId: string;
  orderId: string;
  /** The order's item title. */
  title: string;
  /** The offered amount in integer cents, or the order amount when the offer names none. */
  amountCents: number;
  currency: string;
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
    currency: o.currency,
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
  | { ok: false; reason: 'gone' | 'paypal-unavailable' | 'paypal-failed' };

/**
 * Accept or decline the offer the buyer just heard. The offer must still be the open one (same
 * case and offer id), so an answer can never land on a newer offer the buyer has not heard.
 */
export async function answerOffer(userId: string, caseId: string, offerId: string, answer: OfferAnswer): Promise<OfferAnswerResult> {
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

  const updated = await db()
    .update(tables.cases)
    .set({ stage: plan.stage, status: plan.status, ...(plan.outcome ? { outcome: plan.outcome } : {}), updatedAt: now })
    .where(and(eq(tables.cases.id, caseId), eq(tables.cases.stage, 'offer_received')))
    .returning({ id: tables.cases.id });
  if (updated.length === 0) return { ok: false, reason: 'gone' };
  if (plan.orderStatus) await db().update(tables.orders).set({ status: plan.orderStatus, updatedAt: now }).where(eq(tables.orders.id, open.orderId));
  await audit({
    userId,
    actor: 'user',
    action: answer === 'accept' ? 'case.offer_accepted' : 'case.offer_declined',
    subjectId: open.orderId,
    payload: { caseId, offerId, type: open.offer.type, via: open.offer.via },
  });
  await markOfferNoticesRead(userId, open.orderId);
  return { ok: true, plan, offer: open };
}
