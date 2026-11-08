import type { OfferKind } from '@sightline/agent';

/**
 * How the buyer's answer to a store's offer changes the case. Pure, so it is tested without a
 * database or PayPal. Money never moves here: a refund is made by PayPal (for an offer made on a
 * PayPal dispute) or by Demo Store from its desk once the item is back.
 */

export interface OfferLike {
  id: string;
  /** PayPal's offer type: REFUND, REFUND_WITH_RETURN, REFUND_WITH_REPLACEMENT, REPLACEMENT_WITHOUT_REFUND. */
  type: string;
  via: 'paypal' | 'local';
}

export type OfferAnswer = 'accept' | 'decline';

export interface OfferPlan {
  kind: OfferKind;
  stage: 'accepted' | 'declined' | 'resolved';
  status: 'open' | 'resolved';
  orderStatus?: 'resolved_replacement';
  outcome?: { kind: 'replacement'; by: 'buyer'; offerId: string; at: string };
  /** The buyer-side PayPal dispute call to make first, for offers made on a PayPal dispute. */
  paypal?: 'accept-offer' | 'deny-offer';
}

export function offerKind(type: string): OfferKind {
  switch (type) {
    case 'REFUND':
      return 'refund';
    case 'REFUND_WITH_RETURN':
      return 'refund_with_return';
    case 'REFUND_WITH_REPLACEMENT':
      return 'refund_with_replacement';
    default:
      return 'replacement';
  }
}

export function planOfferAnswer(offer: OfferLike, answer: OfferAnswer, at: string): OfferPlan {
  const kind = offerKind(offer.type);
  const paypal: OfferPlan['paypal'] = offer.via === 'paypal' ? (answer === 'accept' ? 'accept-offer' : 'deny-offer') : undefined;
  const withPaypal = paypal ? { paypal } : {};
  // Declining keeps the case open, so the store can make another offer or refund.
  if (answer === 'decline') return { kind, stage: 'declined', status: 'open', ...withPaypal };
  // A replacement agreed on the store's own desk settles the case at once.
  if (kind === 'replacement' && offer.via === 'local')
    return {
      kind,
      stage: 'resolved',
      status: 'resolved',
      orderStatus: 'resolved_replacement',
      outcome: { kind: 'replacement', by: 'buyer', offerId: offer.id, at },
    };
  // Anything with a refund stays open until the money has actually moved; PayPal's webhook or the
  // store's refund closes it then.
  return { kind, stage: 'accepted', status: 'open', ...withPaypal };
}
