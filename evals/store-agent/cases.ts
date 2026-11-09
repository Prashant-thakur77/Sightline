import type { Verdict, VerdictReason } from '@sightline/core';
import { DEFAULT_STORE_POLICY, type CaseFacts, type StoreOptionId, type StorePolicy } from '@sightline/agent';
import { usd } from '../lib/commerce';

/*
 * Store-agent fixtures: a money-back case as the store's agent reads it, the store's policy, and
 * which replies a fair store would choose (labelled by hand before any model ran on them; written by
 * the author of the code, so not independent). "sensible" lists every reply judged fair; the agent
 * passes a case when its pick is one of them.
 */

export interface StoreCaseFixture {
  id: string;
  note: string;
  facts: CaseFacts;
  policy: StorePolicy;
  sensible: StoreOptionId[];
}

const r = (module: VerdictReason['module'], finding: VerdictReason['finding'], confidence: VerdictReason['confidence'], expected?: string, observed?: string): VerdictReason => ({
  module,
  finding,
  confidence,
  expected,
  observed,
  sentence: '',
});
const verdict = (kind: Verdict['kind'], ...reasons: VerdictReason[]): Verdict => ({ kind, headline: '', reasons, nextSteps: [] });

const SIZE_SURE = r('size', 'disagree', 'sure', 'M', 'L');
const SIZE_FAIR = r('size', 'disagree', 'fairly_sure', 'M', 'L');
const COLOUR_OK = r('colour', 'agree', 'fairly_sure', 'navy', 'navy');
const COLOUR_SURE = r('colour', 'disagree', 'sure', 'navy', 'black');
const COLOUR_SHADE = r('colour', 'disagree', 'fairly_sure', 'navy', 'blue');
const SIZE_OK = r('size', 'agree', 'sure', 'M', 'M');
const DAMAGE_SURE = r('damage', 'disagree', 'sure', undefined, 'a torn seam');
const DAMAGE_MAYBE = r('damage', 'disagree', 'fairly_sure', undefined, 'a small mark on the cuff');
const IDENTITY_SURE = r('identity', 'disagree', 'sure');

function facts(over: Partial<CaseFacts>): CaseFacts {
  return {
    merchant: 'Demo Store',
    item: 'Harbor knit crew-neck sweater',
    colour: 'navy',
    size: 'M',
    amount: usd(3672),
    payment: 'held',
    dispute: false,
    reason: 'wrong_size',
    verdict: verdict('mismatch', SIZE_SURE, COLOUR_OK),
    shippedVariant: 'wrong_size',
    evidenceVerified: true,
    photos: 2,
    dueAt: '2026-11-12T12:00:00.000Z',
    declined: [],
    round: 1,
    ...over,
  };
}
const policy = (over: Partial<StorePolicy> = {}): StorePolicy => ({ ...DEFAULT_STORE_POLICY, ...over });

