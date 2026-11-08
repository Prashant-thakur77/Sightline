import { createHmac, timingSafeEqual } from 'node:crypto';
import { RECEIPT, hashObject, isHexHash, utf8 } from './hash';

/**
 * A receipt is the body, its domain-separated hash, and an HMAC-SHA256 over that hash.
 * Anyone holding the body can recompute the hash; only the key holder can produce the signature.
 */
export interface SignedReceipt<B = unknown> {
  body: B;
  hash: string;
  signature: string;
}

export type ReceiptVerification =
  | { ok: true }
  | { ok: false; reason: 'malformed' | 'invalid_key' | 'hash_mismatch' | 'bad_signature' };

export const MIN_RECEIPT_KEY_BYTES = 32;

function keyBytes(key: string | Uint8Array): Uint8Array {
  return typeof key === 'string' ? utf8(key) : key;
}

function hmacHex(key: Uint8Array, hash: string): string {
  return createHmac('sha256', key).update(hash, 'utf8').digest('hex');
}

export function receiptHash(body: unknown): string {
  return hashObject(RECEIPT, body);
}

export function signReceipt<B>(body: B, key: string | Uint8Array): SignedReceipt<B> {
  const k = keyBytes(key);
  if (k.length < MIN_RECEIPT_KEY_BYTES) {
    throw new Error(`Receipt signing key must be at least ${MIN_RECEIPT_KEY_BYTES} bytes`);
  }
  const hash = receiptHash(body);
  return { body, hash, signature: hmacHex(k, hash) };
}

/** Recompute both the hash and the signature; a receipt passes only if both match. */
export function verifyReceipt(receipt: SignedReceipt<unknown>, key: string | Uint8Array): ReceiptVerification {
  if (!receipt || typeof receipt !== 'object' || !('body' in receipt)) return { ok: false, reason: 'malformed' };
  if (!isHexHash(receipt.hash) || !isHexHash(receipt.signature)) return { ok: false, reason: 'malformed' };
  const k = keyBytes(key);
  if (k.length < MIN_RECEIPT_KEY_BYTES) return { ok: false, reason: 'invalid_key' };

  let recomputed: string;
  try {
    recomputed = receiptHash(receipt.body);
  } catch {
    return { ok: false, reason: 'malformed' };
  }
  if (recomputed !== receipt.hash) return { ok: false, reason: 'hash_mismatch' };

  const expected = Buffer.from(hmacHex(k, recomputed), 'hex');
  const given = Buffer.from(receipt.signature, 'hex');
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) {
    return { ok: false, reason: 'bad_signature' };
  }
  return { ok: true };
}
