import 'server-only';
import { createHash } from 'node:crypto';
import { eq, inArray } from 'drizzle-orm';
import sharp, { type Metadata } from 'sharp';
import { tables } from '@sightline/db';
import { newId } from '@sightline/core';
import { db } from './runtime';

export const MAX_PHOTO_BYTES = 12 * 1024 * 1024;

/** Said when a photo can't be read: a damaged file, or a format this server can't open. */
export const UNREADABLE_PHOTO_SAY =
  "I couldn't read that photo. Retake it with the camera, or choose a JPEG or PNG photo. Nothing about your payment changed.";
export const PHOTO_TOO_LARGE_SAY =
  'That photo is too large to send. Retake it with the camera, or choose a smaller photo. Nothing about your payment changed.';

/** The bytes are not a photo this server can decode. Nothing was stored. */
export class UnreadablePhotoError extends Error {
  constructor(readonly detail: string) {
    super(`Unreadable photo: ${detail}`);
    this.name = 'UnreadablePhotoError';
  }
}

export class PhotoTooLargeError extends Error {
  constructor() {
    super('Photo too large');
    this.name = 'PhotoTooLargeError';
  }
}

/** A tiny image in one HEIF codec, made and read back: proves this sharp build can decode it. */
async function heifRoundTrip(compression: 'av1' | 'hevc'): Promise<boolean> {
  try {
    const made = await sharp({ create: { width: 8, height: 8, channels: 3, background: '#808080' } })
      .heif({ compression })
      .toBuffer();
    const meta = await sharp(made).metadata();
    await sharp(made).raw().toBuffer();
    return meta.format === 'heif';
  } catch {
    return false;
  }
}

let allowed: Promise<ReadonlySet<string>> | undefined;

/**
 * The photo types this server can actually decode, read from sharp at runtime: sharp.format for
 * each container, and for HEIF a round trip per codec, because sharp reports "heif" for both AVIF
 * (AV1, in the prebuilt binaries) and iPhone HEIC (HEVC, not in the prebuilt binaries). Anything
 * else is refused before it is stored, with words the buyer can act on.
 */
export function allowedPhotoTypes(): Promise<ReadonlySet<string>> {
  allowed ??= (async () => {
    const f = sharp.format as unknown as Record<string, { input?: { buffer?: boolean } } | undefined>;
    const can = (k: string) => Boolean(f[k]?.input?.buffer);
    const out = new Set<string>();
    if (can('jpeg')) out.add('image/jpeg');
    if (can('png')) out.add('image/png');
    if (can('webp')) out.add('image/webp');
    if (can('gif')) out.add('image/gif');
    if (can('tiff')) out.add('image/tiff');
    if (can('heif')) {
      if (await heifRoundTrip('av1')) out.add('image/avif');
      if (await heifRoundTrip('hevc')) {
        out.add('image/heic');
        out.add('image/heif');
      }
    }
    return out;
  })();
  return allowed;
}

/** The type the bytes really are, from sharp's own reading of them (the browser's label can be wrong or empty). */
function mimeOf(meta: Metadata): string | null {
  switch (meta.format) {
    case 'jpeg':
    case 'png':
    case 'webp':
    case 'gif':
    case 'tiff':
      return `image/${meta.format}`;
    case 'heif':
      return meta.compression === 'av1' ? 'image/avif' : 'image/heic';
    default:
      return null;
  }
}

/**
 * Normalise a photo before it is stored or sent anywhere: check it is a type this server decodes,
 * apply the EXIF orientation, then re-encode without metadata, which drops GPS location and camera
 * serials. Capped at 2000 px. A damaged file, or a type that can't be decoded here, throws
 * UnreadablePhotoError; nothing is stored.
 */
export async function sanitisePhoto(input: Buffer): Promise<Buffer> {
  if (input.byteLength > MAX_PHOTO_BYTES) throw new PhotoTooLargeError();
  if (input.byteLength === 0) throw new UnreadablePhotoError('empty');
  let meta: Metadata;
  try {
    meta = await sharp(input).metadata();
  } catch {
    throw new UnreadablePhotoError('not an image');
  }
  const mime = mimeOf(meta);
  if (!mime || !(await allowedPhotoTypes()).has(mime)) throw new UnreadablePhotoError(`unsupported ${mime ?? meta.format ?? 'format'}`);
  try {
    return await sharp(input, { failOn: 'error' })
      .rotate()
      .resize({ width: 2000, height: 2000, fit: 'inside', withoutEnlargement: true })
      .jpeg({ quality: 88, mozjpeg: true })
      .toBuffer();
  } catch {
    throw new UnreadablePhotoError(`damaged ${mime}`);
  }
}

export async function putBlob(bytes: Buffer, mime: string, ownerId: string | null): Promise<StoredBlob> {
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  const id = newId('blb');
  await db().insert(tables.blobs).values({ id, ownerId, sha256, mime, bytes, size: bytes.byteLength });
  return { id, sha256, mime, size: bytes.byteLength };
}

export interface StoredBlob {
  id: string;
  sha256: string;
  mime: string;
  size: number;
}

export async function getBlob(id: string): Promise<{ bytes: Buffer; mime: string; sha256: string; ownerId: string | null } | null> {
  const [b] = await db().select().from(tables.blobs).where(eq(tables.blobs.id, id)).limit(1);
  if (!b?.bytes) return null;
  return { bytes: b.bytes, mime: b.mime, sha256: b.sha256, ownerId: b.ownerId };
}

/** Which of these photos still exist; a buyer may have deleted them, or retention removed them. */
export async function existingBlobIds(ids: string[]): Promise<Set<string>> {
  if (!ids.length) return new Set();
  const rows = await db().select({ id: tables.blobs.id }).from(tables.blobs).where(inArray(tables.blobs.id, ids));
  return new Set(rows.map((r) => r.id));
}
