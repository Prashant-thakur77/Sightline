import 'server-only';
import { and, desc, eq, gt, inArray, like, lt, lte, or, sql } from 'drizzle-orm';
import { tables } from '@sightline/db';
import { formatMoney } from '@sightline/core';
import { spokenWhen } from '@/lib/when';
import { db } from './runtime';

/*
 * "What your agent did": every step of one order, from the shopping conversation before it to the
 * last PayPal update, in plain words, read from the hash-chained audit log. Each step says who did
 * it, which tool or service was used, whether a model or fixed rules decided it, and, for PayPal
 * steps, PayPal's own id and status as PayPal answered or as a signature-verified webhook said.
 * Nothing is inferred: a step is shown only because the audit log recorded it.
 */

export type Who = 'you' | 'agent' | 'store_agent' | 'staff' | 'paypal' | 'helper' | 'safety';

export const WHO_WORDS: Record<Who, string> = {
  you: 'You',
  agent: 'Your agent',
  store_agent: 'The store’s agent',
  staff: 'Store staff',
  paypal: 'PayPal',
  helper: 'Your helper',
  safety: 'Sightline’s safety check',
};

/** Who made the decision in a step: a model (with code checking its answer), fixed rules, or a person. */
export type Decided = 'model' | 'rules' | 'person';

export interface PayPalRef {
  label: 'PayPal order' | 'Authorization' | 'Capture' | 'Refund' | 'Dispute';
  id: string;
  /** PayPal's status word, as PayPal last said it; null when it was not recorded. */
  status: string | null;
  /** answer: PayPal's reply to our call. webhook: a signature-verified PayPal webhook. */
  source: 'answer' | 'webhook';
}

export interface TimelineStep {
  key: string;
  seq: number;
  at: string;
  when: string;
  action: string;
  who: Who;
  whoWords: string;
  what: string;
  tool: string | null;
  decided: Decided | null;
  paypal: PayPalRef | null;
}

export interface AuditRow {
  seq: number;
  actor: string;
  action: string;
  payload: unknown;
  createdAt: string;
}

export interface OrderFacts {
  amountCents: number;
  currency: string;
}

type P = Record<string, unknown>;
type Draft = Omit<TimelineStep, 'key' | 'seq' | 'at' | 'when' | 'action' | 'whoWords'>;

const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null);
const cents = (v: unknown): number | null => (typeof v === 'number' && Number.isInteger(v) ? v : null);
const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
const pp = (label: PayPalRef['label'], id: unknown, status: unknown, source: PayPalRef['source'] = 'answer'): PayPalRef | null =>
  str(id) ? { label, id: str(id)!, status: str(status), source } : null;

/** A tool name as recorded by any agent step, in the names the timeline uses. */
export function toolName(raw: unknown): string | null {
  const t = str(raw);
  if (!t) return null;
  const k = t.toLowerCase();
  if (k.includes('claude') || k.includes('anthropic')) return 'Claude';
  if (k.includes('channel3') || k.includes('channel 3')) return 'Channel3';
  if (k.includes('webhook')) return 'PayPal webhook';
  if (k.includes('paypal') && (k.includes('payment') || k.includes('refund') || k.includes('capture') || k.includes('void'))) return 'PayPal Payments API';
  if (k.includes('paypal') && k.includes('dispute')) return 'PayPal Disputes API';
  if (k.includes('paypal')) return 'PayPal Orders API';
  if (k.includes('vision')) return 'Sightline vision check';
  if (k === 'store rules') return 'Store rules';
  const named: Record<string, string> = { catalog: 'Demo Store catalog', memory: 'Saved preferences', money: 'Order records', app: 'Fixed templates' };
  if (named[k]) return named[k];
  return t.length > 60 ? `${t.slice(0, 57)}…` : t;
}

