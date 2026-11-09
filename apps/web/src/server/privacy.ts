import 'server-only';
import { and, eq, inArray, isNotNull, isNull, like, lt, ne } from 'drizzle-orm';
import { tables } from '@sightline/db';
import { db } from './runtime';
import { audit } from './audit';

/**
 * What a buyer can delete, and what stays.
 *
 * Parcel photos are taken inside people's homes, so they are the most private thing stored.
 * They go when the buyer asks, and on their own after PHOTO_RETENTION_DAYS. The one exception is
 * a money-back case that is not resolved yet: the store or PayPal may still need to see them.
 * Checks keep each photo's SHA-256 fingerprint, so signed receipts and evidence packs still verify
 * after the photo itself is gone.
 *
 * Payment records, receipts and the audit chain are never deleted here: refunds and the
 * tamper-evident log depend on them.
 */
export const PHOTO_RETENTION_DAYS = 30;

export interface PhotoDeletion {
  deleted: number;
  kept: number;
}

/** Photo ids that an unresolved case still needs, for one buyer or for everyone. */
async function photosNeededByOpenCases(userId?: string): Promise<Set<string>> {
  const rows = await db()
    .select({ photos: tables.verifications.photos })
    .from(tables.verifications)
    .innerJoin(tables.cases, eq(tables.cases.orderId, tables.verifications.orderId))
    .where(and(ne(tables.cases.status, 'resolved'), userId ? eq(tables.cases.userId, userId) : undefined));
  return new Set(rows.flatMap((r) => r.photos.map((p) => p.blobId)));
}

/** Helper links show the photos, so a link to a deleted photo is cancelled with it. */
async function revokeHelperLinksFor(blobIds: Set<string>, userId?: string): Promise<void> {
  if (!blobIds.size) return;
  const checks = await db()
    .select({ id: tables.verifications.id, photos: tables.verifications.photos })
    .from(tables.verifications)
    .innerJoin(tables.orders, eq(tables.orders.id, tables.verifications.orderId))
    .where(userId ? eq(tables.orders.userId, userId) : undefined);
  const affected = checks.filter((c) => c.photos.some((p) => blobIds.has(p.blobId))).map((c) => c.id);
  if (!affected.length) return;
  await db()
    .update(tables.helperRequests)
    .set({ revokedAt: new Date().toISOString() })
    .where(and(inArray(tables.helperRequests.verificationId, affected), isNull(tables.helperRequests.revokedAt)));
}

/** How many parcel photos this buyer has, and how many an unresolved case still needs. */
export async function photoSummary(userId: string): Promise<{ total: number; needed: number }> {
  const keep = await photosNeededByOpenCases(userId);
  const mine = await db()
    .select({ id: tables.blobs.id })
    .from(tables.blobs)
    .where(and(eq(tables.blobs.ownerId, userId), like(tables.blobs.mime, 'image/%')));
  return { total: mine.length, needed: mine.filter((b) => keep.has(b.id)).length };
}

/** Delete every parcel photo this buyer owns that no unresolved case needs. */
export async function deleteMyPhotos(userId: string): Promise<PhotoDeletion> {
  const keep = await photosNeededByOpenCases(userId);
  const mine = await db()
    .select({ id: tables.blobs.id })
    .from(tables.blobs)
    .where(and(eq(tables.blobs.ownerId, userId), like(tables.blobs.mime, 'image/%')));
  const gone = mine.map((b) => b.id).filter((id) => !keep.has(id));
  if (gone.length) await db().delete(tables.blobs).where(and(inArray(tables.blobs.id, gone), eq(tables.blobs.ownerId, userId)));
  await revokeHelperLinksFor(new Set(gone), userId);
  const result = { deleted: gone.length, kept: mine.length - gone.length };
  await audit({ userId, actor: 'user', action: 'privacy.photos_deleted', subjectId: userId, payload: { ...result } });
  return result;
}

/** Retention: photos older than PHOTO_RETENTION_DAYS go, unless an unresolved case needs them. */
export async function purgeExpiredPhotos(now: Date): Promise<number> {
  const cutoff = new Date(now.getTime() - PHOTO_RETENTION_DAYS * 86_400_000).toISOString();
  const keep = await photosNeededByOpenCases();
  const old = await db()
    .select({ id: tables.blobs.id })
    .from(tables.blobs)
    .where(and(isNotNull(tables.blobs.ownerId), like(tables.blobs.mime, 'image/%'), lt(tables.blobs.createdAt, cutoff)));
  const gone = old.map((b) => b.id).filter((id) => !keep.has(id));
  if (!gone.length) return 0;
  await db().delete(tables.blobs).where(inArray(tables.blobs.id, gone));
  await revokeHelperLinksFor(new Set(gone));
  await audit({ actor: 'system', action: 'privacy.retention_purge', subjectId: 'blobs', payload: { deleted: gone.length, retentionDays: PHOTO_RETENTION_DAYS } });
  return gone.length;
}

let lastPurge = 0;
/** Run retention at most once an hour per server process; cheap enough to call from busy routes. */
export async function maybePurgeExpiredPhotos(now = new Date()): Promise<void> {
  if (now.getTime() - lastPurge < 3_600_000) return;
  lastPurge = now.getTime();
  await purgeExpiredPhotos(now);
}

export interface DataDeletion {
  photos: PhotoDeletion;
  conversations: number;
}

/**
 * Delete everything personal that payments do not depend on: photos, conversations, saved sizes
 * and colours, the trusted helper's contact, notifications and notification devices.
 */
export async function deleteMyData(userId: string): Promise<DataDeletion> {
  const photos = await deleteMyPhotos(userId);
  const conversations = await db().delete(tables.conversations).where(eq(tables.conversations.userId, userId)).returning({ id: tables.conversations.id });
  await db().delete(tables.notifications).where(eq(tables.notifications.userId, userId));
  await db().delete(tables.pushSubscriptions).where(eq(tables.pushSubscriptions.userId, userId));
  await db().delete(tables.helpers).where(eq(tables.helpers.userId, userId));
  await db().delete(tables.memories).where(eq(tables.memories.userId, userId));
  await db().update(tables.preferences).set({ sizes: {}, avoidColours: [] }).where(eq(tables.preferences.userId, userId));
  await audit({ userId, actor: 'user', action: 'privacy.data_deleted', subjectId: userId, payload: { photos: photos.deleted, conversations: conversations.length } });
  return { photos, conversations: conversations.length };
}
