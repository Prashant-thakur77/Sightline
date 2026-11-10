import 'server-only';
import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import { tables } from '@sightline/db';
import { db } from './runtime';
import {
  CASE_SENT_ACTIONS,
  PAID_ACTIONS,
  PARTIAL_REFUND_ACTION,
  REAUTHORIZED_ACTION,
  REFUNDED_ACTIONS,
  RELEASED_ACTIONS,
  REMINDER_ACTION,
  entryTime,
} from './hold-rules';
import { buildSchedule, type Schedule, type ScheduleOrderFacts } from './schedule';

/** The audit actions the schedule reads: money moving, renewals, the reminder and the case's reply-by. */
const ACTIONS = [
  ...PAID_ACTIONS,
  ...RELEASED_ACTIONS,
  ...REFUNDED_ACTIONS,
  PARTIAL_REFUND_ACTION,
  REAUTHORIZED_ACTION,
  REMINDER_ACTION,
  ...CASE_SENT_ACTIONS,
];

/**
 * The store's holds and deadlines for one demo scope, read from the database each time: the same
 * orders the Orders page lists and the same cases the cases desk lists (never a draft).
 */
export async function loadSchedule(scopeUserId: string, now = new Date()): Promise<Schedule> {
  const orders = await db()
    .select()
    .from(tables.orders)
    .where(eq(tables.orders.userId, scopeUserId))
    .orderBy(desc(tables.orders.createdAt))
    .limit(200);
  if (!orders.length) return buildSchedule([], now);
  const ids = orders.map((o) => o.id);
  const [users, cases, ships, checks, entries] = await Promise.all([
    db()
      .select({ id: tables.users.id, name: tables.users.displayName })
      .from(tables.users)
      .where(inArray(tables.users.id, [...new Set(orders.map((o) => o.userId))])),
    db()
      .select()
      .from(tables.cases)
      .where(
        and(
          inArray(tables.cases.orderId, ids),
          eq(tables.cases.userId, scopeUserId),
          sql`${tables.cases.stage} not in ('draft', 'evidence_built')`,
        ),
      )
      .orderBy(desc(tables.cases.createdAt)),
    db()
      .select({ orderId: tables.shipments.orderId, deliveredAt: tables.shipments.deliveredAt })
      .from(tables.shipments)
      .where(inArray(tables.shipments.orderId, ids)),
    db()
      .select({ orderId: tables.verifications.orderId, verdict: tables.verifications.verdict })
      .from(tables.verifications)
      .where(inArray(tables.verifications.orderId, ids))
      .orderBy(desc(tables.verifications.createdAt)),
    db()
      .select({
        subjectId: tables.auditLog.subjectId,
        action: tables.auditLog.action,
        payload: tables.auditLog.payload,
        createdAt: tables.auditLog.createdAt,
      })
      .from(tables.auditLog)
      .where(and(inArray(tables.auditLog.subjectId, ids), inArray(tables.auditLog.action, ACTIONS)))
      .orderBy(tables.auditLog.seq),
  ]);
  const nameOf = new Map(users.map((u) => [u.id, u.name]));
  const facts: ScheduleOrderFacts[] = orders.map((o) => {
    const kase = cases.find((c) => c.orderId === o.id) ?? null;
    const verdict =
      (checks.find((v) => v.orderId === o.id && v.verdict)?.verdict as { kind?: string } | null | undefined)
        ?.kind ?? null;
    return {
      id: o.id,
      title: o.title,
      buyer: nameOf.get(o.userId) ?? 'Buyer',
      amountCents: o.amountCents,
      currency: o.currency,
      intent: o.intent,
      status: o.status,
      authorizationId: o.authorizationId,
      captureId: o.captureId,
      createdAt: o.createdAt,
      updatedAt: o.updatedAt,
      deliveredAt: ships.find((s) => s.orderId === o.id)?.deliveredAt ?? null,
      verdict,
      kase: kase
        ? {
            id: kase.id,
            kind: kase.kind,
            stage: kase.stage,
            dueAt: kase.dueAt,
            createdAt: kase.createdAt,
            updatedAt: kase.updatedAt,
            offers: (kase.offers as unknown[]) ?? [],
            outcome: kase.outcome,
          }
        : null,
      happenings: entries
        .filter((e) => e.subjectId === o.id)
        .map((e) => ({ action: e.action, at: entryTime(e), payload: e.payload })),
    };
  });
  return buildSchedule(facts, now);
}