const VERDICT_WORDS: Record<string, string> = { match: 'it matches the order', mismatch: 'it does not match the order', unsure: 'it is not sure' };
const MODULE_WORDS: Record<string, string> = { colour: 'colour', size: 'size', identity: 'product', damage: 'damage', quality: 'photo quality' };
const CONFIDENCE: Record<string, string> = { sure: 'sure', fairly_sure: 'fairly sure', not_sure: 'not sure' };
const OFFER_WORDS: Record<string, string> = {
  REPLACEMENT_WITHOUT_REFUND: 'a replacement',
  REFUND_WITH_RETURN: 'the money back once the item is returned',
  REFUND: 'a full refund',
  REFUND_WITH_REPLACEMENT: 'a refund and a replacement',
};
const WEBHOOK_WORDS: Record<string, { what: string; label: PayPalRef['label'] }> = {
  'payment.capture.completed': { what: 'Confirmed the payment was completed.', label: 'Capture' },
  'payment.capture.refunded': { what: 'Confirmed the refund.', label: 'Refund' },
  'payment.capture.reversed': { what: 'Reversed the payment.', label: 'Capture' },
  'payment.capture.pending': { what: 'Said the payment is still being reviewed.', label: 'Capture' },
  'payment.capture.denied': { what: 'Declined the payment.', label: 'Capture' },
  'payment.authorization.created': { what: 'Confirmed the hold.', label: 'Authorization' },
  'payment.authorization.voided': { what: 'Confirmed the hold was released.', label: 'Authorization' },
  'checkout.order.approved': { what: 'Confirmed you approved the order.', label: 'PayPal order' },
  'customer.dispute.created': { what: 'Opened a PayPal case.', label: 'Dispute' },
  'customer.dispute.updated': { what: 'Sent an update on the PayPal case.', label: 'Dispute' },
  'customer.dispute.resolved': { what: 'Closed the PayPal case.', label: 'Dispute' },
};

/**
 * One audit entry as a timeline step, in plain words. Pure: tested without a database. Returns
 * null for entries that are not about this order's journey.
 */
