import type { Cart, Money, OrderStatus, PaymentSourceKind, Readback } from '@sightline/core';
import type { SignedReceipt } from '@sightline/evidence';

export type Awaitable<T> = T | Promise<T>;

/** Both keys of a spoken confirmation, as recorded by the voice layer. */
export interface ConfirmationEvidence {
  /** Key 1: a deterministic match of an allowed confirmation phrase, or the Confirm button. */
  phraseMatched: boolean;
  /** Key 2: the utterance classifier agreed it was a confirmation. */
  classifierAgreed: boolean;
  utterance: string;
  /** When the utterance was heard, ISO 8601. */
  at: string;
}

export type ConfirmedReadback = Readback & {
  /** When the server recorded the confirmation, ISO 8601. */
  confirmedAt?: string;
  confirmation?: ConfirmationEvidence;
  /** The user said "wait" or "hold on": the confirmation window has no time limit. */
  holdOpen?: boolean;
};

/**
 * Everything the gate decides on. Built server-side from database rows; the only fields that a
 * model could ever influence (amount, payee) are exactly the ones the guards recompute.
 */
export interface PaymentIntent {
  userId: string;
  cart: Cart;
  readback: ConfirmedReadback | null;
  payee: { merchantId: string };
  amount: Money;
  paymentSource: PaymentSourceKind;
  intent: 'CAPTURE' | 'AUTHORIZE';
  now: Date;
  /**
   * The buyer's own utterances in this conversation, oldest first, as recorded by the server
   * (typed or spoken by the buyer; never model text). IntentGuard parses them with the grammar to
   * learn the colour, size and material asked for. Missing means nothing to compare.
   */
  buyerUtterances?: Array<{ text: string; at?: string }>;
}

export interface SpendLimits {
  perOrderCap: Money;
  dailyCap: Money;
  maxOrdersPerHour: number;
}

export interface RecentOrder {
  id: string;
  cartHash: string;
  createdAt: string;
  status?: OrderStatus;
}

export type ReservationStatus = 'reserved' | 'committed' | 'released';

/** A hold on budget between the gate passing and the money moving (or not). */
export interface Reservation {
  id: string;
  /** The PayPal-Request-Id of the order this reservation is for. */
  key: string;
  userId: string;
  cartHash: string;
  amount: Money;
  status: ReservationStatus;
  createdAt: string;
  expiresAt: string;
  committedAt?: string;
  releasedAt?: string;
  releaseReason?: string;
}

export interface ReservationRequest {
  key: string;
  userId: string;
  cartHash: string;
  amount: Money;
  now: Date;
  expiresAt: Date;
  limits: SpendLimits;
  duplicateWindowMs: number;
}

export type ReservationRefusalCode = 'OVER_ORDER_LIMIT' | 'OVER_DAILY_LIMIT' | 'DUPLICATE_ORDER' | 'RATE_LIMITED' | 'CURRENCY_MISMATCH';

export type ReservationOutcome =
  | { ok: true; reservation: Reservation }
  | { ok: false; code: ReservationRefusalCode; details: Record<string, unknown> };

/**
 * Budget holds. Reserve when the gate passes, commit when the capture lands, release on
 * failure or void. `reserve` must re-check the limits and take the hold in one atomic step
 * (an in-process critical section, `SELECT ... FOR UPDATE`, or a serialisable transaction),
 * which is what stops two concurrent confirmations from both fitting under the same cap.
 */
export interface ReservationPort {
  reserve(req: ReservationRequest): Awaitable<ReservationOutcome>;
  /** Move a hold into spend. Afterwards it counts in `spentToday`, not in `active`. */
  commit(id: string, at: Date): Awaitable<Reservation>;
  release(id: string, reason: string, at: Date): Awaitable<Reservation>;
  /** Holds for this user that are still reserved and not expired at `now`. */
  active(userId: string, now: Date): Awaitable<Reservation[]>;
}

/** Everything the gate reads from the outside world. DB-agnostic. */
export interface GatePorts {
  /** Orders already placed for this cart hash at or after `sinceMs` (epoch milliseconds). */
  recentOrdersForCart(cartHash: string, sinceMs: number): Awaitable<RecentOrder[]>;
  /** Money committed in the last 24 hours. Active reservations are counted separately. */
  spentToday(userId: string, now: Date): Awaitable<Money>;
  /** Orders placed in the last hour. Active reservations are counted separately. */
  ordersInLastHour(userId: string, now: Date): Awaitable<number>;
  /** PayPal merchant ids this deployment may pay. */
  payeeAllowlist(): Awaitable<string[]>;
  limits(userId: string): Awaitable<SpendLimits>;
  reservations?: ReservationPort;
  /** Shipping and tax recomputed server-side. When absent, the cart's own figures are used. */
  quoteExtras?(cart: Cart): Awaitable<{ shipping: Money; tax: Money }>;
  /**
   * Re-read a listing whose snapshot is too old. Returning null means the listing is gone.
   * When absent, an old snapshot is simply refused.
   */
  refreshSnapshot?(snapshot: Cart['lines'][number]['snapshot']): Awaitable<Cart['lines'][number]['snapshot'] | null>;
  /** Persist the receipt. Called for every decision, allowed or not. */
  recordReceipt?(receipt: SignedReceipt<GateReceiptBody>): Awaitable<void>;
}

