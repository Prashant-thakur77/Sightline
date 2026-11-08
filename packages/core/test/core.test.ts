import { describe, expect, it } from 'vitest';
import { addMoney, formatMoney, formatMoneyShort, parseMoney, toDecimalString, spokenDate, addBusinessDays, newId } from '../src';
import { assertSandbox, loadEnv, SandboxOnlyError } from '../src/env';

describe('money', () => {
  it('parses decimal strings without float drift', () => {
    expect(parseMoney('36.72').cents).toBe(3672);
    expect(parseMoney('0.1').cents).toBe(10);
    expect(parseMoney('34').cents).toBe(3400);
    expect(parseMoney(19.99).cents).toBe(1999);
    expect(() => parseMoney('3.999')).toThrow();
  });
  it('round-trips to PayPal decimal strings', () => {
    expect(toDecimalString(parseMoney('36.72'))).toBe('36.72');
    expect(toDecimalString({ cents: 5, currency: 'USD' })).toBe('0.05');
  });
  it('adds and formats', () => {
    const t = addMoney(parseMoney('34'), parseMoney('2.72'));
    expect(formatMoney(t)).toBe('$36.72');
    expect(formatMoneyShort(parseMoney('34'))).toBe('$34');
    expect(() => addMoney({ cents: 1, currency: 'USD' }, { cents: 1, currency: 'EUR' })).toThrow();
  });
});

describe('dates', () => {
  it('speaks dates as weekday day month', () => {
    expect(spokenDate('2026-11-17T12:00:00Z')).toBe('Tuesday 17 November');
  });
  it('skips weekends for business days', () => {
    const fri = new Date('2026-11-13T12:00:00Z');
    expect(addBusinessDays(fri, 1).toISOString().slice(0, 10)).toBe('2026-11-16');
  });
});

describe('ids', () => {
  it('are prefixed and unique', () => {
    const a = newId('ord');
    const b = newId('ord');
    expect(a).toMatch(/^ord_[0-9a-z]{22}$/);
    expect(a).not.toBe(b);
  });
});

describe('sandbox boot assertion', () => {
  it('accepts the sandbox base', () => {
    expect(() => assertSandbox({ PAYPAL_ENV: 'sandbox', PAYPAL_API_BASE: 'https://api-m.sandbox.paypal.com' })).not.toThrow();
  });
  it('refuses live', () => {
    expect(() => assertSandbox({ PAYPAL_ENV: 'live', PAYPAL_API_BASE: 'https://api-m.paypal.com' })).toThrow(SandboxOnlyError);
    expect(() => assertSandbox({ PAYPAL_ENV: 'sandbox', PAYPAL_API_BASE: 'https://api-m.paypal.com' })).toThrow(SandboxOnlyError);
    expect(() => loadEnv({ PAYPAL_API_BASE: 'https://api-m.paypal.com' })).toThrow(SandboxOnlyError);
  });
  it('treats empty strings as missing', () => {
    expect(loadEnv({ ANTHROPIC_API_KEY: '' }).ANTHROPIC_API_KEY).toBeUndefined();
  });
});
