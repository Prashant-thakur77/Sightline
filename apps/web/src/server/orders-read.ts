import 'server-only';
import { and, desc, eq } from 'drizzle-orm';
import { tables } from '@sightline/db';
import type { ProductSnapshot, Verdict } from '@sightline/core';
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
