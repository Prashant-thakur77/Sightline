import { DEMO_MERCHANT_NAME as STORE, formatMoney, type StatusWord } from '@sightline/core';

/**
 * "Where is my money?": every hold, payment, release, refund, case step and deadline, newest
 * first. Built only from what is recorded: audit log entries about the buyer's orders (each with
 * the time it was hashed into the chain), the orders' own hold expiry, and open cases' reply
 * deadlines. Nothing is inferred, so an order with no recorded money event adds no line.
 */

export interface TimelineOrder {
  id: string;
  title: string;
  amountCents: number;
  currency: string;
  intent: string;
  status: string;
  authorizationId: string | null;
  captureId: string | null;
  authorizationExpiresAt: string | null;
}

export interface TimelineCase {
  orderId: string;
  stage: string;
  status: string;
  dueAt: string | null;
}

export interface TimelineEntry {
  seq: number;
  action: string;
  subjectId: string | null;
  payload: unknown;
  createdAt: string;
}

export interface MoneyEvent {
  key: string;
  /** ISO time of the event, or of the deadline. */
  at: string;
  orderId: string;
  status: Pick<StatusWord, 'word' | 'glyph' | 'tone'>;
  /** Formatted from integer cents, or null when the record says nothing about an amount. */
  amount: string | null;
  sentence: string;
  /** A deadline that has not passed yet. */
  upcoming?: boolean;
}

/** The audit actions that are about money, in the buyer's words. */
export const MONEY_ACTIONS = [
  'order.created',
  'order.outcome_unknown',
  'payment.authorized',
  'payment.captured',
  'payment.captured_after_check',
  'payment.voided_after_check',
  'case.sent_to_seller',
  'case.offer_made',
  'case.no_response',
  'case.hold_released',
  'case.refunded',
  'webhook.payment.capture.completed',
  'webhook.payment.capture.refunded',
  'webhook.payment.capture.reversed',
  'webhook.payment.authorization.voided',
] as const;

const OFFER: Record<string, string> = {
  REFUND: 'a refund',
  REFUND_WITH_RETURN: 'a refund when you send the item back',
  REFUND_WITH_REPLACEMENT: 'a refund and a replacement',
  REPLACEMENT_WITHOUT_REFUND: 'a replacement instead of a refund',
};

type Line = { status: MoneyEvent['status']; sentence: (amount: string, p: Record<string, unknown>) => string; amount: boolean };

const LINES: Record<(typeof MONEY_ACTIONS)[number], Line> = {
  'order.created': {
    status: { word: 'Sent to PayPal', glyph: '…', tone: 'waiting' },
    sentence: () => 'The order went to PayPal for your approval. Nothing is charged before you approve.',
    amount: true,
  },
  'order.outcome_unknown': {
    status: { word: 'Checking with PayPal', glyph: '…', tone: 'waiting' },
    sentence: () => 'PayPal did not answer in time. No second charge can happen while I check.',
    amount: true,
  },
  'payment.authorized': {
    status: { word: 'On hold', glyph: '…', tone: 'waiting' },
    sentence: (a) => `PayPal put ${a} on hold. ${STORE} is paid only after your check matches.`,
    amount: true,
  },
  'payment.captured': {
    status: { word: 'Paid', glyph: '✓', tone: 'good' },
    sentence: (a) => `You paid ${a} to ${STORE} through PayPal.`,
    amount: true,
  },
  'payment.captured_after_check': {
    status: { word: 'Paid', glyph: '✓', tone: 'good' },
    sentence: (a) => `Your check matched, so PayPal paid ${a} to ${STORE}.`,
    amount: true,
  },
  'payment.voided_after_check': {
    status: { word: 'Hold released', glyph: '✓', tone: 'good' },
    sentence: (a) => `PayPal released the hold on ${a}. ${STORE} was never paid.`,
    amount: true,
  },
  'case.sent_to_seller': {
    status: { word: 'Case sent', glyph: '…', tone: 'waiting' },
    sentence: () => `You asked ${STORE} for your money back, with the evidence.`,
    amount: false,
  },
  'case.offer_made': {
    status: { word: 'Offer to answer', glyph: '!', tone: 'waiting' },
    sentence: (_a, p) => `${STORE} offered ${OFFER[String(p.offerType)] ?? 'something'}. Nothing changes until you answer.`,
    amount: false,
  },
  'case.no_response': {
    status: { word: 'No reply', glyph: '!', tone: 'bad' },
    sentence: () => `${STORE} did not reply in time.`,
    amount: false,
  },
  'case.hold_released': {
    status: { word: 'Hold released', glyph: '✓', tone: 'good' },
    sentence: (a) => `${STORE} released the hold on ${a}. You were never charged.`,
    amount: true,
  },
  'case.refunded': {
    status: { word: 'Refunded', glyph: '✓', tone: 'good' },
    sentence: (a) => `${STORE} refunded ${a} through PayPal.`,
    amount: true,
  },
  'webhook.payment.capture.completed': {
    status: { word: 'Paid', glyph: '✓', tone: 'good' },
    sentence: (a) => `PayPal confirmed the payment of ${a}.`,
    amount: true,
  },
  'webhook.payment.capture.refunded': {
    status: { word: 'Refunded', glyph: '✓', tone: 'good' },
    sentence: (a) => `PayPal confirmed the refund of ${a}.`,
    amount: true,
  },
  'webhook.payment.capture.reversed': {
    status: { word: 'Reversed', glyph: '✓', tone: 'good' },
    sentence: (a) => `PayPal reversed the payment of ${a}.`,
    amount: true,
  },
  'webhook.payment.authorization.voided': {
    status: { word: 'Hold released', glyph: '✓', tone: 'good' },
    sentence: (a) => `PayPal confirmed the hold on ${a} was released.`,
    amount: true,
  },
};

