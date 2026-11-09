import type { CheckModule, Confidence, VerdictKind, VerdictReason } from './types';

/**
 * One vocabulary for every status shown or spoken anywhere: buyer pages, the merchant console,
 * the cases desk and evidence packs. Each status has a word, a glyph and a tone, so meaning never
 * depends on colour, and the same fact is never described two ways.
 */
export type Tone = 'good' | 'bad' | 'unsure' | 'waiting' | 'neutral';
export type Glyph = '✓' | '✕' | '?' | '…' | '–' | '!';

export interface StatusWord {
  word: string;
  glyph: Glyph;
  tone: Tone;
  /** A plain sentence for when there is room. */
  detail?: string;
}

export interface PaymentFacts {
  intent: string;
  status: string;
  paypalOrderId: string | null;
  authorizationId: string | null;
  captureId: string | null;
}

/** Where the money is, decided from PayPal's state, not from the delivery status. */
export function paymentStatus(o: PaymentFacts): StatusWord {
  if (o.status === 'failed') return { word: 'Not placed', glyph: '–', tone: 'neutral', detail: 'Nothing was charged.' };
  if (o.status === 'voided') return { word: 'Hold released', glyph: '✓', tone: 'good', detail: 'PayPal cancelled the hold. The store was never paid.' };
  if (o.status === 'resolved_refund') return { word: 'Refunded', glyph: '✓', tone: 'good', detail: 'PayPal refunded the payment.' };
  if (o.status === 'confirmed') return { word: 'Checking with PayPal', glyph: '…', tone: 'waiting', detail: 'PayPal has not answered yet. No second charge can happen meanwhile.' };
  if (!o.paypalOrderId) return { word: 'Not paid', glyph: '–', tone: 'neutral', detail: 'No PayPal order exists. Nothing was charged.' };
  if (o.status === 'approval_pending') return { word: 'Waiting for approval', glyph: '…', tone: 'waiting', detail: 'Approve in PayPal to pay. Nothing is charged until then.' };
  if (o.intent === 'AUTHORIZE' && o.authorizationId && !o.captureId)
    return { word: 'On hold', glyph: '…', tone: 'waiting', detail: 'PayPal holds the money until the parcel is checked.' };
  if (o.captureId) return { word: 'Paid', glyph: '✓', tone: 'good', detail: 'Paid to Demo Store through PayPal.' };
  return { word: 'Not paid', glyph: '–', tone: 'neutral', detail: 'Nothing was charged.' };
}

export function verdictStatus(kind: VerdictKind | null | undefined): StatusWord {
  if (kind === 'match') return { word: 'Matches the order', glyph: '✓', tone: 'good' };
  if (kind === 'mismatch') return { word: 'Does not match', glyph: '✕', tone: 'bad' };
  if (kind === 'unsure') return { word: 'Not sure', glyph: '?', tone: 'unsure' };
  return { word: 'Not checked', glyph: '–', tone: 'neutral' };
}

export const MODULE_LABEL: Record<CheckModule, string> = {
  colour: 'Colour',
  size: 'Size',
  identity: 'Same product',
  damage: 'Damage',
  quality: 'Photo quality',
};

export const FINDING: Record<VerdictReason['finding'], StatusWord> = {
  agree: { word: 'Matches', glyph: '✓', tone: 'good' },
  disagree: { word: 'Different', glyph: '✕', tone: 'bad' },
  unknown: { word: 'Could not check', glyph: '?', tone: 'unsure' },
};

export const CONFIDENCE_WORD: Record<Confidence, string> = {
  sure: 'Sure',
  fairly_sure: 'Fairly sure',
  not_sure: 'Not sure',
};

/** A reason in the third person, for sellers and evidence packs ("The size tag reads L; the order was for M."). */
export function reasonForSeller(r: VerdictReason): string {
  const conf = r.confidence === 'sure' ? '' : r.confidence === 'fairly_sure' ? ' (fairly sure)' : ' (not sure)';
  if (r.finding === 'unknown') return `${MODULE_LABEL[r.module]}: could not be checked from the photos.`;
  switch (r.module) {
    case 'size':
      return r.finding === 'disagree'
        ? `The size tag reads ${r.observed ?? 'a different size'}; the order was for ${r.expected ?? 'another size'}${conf}.`
        : `The size tag matches the order (${r.expected ?? r.observed})${conf}.`;
    case 'colour':
      return r.finding === 'disagree'
        ? `The colour looks ${r.observed ?? 'different'}; the listing says ${r.expected ?? 'another colour'}${conf}.`
        : `The colour matches the listing (${r.expected ?? r.observed})${conf}.`;
    case 'identity':
      return r.finding === 'disagree' ? `It does not look like the listed product${conf}.` : `It looks like the listed product${conf}.`;
    case 'damage':
      return r.finding === 'disagree' ? `Damage is visible${r.observed ? `: ${r.observed}` : ''}${conf}.` : `No damage is visible${conf}.`;
    default:
      return `${MODULE_LABEL[r.module]}: ${FINDING[r.finding].word.toLowerCase()}${conf}.`;
  }
}

export function caseStatus(stage: string | null | undefined): StatusWord {
  switch (stage) {
    case null:
    case undefined:
    case 'draft':
      return { word: 'No case', glyph: '–', tone: 'neutral' };
    case 'evidence_built':
      return { word: 'Evidence ready, not sent', glyph: '…', tone: 'waiting' };
    case 'seller_contacted':
      return { word: 'Waiting for the store', glyph: '…', tone: 'waiting' };
    case 'offer_received':
      return { word: 'Offer to answer', glyph: '!', tone: 'waiting' };
    case 'escalated':
    case 'under_review':
      return { word: 'With PayPal', glyph: '…', tone: 'waiting' };
    case 'resolved':
      return { word: 'Resolved', glyph: '✓', tone: 'good' };
    default:
      return { word: stage.replace(/_/g, ' '), glyph: '…', tone: 'waiting' };
  }
}

export function shipmentStatus(s: { status: string; shippedVariant?: string | null; deliveredAt?: string | null; carrier?: string | null } | null): StatusWord {
  if (!s || s.status === 'awaiting_shipment') return { word: 'Not shipped yet', glyph: '–', tone: 'neutral' };
  if (s.shippedVariant === 'nothing') return { word: 'Not shipped', glyph: '!', tone: 'bad' };
  if (s.deliveredAt) return { word: 'Delivered', glyph: '✓', tone: 'good' };
  return { word: `On its way${s.carrier ? ` with ${s.carrier}` : ''}`, glyph: '…', tone: 'waiting' };
}