export function describeEntry(row: AuditRow, order: OrderFacts): TimelineStep[] {
  const p = (row.payload ?? {}) as P;
  const money = (c: unknown) => formatMoney({ cents: cents(c) ?? order.amountCents, currency: order.currency });
  const total = money(null);
  const byStoreAgent = p.by === 'store_agent' || row.actor === 'store_agent';
  const d = (x: Draft): Draft => x;
  let drafts: Draft[] = [];

  switch (row.action) {
    case 'agent.step': {
      const tool = toolName(p.tool);
      const decided: Decided | null = p.decided === 'model' || p.decided === 'rules' || p.decided === 'person' ? p.decided : tool === 'Claude' ? 'model' : null;
      drafts = [d({ who: 'agent', what: str(p.summary) ?? str(p.step) ?? 'Took a step.', tool, decided, paypal: null })];
      break;
    }
    case 'answer.grounded': {
      const removed = Array.isArray(p.unsupported) ? p.unsupported.length : 0;
      drafts = [
        d({
          who: 'agent',
          what: `Answered your question about the listing from its own words${removed ? `, and left out ${plural(removed, 'claim', 'claims')} the listing doesn't support` : ''}.`,
          tool: 'Claude',
          decided: 'model',
          paypal: null,
        }),
      ];
      break;
    }
    case 'readback.spoken':
      drafts = [d({ who: 'agent', what: 'Read the order back to you, word for word, before any money could move.', tool: null, decided: 'rules', paypal: null })];
      break;
    case 'readback.confirmed':
      drafts = [d({ who: 'you', what: p.key1 === 'button' ? 'Confirmed the purchase with the Confirm button.' : 'Confirmed the purchase in your own words.', tool: null, decided: 'person', paypal: null })];
      if (p.key2 === 'classifier')
        drafts.push(d({ who: 'safety', what: 'A second, independent check of your words agreed that you meant to buy.', tool: 'Claude', decided: 'model', paypal: null }));
      break;
    case 'gate.allowed':
      drafts = [d({ who: 'safety', what: 'Checked the payment against eight fixed rules (amount, payee, budget, duplicates and more) before any money moved. It passed.', tool: null, decided: 'rules', paypal: null })];
      break;
    case 'gate.refused':
      drafts = [d({ who: 'safety', what: 'Stopped the payment: one of its eight fixed rules did not pass. Nothing was charged.', tool: null, decided: 'rules', paypal: null })];
      break;
    case 'order.created':
      drafts = [d({ who: 'paypal', what: 'Created the PayPal order for your approval.', tool: 'PayPal Orders API', decided: null, paypal: pp('PayPal order', p.paypalOrderId, p.paypalStatus) })];
      break;
    case 'order.outcome_unknown':
      drafts = [d({ who: 'paypal', what: 'Did not answer in time, so the purchase was paused to make a second charge impossible.', tool: 'PayPal Orders API', decided: null, paypal: null })];
      break;
    case 'payment.authorized':
      drafts = [
        d({
          who: 'paypal',
          what: `Put ${str(p.amount) ?? total} on hold. Demo Store is paid only after your check.`,
          tool: 'PayPal Orders API',
          decided: null,
          paypal: pp('Authorization', p.authorizationId, p.paypalStatus) ?? pp('PayPal order', p.paypalOrderId, p.paypalOrderStatus),
        }),
      ];
      break;
    case 'payment.captured':
      drafts = [
        d({
          who: 'paypal',
          what: `Took the payment of ${str(p.amount) ?? total}.`,
          tool: 'PayPal Orders API',
          decided: null,
          paypal: pp('Capture', p.captureId, p.paypalStatus) ?? pp('PayPal order', p.paypalOrderId, p.paypalOrderStatus),
        }),
      ];
      break;
    case 'payment.pending':
      drafts = [d({ who: 'paypal', what: 'Is still reviewing the payment.', tool: 'PayPal Orders API', decided: null, paypal: pp('PayPal order', p.paypalOrderId, 'PENDING') })];
      break;
    case 'payment.declined':
      drafts = [d({ who: 'paypal', what: 'Declined the payment. Nothing was charged.', tool: 'PayPal Orders API', decided: null, paypal: pp('PayPal order', p.paypalOrderId, p.state) })];
      break;
    case 'shipment.shipped':
      drafts = [
        d({
          who: 'staff',
          what: p.paypal === 'sent' ? 'Shipped your parcel and added the tracking to the PayPal order.' : 'Shipped your parcel.',
          tool: p.paypal === 'sent' ? 'PayPal Orders API' : null,
          decided: 'person',
          paypal: null,
        }),
      ];
      break;
    case 'shipment.not_shipped':
      drafts = [d({ who: 'staff', what: 'Marked the order as not shipped.', tool: null, decided: 'person', paypal: null })];
      break;
    case 'shipment.delivered':
      drafts = [d({ who: 'staff', what: 'Marked the parcel delivered.', tool: null, decided: 'person', paypal: null })];
      break;
    case 'tracking.sent':
      drafts = [d({ who: 'staff', what: 'Added the tracking to the PayPal order.', tool: 'PayPal Orders API', decided: 'person', paypal: null })];
      break;
    case 'check.photos_sent': {
      const n = Array.isArray(p.photos) ? p.photos.length : 0;
      drafts = [d({ who: 'you', what: `Sent ${plural(n, 'photo', 'photos')} for the check. Location data was removed first.`, tool: null, decided: 'person', paypal: null })];
      break;
    }
    case 'check.verdict': {
      const reasons = (Array.isArray(p.reasons) ? p.reasons : []) as [string, string, string][];
      const diff = reasons.filter((r) => r[1] === 'disagree').map((r) => `${MODULE_WORDS[r[0]] ?? r[0]} different (${CONFIDENCE[r[2]] ?? r[2]})`);
      drafts = [
        d({
          who: 'agent',
          what: `Checked the parcel: ${VERDICT_WORDS[String(p.kind)] ?? 'done'}${diff.length ? `. ${diff.join(', ')}` : ''}.`.replace(/\.\./g, '.'),
          tool: 'Sightline vision check',
          decided: 'rules',
          paypal: null,
        }),
      ];
      break;
    }
    case 'payment.captured_after_check':
      drafts = [d({ who: 'agent', what: `Your check matched, so it told PayPal to pay Demo Store ${total}.`, tool: 'PayPal Payments API', decided: 'rules', paypal: pp('Capture', p.captureId, p.paypalStatus) })];
      break;
    case 'payment.capture_retry_failed':
      drafts = [d({ who: 'paypal', what: 'Could not complete the payment yet. It is tried again later.', tool: 'PayPal Payments API', decided: null, paypal: null })];
      break;
    case 'payment.captured_no_check':
      drafts = [d({ who: 'agent', what: `A week after delivery with no problem reported, it told PayPal to pay Demo Store ${total}.`, tool: 'PayPal Payments API', decided: 'rules', paypal: pp('Capture', p.captureId, p.paypalStatus) })];
      break;
    case 'payment.captured_after_replacement':
      drafts = [d({ who: 'agent', what: `A week after you agreed to a replacement, it told PayPal to pay Demo Store ${total}.`, tool: 'PayPal Payments API', decided: 'rules', paypal: pp('Capture', p.captureId, p.paypalStatus) })];
      break;
    case 'payment.voided_after_check':
    case 'payment.voided_no_reply':
      drafts = [
        d({
          who: 'agent',
          what: `The case was not settled by its deadline, so it cancelled the ${total} hold. You were never charged.`,
          tool: 'PayPal Payments API',
          decided: 'rules',
          paypal: pp('Authorization', p.paypalId, p.paypalStatus),
        }),
      ];
      break;
    case 'payment.reauthorized':
      drafts = [d({ who: 'agent', what: 'Renewed the PayPal hold, so it stays good for the full amount.', tool: 'PayPal Payments API', decided: 'rules', paypal: pp('Authorization', p.to, p.paypalStatus) })];
      break;
    case 'hold.reminder_sent':
      drafts = [d({ who: 'agent', what: 'Reminded you to check the parcel while the money is on hold.', tool: null, decided: 'rules', paypal: null })];
      break;
    case 'hold.deadline_notice':
      drafts = [d({ who: 'agent', what: 'Told you a day ahead what happens at the case deadline.', tool: null, decided: 'rules', paypal: null })];
      break;
    case 'evidence.built':
      drafts = [
        d({
          who: 'agent',
          what:
            p.narrative === 'model'
              ? 'Built and signed the evidence pack. Claude wrote the summary, and code checked every amount, size and colour in it against the facts.'
              : 'Built and signed the evidence pack, with a summary from a template.',
          tool: p.narrative === 'model' ? 'Claude' : null,
          decided: p.narrative === 'model' ? 'model' : p.narrative === 'template' ? 'rules' : null,
          paypal: null,
        }),
      ];
      break;
    case 'case.return_requested':
      drafts = [d({ who: 'you', what: 'Sent the case to Demo Store with the signed evidence. The money stayed on hold.', tool: null, decided: 'person', paypal: null })];
      break;
    case 'case.sent_to_seller':
      drafts = [d({ who: 'you', what: 'Sent the case to Demo Store with the signed evidence.', tool: null, decided: 'person', paypal: null })];
      break;
    case 'store_agent.step': {
      const tool = toolName(p.tool);
      drafts = [
        d({
          who: 'store_agent',
          what: str(p.summary) ?? 'Took a step.',
          tool,
          decided: p.decided === 'model' || p.decided === 'rules' ? (p.decided as Decided) : tool === 'Claude' ? 'model' : tool === 'Store rules' ? 'rules' : null,
          paypal: null,
        }),
      ];
      break;
    }
    case 'store_agent.proposal_sent':
      drafts = [d({ who: 'staff', what: p.changed ? 'Changed the store agent’s proposal and sent another reply.' : 'Approved and sent the store agent’s proposal.', tool: null, decided: 'person', paypal: null })];
      break;
    case 'store_agent.proposal_dismissed':
      drafts = [d({ who: 'staff', what: 'Set the store agent’s proposal aside.', tool: null, decided: 'person', paypal: null })];
      break;
    case 'case.offer_made': {
      const what =
        p.offerType === 'PARTIAL_REFUND'
          ? `Offered ${money(p.amountCents)} back if you keep the item.`
          : `Offered ${OFFER_WORDS[String(p.offerType)] ?? 'something'}.`;
      drafts = [
        d({
          who: byStoreAgent ? 'store_agent' : 'staff',
          what: byStoreAgent ? `${what} It was inside the store’s policy, so it was sent without staff.` : what,
          tool: p.via === 'paypal' ? 'PayPal Disputes API' : null,
          decided: byStoreAgent ? 'rules' : 'person',
          paypal: p.via === 'paypal' ? pp('Dispute', p.paypalId, p.paypalStatus) : null,
        }),
      ];
      break;
    }
    case 'case.offer_accepted':
      drafts = [d({ who: 'you', what: 'Accepted the offer.', tool: null, decided: 'person', paypal: null })];
      break;
    case 'case.offer_declined':
      drafts = [d({ who: 'you', what: 'Declined the offer. The case stayed open.', tool: null, decided: 'person', paypal: null })];
      break;
    case 'case.partial_refunded': {
      const part = money(p.amountCents);
      drafts = [
        d({
          who: 'paypal',
          what: p.held
            ? `Took ${money(p.keptCents)} from your hold and released the other ${part}. You kept the item for less.`
            : `Refunded ${part}. You kept the item.`,
          tool: 'PayPal Payments API',
          decided: null,
          paypal: pp(p.via === 'capture' ? 'Capture' : 'Refund', p.paypalId, p.paypalStatus),
        }),
      ];
      break;
    }
    case 'case.hold_released':
      drafts = [
        d({
          who: byStoreAgent ? 'store_agent' : 'staff',
          what: `Released your ${money(p.amountCents)} hold through PayPal. You were never charged.`,
          tool: 'PayPal Payments API',
          decided: byStoreAgent ? 'rules' : 'person',
          paypal: pp('Authorization', p.paypalId, p.paypalStatus),
        }),
      ];
      break;
    case 'case.refunded':
      drafts = [
        d({
          who: byStoreAgent ? 'store_agent' : 'staff',
          what: `Refunded ${money(p.amountCents)} through PayPal.`,
          tool: p.via === 'dispute' ? 'PayPal Disputes API' : 'PayPal Payments API',
          decided: byStoreAgent ? 'rules' : 'person',
          paypal: pp(p.via === 'dispute' ? 'Dispute' : 'Refund', p.paypalId, p.paypalStatus),
        }),
      ];
      break;
    case 'case.no_response':
      drafts = [d({ who: 'staff', what: 'Chose not to reply for now.', tool: null, decided: 'person', paypal: null })];
      break;
    case 'helper.asked':
      drafts = [d({ who: 'you', what: 'Asked your helper to look at the photos.', tool: null, decided: 'person', paypal: null })];
      break;
    case 'helper.answered': {
      const a = p.answer === 'matches' ? 'it matches' : p.answer === 'different' ? 'it is different' : 'they could not tell';
      drafts = [d({ who: 'helper', what: `Looked at the photos and answered: ${a}.`, tool: null, decided: 'person', paypal: null })];
      break;
    }
    case 'helper.revoked':
      drafts = [d({ who: 'you', what: 'Cancelled the helper link.', tool: null, decided: 'person', paypal: null })];
      break;
    case 'order.reconcile_stopped':
      drafts = [d({ who: 'agent', what: 'Stopped re-sending the unanswered order, so it can never be charged twice.', tool: null, decided: 'rules', paypal: null })];
      break;
    case 'order.duplicate_invoice':
      drafts = [d({ who: 'paypal', what: 'Said this order was already placed once, so nothing was charged again.', tool: 'PayPal Orders API', decided: null, paypal: null })];
      break;
    default:
      if (row.action.startsWith('webhook.')) {
        const type = row.action.slice('webhook.'.length);
        const w = WEBHOOK_WORDS[type];
        drafts = [d({ who: 'paypal', what: w?.what ?? 'Sent an update.', tool: 'PayPal webhook', decided: null, paypal: pp(w?.label ?? 'PayPal order', p.resourceId, p.paypalStatus, 'webhook') })];
      }
  }
  const at = new Date(str(p._at) ?? row.createdAt).toISOString();
  return drafts.map((x, i) => ({ ...x, key: `${row.seq}-${i}`, seq: row.seq, at, when: spokenWhen(at), action: row.action, whoWords: WHO_WORDS[x.who] }));
}

