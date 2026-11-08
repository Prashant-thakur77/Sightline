import { describe, expect, it } from 'vitest';
import { refusalSentence, type GateCode } from '../src';
import { usd } from './fixtures';

const ALL_CODES: Exclude<GateCode, 'OK'>[] = [
  'ENV_NOT_SANDBOX',
  'INVALID_CLOCK',
  'UNSUPPORTED_MODE',
  'READBACK_MISSING',
  'READBACK_TAMPERED',
  'CART_TAMPERED',
  'READBACK_CART_MISMATCH',
  'USER_MISMATCH',
  'NOT_CONFIRMED',
  'SINGLE_KEY_CONFIRMATION',
  'CONFIRMATION_OUT_OF_ORDER',
  'CONFIRMATION_EXPIRED',
  'CART_EMPTY',
  'INVALID_QUANTITY',
  'CURRENCY_MISMATCH',
  'AMOUNT_INVALID',
  'TOTALS_MISMATCH',
  'AMOUNT_MISMATCH',
  'PAYEE_NOT_ALLOWED',
  'PAYEE_MISMATCH',
  'MULTIPLE_SELLERS',
  'LIMITS_UNAVAILABLE',
  'OVER_ORDER_LIMIT',
  'OVER_DAILY_LIMIT',
  'DUPLICATE_ORDER',
  'RATE_LIMITED',
  'SNAPSHOT_STALE',
  'SNAPSHOT_TIME_INVALID',
  'PRICE_CHANGED',
  'LISTING_CHANGED',
  'LISTING_UNAVAILABLE',
  'RECEIPT_WRITE_FAILED',
  'GUARD_ERROR',
];

describe('refusalSentence', () => {
  it('per-order limit', () => {
    expect(refusalSentence('OVER_ORDER_LIMIT', { limit: usd(10_000), amount: usd(12_000) })).toBe(
      "That's over your $100 limit for one order. You can raise the limit in settings, or pick something else.",
    );
  });

  it('duplicate', () => {
    expect(refusalSentence('DUPLICATE_ORDER', { ageMs: 60_000 })).toBe(
      "You already bought this a minute ago, so I didn't charge you again.",
    );
    expect(refusalSentence('DUPLICATE_ORDER', { ageMs: 5_000 })).toBe(
      "You already bought this just now, so I didn't charge you again.",
    );
    expect(refusalSentence('DUPLICATE_ORDER', { ageMs: 7 * 60_000 })).toContain('7 minutes ago');
  });

  it('price changed', () => {
    expect(refusalSentence('PRICE_CHANGED', { from: usd(3400), to: usd(3900) })).toBe(
      "The price changed from $34 to $39 since I read it to you. I'll read the new total.",
    );
  });

  it('daily limit says what is left', () => {
    expect(refusalSentence('OVER_DAILY_LIMIT', { limit: usd(20_000), remaining: usd(4050) })).toBe(
      "That's over your $200 limit for today. You have $40.50 left today. You can raise the limit in settings, or try again tomorrow.",
    );
  });

  it.each(ALL_CODES)('%s: short, blame-free, and says what happens next', (code) => {
    const s = refusalSentence(code, {});
    expect(s.length).toBeGreaterThan(0);
    expect(s).not.toMatch(/undefined|null|NaN|\[object/);
    expect(s).not.toMatch(/\byou (failed|forgot|must|should have)\b|your fault|invalid|error|guard|%/i);
    for (const sentence of s.split(/(?<=[.?!])\s+/)) {
      expect(sentence.split(/\s+/).length, sentence).toBeLessThanOrEqual(22);
    }
    expect(s).toMatch(/didn't charge|weren't charged|didn't buy|didn't place|I'll|You can|Which one|Try again|Say|Tell me/);
  });

  it('falls back safely for an unknown code', () => {
    expect(refusalSentence('SOMETHING_NEW')).toBe("I couldn't complete the payment, so I didn't charge you. Your cart is saved.");
  });
});
