import type { Money, OrderStatus, ProductSnapshot, Readback, Verdict } from '@sightline/core';
import { EVIDENCE_FILE, EVIDENCE_MANIFEST, hashDomain, hashObject, isHexHash } from './hash';
import { hashReadbackText, hashSnapshot } from './subjects';

export const EVIDENCE_SCHEMA = 'sightline.evidence/v1' as const;

export interface EvidenceOrder {
  id: string;
  paypalOrderId?: string;
  captureId?: string;
  status: OrderStatus;
  amount: Money;
  payee: { merchantId: string; name?: string };
  placedAt: string;
  /** PayPal-Request-Id used to create the order. */
  requestId?: string;
  /** Hash of the gate receipt that allowed the payment. */
  gateReceiptHash?: string;
}

/** A photo going into the pack: either the bytes, or the EVIDENCE_FILE hash computed earlier. */
export interface EvidencePhotoInput {
  name: string;
  mime: string;
  /** When the photo was taken (from EXIF when available), ISO 8601. */
  takenAt: string;
  bytes?: Uint8Array;
  /** `hashEvidenceFile(bytes)`, for files already in object storage. */
  sha256?: string;
}

export interface EvidenceFileEntry {
  name: string;
  mime: string;
  takenAt: string;
  /** hashDomain(EVIDENCE_FILE, bytes). */
  hash: string;
  /** Byte length, when the bytes were available at build time. */
  size?: number;
}

export interface EvidenceManifest<V = Verdict> {
  schema: typeof EVIDENCE_SCHEMA;
  createdAt?: string;
  order: EvidenceOrder;
  /** The readback exactly as spoken, with its text hash and the cart hash it was bound to. */
  readback: Readback;
  /** The frozen listing the order was placed against. */
  snapshot: ProductSnapshot;
  files: EvidenceFileEntry[];
  verification: V;
  narrative: string;
}

export interface BuiltManifest<V = Verdict> {
  manifest: EvidenceManifest<V>;
  manifestHash: string;
}

export interface BuildManifestInput<V = Verdict> {
  order: EvidenceOrder;
  readback: Readback;
  snapshot: ProductSnapshot;
  photos: EvidencePhotoInput[];
  verification: V;
  narrative: string;
  createdAt?: string;
}

export interface EvidenceFileBytes {
  name: string;
  bytes: Uint8Array;
}

export interface ManifestVerification {
  ok: boolean;
  /** Recomputed hash of the manifest, or null when the manifest could not be serialised. */
  manifestHash: string | null;
  /** Every problem found, in a stable order. Empty when ok. */
  problems: string[];
  /** How many file entries were checked against supplied bytes. */
  filesChecked: number;
}

export function hashEvidenceFile(bytes: Uint8Array): string {
  return hashDomain(EVIDENCE_FILE, bytes);
}

export function hashManifest(manifest: EvidenceManifest<unknown>): string {
  return hashObject(EVIDENCE_MANIFEST, manifest);
}

function fileEntry(photo: EvidencePhotoInput): EvidenceFileEntry {
  if (!photo.name) throw new Error('Evidence file needs a name');
  let hash: string;
  if (photo.bytes) {
    hash = hashEvidenceFile(photo.bytes);
    if (photo.sha256 !== undefined && photo.sha256 !== hash) {
      throw new Error(`Evidence file "${photo.name}": bytes do not match the supplied hash`);
    }
  } else if (isHexHash(photo.sha256)) {
    hash = photo.sha256;
  } else {
    throw new Error(`Evidence file "${photo.name}" needs bytes or a hex SHA-256`);
  }
  return {
    name: photo.name,
    mime: photo.mime,
    takenAt: photo.takenAt,
    hash,
    size: photo.bytes ? photo.bytes.length : undefined,
  };
}

/**
 * Build the evidence manifest. Snapshot and readback are embedded whole rather than summarised,
 * so a holder of the pack can recompute their hashes instead of trusting a summary.
 * Refuses to build from a snapshot or readback whose own hash does not recompute.
 */
export function buildManifest<V = Verdict>(input: BuildManifestInput<V>): BuiltManifest<V> {
  if (hashSnapshot(input.snapshot) !== input.snapshot.hash) {
    throw new Error('Snapshot hash does not match its contents');
  }
  if (hashReadbackText(input.readback.text) !== input.readback.textHash) {
    throw new Error('Readback text hash does not match the text');
  }
  const names = new Set<string>();
  for (const p of input.photos) {
    if (names.has(p.name)) throw new Error(`Duplicate evidence file name "${p.name}"`);
    names.add(p.name);
  }
  const manifest: EvidenceManifest<V> = {
    schema: EVIDENCE_SCHEMA,
    createdAt: input.createdAt,
    order: input.order,
    readback: input.readback,
    snapshot: input.snapshot,
    files: input.photos.map(fileEntry),
    verification: input.verification,
    narrative: input.narrative,
  };
  return { manifest, manifestHash: hashManifest(manifest) };
}

function isBuilt(v: unknown): v is BuiltManifest<unknown> {
  return !!v && typeof v === 'object' && 'manifest' in v && 'manifestHash' in v;
}

/**
 * Re-check a manifest. Pass the `{ manifest, manifestHash }` pair to check the stored hash too,
 * and any file bytes you hold to check them against their entries. Every check runs, so a bad
 * pack reports everything that is wrong with it, not only the first thing.
 */
export function verifyManifest(
  input: BuiltManifest<unknown> | EvidenceManifest<unknown>,
  files: readonly EvidenceFileBytes[] = [],
): ManifestVerification {
  const manifest = isBuilt(input) ? input.manifest : input;
  const problems: string[] = [];
  let filesChecked = 0;

  if (!manifest || typeof manifest !== 'object') {
    return { ok: false, manifestHash: null, problems: ['malformed'], filesChecked };
  }

  let manifestHash: string | null = null;
  try {
    manifestHash = hashManifest(manifest);
  } catch {
    problems.push('malformed');
  }

  if (manifest.schema !== EVIDENCE_SCHEMA) problems.push('schema');
  if (isBuilt(input) && manifestHash !== null && input.manifestHash !== manifestHash) {
    problems.push('manifest_hash_mismatch');
  }

  try {
    if (hashSnapshot(manifest.snapshot) !== manifest.snapshot.hash) problems.push('snapshot_hash_mismatch');
  } catch {
    problems.push('snapshot_malformed');
  }
  try {
    if (hashReadbackText(manifest.readback.text) !== manifest.readback.textHash) {
      problems.push('readback_text_hash_mismatch');
    }
  } catch {
    problems.push('readback_malformed');
  }

  const entries = new Map<string, EvidenceFileEntry>();
  for (const entry of Array.isArray(manifest.files) ? manifest.files : []) {
    if (entries.has(entry.name)) problems.push(`duplicate_file_name:${entry.name}`);
    if (!isHexHash(entry.hash)) problems.push(`file_hash_malformed:${entry.name}`);
    entries.set(entry.name, entry);
  }
  for (const f of files) {
    const entry = entries.get(f.name);
    if (!entry) {
      problems.push(`unknown_file:${f.name}`);
      continue;
    }
    filesChecked++;
    if (hashEvidenceFile(f.bytes) !== entry.hash) problems.push(`file_hash_mismatch:${f.name}`);
    else if (entry.size !== undefined && entry.size !== f.bytes.length) problems.push(`file_size_mismatch:${f.name}`);
  }

  return { ok: problems.length === 0, manifestHash, problems, filesChecked };
}