/** Every step of one of this buyer's orders, oldest first. Empty when the order is not theirs. */
export async function orderTimeline(orderId: string, userId: string): Promise<TimelineStep[]> {
  const [o] = await db()
    .select()
    .from(tables.orders)
    .where(and(eq(tables.orders.id, orderId), eq(tables.orders.userId, userId)))
    .limit(1);
  if (!o) return [];
  // The shopping before this order: the buyer's conversation steps since their previous order.
  const [prev] = await db()
    .select({ createdAt: tables.orders.createdAt })
    .from(tables.orders)
    .where(and(eq(tables.orders.userId, userId), lt(tables.orders.createdAt, o.createdAt)))
    .orderBy(desc(tables.orders.createdAt))
    .limit(1);
  const convos = (await db().select({ id: tables.conversations.id }).from(tables.conversations).where(eq(tables.conversations.userId, userId))).map((c) => c.id);
  const a = tables.auditLog;
  const shopping = and(
    inArray(a.action, ['agent.step', 'answer.grounded']),
    lte(a.createdAt, o.createdAt),
    prev ? gt(a.createdAt, prev.createdAt) : undefined,
    or(eq(a.userId, userId), convos.length ? inArray(a.subjectId, convos) : undefined, convos.length ? inArray(sql`${a.payload}->>'conversationId'`, convos) : undefined),
  );
  const rows = await db()
    .select({ seq: a.seq, actor: a.actor, action: a.action, payload: a.payload, createdAt: a.createdAt, userId: a.userId })
    .from(a)
    .where(
      or(
        inArray(a.subjectId, [o.id, o.readbackId]),
        and(eq(a.action, 'agent.step'), sql`${a.payload}->>'readbackId' = ${o.readbackId}`),
        shopping,
      ),
    )
    .orderBy(a.seq)
    .limit(400);
  const facts = { amountCents: o.amountCents, currency: o.currency };
  return rows.filter((r) => !r.userId || r.userId === userId).flatMap((r) => describeEntry(r, facts));
}

