/**
 * The numbers and words behind a pay-after-check hold, with no database or PayPal attached, so the
 * hold sweep (holds.ts), the money answers and the store's schedule all read the same rules.
 */

export const DAY_MS = 86_400_000;
export const HOUR_MS = 3_600_000;

/** The buyer is reminded to check on this day after delivery. */
export const CHECK_REMINDER_DAYS = 5;
/** On this day after delivery, with no problem reported, the store is paid as usual. */
export const AUTO_CAPTURE_DAYS = 7;
/** PayPal honours an authorization for the full amount for this many days, then it is reauthorized. */
export const HONOR_PERIOD_DAYS = 3;
/** PayPal honours reauthorizations only inside this many days of the original authorization. */
export const AUTHORIZATION_DAYS = 29;
export const MAX_CAPTURE_ATTEMPTS = 5;
/** How long before a case deadline the buyer is told what happens at it. */
export const DEADLINE_NOTICE_HOURS = 24;
/** An offer's deadline on a held payment stays a day inside the authorization's life. */
export const OFFER_DEADLINE_LIMIT_DAYS = AUTHORIZATION_DAYS - 1;

/** Case stages in which a wrong-item case on a held payment is still open and its deadline applies. */
export const OPEN_STAGES: ReadonlySet<string> = new Set([
  'seller_contacted',
  'offer_received',
  'accepted',
  'declined',
]);

/** PayPal holds the money: authorized at purchase, not captured yet. Independent of delivery status. */
export function isHeld(o: {
  intent: string;
  authorizationId: string | null;
  captureId: string | null;
  status: string;
}): boolean {
  return o.intent === 'AUTHORIZE' && Boolean(o.authorizationId) && !o.captureId && o.status !== 'voided';
}

/** Audit actions that mark when PayPal completed a payment, refunded it, or released a hold. */
export const PAID_ACTIONS: readonly string[] = [
  'payment.captured',
  'payment.captured_after_check',
  'payment.captured_after_replacement',
  'payment.captured_no_check',
  'webhook.payment.capture.completed',
];
export const REFUNDED_ACTIONS: readonly string[] = [
  'case.refunded',
  'webhook.payment.capture.refunded',
  'webhook.payment.capture.reversed',
];
export const RELEASED_ACTIONS: readonly string[] = [
  'payment.voided_after_check',
  'payment.voided_no_reply',
  'case.hold_released',
  'webhook.payment.authorization.voided',
];
/** Kept for less on a held payment: PayPal took part of the hold and released the rest. */
export const PARTIAL_REFUND_ACTION = 'case.partial_refunded';
export const REAUTHORIZED_ACTION = 'payment.reauthorized';
export const REMINDER_ACTION = 'hold.reminder_sent';
/** The buyer sent the case to the store; the payload carries the store's reply-by deadline. */
export const CASE_SENT_ACTIONS: readonly string[] = ['case.return_requested', 'case.sent_to_seller'];

/** When an audit entry happened: the time hashed into the chain, else when the row was written. */
export function entryTime(e: { payload: unknown; createdAt: string }): string {
  const at = (e.payload as { _at?: unknown } | null)?._at;
  return typeof at === 'string' && !Number.isNaN(Date.parse(at)) ? at : e.createdAt;
}