export const FIXTURES: StoreCaseFixture[] = [
  { id: 'wrong-size-own-record-held', note: "The store's record shows it sent the wrong size; check is sure.", facts: facts({}), policy: policy(), sensible: ['replacement', 'refund'] },
  {
    id: 'wrong-colour-own-record-captured',
    note: 'Wrong colour shipped by the store, payment already captured.',
    facts: facts({ payment: 'captured', reason: 'wrong_colour', shippedVariant: 'wrong_colour', verdict: verdict('mismatch', COLOUR_SURE, SIZE_OK) }),
    policy: policy(),
    sensible: ['replacement', 'refund'],
  },
  {
    id: 'unsure-shade-store-says-right',
    note: 'The check is not sure about a shade; the store says it sent the right item.',
    facts: facts({ reason: 'wrong_colour', shippedVariant: 'correct', verdict: verdict('unsure', COLOUR_SHADE, SIZE_OK) }),
    policy: policy(),
    sensible: ['return', 'partial_20', 'replacement'],
  },
  {
    id: 'sure-size-store-says-right',
    note: 'The check is sure of a wrong size, but the store says it sent the right one.',
    facts: facts({ shippedVariant: 'correct' }),
    policy: policy(),
    sensible: ['return', 'replacement', 'refund'],
  },
  {
    id: 'never-shipped',
    note: 'Nothing was shipped; the parcel never came.',
    facts: facts({ reason: 'not_received', shippedVariant: 'nothing', verdict: null }),
    policy: policy(),
    sensible: ['refund', 'replacement'],
  },
  {
    id: 'damaged-sure',
    note: 'The store shipped a damaged item and the check is sure of the damage.',
    facts: facts({ reason: 'damaged', shippedVariant: 'damaged', verdict: verdict('mismatch', DAMAGE_SURE, SIZE_OK, COLOUR_OK) }),
    policy: policy(),
    sensible: ['refund', 'replacement'],
  },
  {
    id: 'minor-mark-unsure',
    note: 'A possible small mark; the store says it sent the right item.',
    facts: facts({ reason: 'damaged', shippedVariant: 'correct', verdict: verdict('unsure', DAMAGE_MAYBE, SIZE_OK, COLOUR_OK) }),
    policy: policy(),
    sensible: ['partial_20', 'return', 'replacement'],
  },
  {
    id: 'no-payment',
    note: 'No PayPal payment was taken: only a replacement is possible.',
    facts: facts({ payment: 'none' }),
    policy: policy(),
    sensible: ['replacement'],
  },
  {
    id: 'dispute-captured',
    note: 'A PayPal dispute on a captured payment, wrong size shipped.',
    facts: facts({ payment: 'captured', dispute: true }),
    policy: policy(),
    sensible: ['refund', 'replacement'],
  },
  {
    id: 'declined-replacement',
    note: 'The buyer declined a replacement; the store shipped the wrong size.',
    facts: facts({ round: 2, declined: [{ resolution: 'replacement' }] }),
    policy: policy(),
    sensible: ['refund'],
  },
  {
    id: 'declined-return-unsure',
    note: 'The buyer declined sending it back; the check is not sure of a shade.',
    facts: facts({ round: 2, reason: 'wrong_colour', shippedVariant: 'correct', verdict: verdict('unsure', COLOUR_SHADE, SIZE_OK), declined: [{ resolution: 'return' }] }),
    policy: policy(),
    sensible: ['partial_20', 'refund', 'replacement'],
  },
  {
    id: 'over-staff-limit',
    note: 'A $180 order: every reply waits for staff, but the agent still proposes.',
    facts: facts({ amount: usd(18000) }),
    policy: policy(),
    sensible: ['replacement', 'refund'],
  },
  {
    id: 'auto-send-off',
    note: 'The store sends nothing without staff.',
    facts: facts({}),
    policy: policy({ autoSend: false }),
    sensible: ['replacement', 'refund'],
  },
  {
    id: 'no-part-refunds',
    note: 'Unsure shade, store says right item, and the policy allows no part refunds.',
    facts: facts({ reason: 'wrong_colour', shippedVariant: 'correct', verdict: verdict('unsure', COLOUR_SHADE, SIZE_OK) }),
    policy: policy({ partialRefunds: 'none' }),
    sensible: ['return', 'replacement'],
  },
  {
    id: 'half-back-allowed',
    note: 'A possible mark, and the policy allows up to half back.',
    facts: facts({ reason: 'damaged', shippedVariant: 'correct', verdict: verdict('unsure', DAMAGE_MAYBE, SIZE_OK, COLOUR_OK) }),
    policy: policy({ partialRefunds: 'up_to_50' }),
    sensible: ['partial_20', 'partial_50', 'return', 'replacement'],
  },
  {
    id: 'different-product-sure',
    note: 'A different product arrived; the store says it sent the right item.',
    facts: facts({ reason: 'wrong_item', shippedVariant: 'correct', verdict: verdict('mismatch', IDENTITY_SURE) }),
    policy: policy(),
    sensible: ['return', 'refund', 'replacement'],
  },
  {
    id: 'not-checked',
    note: 'The buyer could not check the parcel; the store says it sent the right item.',
    facts: facts({ reason: 'unclear', shippedVariant: 'correct', verdict: null }),
    policy: policy(),
    sensible: ['return', 'replacement'],
  },
  {
    id: 'two-declined',
    note: 'The buyer declined a replacement and a part refund: only the money back is left that a buyer wants.',
    facts: facts({ round: 2, declined: [{ resolution: 'replacement' }, { resolution: 'partial_refund', percent: 20 }] }),
    policy: policy(),
    sensible: ['refund'],
  },
  {
    id: 'cheap-wrong-colour',
    note: 'A $12 order with the wrong colour shipped, payment captured.',
    facts: facts({ amount: usd(1200), payment: 'captured', reason: 'wrong_colour', shippedVariant: 'wrong_colour', verdict: verdict('mismatch', COLOUR_SURE) }),
    policy: policy(),
    sensible: ['replacement', 'refund'],
  },
  {
    id: 'fairly-sure-size-own-record',
    note: "The check is only fairly sure, but the store's own record shows the wrong size.",
    facts: facts({ verdict: verdict('unsure', SIZE_FAIR, COLOUR_OK) }),
    policy: policy(),
    sensible: ['replacement', 'refund'],
  },
];
