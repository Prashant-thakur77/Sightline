import { beforeAll, describe, expect, it } from 'vitest';
import path from 'node:path';

/**
 * Integration test against the local Postgres and the demo catalog: a confirmation that comes
 * too late is not a dead end. The buyer hears why nothing was paid and gets a fresh readback to
 * confirm, as the refusal promises. Skipped without a database.
 */
try {
  process.loadEnvFile(path.resolve(import.meta.dirname, '../../../.env.local'));
} catch {
  /* CI provides env directly */
}
const hasDb = Boolean(process.env.DATABASE_URL);

describe.skipIf(!hasDb)('late confirmation reads the order again (Postgres)', () => {
  let conductor: typeof import('../src/server/conductor');
  let personas: typeof import('../src/server/personas');
  let rt: typeof import('../src/server/runtime');
  let t: typeof import('@sightline/db').tables;
  let eq: typeof import('drizzle-orm').eq;

  beforeAll(async () => {
    rt = await import('../src/server/runtime');
    conductor = await import('../src/server/conductor');
    personas = await import('../src/server/personas');
    ({ tables: t } = await import('@sightline/db'));
    ({ eq } = await import('drizzle-orm'));
  });

  it('a yes 10 minutes after the readback gets a new readback, and nothing is paid', async () => {
    const userId = await personas.ensurePersona('maya');
    await conductor.handleTurn(userId, { text: 'navy crew-neck sweater', source: 'keyboard' });
    const first = await conductor.handleTurn(userId, { action: 'buy', index: 1 });
    expect(first.card?.kind).toBe('readback');
    const oldId = first.card?.kind === 'readback' ? first.card.readbackId : '';

    const tenMinutesAgo = new Date(Date.now() - 10 * 60_000).toISOString();
    await rt.db().update(t.readbacks).set({ spokenAt: tenMinutesAgo, createdAt: tenMinutesAgo }).where(eq(t.readbacks.id, oldId));

    // Without a classifier key, two presses of Confirm stand in for the two keys.
    await conductor.handleTurn(userId, { action: 'confirm-button', readbackId: oldId });
    await new Promise((r) => setTimeout(r, 650));
    const late = await conductor.handleTurn(userId, { action: 'confirm-button', readbackId: oldId });

    expect(late.say).toMatch(/^It's been a while since I read your order, so I didn't buy it yet\./);
    expect(late.card?.kind).toBe('readback');
    const newId = late.card?.kind === 'readback' ? late.card.readbackId : '';
    expect(newId).not.toBe(oldId);
    const [old] = await rt.db().select().from(t.readbacks).where(eq(t.readbacks.id, oldId));
    expect(old!.invalidatedAt).not.toBeNull();
    expect(await rt.db().select().from(t.orders).where(eq(t.orders.userId, userId))).toHaveLength(0);
  });
});
