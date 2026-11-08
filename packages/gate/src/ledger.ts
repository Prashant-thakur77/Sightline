import type { Money } from '@sightline/core';
import { DAY, HOUR, isMoney, isValidDate, timeOf } from './guard';
import type { RecentOrder, Reservation, ReservationOutcome, ReservationPort, ReservationRequest } from './types';

/**
 * Spend ledger with reservations, held in memory. Used by tests, local development and the
 * demo; a database adapter implements the same ReservationPort with a per-user row lock.
 *
 *   reserve  -> status 'reserved'  (counts as a hold: budget, rate and duplicate checks see it)
 *   commit   -> status 'committed' (counts as spend in spentToday and ordersInLastHour)
 *   release  -> status 'released'  (counts as nothing)
 *
 * `reserve` re-checks every limit and records the hold with no await in between, so within one
 * Node process two concurrent confirmations are serialised: the second sees the first's hold.
 * Holds that pass their `expiresAt` stop counting and are marked released on the next reserve.
 */
export class InMemoryLedger implements ReservationPort {
  readonly currency: string;
  private readonly entries = new Map<string, Reservation>();
  private seq = 0;

  constructor(opts: { currency?: string } = {}) {
    this.currency = opts.currency ?? 'USD';
  }

  // ---- reads, shaped to plug straight into GatePorts ----

  spentToday(userId: string, now: Date): Money {
    const since = now.getTime() - DAY;
    let cents = 0;
    for (const e of this.entries.values()) {
      if (e.userId === userId && e.status === 'committed' && this.createdMs(e) > since) cents += e.amount.cents;
    }
    return { cents, currency: this.currency };
  }

  ordersInLastHour(userId: string, now: Date): number {
    const since = now.getTime() - HOUR;
    let n = 0;
    for (const e of this.entries.values()) {
      if (e.userId === userId && e.status === 'committed' && this.createdMs(e) > since) n++;
    }
    return n;
  }

  recentOrdersForCart(cartHash: string, sinceMs: number): RecentOrder[] {
    const out: RecentOrder[] = [];
    for (const e of this.entries.values()) {
      if (e.cartHash === cartHash && e.status === 'committed' && this.createdMs(e) >= sinceMs) {
        out.push({ id: e.id, cartHash: e.cartHash, createdAt: e.createdAt, status: 'captured' });
      }
    }
    return out;
  }

  // ---- ReservationPort ----

  active(userId: string, now: Date): Reservation[] {
    const t = now.getTime();
    return [...this.entries.values()]
      .filter((e) => e.userId === userId && e.status === 'reserved' && (timeOf(e.expiresAt) ?? 0) > t)
      .map((e) => ({ ...e }));
  }

  reserve(req: ReservationRequest): ReservationOutcome {
    // Everything below is synchronous on purpose: check-and-hold is one critical section.
    if (!isValidDate(req.now) || !isValidDate(req.expiresAt) || req.expiresAt.getTime() <= req.now.getTime()) {
      throw new Error('Reservation needs a valid now and a later expiresAt');
    }
    const now = req.now.getTime();
    this.expire(now);

    const { amount, limits } = req;
    if (
      !isMoney(amount) ||
      amount.cents <= 0 ||
      amount.currency !== this.currency ||
      limits.perOrderCap.currency !== this.currency ||
      limits.dailyCap.currency !== this.currency
    ) {
      return { ok: false, code: 'CURRENCY_MISMATCH', details: { ledgerCurrency: this.currency } };
    }

    const mine = [...this.entries.values()].filter((e) => e.userId === req.userId && e.status !== 'released');

    const sameKey = [...this.entries.values()].find((e) => e.key === req.key && e.status !== 'released');
    const sameCart = mine.find((e) => e.cartHash === req.cartHash && this.createdMs(e) >= now - req.duplicateWindowMs);
    const dup = sameKey ?? sameCart;
    if (dup) {
      return {
        ok: false,
        code: 'DUPLICATE_ORDER',
        details: { existing: dup.id, kind: 'reservation', ageMs: Math.max(0, now - this.createdMs(dup)) },
      };
    }

    if (amount.cents > limits.perOrderCap.cents) {
      return { ok: false, code: 'OVER_ORDER_LIMIT', details: { limit: limits.perOrderCap, amount } };
    }

    const lastDay = mine.filter((e) => this.createdMs(e) > now - DAY);
    const usedCents = lastDay.reduce((a, e) => a + e.amount.cents, 0);
    if (usedCents + amount.cents > limits.dailyCap.cents) {
      return {
        ok: false,
        code: 'OVER_DAILY_LIMIT',
        details: {
          limit: limits.dailyCap,
          amount,
          remaining: { cents: Math.max(0, limits.dailyCap.cents - usedCents), currency: this.currency },
        },
      };
    }

    const lastHour = mine.filter((e) => this.createdMs(e) > now - HOUR).length;
    if (lastHour >= limits.maxOrdersPerHour) {
      return { ok: false, code: 'RATE_LIMITED', details: { limit: limits.maxOrdersPerHour, count: lastHour } };
    }

    const reservation: Reservation = {
      id: `res_${++this.seq}`,
      key: req.key,
      userId: req.userId,
      cartHash: req.cartHash,
      amount: { cents: amount.cents, currency: amount.currency },
      status: 'reserved',
      createdAt: req.now.toISOString(),
      expiresAt: req.expiresAt.toISOString(),
    };
    this.entries.set(reservation.id, reservation);
    return { ok: true, reservation: { ...reservation } };
  }

  /** Capture landed: the hold becomes spend. Idempotent for an already committed hold. */
  commit(id: string, at: Date): Reservation {
    const e = this.get(id);
    if (e.status === 'committed') return { ...e };
    if (e.status === 'released') throw new Error(`Reservation ${id} was released (${e.releaseReason ?? 'unknown'})`);
    e.status = 'committed';
    e.committedAt = at.toISOString();
    return { ...e };
  }

  /** Failure, void or abandonment: the hold stops counting. Idempotent for a released hold. */
  release(id: string, reason: string, at: Date): Reservation {
    const e = this.get(id);
    if (e.status === 'released') return { ...e };
    if (e.status === 'committed') throw new Error(`Reservation ${id} is committed; refund it instead`);
    e.status = 'released';
    e.releasedAt = at.toISOString();
    e.releaseReason = reason;
    return { ...e };
  }

  /** Record an order that was placed outside the gate (seed data, imports, tests). */
  recordCommitted(input: { userId: string; cartHash: string; amount: Money; createdAt: Date; key?: string }): Reservation {
    const id = `res_${++this.seq}`;
    const at = input.createdAt.toISOString();
    const e: Reservation = {
      id,
      key: input.key ?? id,
      userId: input.userId,
      cartHash: input.cartHash,
      amount: { ...input.amount },
      status: 'committed',
      createdAt: at,
      expiresAt: at,
      committedAt: at,
    };
    this.entries.set(id, e);
    return { ...e };
  }

  snapshot(): Reservation[] {
    return [...this.entries.values()].map((e) => ({ ...e }));
  }

  private get(id: string): Reservation {
    const e = this.entries.get(id);
    if (!e) throw new Error(`Unknown reservation ${id}`);
    return e;
  }

  private createdMs(e: Reservation): number {
    return timeOf(e.createdAt) ?? 0;
  }

  private expire(now: number): void {
    for (const e of this.entries.values()) {
      if (e.status === 'reserved' && (timeOf(e.expiresAt) ?? 0) <= now) {
        e.status = 'released';
        e.releasedAt = new Date(now).toISOString();
        e.releaseReason = 'expired';
      }
    }
  }
}
