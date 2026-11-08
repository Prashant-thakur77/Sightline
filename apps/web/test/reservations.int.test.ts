import { describe, expect, it, beforeAll } from 'vitest';
import path from 'node:path';

/**
 * Integration test against the local Postgres: two confirmations racing for the same budget
 * cannot both pass. Skipped when no database is configured.
 */
try {
  process.loadEnvFile(path.resolve(import.meta.dirname, '../../../.env.local'));
} catch {
  /* CI provides env directly */
}
const hasDb = Boolean(process.env.DATABASE_URL);

describe.skipIf(!hasDb)('budget reservations (Postgres)', () => {
  let userId = '';
  let mod: typeof import('../src/server/gate-ports');
  let db: typeof import('../src/server/runtime');
  beforeAll(async () => {
    mod = await import('../src/server/gate-ports');
    db = await import('../src/server/runtime');
    const { tables } = await import('@sightline/db');
    const { newId } = await import('@sightline/core');
    userId = newId('usr');
    await db.db().insert(tables.users).values({ id: userId, email: `${userId}@test.local`, displayName: 'Test', isDemo: true });
    await db.db().insert(tables.preferences).values({ userId, perOrderCapCents: 5000, dailyCapCents: 6000, maxOrdersPerHour: 10 });
  });

  const req = (key: string, cents: number, cartHash: string) => ({
    key,
    userId,
    cartHash,
    amount: { cents, currency: 'USD' },
    now: new Date(),
    expiresAt: new Date(Date.now() + 30 * 60_000),
    limits: { perOrderCap: { cents: 5000, currency: 'USD' }, dailyCap: { cents: 6000, currency: 'USD' }, maxOrdersPerHour: 10 },
    duplicateWindowMs: 10 * 60_000,
  });

  it('only one of two concurrent $36.72 holds fits under a $60 daily cap', async () => {
    const [a, b] = await Promise.all([
      mod.dbReservations.reserve(req(`k-${userId}-a`, 3672, `cart-a-${userId}`)),
      mod.dbReservations.reserve(req(`k-${userId}-b`, 3672, `cart-b-${userId}`)),
    ]);
    const passed = [a, b].filter((r) => r.ok);
    expect(passed).toHaveLength(1);
    const refused = [a, b].find((r) => !r.ok);
    expect(refused && !refused.ok && refused.code).toBe('OVER_DAILY_LIMIT');
  });

  it('the same request key is idempotent', async () => {
    const first = await mod.dbReservations.reserve(req(`k-${userId}-c`, 100, `cart-c-${userId}`));
    const again = await mod.dbReservations.reserve(req(`k-${userId}-c`, 100, `cart-c-${userId}`));
    expect(first.ok && again.ok && first.reservation.id === again.reservation.id).toBe(true);
  });

  it('a second hold for the same cart inside the window is a duplicate', async () => {
    const r = await mod.dbReservations.reserve(req(`k-${userId}-d`, 100, `cart-c-${userId}`));
    expect(!r.ok && r.code).toBe('DUPLICATE_ORDER');
  });

  it('over the per-order cap is refused', async () => {
    const r = await mod.dbReservations.reserve(req(`k-${userId}-e`, 5001, `cart-e-${userId}`));
    expect(!r.ok && r.code).toBe('OVER_ORDER_LIMIT');
  });
});
