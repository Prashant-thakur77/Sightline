import 'server-only';
import { and, eq, gte, inArray, or, sql } from 'drizzle-orm';
import { tables } from '@sightline/db';
import { money, newId, type Money } from '@sightline/core';
import type { GatePorts, Reservation, ReservationOutcome, ReservationPort, ReservationRequest, SpendLimits } from '@sightline/gate';
import { computeTotals } from '@sightline/catalog';
import { db, ENV } from './runtime';
import { ed25519 } from './keys';

const DAY_MS = 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;
const PLACED = ['confirmed', 'approval_pending', 'authorized', 'captured', 'shipped', 'delivered', 'verified_match', 'verified_mismatch', 'verified_unsure', 'case_open'];

type Row = typeof tables.reservations.$inferSelect;

function toReservation(r: Row): Reservation {
  return {
    id: r.id,
    key: r.key,
    userId: r.userId,
    cartHash: r.cartHash,
    amount: money(r.amountCents, r.currency),
    status: r.status as Reservation['status'],
    createdAt: r.createdAt,
    expiresAt: r.expiresAt,
    committedAt: r.committedAt ?? undefined,
    releasedAt: r.releasedAt ?? undefined,
    releaseReason: r.releaseReason ?? undefined,
  };
}

async function limitsFor(userId: string): Promise<SpendLimits> {
  const [p] = await db().select().from(tables.preferences).where(eq(tables.preferences.userId, userId)).limit(1);
  return {
    perOrderCap: money(p?.perOrderCapCents ?? 10000),
    dailyCap: money(p?.dailyCapCents ?? 25000),
    maxOrdersPerHour: p?.maxOrdersPerHour ?? 5,
  };
}

/**
 * Budget holds in Postgres. `reserve` locks the user's row in `preferences` (SELECT ... FOR
 * UPDATE) and re-checks every limit inside the same transaction, so two concurrent confirmations
 * are serialised and cannot both fit under the same cap.
 */
export const dbReservations: ReservationPort = {
  async reserve(req: ReservationRequest): Promise<ReservationOutcome> {
    return db().transaction(async (tx) => {
      await tx.execute(sql`select 1 from preferences where user_id = ${req.userId} for update`);
      const existing = await tx.select().from(tables.reservations).where(eq(tables.reservations.key, req.key)).limit(1);
      if (existing[0] && existing[0].status !== 'released') {
        // Same request id: idempotent replay of the same confirmation.
        return { ok: true as const, reservation: toReservation(existing[0]) };
      }
      const nowIso = req.now.toISOString();
      const active = await tx
        .select()
        .from(tables.reservations)
        .where(and(eq(tables.reservations.userId, req.userId), eq(tables.reservations.status, 'reserved'), gte(tables.reservations.expiresAt, nowIso)));
      if (req.amount.cents > req.limits.perOrderCap.cents)
        return { ok: false as const, code: 'OVER_ORDER_LIMIT' as const, details: { cap: req.limits.perOrderCap, amount: req.amount } };
      const dupe = active.find((r) => r.cartHash === req.cartHash && req.now.getTime() - Date.parse(r.createdAt) < req.duplicateWindowMs);
      if (dupe) return { ok: false as const, code: 'DUPLICATE_ORDER' as const, details: { reservationId: dupe.id } };
      const since = new Date(req.now.getTime() - DAY_MS).toISOString();
      const committed = await tx
        .select({ c: sql<number>`coalesce(sum(${tables.reservations.amountCents}), 0)::int` })
        .from(tables.reservations)
        .where(and(eq(tables.reservations.userId, req.userId), eq(tables.reservations.status, 'committed'), gte(tables.reservations.committedAt, since)));
      const held = active.reduce((a, r) => a + r.amountCents, 0);
      const spent = committed[0]?.c ?? 0;
      if (spent + held + req.amount.cents > req.limits.dailyCap.cents)
        return {
          ok: false as const,
          code: 'OVER_DAILY_LIMIT' as const,
          details: { cap: req.limits.dailyCap, spentCents: spent, heldCents: held, amount: req.amount },
        };
      const hourAgo = new Date(req.now.getTime() - HOUR_MS).toISOString();
      const recent = await tx
        .select({ n: sql<number>`count(*)::int` })
        .from(tables.reservations)
        .where(and(eq(tables.reservations.userId, req.userId), gte(tables.reservations.createdAt, hourAgo), inArray(tables.reservations.status, ['reserved', 'committed'])));
      if ((recent[0]?.n ?? 0) >= req.limits.maxOrdersPerHour)
        return { ok: false as const, code: 'RATE_LIMITED' as const, details: { maxOrdersPerHour: req.limits.maxOrdersPerHour } };
      const row = {
        id: newId('rsv'),
        key: req.key,
        userId: req.userId,
        cartHash: req.cartHash,
        amountCents: req.amount.cents,
        currency: req.amount.currency,
        status: 'reserved',
        createdAt: nowIso,
        expiresAt: req.expiresAt.toISOString(),
      };
      if (existing[0]) {
        await tx.update(tables.reservations).set({ ...row, id: existing[0].id, releasedAt: null, releaseReason: null }).where(eq(tables.reservations.id, existing[0].id));
        return { ok: true as const, reservation: toReservation({ ...existing[0], ...row, id: existing[0].id, releasedAt: null, releaseReason: null, committedAt: null }) };
      }
      await tx.insert(tables.reservations).values(row);
      return { ok: true as const, reservation: toReservation({ ...row, committedAt: null, releasedAt: null, releaseReason: null }) };
    });
  },
  async commit(id: string, at: Date) {
    const [r] = await db()
      .update(tables.reservations)
      .set({ status: 'committed', committedAt: at.toISOString() })
      .where(eq(tables.reservations.id, id))
      .returning();
    if (!r) throw new Error(`No reservation ${id}`);
    return toReservation(r);
  },
  async release(id: string, reason: string, at: Date) {
    const [r] = await db()
      .update(tables.reservations)
      .set({ status: 'released', releasedAt: at.toISOString(), releaseReason: reason })
      .where(eq(tables.reservations.id, id))
      .returning();
    if (!r) throw new Error(`No reservation ${id}`);
    return toReservation(r);
  },
  async active(userId: string, now: Date) {
    const rows = await db()
      .select()
      .from(tables.reservations)
      .where(and(eq(tables.reservations.userId, userId), eq(tables.reservations.status, 'reserved'), gte(tables.reservations.expiresAt, now.toISOString())));
    return rows.map(toReservation);
  },
};

