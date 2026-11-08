import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  CART,
  DOMAIN,
  RECEIPT,
  SNAPSHOT,
  canonicalJson,
  domainPrefix,
  hashCart,
  hashDomain,
  hashObject,
  hashReadbackBinding,
  hashReadbackText,
  hashSnapshot,
} from '../src';
import { readback, snapshot } from './fixtures';

describe('hashDomain', () => {
  it('matches known answers computed by an independent implementation', () => {
    expect(hashDomain(CART, 'hello')).toBe('1d46a59ea7a392df9982be22e4ce9d005a00e68f789748ef4c9f64f60f19186e');
    expect(hashObject(RECEIPT, { b: [true, null], a: 1 })).toBe(
      'e38e7ced842d3ad9bc4f0e4d0b7fa052cb02bc8542c57c2111cacf6b43bfb352',
    );
  });

  it('hashes u32be(len(tag)) || tag || 0x00 || data', () => {
    const tag = Buffer.from('SIGHTLINE/v1/snapshot', 'utf8');
    const len = Buffer.alloc(4);
    len.writeUInt32BE(tag.length);
    const expected = createHash('sha256')
      .update(Buffer.concat([len, tag, Buffer.of(0), Buffer.from('payload')]))
      .digest('hex');
    expect(hashDomain(SNAPSHOT, 'payload')).toBe(expected);
    expect(Array.from(domainPrefix('snapshot').slice(0, 4))).toEqual([0, 0, 0, tag.length]);
  });

  it('treats a string and its UTF-8 bytes the same', () => {
    expect(hashDomain(CART, 'café 😀')).toBe(hashDomain(CART, new TextEncoder().encode('café 😀')));
  });

  it('is stable: lowercase hex, 64 characters, same input same output', () => {
    const a = hashObject(CART, { x: [1, 2, 3] });
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(hashObject(CART, { x: [1, 2, 3] })).toBe(a);
  });

  it('separates domains: same data, different domain, different hash', () => {
    const hashes = Object.values(DOMAIN).map((d) => hashDomain(d, 'same bytes'));
    expect(new Set(hashes).size).toBe(Object.values(DOMAIN).length);
    expect(hashDomain(SNAPSHOT, 'x')).not.toBe(hashDomain(CART, 'x'));
    expect(hashDomain(CART, 'x')).not.toBe(createHash('sha256').update('x').digest('hex'));
  });

  it('cannot be confused by moving bytes across the domain boundary', () => {
    expect(hashDomain('ab', 'c')).not.toBe(hashDomain('a', 'bc'));
  });

  it('hashObject equals hashDomain over the canonical form, regardless of key order', () => {
    const v = { b: 2, a: { d: 4, c: 3 } };
    expect(hashObject(CART, v)).toBe(hashDomain(CART, canonicalJson(v)));
    expect(hashObject(CART, v)).toBe(hashObject(CART, { a: { c: 3, d: 4 }, b: 2 }));
  });

  it('refuses empty or ambiguous domain names', () => {
    expect(() => hashDomain('', 'x')).toThrow();
    expect(() => hashDomain('Cart', 'x')).toThrow();
    expect(() => hashDomain('a/b', 'x')).toThrow();
  });
});

describe('subject hashes', () => {
  it('snapshot hash covers every field but itself', () => {
    const s = snapshot();
    expect(hashSnapshot(s)).toBe(s.hash);
    expect(hashSnapshot({ ...s, hash: 'anything' })).toBe(s.hash);
    expect(hashSnapshot({ ...s, price: { cents: 3900, currency: 'USD' } })).not.toBe(s.hash);
    expect(hashSnapshot({ ...s, seller: { ...s.seller, merchantId: 'OTHER' } })).not.toBe(s.hash);
  });

  it('cart hash changes with quantity, price, totals or owner', () => {
    const s = snapshot();
    const totals = {
      items: { cents: 3400, currency: 'USD' },
      shipping: { cents: 0, currency: 'USD' },
      tax: { cents: 0, currency: 'USD' },
      total: { cents: 3400, currency: 'USD' },
    };
    const base = hashCart({ userId: 'u', lines: [{ snapshot: s, quantity: 1 }], totals });
    expect(hashCart({ userId: 'u', lines: [{ snapshot: s, quantity: 2 }], totals })).not.toBe(base);
    expect(hashCart({ userId: 'v', lines: [{ snapshot: s, quantity: 1 }], totals })).not.toBe(base);
    expect(
      hashCart({ userId: 'u', lines: [{ snapshot: snapshot({ price: { cents: 1, currency: 'USD' } }), quantity: 1 }], totals }),
    ).not.toBe(base);
    expect(
      hashCart({ userId: 'u', lines: [{ snapshot: s, quantity: 1 }], totals: { ...totals, tax: { cents: 1, currency: 'USD' } } }),
    ).not.toBe(base);
  });

  it('readback text and binding hashes', () => {
    const rb = readback();
    expect(hashReadbackText(rb.text)).toBe(rb.textHash);
    const binding = hashReadbackBinding(rb);
    expect(hashReadbackBinding({ ...rb, cartHash: 'f'.repeat(64) })).not.toBe(binding);
    expect(hashReadbackBinding({ ...rb, id: 'rb_2' })).not.toBe(binding);
  });
});
