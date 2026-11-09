/**
 * Money questions by voice: "What's on hold?", "How much did I spend this month?", "When does my
 * hold expire?", "Did I get my refund?", "What did I order last week?". Every number is computed
 * here from the buyer's orders, PayPal's payment state, hold deadlines and cases, and every
 * sentence is a template: no model writes an amount or a date the buyer hears.
 */
import { DEMO_MERCHANT_NAME as STORE, addDays, formatMoney, money, paymentStatus, spokenDate, type Money } from '@sightline/core';
import { numberToWords } from './numbers';
import { capitalise, expandContractions, normaliseText, words } from './text';

export type MoneyQuestion = 'on_hold' | 'spent' | 'hold_ends' | 'refunds' | 'orders' | 'overview';
export type MoneyPeriod = 'today' | 'yesterday' | 'this_week' | 'last_week' | 'this_month' | 'last_month' | 'all';

export const MONEY_QUESTIONS: readonly MoneyQuestion[] = ['on_hold', 'spent', 'hold_ends', 'refunds', 'orders', 'overview'];
export const MONEY_PERIODS: readonly MoneyPeriod[] = ['today', 'yesterday', 'this_week', 'last_week', 'this_month', 'last_month', 'all'];

export interface MoneyAsk {
  question: MoneyQuestion;
  period?: MoneyPeriod;
}

/** One order as the money answers see it. Times are ISO strings; amounts are integer cents. */
export interface MoneyOrder {
  id: string;
  title: string;
  amountCents: number;
  currency: string;
  status: string;
  intent: string;
  paypalOrderId: string | null;
  authorizationId: string | null;
  captureId: string | null;
  authorizationExpiresAt: string | null;
  createdAt: string;
  /** When PayPal completed the payment, from the audit chain. */
  paidAt?: string | null;
  /** When the store refunded it, and how much (the order amount when not recorded). */
  refundedAt?: string | null;
  refundedCents?: number | null;
  /** When the hold was released (voided). */
  releasedAt?: string | null;
  deliveredAt?: string | null;
  kase?: { stage: string; dueAt: string | null } | null;
}

export interface MoneyRules {
  /** Days after delivery when an unchecked held order is paid to the store (holds.ts). */
  autoCaptureDays: number;
}

export interface MoneyAnswer {
  text: string;
  /** The orders the answer is about, for the agent's step log and a link. */
  orderIds: string[];
}

// ---------------------------------------------------------------------------------------------
// Understanding the question

const PERIODS: Array<[RegExp, MoneyPeriod]> = [
  [/\btoday\b/, 'today'],
  [/\byesterday\b/, 'yesterday'],
  [/\bthis week\b/, 'this_week'],
  [/\b(?:last week|past week|previous week)\b/, 'last_week'],
  [/\b(?:this month|so far this month)\b/, 'this_month'],
  [/\b(?:last month|previous month)\b/, 'last_month'],
  [/\b(?:in total|altogether|all time|ever|so far)\b/, 'all'],
];

function periodIn(s: string): MoneyPeriod | undefined {
  return PERIODS.find(([re]) => re.test(s))?.[1];
}

const QUESTIONS: Array<[RegExp, MoneyQuestion]> = [
  [/\bwhen (?:does|will|do) (?:my|the) holds? (?:expire|end|run out|stop|finish)\b|\bhow long (?:is|does) (?:my|the) hold\b|\bwhen (?:does|will) (?:the store|demo store|the shop) get paid\b|\bwhen (?:is|will) (?:the store|demo store) (?:be )?paid\b/, 'hold_ends'],
  [/\b(?:what is|what s|anything|is anything|is there anything|how much is|how much money is|what money is|what do i have) on hold\b|\bwhat is held\b|\bmy holds\b|\bwhat holds\b|\bon hold right now\b/, 'on_hold'],
  [/\bhow much (?:did|have) i (?:spend|spent|paid|pay)\b|\bwhat (?:did|have) i (?:spend|spent)\b|\bhow much have i spent\b|\bmy spending\b|\bhow much money (?:did|have) i spen[dt]\b/, 'spent'],
  [/\b(?:did|have) i (?:get|got|received|receive) (?:my|a|the) refunds?\b|\bhave i been refunded\b|\bwas i refunded\b|\bwhere is my refund\b|\bhas my refund\b|\bdid my refund\b|\bany refunds?\b|\bam i getting (?:a|my) refund\b/, 'refunds'],
  [/\bwhat (?:did|have) i (?:order|ordered|buy|bought)\b|\bwhat have i bought\b|\bwhat did i get\b/, 'orders'],
  [/\bwhere is my money\b|\bwas i charged\b|\bdid i pay\b|\bmy payments\b|\bmoney timeline\b/, 'overview'],
];

