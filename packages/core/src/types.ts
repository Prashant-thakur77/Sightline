import type { Money } from './money';

/** Return policy as the listing states it. Unknown fields stay undefined, never guessed. */
export interface ReturnPolicy {
  windowDays?: number;
  free?: boolean;
  /** Exact text from the listing, when we have it. */
  text?: string;
}

export interface ProductImage {
  url: string;
  alt?: string;
  variantId?: string;
}

/** Attributes the unboxing check can verify. Missing means "the listing doesn't say". */
export interface ProductAttributes {
  colour?: string;
  size?: string;
  material?: string;
  fit?: string;
  neckline?: string;
  pattern?: string;
  care?: string;
  [key: string]: string | undefined;
}

export interface Seller {
  name: string;
  /** PayPal merchant (payer) id that receives the money. */
  merchantId: string;
}

/**
 * A frozen copy of a listing at a moment in time. Everything the readback says and everything
 * the unboxing check compares against comes from a snapshot, never from live model text.
 */
export interface ProductSnapshot {
  id: string;
  productId: string;
  variantId: string;
  source: 'channel3' | 'demo-store' | 'caller';
  title: string;
  brand?: string;
  category?: string;
  description?: string;
  /** The listing's own feature lines ("Waterproof membrane", "Machine washable"), when it gives them. */
  keyFeatures?: string[];
  attributes: ProductAttributes;
  price: Money;
  images: ProductImage[];
  returnPolicy: ReturnPolicy | null;
  seller: Seller;
  retailerUrl?: string;
  rating?: { average: number; count: number };
  /** Review lines quoted verbatim from the listing; spoken only as quotes. */
  reviews?: { quote: string; rating?: number }[];
  capturedAt: string;
  /** Domain-separated SHA-256 of the canonical snapshot body. */
  hash: string;
}

export interface CartLine {
  snapshot: ProductSnapshot;
  quantity: number;
}

export interface Totals {
  items: Money;
  shipping: Money;
  tax: Money;
  total: Money;
}

export interface Cart {
  id: string;
  userId: string;
  lines: CartLine[];
  totals: Totals;
  /** Hash of lines + totals; any change invalidates the readback. */
  hash: string;
  createdAt: string;
}

export type PaymentSourceKind = 'vault' | 'paypal-popup';

export interface PaymentSourceDescription {
  kind: PaymentSourceKind;
  /** What the user hears, e.g. "your saved PayPal". */
  label: string;
}

export type Verbosity = 'brief' | 'standard' | 'detailed';

export interface ReadbackField {
  key: string;
  label: string;
  value: string;
}

export interface Readback {
  id: string;
  cartId: string;
  cartHash: string;
  text: string;
  fields: ReadbackField[];
  textHash: string;
  createdAt: string;
}

export type Confidence = 'sure' | 'fairly_sure' | 'not_sure';
export type VerdictKind = 'match' | 'mismatch' | 'unsure';
export type CheckModule = 'colour' | 'size' | 'identity' | 'damage' | 'quality';

export interface VerdictReason {
  module: CheckModule;
  finding: 'agree' | 'disagree' | 'unknown';
  confidence: Confidence;
  expected?: string;
  observed?: string;
  /** Plain-language sentence spoken to the user. */
  sentence: string;
}

export interface Verdict {
  kind: VerdictKind;
  reasons: VerdictReason[];
  /** The sentence spoken first. */
  headline: string;
  /** Spoken guidance when unsure, e.g. try daylight or ask a helper. */
  nextSteps: string[];
}

export interface Preferences {
  verbosity: Verbosity;
  voiceMode: 'screen-reader' | 'own-voice' | 'both';
  speechRate: number;
  sizes: { tops?: string; bottoms?: string; shoes?: string; rings?: string };
  avoidColours: string[];
  perOrderCap: Money;
  dailyCap: Money;
  lowVision: { enabled: boolean; textScale: number; highContrast: boolean };
  payAfterCheck: boolean;
}

export type OrderStatus =
  | 'readback_pending'
  | 'confirmed'
  | 'approval_pending'
  | 'authorized'
  | 'captured'
  | 'voided'
  | 'shipped'
  | 'delivered'
  | 'verified_match'
  | 'verified_mismatch'
  | 'verified_unsure'
  | 'case_open'
  | 'resolved_refund'
  /** The buyer kept the item for less, as agreed with the store: part refunded, or part of the hold captured. */
  | 'resolved_partial_refund'
  | 'resolved_replacement'
  | 'resolved_seller_favour'
  | 'closed'
  | 'failed';

export type CaseStage =
  | 'draft'
  | 'evidence_built'
  | 'seller_contacted'
  | 'offer_received'
  | 'accepted'
  | 'declined'
  | 'escalated'
  | 'under_review'
  | 'resolved';

export type ShippedVariant = 'correct' | 'wrong_colour' | 'wrong_size' | 'damaged' | 'nothing';
