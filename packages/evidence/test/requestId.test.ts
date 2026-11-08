import { describe, expect, it } from 'vitest';
import { PAYPAL_REQUEST_ID_KINDS, base32Encode, paypalRequestId } from '../src';

describe('base32Encode', () => {
  it.each([
    ['', ''],
    ['f', 'my'],
    ['fo', 'mzxq'],
    ['foo', 'mzxw6'],
    ['foob', 'mzxw6yq'],
    ['fooba', 'mzxw6ytb'],
    ['foobar', 'mzxw6ytboi'],
  ])('RFC 4648 vector %j -> %s (lowercase, no padding)', (input, expected) => {
    expect(base32Encode(new TextEncoder().encode(input))).toBe(expected);
  });
});

describe('paypalRequestId', () => {
  it('matches known answers computed by an independent implementation', () => {
    expect(paypalRequestId('order', 'cart-hash-abc', 'rb_1')).toBe('wu2il7o5fiw6bi2mvnxf5m4g3ytuyxy345ox');
    expect(paypalRequestId('offer-accept', 'PP-D-123')).toBe('hsey7qiba7y6m5es4gqyckmxkiqb7slwr3hv');
  });

  it('is deterministic: same inputs, same id', () => {
    expect(paypalRequestId('capture', 'ORDER-1')).toBe(paypalRequestId('capture', 'ORDER-1'));
  });

  it('is 36 characters of the base32 alphabet for every kind', () => {
    for (const kind of PAYPAL_REQUEST_ID_KINDS) {
      expect(paypalRequestId(kind, 'x', 'y')).toMatch(/^[a-z2-7]{36}$/);
    }
  });

  it('differs by kind, by part, and by part order', () => {
    const ids = new Set(PAYPAL_REQUEST_ID_KINDS.map((k) => paypalRequestId(k, 'same')));
    expect(ids.size).toBe(PAYPAL_REQUEST_ID_KINDS.length);
    expect(paypalRequestId('order', 'a', 'b')).not.toBe(paypalRequestId('order', 'b', 'a'));
    expect(paypalRequestId('order', 'cart', 'rb_1')).not.toBe(paypalRequestId('order', 'cart', 'rb_2'));
  });

  it('keeps part boundaries: ["ab","c"] and ["a","bc"] differ', () => {
    expect(paypalRequestId('order', 'ab', 'c')).not.toBe(paypalRequestId('order', 'a', 'bc'));
  });

  it('refuses parts containing the separator, no parts, and unknown kinds', () => {
    expect(() => paypalRequestId('order', 'a\u001fb')).toThrow();
    expect(() => paypalRequestId('order')).toThrow();
    // @ts-expect-error unknown kind
    expect(() => paypalRequestId('payout', 'x')).toThrow();
  });
});