/** A money question in the buyer's words, or null. */
export function parseMoneyQuestion(text: string): MoneyAsk | null {
  const s = expandContractions(words(normaliseText(text))).join(' ');
  const hit = QUESTIONS.find(([re]) => re.test(s));
  if (!hit) return null;
  const period = periodIn(s);
  return { question: hit[1], ...(period ? { period } : {}) };
}

// ---------------------------------------------------------------------------------------------
// Periods

function startOfDay(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

function monthName(d: Date): string {
  return new Intl.DateTimeFormat('en-US', { month: 'long', timeZone: 'UTC' }).format(d);
}

export interface PeriodRange {
  from: Date;
  to: Date;
  /** "this month", "last week, from Monday 2 November to Sunday 8 November". */
  words: string;
}

/** A period as a range of UTC days, and how to say it. */
export function periodRange(period: MoneyPeriod, now: Date): PeriodRange {
  const today = startOfDay(now);
  const monday = addDays(today, -((today.getUTCDay() + 6) % 7));
  switch (period) {
    case 'today':
      return { from: today, to: now, words: 'today' };
    case 'yesterday': {
      const y = addDays(today, -1);
      return { from: y, to: today, words: 'yesterday' };
    }
    case 'this_week':
      return { from: monday, to: now, words: 'this week' };
    case 'last_week': {
      const from = addDays(monday, -7);
      return { from, to: monday, words: `last week, from ${spokenDate(from)} to ${spokenDate(addDays(monday, -1))}` };
    }
    case 'this_month':
      return { from: new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)), to: now, words: 'this month' };
    case 'last_month': {
      const from = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1));
      return { from, to: new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)), words: `last month, in ${monthName(from)}` };
    }
    case 'all':
      return { from: new Date(0), to: now, words: 'in total' };
  }
}

const within = (iso: string | null | undefined, r: PeriodRange) => {
  if (!iso) return false;
  const t = Date.parse(iso);
  return t >= r.from.getTime() && t <= r.to.getTime();
};

// ---------------------------------------------------------------------------------------------
// Facts

const facts = (o: MoneyOrder) => ({ intent: o.intent, status: o.status, paypalOrderId: o.paypalOrderId, authorizationId: o.authorizationId, captureId: o.captureId });
const amountOf = (o: MoneyOrder, cents = o.amountCents): Money => money(cents, o.currency);
const amt = (o: MoneyOrder, cents?: number) => formatMoney(amountOf(o, cents));

export function isOnHold(o: MoneyOrder): boolean {
  return paymentStatus(facts(o)).word === 'On hold';
}
function isPaid(o: MoneyOrder): boolean {
  return paymentStatus(facts(o)).word === 'Paid';
}

function sum(orders: MoneyOrder[], pick: (o: MoneyOrder) => number = (o) => o.amountCents): string {
  const currency = orders[0]?.currency ?? 'USD';
  return formatMoney(money(orders.reduce((n, o) => n + pick(o), 0), currency));
}

const count = (n: number, noun: string) => `${numberToWords(n)} ${noun}${n === 1 ? '' : 's'}`;
const OPEN_CASE = new Set(['seller_contacted', 'offer_received', 'accepted', 'declined']);

/** "your Harbor knit crew-neck sweater, $36.72" for up to three; "and 2 more" after. */
function listOrders(orders: MoneyOrder[], withAmount = true, detail?: (o: MoneyOrder) => string): string {
  const shown = orders.slice(0, 3).map((o) => `your ${o.title}${withAmount ? `, ${amt(o)}` : ''}${detail ? `, ${detail(o)}` : ''}`);
  const more = orders.length - shown.length;
  return more > 0 ? `${shown.join('; ')}; and ${numberToWords(more)} more` : shown.length > 1 ? `${shown.slice(0, -1).join('; ')}; and ${shown[shown.length - 1]}` : shown.join('');
}

// ---------------------------------------------------------------------------------------------
// Answers

