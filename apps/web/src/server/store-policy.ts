import 'server-only';
import { eq } from 'drizzle-orm';
import { tables } from '@sightline/db';
import { DEFAULT_STORE_POLICY, POLICY_MAX_CENTS, type PartialRefunds, type StorePolicy } from '@sightline/agent';
import { db } from './runtime';

/*
 * The store's case policy, kept per demo scope: each visitor plays the store for their own demo
 * shopper, so one visitor's policy never changes another's. No row means the defaults.
 */

const PARTIALS: readonly PartialRefunds[] = ['none', 'up_to_20', 'up_to_50'];

export async function loadStorePolicy(scopeId: string): Promise<StorePolicy> {
  const [row] = await db().select().from(tables.storePolicies).where(eq(tables.storePolicies.scopeId, scopeId)).limit(1);
  if (!row) return { ...DEFAULT_STORE_POLICY };
  return {
    agentOn: row.agentOn,
    autoSend: row.autoSend,
    autoReplaceMaxCents: row.autoReplaceMaxCents,
    askStaffAboveCents: row.askStaffAboveCents,
    partialRefunds: PARTIALS.includes(row.partialRefunds as PartialRefunds) ? (row.partialRefunds as PartialRefunds) : DEFAULT_STORE_POLICY.partialRefunds,
  };
}

/** A policy is saved only whole and within limits: whole cents, from $0 to $5,000. */
export function validPolicy(p: StorePolicy): boolean {
  const cents = (n: number) => Number.isInteger(n) && n >= 0 && n <= POLICY_MAX_CENTS;
  return cents(p.autoReplaceMaxCents) && cents(p.askStaffAboveCents) && PARTIALS.includes(p.partialRefunds);
}

export async function saveStorePolicy(scopeId: string, p: StorePolicy): Promise<void> {
  if (!validPolicy(p)) throw new Error('Invalid store policy');
  const values = { ...p, updatedAt: new Date().toISOString() };
  await db()
    .insert(tables.storePolicies)
    .values({ scopeId, ...values })
    .onConflictDoUpdate({ target: tables.storePolicies.scopeId, set: values });
}