export function gatePorts(): GatePorts {
  return {
    async recentOrdersForCart(cartHash, sinceMs) {
      const rows = await db()
        .select({ id: tables.orders.id, createdAt: tables.orders.createdAt, status: tables.orders.status, cartHash: tables.carts.hash })
        .from(tables.orders)
        .innerJoin(tables.carts, eq(tables.carts.id, tables.orders.cartId))
        .where(
          and(
            eq(tables.carts.hash, cartHash),
            or(
              and(gte(tables.orders.createdAt, new Date(sinceMs).toISOString()), inArray(tables.orders.status, PLACED)),
              // An order whose PayPal outcome is unknown blocks repeats of the same goods with no
              // time limit, until it is reconciled with PayPal.
              eq(tables.orders.status, 'confirmed'),
            ),
          ),
        );
      // Report unknown-outcome orders as recent so the duplicate guard refuses the repeat.
      return rows.map((r) => ({ id: r.id, cartHash: r.cartHash, createdAt: r.status === 'confirmed' ? new Date().toISOString() : r.createdAt, status: r.status as never }));
    },
    async spentToday(userId, now) {
      const since = new Date(now.getTime() - DAY_MS).toISOString();
      const [r] = await db()
        .select({ c: sql<number>`coalesce(sum(${tables.reservations.amountCents}), 0)::int` })
        .from(tables.reservations)
        .where(and(eq(tables.reservations.userId, userId), eq(tables.reservations.status, 'committed'), gte(tables.reservations.committedAt, since)));
      return money(r?.c ?? 0);
    },
    async ordersInLastHour(userId, now) {
      const since = new Date(now.getTime() - HOUR_MS).toISOString();
      const [r] = await db()
        .select({ n: sql<number>`count(*)::int` })
        .from(tables.orders)
        .where(and(eq(tables.orders.userId, userId), gte(tables.orders.createdAt, since), inArray(tables.orders.status, PLACED)));
      return r?.n ?? 0;
    },
    payeeAllowlist() {
      return [ENV.PAYPAL_MERCHANT_ID ?? 'DEMO-STORE-UNCONFIGURED'];
    },
    limits: limitsFor,
    reservations: dbReservations,
    quoteExtras(cart) {
      const t = computeTotals(cart.lines.map((l) => ({ price: l.snapshot.price, quantity: l.quantity })));
      return { shipping: t.shipping as Money, tax: t.tax as Money };
    },
    async recordReceipt(receipt) {
      await db()
        .insert(tables.receipts)
        .values({
          id: newId('rct'),
          kind: 'gate',
          subjectId: (receipt.body as { requestId?: string }).requestId ?? null,
          body: receipt.body as object,
          hash: receipt.hash,
          signature: receipt.signature,
          ed25519: ed25519(receipt.hash),
        })
        .onConflictDoNothing();
    },
  };
}
