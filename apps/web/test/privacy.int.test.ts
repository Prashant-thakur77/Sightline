import { beforeAll, describe, expect, it } from 'vitest';
import path from 'node:path';

/**
 * Integration test against the local Postgres: deleting photos and data keeps what an open
 * money-back case and the payment records need, and nothing else. Skipped without a database.
 */
try {
  process.loadEnvFile(path.resolve(import.meta.dirname, '../../../.env.local'));
} catch {
  /* CI provides env directly */
}
const hasDb = Boolean(process.env.DATABASE_URL);

describe.skipIf(!hasDb)('delete my photos and data (Postgres)', () => {
  let privacy: typeof import('../src/server/privacy');
  let rt: typeof import('../src/server/runtime');
  let t: typeof import('@sightline/db').tables;
  let id: (p: string) => string;
  let eq: typeof import('drizzle-orm').eq;
  let inArray: typeof import('drizzle-orm').inArray;

  const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString();

  async function seedUser() {
    const userId = id('usr');
    await rt.db().insert(t.users).values({ id: userId, email: `${userId}@test.local`, displayName: 'Test', isDemo: true });
    await rt.db().insert(t.preferences).values({ userId, sizes: { tops: 'M' }, avoidColours: ['orange'] });
    return userId;
  }

  async function seedOrder(userId: string) {
    const orderId = id('ord');
    await rt.db().insert(t.orders).values({
      id: orderId,
      userId,
      cartId: id('crt'),
      readbackId: id('rbk'),
      snapshotId: id('snp'),
      paypalRequestId: id('req'),
      intent: 'AUTHORIZE',
      paymentSource: 'vault',
      status: 'delivered',
      amountCents: 3672,
      merchantId: 'demo-store',
      title: 'Harbor knit crew-neck sweater',
    });
    return orderId;
  }

  async function seedPhoto(ownerId: string, createdAt = new Date().toISOString()) {
    const blobId = id('blb');
    await rt.db().insert(t.blobs).values({ id: blobId, ownerId, sha256: 'ab'.repeat(32), mime: 'image/jpeg', bytes: Buffer.from([1, 2, 3]), size: 3, createdAt });
    return blobId;
  }

  async function seedCheck(orderId: string, blobIds: string[]) {
    const verificationId = id('ver');
    await rt.db().insert(t.verifications).values({
      id: verificationId,
      orderId,
      status: 'done',
      photos: blobIds.map((blobId) => ({ kind: 'item', blobId, sha256: 'ab'.repeat(32) })),
    });
    return verificationId;
  }

  const blobExists = async (blobId: string) =>
    (await rt.db().select({ id: t.blobs.id }).from(t.blobs).where(eq(t.blobs.id, blobId))).length === 1;

  beforeAll(async () => {
    rt = await import('../src/server/runtime');
    privacy = await import('../src/server/privacy');
    ({ tables: t } = await import('@sightline/db'));
    ({ newId: id } = await import('@sightline/core'));
    ({ eq, inArray } = await import('drizzle-orm'));
  });

  it('deletes photos no open case needs, keeps the rest, and revokes helper links to them', async () => {
    const userId = await seedUser();
    const plainOrder = await seedOrder(userId);
    const caseOrder = await seedOrder(userId);
    const [a, b] = [await seedPhoto(userId), await seedPhoto(userId)];
    const kept = await seedPhoto(userId);
    const ver = await seedCheck(plainOrder, [a, b]);
    await seedCheck(caseOrder, [kept]);
    await rt.db().insert(t.cases).values({ id: id('cas'), orderId: caseOrder, userId, kind: 'inquiry', stage: 'seller_contacted', status: 'open', reason: 'size' });
    const helperId = id('hlp');
    await rt.db().insert(t.helperRequests).values({ id: helperId, verificationId: ver, question: 'Is it navy?', tokenHash: 'x', expiresAt: daysAgo(-1) });

    const r = await privacy.deleteMyPhotos(userId);

    expect(r).toEqual({ deleted: 2, kept: 1 });
    expect(await blobExists(a)).toBe(false);
    expect(await blobExists(b)).toBe(false);
    expect(await blobExists(kept)).toBe(true);
    const [h] = await rt.db().select().from(t.helperRequests).where(eq(t.helperRequests.id, helperId));
    expect(h!.revokedAt).not.toBeNull();
    // The check keeps the photo fingerprints, so signed evidence still verifies.
    const [v] = await rt.db().select().from(t.verifications).where(eq(t.verifications.id, ver));
    expect(v!.photos.map((p) => p.sha256)).toEqual(['ab'.repeat(32), 'ab'.repeat(32)]);
  });

  it('never touches another person’s photos', async () => {
    const me = await seedUser();
    const other = await seedUser();
    const theirs = await seedPhoto(other);
    await privacy.deleteMyPhotos(me);
    expect(await blobExists(theirs)).toBe(true);
  });

  it('keeps photos for a case that is drafted but not sent, and frees them once it is resolved', async () => {
    const userId = await seedUser();
    const orderId = await seedOrder(userId);
    const p = await seedPhoto(userId);
    await seedCheck(orderId, [p]);
    const caseId = id('cas');
    await rt.db().insert(t.cases).values({ id: caseId, orderId, userId, kind: 'void', stage: 'evidence_built', status: 'draft', reason: 'size' });
    expect(await privacy.deleteMyPhotos(userId)).toEqual({ deleted: 0, kept: 1 });
    await rt.db().update(t.cases).set({ status: 'resolved', stage: 'resolved' }).where(eq(t.cases.id, caseId));
    expect(await privacy.deleteMyPhotos(userId)).toEqual({ deleted: 1, kept: 0 });
  });

  it('retention removes photos older than 30 days unless an open case needs them', async () => {
    const userId = await seedUser();
    const orderId = await seedOrder(userId);
    const old = await seedPhoto(userId, daysAgo(31));
    const fresh = await seedPhoto(userId, daysAgo(2));
    const oldInCase = await seedPhoto(userId, daysAgo(40));
    await seedCheck(orderId, [oldInCase]);
    await rt.db().insert(t.cases).values({ id: id('cas'), orderId, userId, kind: 'inquiry', stage: 'seller_contacted', status: 'open', reason: 'size' });

    const n = await privacy.purgeExpiredPhotos(new Date());

    expect(n).toBeGreaterThanOrEqual(1);
    expect(await blobExists(old)).toBe(false);
    expect(await blobExists(fresh)).toBe(true);
    expect(await blobExists(oldInCase)).toBe(true);
  });

  it('delete everything clears conversations, sizes, notifications and devices but keeps payment records', async () => {
    const userId = await seedUser();
    const orderId = await seedOrder(userId);
    const convId = id('cnv');
    await rt.db().insert(t.conversations).values({ id: convId, userId });
    await rt.db().insert(t.messages).values({ id: id('msg'), conversationId: convId, role: 'user', text: 'navy sweater, medium' });
    await rt.db().insert(t.notifications).values({ id: id('ntf'), userId, kind: 'delivery', text: 'Your parcel arrived.' });
    await rt.db().insert(t.pushSubscriptions).values({ endpoint: `https://push.test/${userId}`, userId, keys: {} });
    const p = await seedPhoto(userId);
    await seedCheck(orderId, [p]);

    const r = await privacy.deleteMyData(userId);

    expect(r.photos).toEqual({ deleted: 1, kept: 0 });
    expect(await rt.db().select().from(t.conversations).where(eq(t.conversations.userId, userId))).toHaveLength(0);
    expect(await rt.db().select().from(t.notifications).where(eq(t.notifications.userId, userId))).toHaveLength(0);
    expect(await rt.db().select().from(t.pushSubscriptions).where(eq(t.pushSubscriptions.userId, userId))).toHaveLength(0);
    const [pref] = await rt.db().select().from(t.preferences).where(eq(t.preferences.userId, userId));
    expect(pref!.sizes).toEqual({});
    expect(pref!.avoidColours).toEqual([]);
    expect(await rt.db().select().from(t.orders).where(inArray(t.orders.id, [orderId]))).toHaveLength(1);
  });
});
