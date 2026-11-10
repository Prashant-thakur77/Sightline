import { describe, expect, it } from 'vitest';
import { webhookWords } from '@/server/webhook-log';

describe('webhook log words', () => {
  it('says what PayPal did in plain words, and keeps unknown types as PayPal names them', () => {
    expect(webhookWords('PAYMENT.AUTHORIZATION.CREATED')).toBe('PayPal put the money on hold');
    expect(webhookWords('PAYMENT.AUTHORIZATION.VOIDED')).toBe('PayPal released the hold');
    expect(webhookWords('PAYMENT.CAPTURE.COMPLETED')).toBe('PayPal paid the store');
    expect(webhookWords('SOMETHING.NEW')).toBe('SOMETHING.NEW');
  });
});
