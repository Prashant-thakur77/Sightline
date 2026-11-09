import { describe, expect, it } from 'vitest';
import { offerKind, planOfferAnswer } from '../src/server/offer-plan';

const AT = '2026-11-09T12:00:00.000Z';

describe('planOfferAnswer', () => {
  it('a replacement agreed on the store desk settles the case and the order', () => {
    expect(planOfferAnswer({ id: 'ofr_1', type: 'REPLACEMENT_WITHOUT_REFUND', via: 'local' }, 'accept', AT)).toEqual({
      kind: 'replacement',
      stage: 'resolved',
      status: 'resolved',
      orderStatus: 'resolved_replacement',
      outcome: { kind: 'replacement', by: 'buyer', offerId: 'ofr_1', at: AT },
    });
  });

  it('a refund after return stays open until the store refunds; no money moves here', () => {
    expect(planOfferAnswer({ id: 'ofr_2', type: 'REFUND_WITH_RETURN', via: 'local' }, 'accept', AT)).toEqual({
      kind: 'refund_with_return',
      stage: 'accepted',
      status: 'open',
    });
  });

  it('offers on a PayPal dispute are answered through PayPal first', () => {
    expect(planOfferAnswer({ id: 'ofr_3', type: 'REFUND', via: 'paypal' }, 'accept', AT)).toEqual({
      kind: 'refund',
      stage: 'accepted',
      status: 'open',
      paypal: 'accept-offer',
    });
    expect(planOfferAnswer({ id: 'ofr_3', type: 'REFUND', via: 'paypal' }, 'decline', AT).paypal).toBe('deny-offer');
  });

  it('keeping the item for less, offered on the store desk, settles on acceptance through PayPal', () => {
    expect(planOfferAnswer({ id: 'ofr_5', type: 'REFUND', via: 'local', partial: { percent: 20 } }, 'accept', AT)).toEqual({
      kind: 'partial_refund',
      stage: 'resolved',
      status: 'resolved',
      orderStatus: 'resolved_partial_refund',
      outcome: { kind: 'partial_refund', by: 'buyer', offerId: 'ofr_5', at: AT },
      settle: 'partial_refund',
    });
    expect(planOfferAnswer({ id: 'ofr_5', type: 'REFUND', via: 'local', partial: { percent: 20 } }, 'decline', AT)).toEqual({ kind: 'partial_refund', stage: 'declined', status: 'open' });
    expect(offerKind('REFUND', { percent: 50 })).toBe('partial_refund');
  });

  it('declining keeps the case open so the store can try again', () => {
    expect(planOfferAnswer({ id: 'ofr_4', type: 'REPLACEMENT_WITHOUT_REFUND', via: 'local' }, 'decline', AT)).toEqual({
      kind: 'replacement',
      stage: 'declined',
      status: 'open',
    });
  });

  it('maps PayPal offer types to spoken kinds', () => {
    expect(['REFUND', 'REFUND_WITH_RETURN', 'REFUND_WITH_REPLACEMENT', 'REPLACEMENT_WITHOUT_REFUND'].map(offerKind)).toEqual([
      'refund',
      'refund_with_return',
      'refund_with_replacement',
      'replacement',
    ]);
  });
});