const isTime = (v: unknown): v is string => typeof v === 'string' && !Number.isNaN(Date.parse(v));

/** The time hashed into the audit chain when there is one, otherwise when the row was written. */
function entryTime(e: TimelineEntry): string {
  const p = (e.payload ?? {}) as Record<string, unknown>;
  return new Date(isTime(p._at) ? p._at : e.createdAt).toISOString();
}

/** The open stages in which Demo Store still owes a reply by the case deadline. */
const AWAITING_REPLY = new Set(['seller_contacted']);

/** PayPal holds the money: authorized, not captured, not released. */
const held = (o: TimelineOrder) => o.intent === 'AUTHORIZE' && Boolean(o.authorizationId) && !o.captureId && o.status !== 'voided';

export function buildMoneyTimeline(input: { orders: TimelineOrder[]; cases: TimelineCase[]; entries: TimelineEntry[]; now: Date }): MoneyEvent[] {
  const byId = new Map(input.orders.map((o) => [o.id, o]));
  const money = (o: TimelineOrder, cents?: unknown) =>
    formatMoney({ cents: typeof cents === 'number' && Number.isInteger(cents) ? cents : o.amountCents, currency: o.currency });
  const out: MoneyEvent[] = [];

  for (const e of input.entries) {
    const o = e.subjectId ? byId.get(e.subjectId) : undefined;
    const line = (LINES as Record<string, Line | undefined>)[e.action];
    if (!o || !line) continue;
    const p = (e.payload ?? {}) as Record<string, unknown>;
    const amount = money(o, p.amountCents);
    out.push({ key: `a${e.seq}`, at: entryTime(e), orderId: o.id, status: line.status, amount: line.amount ? amount : null, sentence: line.sentence(amount, p) });
  }

  for (const c of input.cases) {
    const o = byId.get(c.orderId);
    if (!o || !c.dueAt || !isTime(c.dueAt) || !AWAITING_REPLY.has(c.stage)) continue;
    const upcoming = Date.parse(c.dueAt) > input.now.getTime();
    out.push({
      key: `due-${c.orderId}-${c.dueAt}`,
      at: new Date(c.dueAt).toISOString(),
      orderId: o.id,
      status: { word: upcoming ? 'Reply due' : 'Reply was due', glyph: '!', tone: 'waiting' },
      amount: null,
      sentence: upcoming
        ? `${STORE}'s deadline to reply to your case. If they don't, I'll ask PayPal to step in.`
        : `${STORE}'s deadline to reply to your case has passed.`,
      upcoming: upcoming || undefined,
    });
  }

  for (const o of input.orders) {
    if (!held(o) || !o.authorizationExpiresAt || !isTime(o.authorizationExpiresAt)) continue;
    const upcoming = Date.parse(o.authorizationExpiresAt) > input.now.getTime();
    out.push({
      key: `hold-${o.id}`,
      at: new Date(o.authorizationExpiresAt).toISOString(),
      orderId: o.id,
      status: { word: upcoming ? 'Hold ends' : 'Hold ended', glyph: '…', tone: 'waiting' },
      amount: money(o),
      sentence: upcoming ? `PayPal's hold on ${money(o)} lasts until this date.` : `PayPal's hold on ${money(o)} reached its end date.`,
      upcoming: upcoming || undefined,
    });
  }

  // Newest first; deadlines still ahead come before everything that already happened.
  return out.sort((a, b) => Date.parse(b.at) - Date.parse(a.at) || b.key.localeCompare(a.key));
}
