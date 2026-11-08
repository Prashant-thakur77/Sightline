import 'server-only';
import { and, desc, eq, inArray } from 'drizzle-orm';
import { tables } from '@sightline/db';
import type { ProductSnapshot, Verdict, VerdictKind } from '@sightline/core';
import { MONEY_ACTIONS, type TimelineCase, type TimelineEntry } from '@/lib/money-timeline';
import { db } from './runtime';

export async function orderForUser(orderId: string, userId: string) {
  const [o] = await db()
    .select()
    .from(tables.orders)
    .where(and(eq(tables.orders.id, orderId), eq(tables.orders.userId, userId)))
    .limit(1);
  if (!o) return null;
  const [snap] = await db().select().from(tables.productSnapshots).where(eq(tables.productSnapshots.id, o.snapshotId)).limit(1);
  const [ship] = await db().select().from(tables.shipments).where(eq(tables.shipments.orderId, o.id)).limit(1);
  const [ver] = await db()
    .select()
    .from(tables.verifications)
    .where(eq(tables.verifications.orderId, o.id))
    .orderBy(desc(tables.verifications.createdAt))
    .limit(1);
  const [kase] = await db().select().from(tables.cases).where(eq(tables.cases.orderId, o.id)).orderBy(desc(tables.cases.createdAt)).limit(1);
  return {
    order: o,
    snapshot: (snap?.body ?? null) as ProductSnapshot | null,
    shipment: ship ?? null,
    verification: ver ? { ...ver, verdict: ver.verdict as Verdict | null } : null,
    kase: kase ?? null,
  };
}

export async function ordersForUser(userId: string) {
  return db().select().from(tables.orders).where(eq(tables.orders.userId, userId)).orderBy(desc(tables.orders.createdAt)).limit(50);
}

/**
 * Everything the orders list shows: each order with its latest check and case, and the recorded
 * money events (audit entries about these orders) for the money timeline.
 */
export async function ordersPageData(userId: string) {
  const orders = await ordersForUser(userId);
  const verdictOf = new Map<string, VerdictKind | null>();
  const caseOf = new Map<string, TimelineCase>();
  if (!orders.length) return { orders, verdictOf, caseOf, cases: [] as TimelineCase[], entries: [] as TimelineEntry[] };
  const ids = orders.map((o) => o.id);
  const [vers, kases, entries] = await Promise.all([
    db()
      .select({ orderId: tables.verifications.orderId, verdict: tables.verifications.verdict })
      .from(tables.verifications)
      .where(inArray(tables.verifications.orderId, ids))
      .orderBy(desc(tables.verifications.createdAt)),
    db()
      .select({ orderId: tables.cases.orderId, stage: tables.cases.stage, status: tables.cases.status, dueAt: tables.cases.dueAt })
      .from(tables.cases)
      .where(inArray(tables.cases.orderId, ids))
      .orderBy(desc(tables.cases.createdAt)),
    db()
      .select({ seq: tables.auditLog.seq, action: tables.auditLog.action, subjectId: tables.auditLog.subjectId, payload: tables.auditLog.payload, createdAt: tables.auditLog.createdAt })
      .from(tables.auditLog)
      .where(and(inArray(tables.auditLog.subjectId, ids), inArray(tables.auditLog.action, [...MONEY_ACTIONS])))
      .orderBy(desc(tables.auditLog.seq))
      .limit(300),
  ]);
  // Newest first, so the first one seen per order is its latest, as on the order page.
  for (const v of vers) if (!verdictOf.has(v.orderId)) verdictOf.set(v.orderId, (v.verdict as Verdict | null)?.kind ?? null);
  for (const c of kases) if (!caseOf.has(c.orderId)) caseOf.set(c.orderId, c);
  return { orders, verdictOf, caseOf, cases: [...caseOf.values()], entries: entries as TimelineEntry[] };
}
