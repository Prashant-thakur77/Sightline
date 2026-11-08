import 'server-only';
import { createHash } from 'node:crypto';
import { eq } from 'drizzle-orm';
import sharp from 'sharp';
import { tables } from '@sightline/db';
import { newId } from '@sightline/core';
import { db } from './runtime';

export const MAX_PHOTO_BYTES = 12 * 1024 * 1024;
const ALLOWED = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif']);

export interface StoredBlob {
  id: string;
  sha256: string;
  mime: string;
  size: number;
}

/**
 * Normalise a photo before it is stored or sent anywhere: apply the EXIF orientation, then
 * re-encode without metadata, which drops GPS location and camera serials. Capped at 2000 px.
 */
export async function sanitisePhoto(input: Buffer, mime: string): Promise<Buffer> {
  if (!ALLOWED.has(mime)) throw new Error(`Unsupported image type ${mime}`);
  if (input.byteLength > MAX_PHOTO_BYTES) throw new Error('Photo too large');
  return sharp(input, { failOn: 'error' })
    .rotate()
    .resize({ width: 2000, height: 2000, fit: 'inside', withoutEnlargement: true })
    .jpeg({ quality: 88, mozjpeg: true })
    .toBuffer();
}

export async function putBlob(bytes: Buffer, mime: string, ownerId: string | null): Promise<StoredBlob> {
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  const id = newId('blb');
  await db().insert(tables.blobs).values({ id, ownerId, sha256, mime, bytes, size: bytes.byteLength });
  return { id, sha256, mime, size: bytes.byteLength };
}

export async function getBlob(id: string): Promise<{ bytes: Buffer; mime: string; sha256: string; ownerId: string | null } | null> {
  const [b] = await db().select().from(tables.blobs).where(eq(tables.blobs.id, id)).limit(1);
  if (!b?.bytes) return null;
  return { bytes: b.bytes, mime: b.mime, sha256: b.sha256, ownerId: b.ownerId };
}
