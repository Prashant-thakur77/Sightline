import { createPrivateKey, createPublicKey, sign, verify, type KeyObject } from 'node:crypto';
import { RECEIPT, hashObject, hashDomain } from './hash';

/**
 * Ed25519 signatures over receipt and evidence hashes, so anyone can verify them offline with
 * the published public key, without trusting the server. The key pair is derived from a 32-byte
 * seed (RECEIPT_SIGNING_KEY, hex), so every process derives the same key.
 */

const PKCS8_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');
const SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');

export interface Ed25519KeyPair {
  privateKey: KeyObject;
  publicKey: KeyObject;
  /** Raw 32-byte public key, hex. */
  publicKeyHex: string;
  /** Short fingerprint people can compare by eye. */
  fingerprint: string;
}

export function keyPairFromSeed(seedHex: string, context = 'receipts'): Ed25519KeyPair {
  if (!/^[0-9a-f]{64,}$/i.test(seedHex)) throw new Error('Signing seed must be at least 32 bytes of hex');
  // Domain-separate the seed so the HMAC key and the Ed25519 key are never the same bytes.
  const seed = Buffer.from(hashDomain(`ed25519-seed-${context}`, Buffer.from(seedHex, 'hex')), 'hex');
  const privateKey = createPrivateKey({ key: Buffer.concat([PKCS8_PREFIX, seed]), format: 'der', type: 'pkcs8' });
  const publicKey = createPublicKey(privateKey);
  const raw = publicKey.export({ format: 'der', type: 'spki' }).subarray(SPKI_PREFIX.length);
  const publicKeyHex = Buffer.from(raw).toString('hex');
  return { privateKey, publicKey, publicKeyHex, fingerprint: hashDomain('ed25519-fingerprint', raw).slice(0, 16) };
}

export function publicKeyFromHex(hex: string): KeyObject {
  if (!/^[0-9a-f]{64}$/i.test(hex)) throw new Error('Public key must be 32 bytes of hex');
  return createPublicKey({ key: Buffer.concat([SPKI_PREFIX, Buffer.from(hex, 'hex')]), format: 'der', type: 'spki' });
}

/** Sign a hex hash (the message is the ASCII hex string). Returns base64url. */
export function signHash(hash: string, keys: Pick<Ed25519KeyPair, 'privateKey'>): string {
  return sign(null, Buffer.from(hash, 'utf8'), keys.privateKey).toString('base64url');
}

export function verifyHashSignature(hash: string, signature: string, publicKey: KeyObject | string): boolean {
  try {
    const key = typeof publicKey === 'string' ? publicKeyFromHex(publicKey) : publicKey;
    return verify(null, Buffer.from(hash, 'utf8'), key, Buffer.from(signature, 'base64url'));
  } catch {
    return false;
  }
}

export interface PublicReceipt<B = unknown> {
  body: B;
  hash: string;
  /** Ed25519 over `hash`, base64url. */
  ed25519: string;
  publicKey: string;
}

export function signPublicReceipt<B>(body: B, keys: Ed25519KeyPair): PublicReceipt<B> {
  const hash = hashObject(RECEIPT, body);
  return { body, hash, ed25519: signHash(hash, keys), publicKey: keys.publicKeyHex };
}

export type PublicReceiptCheck =
  | { ok: true }
  | { ok: false; reason: 'hash_mismatch' | 'bad_signature' | 'unexpected_key' };

/** Recompute the hash from the body and check the signature. Optionally pin the expected key. */
export function verifyPublicReceipt(r: PublicReceipt, expectedPublicKey?: string): PublicReceiptCheck {
  if (expectedPublicKey && expectedPublicKey.toLowerCase() !== r.publicKey.toLowerCase()) return { ok: false, reason: 'unexpected_key' };
  if (hashObject(RECEIPT, r.body) !== r.hash) return { ok: false, reason: 'hash_mismatch' };
  if (!verifyHashSignature(r.hash, r.ed25519, r.publicKey)) return { ok: false, reason: 'bad_signature' };
  return { ok: true };
}