export interface DemoTimeline {
  orderId: string;
  title: string;
  /** Whose order it is, in words: the visitor's own, or the scripted lifecycle run's. */
  whose: 'yours' | 'run';
  steps: TimelineStep[];
}

/**
 * The timeline for the judge page: the visitor's own latest demo order when they have one, else the
 * latest order of the scripted lifecycle run. Never another visitor's order.
 */
export async function latestDemoTimeline(sessionUserId: string | null, runEmailPattern: string): Promise<DemoTimeline | null> {
  const pick = async (userId: string) =>
    (await db().select({ id: tables.orders.id, title: tables.orders.title, userId: tables.orders.userId }).from(tables.orders).where(eq(tables.orders.userId, userId)).orderBy(desc(tables.orders.createdAt)).limit(1))[0];
  let whose: DemoTimeline['whose'] = 'yours';
  let latest = sessionUserId ? await pick(sessionUserId) : undefined;
  if (!latest) {
    // The newest order of any lifecycle-run shopper (their emails match the run's pattern).
    [latest] = await db()
      .select({ id: tables.orders.id, title: tables.orders.title, userId: tables.orders.userId })
      .from(tables.orders)
      .innerJoin(tables.users, eq(tables.users.id, tables.orders.userId))
      .where(like(tables.users.email, runEmailPattern))
      .orderBy(desc(tables.orders.createdAt))
      .limit(1);
    whose = 'run';
  }
  if (!latest) return null;
  return { orderId: latest.id, title: latest.title, whose, steps: await orderTimeline(latest.id, latest.userId) };
}