function onHold(orders: MoneyOrder[]): MoneyAnswer {
  const held = orders.filter(isOnHold);
  const waiting = orders.filter((o) => o.status === 'approval_pending');
  const out: string[] = [];
  if (held.length === 0) out.push('Nothing is on hold right now.');
  else if (held.length === 1) {
    const o = held[0]!;
    const inCase = o.kase && OPEN_CASE.has(o.kase.stage);
    out.push(
      inCase
        ? `${amt(o)} is on hold for your ${o.title}, while ${STORE} answers your case. You haven't been charged.`
        : `${amt(o)} is on hold for your ${o.title}. ${STORE} is paid only after you check it.`,
    );
  } else {
    out.push(`${sum(held)} is on hold, for ${count(held.length, 'order')}: ${listOrders(held)}. ${STORE} is paid for each only after you check it.`);
  }
  if (waiting.length)
    out.push(`${capitalise(count(waiting.length, 'order'))} ${waiting.length === 1 ? 'is' : 'are'} waiting for your PayPal approval. Nothing is charged until you approve.`);
  return { text: out.join(' '), orderIds: [...held, ...waiting].map((o) => o.id) };
}

function spent(orders: MoneyOrder[], period: MoneyPeriod, now: Date): MoneyAnswer {
  const r = periodRange(period, now);
  const paid = orders.filter((o) => isPaid(o) && within(o.paidAt ?? o.createdAt, r));
  const refunded = orders.filter((o) => o.status === 'resolved_refund' && within(o.refundedAt, r));
  const held = orders.filter(isOnHold);
  const out: string[] = [];
  const when = r.words;
  if (paid.length === 0) out.push(`You haven't paid for anything ${when}.`);
  else out.push(`${capitalise(when)}, you paid ${sum(paid)}, for ${count(paid.length, 'order')}: ${listOrders(paid)}.`);
  if (held.length) out.push(`${sum(held)} more is on hold, and isn't spent yet.`);
  if (refunded.length) out.push(`${sum(refunded, (o) => o.refundedCents ?? o.amountCents)} came back to you as ${refunded.length === 1 ? 'a refund' : 'refunds'} ${when}.`);
  return { text: out.join(' '), orderIds: [...paid, ...held, ...refunded].map((o) => o.id) };
}

function holdEnds(orders: MoneyOrder[], rules: MoneyRules): MoneyAnswer {
  const held = orders.filter(isOnHold).slice(0, 3);
  if (held.length === 0) return { text: "Nothing is on hold, so there's no hold to end.", orderIds: [] };
  const out: string[] = [];
  for (const o of held) {
    if (o.kase && OPEN_CASE.has(o.kase.stage) && o.kase.dueAt)
      out.push(`${amt(o)} for your ${o.title} stays on hold while your case is open. If it isn't settled by ${spokenDate(o.kase.dueAt)}, the hold is cancelled and you're never charged.`);
    else if (o.deliveredAt)
      out.push(
        `Your ${o.title} arrived on ${spokenDate(o.deliveredAt)}. If you don't check it, ${STORE} is paid ${amt(o)} on ${spokenDate(addDays(new Date(o.deliveredAt), rules.autoCaptureDays))}.`,
      );
    else
      out.push(`${amt(o)} for your ${o.title} stays on hold until you check the parcel. If you don't check it, ${STORE} is paid a week after it arrives.`);
  }
  const latest = held.map((o) => o.authorizationExpiresAt).filter((x): x is string => Boolean(x)).sort()[0];
  if (latest) out.push(`PayPal's hold can last until ${spokenDate(latest)} at the latest.`);
  return { text: out.join(' '), orderIds: held.map((o) => o.id) };
}