export type GateCode =
  | 'OK'
  | 'ENV_NOT_SANDBOX'
  | 'INVALID_CLOCK'
  | 'UNSUPPORTED_MODE'
  | 'READBACK_MISSING'
  | 'READBACK_TAMPERED'
  | 'CART_TAMPERED'
  | 'READBACK_CART_MISMATCH'
  | 'INTENT_MISMATCH'
  | 'USER_MISMATCH'
  | 'NOT_CONFIRMED'
  | 'SINGLE_KEY_CONFIRMATION'
  | 'CONFIRMATION_OUT_OF_ORDER'
  | 'CONFIRMATION_EXPIRED'
  | 'CART_EMPTY'
  | 'INVALID_QUANTITY'
  | 'CURRENCY_MISMATCH'
  | 'AMOUNT_INVALID'
  | 'TOTALS_MISMATCH'
  | 'AMOUNT_MISMATCH'
  | 'PAYEE_NOT_ALLOWED'
  | 'PAYEE_MISMATCH'
  | 'MULTIPLE_SELLERS'
  | 'LIMITS_UNAVAILABLE'
  | 'OVER_ORDER_LIMIT'
  | 'OVER_DAILY_LIMIT'
  | 'DUPLICATE_ORDER'
  | 'RATE_LIMITED'
  | 'SNAPSHOT_STALE'
  | 'SNAPSHOT_TIME_INVALID'
  | 'PRICE_CHANGED'
  | 'LISTING_CHANGED'
  | 'LISTING_UNAVAILABLE'
  | 'RECEIPT_WRITE_FAILED'
  | 'GUARD_ERROR';

export interface GuardResult {
  /** Name of the guard (or gate step) that produced this result. */
  guard: string;
  ok: boolean;
  code: GateCode;
  message: string;
  /** JSON-safe facts behind the decision. Goes into the receipt, so never secrets. */
  details: Record<string, unknown>;
}

export interface GateOptions {
  /** The PayPal environment this process will call. Only the sandbox passes. */
  env: { PAYPAL_ENV?: string; PAYPAL_API_BASE?: string };
  /** HMAC key for receipts (RECEIPT_SIGNING_KEY), at least 32 bytes. */
  signingKey: string | Uint8Array;
  /** How long after the readback a confirmation is accepted, unless held open. Default 5 minutes. */
  confirmWindowMs?: number;
  /** Duplicate look-back. Default 10 minutes; can be lengthened, not shortened. */
  duplicateWindowMs?: number;
  /** Maximum snapshot age. Default 15 minutes; can be shortened, not lengthened. */
  snapshotMaxAgeMs?: number;
  /** Reservation lifetime. Default 30 minutes for CAPTURE, 29 days for AUTHORIZE. */
  reservationTtlMs?: number;
}

export interface ResolvedGateOptions {
  env: { PAYPAL_ENV?: string; PAYPAL_API_BASE?: string };
  confirmWindowMs: number;
  duplicateWindowMs: number;
  snapshotMaxAgeMs: number;
  reservationTtlMs: number;
}

export interface GuardContext {
  intent: PaymentIntent;
  ports: GatePorts;
  opts: ResolvedGateOptions;
}

export interface Guard {
  readonly name: string;
  run(ctx: GuardContext): Promise<GuardResult>;
}

export const GATE_RECEIPT_SCHEMA = 'sightline.gate-receipt/v1' as const;

/** What the gate signs: a canonical summary of its inputs and every outcome. No secrets. */
export interface GateReceiptBody {
  schema: typeof GATE_RECEIPT_SCHEMA;
  decidedAt: string;
  requestId: string;
  allowed: boolean;
  firstFailure: GateCode | null;
  env: { paypalEnv: string | null; apiBase: string | null };
  input: {
    userId: string;
    cartId: string;
    cartHash: string;
    readbackId: string | null;
    readbackCartHash: string | null;
    readbackTextHash: string | null;
    readbackBindingHash: string | null;
    confirmation: {
      phraseMatched: boolean;
      classifierAgreed: boolean;
      utterance: string;
      at: string;
      confirmedAt: string | null;
      holdOpen: boolean;
    } | null;
    payee: string;
    amount: unknown;
    paymentSource: string;
    intent: string;
    lines: Array<{ snapshotId: string; snapshotHash: string; merchantId: string; unitPrice: unknown; quantity: unknown; capturedAt: string }>;
    totals: unknown;
  };
  results: GuardResult[];
  reservation: { id: string; expiresAt: string } | null;
}

export interface GateDecision {
  allowed: boolean;
  results: GuardResult[];
  firstFailure?: GuardResult;
  /** What to say when the gate refused. */
  refusal?: string;
  receipt: SignedReceipt<GateReceiptBody>;
  /** PayPal-Request-Id for the order: paypalRequestId('order', cart.hash, readback.id). */
  requestId: string;
  /** The budget hold taken when the gate passed. Commit on capture, release on failure or void. */
  reservation?: Reservation;
}
