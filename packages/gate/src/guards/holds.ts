import type { Money } from '@sightline/core';
import { isMoney, timeOf } from '../guard';
import type { GatePorts, Reservation, SpendLimits } from '../types';

/** Active budget holds for a user created at or after `sinceMs`. Empty without a reservation port. */
export async function holdsSince(ports: GatePorts, userId: string, now: Date, sinceMs: number): Promise<Reservation[]> {
  if (!ports.reservations) return [];
  const all = await ports.reservations.active(userId, now);
  return all.filter((r) => r.status === 'reserved' && (timeOf(r.createdAt) ?? Infinity) >= sinceMs);
}

export function sumCents(items: readonly { amount: Money }[]): number {
  return items.reduce((acc, r) => acc + r.amount.cents, 0);
}

export function validLimits(l: unknown): l is SpendLimits {
  if (!l || typeof l !== 'object') return false;
  const v = l as Record<string, unknown>;
  return (
    isMoney(v.perOrderCap) &&
    isMoney(v.dailyCap) &&
    (v.perOrderCap as Money).cents >= 0 &&
    (v.dailyCap as Money).cents >= 0 &&
    typeof v.maxOrdersPerHour === 'number' &&
    Number.isInteger(v.maxOrdersPerHour) &&
    v.maxOrdersPerHour >= 0
  );
}
