import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { RECEIPT, hashObject, receiptHash, signReceipt, verifyReceipt } from '../src';

const KEY = 'test-receipt-key-0123456789abcdef0123456789'; // gitleaks:allow (test fixture, not a secret)
const OTHER = 'other-receipt-key-0123456789abcdef012345678';
const body = { kind: 'gate', allowed: true, amount: { cents: 3672, currency: 'USD' }, lines: [{ q: 1 }] };

describe('signed receipts', () => {
  it('hash is hashObject(RECEIPT, body) and signature is HMAC-SHA256(key, hash)', () => {
    const r = signReceipt(body, KEY);
    expect(r.hash).toBe(hashObject(RECEIPT, body));
    expect(r.signature).toBe(createHmac('sha256', KEY).update(r.hash).digest('hex'));
    expect(verifyReceipt(r, KEY)).toEqual({ ok: true });
  });

  it('verifies after a JSON round trip and with keys in another order', () => {
    const r = signReceipt(body, KEY);
    const copy = JSON.parse(JSON.stringify(r));
    expect(verifyReceipt(copy, KEY)).toEqual({ ok: true });
    const reordered = { ...r, body: { lines: [{ q: 1 }], amount: { currency: 'USD', cents: 3672 }, allowed: true, kind: 'gate' } };
    expect(verifyReceipt(reordered, KEY)).toEqual({ ok: true });
  });

  it('detects a body edit', () => {
    const r = signReceipt(body, KEY);
    const tampered = { ...r, body: { ...body, amount: { cents: 1, currency: 'USD' } } };
    expect(verifyReceipt(tampered, KEY)).toEqual({ ok: false, reason: 'hash_mismatch' });
  });

  it('detects a body edit even when the attacker re-hashes it without the key', () => {
    const r = signReceipt(body, KEY);
    const newBody = { ...body, allowed: false };
    expect(verifyReceipt({ body: newBody, hash: receiptHash(newBody), signature: r.signature }, KEY)).toEqual({
      ok: false,
      reason: 'bad_signature',
    });
  });

  it('detects a signature edit', () => {
    const r = signReceipt(body, KEY);
    const flipped = (r.signature[0] === 'a' ? 'b' : 'a') + r.signature.slice(1);
    expect(verifyReceipt({ ...r, signature: flipped }, KEY)).toEqual({ ok: false, reason: 'bad_signature' });
  });

  it('detects the wrong key', () => {
    expect(verifyReceipt(signReceipt(body, KEY), OTHER)).toEqual({ ok: false, reason: 'bad_signature' });
  });

  it('refuses short keys and malformed receipts', () => {
    expect(() => signReceipt(body, 'short')).toThrow();
    expect(verifyReceipt(signReceipt(body, KEY), 'short')).toEqual({ ok: false, reason: 'invalid_key' });
    expect(verifyReceipt({ body, hash: 'x', signature: 'y' }, KEY)).toEqual({ ok: false, reason: 'malformed' });
    // @ts-expect-error not a receipt
    expect(verifyReceipt(null, KEY)).toEqual({ ok: false, reason: 'malformed' });
  });

  it('accepts a byte key', () => {
    const key = new Uint8Array(32).fill(7);
    expect(verifyReceipt(signReceipt(body, key), key)).toEqual({ ok: true });
  });
});
