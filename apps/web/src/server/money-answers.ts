import 'server-only';
import { and, desc, eq, inArray } from 'drizzle-orm';
import { tables } from '@sightline/db';
import { answerMoneyQuestion, type MoneyAnswer, type MoneyAsk, type MoneyOrder } from '@sightline/agent';
import { db } from './runtime';
import { AUTO_CAPTURE_DAYS, PAID_ACTIONS as PAID, REFUNDED_ACTIONS as REFUNDED, RELEASED_ACTIONS as RELEASED, entryTime } from './hold-rules';

/**
 * The buyer's orders as the money answers read them: amounts in integer cents from the order
 * rows, payment state from PayPal's ids, and the moments money moved from the hash-chained log.
 */
export async function moneyOrders(userId: string): Promise<MoneyOrder[]> {
  const orders = await db().select().from(tables.orders).where(eq(tables.orders.userId, userId)).orderBy(desc(tables.orders.createdAt)).limit(100);
  if (!orders.length) return [];
  const ids = orders.map((o) => o.id);
  const [entries, ships, kases] = await Promise.all([
    db()
      .select({ action: tables.auditLog.action, subjectId: tables.auditLog.subjectId, payload: tables.auditLog.payload, createdAt: tables.auditLog.createdAt })
      .from(tables.auditLog)
      .where(and(inArray(tables.auditLog.subjectId, ids), inArray(tables.auditLog.action, [...PAID, ...REFUNDED, ...RELEASED])))
      .orderBy(desc(tables.auditLog.seq)),
    db().select({ orderId: tables.shipments.orderId, deliveredAt: tables.shipments.deliveredAt }).from(tables.shipments).where(inArray(tables.shipments.orderId, ids)),
    db()
      .select({ orderId: tables.cases.orderId, stage: tables.cases.stage, dueAt: tables.cases.dueAt })
      .from(tables.cases)
      .where(inArray(tables.cases.orderId, ids))
      .orderBy(desc(tables.cases.createdAt)),
  ]);
  const first = (orderId: string, actions: readonly string[]) => entries.find((e) => e.subjectId === orderId && actions.includes(e.action));
  return orders.map((o) => {
    const paid = first(o.id, PAID);
    const refund = first(o.id, REFUNDED);
    const released = first(o.id, RELEASED);
    const refundCents = (refund?.payload as { amountCents?: unknown } | undefined)?.amountCents;
    const kase = kases.find((k) => k.orderId === o.id);
    return {
      id: o.id,
      title: o.title,
      amountCents: o.amountCents,
      currency: o.currency,
      status: o.status,
      intent: o.intent,
      paypalOrderId: o.paypalOrderId,
      authorizationId: o.authorizationId,
      captureId: o.captureId,
      authorizationExpiresAt: o.authorizationExpiresAt,
      createdAt: o.createdAt,
      paidAt: paid ? entryTime(paid) : o.captureId ? o.updatedAt : null,
      refundedAt: refund ? entryTime(refund) : null,
      refundedCents: typeof refundCents === 'number' && Number.isInteger(refundCents) ? refundCents : null,
      releasedAt: released ? entryTime(released) : null,
      deliveredAt: ships.find((s) => s.orderId === o.id)?.deliveredAt ?? null,
      kase: kase ? { stage: kase.stage, dueAt: kase.dueAt } : null,
    };
  });
}

/** Answer a money question from the buyer's own records. Every amount and date comes from them. */
export async function answerMoney(userId: string, ask: MoneyAsk, now = new Date()): Promise<MoneyAnswer> {
  return answerMoneyQuestion(ask, await moneyOrders(userId), now, { autoCaptureDays: AUTO_CAPTURE_DAYS });
}
