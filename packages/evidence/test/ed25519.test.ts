import { describe, expect, it } from 'vitest';
import { keyPairFromSeed, signHash, signPublicReceipt, verifyHashSignature, verifyPublicReceipt } from '../src';

const seed = 'a'.repeat(64);

describe('ed25519 receipts', () => {
  it('derives the same key pair from the same seed and a different one per context', () => {
    expect(keyPairFromSeed(seed).publicKeyHex).toBe(keyPairFromSeed(seed).publicKeyHex);
    expect(keyPairFromSeed(seed, 'evidence').publicKeyHex).not.toBe(keyPairFromSeed(seed).publicKeyHex);
    expect(keyPairFromSeed(seed).publicKeyHex).toMatch(/^[0-9a-f]{64}$/);
  });
  it('rejects short seeds', () => {
    expect(() => keyPairFromSeed('abcd')).toThrow();
  });
  it('signs and verifies a hash, and fails on any change', () => {
    const k = keyPairFromSeed(seed);
    const h = 'f'.repeat(64);
    const sig = signHash(h, k);
    expect(verifyHashSignature(h, sig, k.publicKeyHex)).toBe(true);
    expect(verifyHashSignature('e'.repeat(64), sig, k.publicKeyHex)).toBe(false);
    expect(verifyHashSignature(h, sig, keyPairFromSeed('b'.repeat(64)).publicKeyHex)).toBe(false);
    expect(verifyHashSignature(h, 'not-a-signature', k.publicKeyHex)).toBe(false);
  });
  it('public receipts verify offline and detect tampering', () => {
    const k = keyPairFromSeed(seed);
    const r = signPublicReceipt({ order: 'ord_1', amount: { cents: 3672, currency: 'USD' } }, k);
    expect(verifyPublicReceipt(r)).toEqual({ ok: true });
    expect(verifyPublicReceipt(r, k.publicKeyHex)).toEqual({ ok: true });
    expect(verifyPublicReceipt({ ...r, body: { order: 'ord_1', amount: { cents: 1, currency: 'USD' } } })).toEqual({ ok: false, reason: 'hash_mismatch' });
    const other = keyPairFromSeed('c'.repeat(64));
    expect(verifyPublicReceipt({ ...r, publicKey: other.publicKeyHex })).toEqual({ ok: false, reason: 'bad_signature' });
    expect(verifyPublicReceipt(r, other.publicKeyHex)).toEqual({ ok: false, reason: 'unexpected_key' });
  });
});