function refunds(orders: MoneyOrder[]): MoneyAnswer {
  const lines: Array<{ at: number; text: string; id: string }> = [];
  for (const o of orders) {
    if (o.status === 'resolved_refund')
      lines.push({
        at: Date.parse(o.refundedAt ?? o.createdAt),
        id: o.id,
        text: `PayPal refunded ${amt(o, o.refundedCents ?? undefined)} for your ${o.title}${o.refundedAt ? ` on ${spokenDate(o.refundedAt)}` : ''}.`,
      });
    else if (o.status === 'voided')
      lines.push({
        at: Date.parse(o.releasedAt ?? o.createdAt),
        id: o.id,
        text: `You weren't charged for your ${o.title}: the ${amt(o)} hold was released${o.releasedAt ? ` on ${spokenDate(o.releasedAt)}` : ''}, so there was nothing to refund.`,
      });
    else if (o.kase?.stage === 'accepted')
      lines.push({ at: Date.parse(o.createdAt), id: o.id, text: `You accepted a refund for your ${o.title}. It hasn't arrived yet. I'll tell you when it does.` });
    else if (o.kase?.stage === 'offer_received')
      lines.push({ at: Date.parse(o.createdAt), id: o.id, text: `${STORE} made an offer on your case for the ${o.title}. Say 'what did they offer' to hear it.` });
    else if (o.kase?.stage === 'seller_contacted')
      lines.push({
        at: Date.parse(o.createdAt),
        id: o.id,
        text: `Your case for the ${o.title} is with ${STORE}${o.kase.dueAt ? `. They have until ${spokenDate(o.kase.dueAt)} to reply` : ''}. No refund yet.`,
      });
  }
  if (lines.length === 0) return { text: "You haven't had any refunds, and you have no open cases.", orderIds: [] };
  const top = lines.sort((a, b) => b.at - a.at).slice(0, 3);
  const lead = orders.some((o) => o.status === 'resolved_refund') ? 'Yes. ' : '';
  return { text: lead + top.map((l) => l.text).join(' '), orderIds: top.map((l) => l.id) };
}

function ordered(orders: MoneyOrder[], period: MoneyPeriod | undefined, now: Date): MoneyAnswer {
  const placed = orders.filter((o) => o.status !== 'failed');
  const failed = orders.filter((o) => o.status === 'failed');
  const status = (o: MoneyOrder) => paymentStatus(facts(o)).word.toLowerCase();
  if (!period) {
    if (placed.length === 0) return { text: "You haven't ordered anything yet.", orderIds: [] };
    return { text: `Your latest ${placed.length === 1 ? 'order' : 'orders'}: ${listOrders(placed, true, status)}.`, orderIds: placed.slice(0, 3).map((o) => o.id) };
  }
  const r = periodRange(period, now);
  const inRange = placed.filter((o) => within(o.createdAt, r));
  const out: string[] = [];
  if (inRange.length === 0) out.push(`You didn't order anything ${r.words}.`);
  else out.push(`${capitalise(r.words)}, you ordered ${numberToWords(inRange.length)} ${inRange.length === 1 ? 'thing' : 'things'}: ${listOrders(inRange, true, status)}.`);
  const notPlaced = failed.filter((o) => within(o.createdAt, r));
  if (notPlaced.length) out.push(`${capitalise(count(notPlaced.length, 'more order'))} wasn't placed, and nothing was charged.`);
  if (inRange.length > 3) out.push("They're all on the Orders page.");
  return { text: out.join(' '), orderIds: inRange.map((o) => o.id) };
}

function overview(orders: MoneyOrder[], now: Date): MoneyAnswer {
  if (orders.length === 0) return { text: "You haven't bought anything yet, so no money has moved.", orderIds: [] };
  const hold = onHold(orders);
  const parts = [hold.text];
  const paid = spent(orders, 'this_month', now);
  if (orders.some((o) => isPaid(o))) parts.push(paid.text.split('. ')[0]!.replace(/\.?$/, '.'));
  const back = refunds(orders);
  if (back.orderIds.length) parts.push(back.text.replace(/^Yes\. /, ''));
  return { text: parts.join(' '), orderIds: [...new Set([...hold.orderIds, ...back.orderIds])] };
}

/** The answer to a money question, from the buyer's orders only. */
export function answerMoneyQuestion(ask: MoneyAsk, orders: MoneyOrder[], now: Date, rules: MoneyRules): MoneyAnswer {
  switch (ask.question) {
    case 'on_hold':
      return onHold(orders);
    case 'spent':
      return spent(orders, ask.period ?? 'this_month', now);
    case 'hold_ends':
      return holdEnds(orders, rules);
    case 'refunds':
      return refunds(orders);
    case 'orders':
      return ordered(orders, ask.period, now);
    case 'overview':
      return overview(orders, now);
  }
}

/** Plain words for a question, for the agent's step log. */
export function moneyQuestionWords(ask: MoneyAsk): string {
  const what: Record<MoneyQuestion, string> = {
    on_hold: 'what is on hold',
    spent: 'how much was spent',
    hold_ends: 'when the holds end',
    refunds: 'about refunds',
    orders: 'what was ordered',
    overview: 'where the money is',
  };
  const period = ask.period ? ` (${ask.period.replace('_', ' ')})` : '';
  return `${what[ask.question]}${period}`;
}

