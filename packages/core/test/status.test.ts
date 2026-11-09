import { describe, expect, it } from 'vitest';
import { paymentStatus, reasonForSeller, verdictStatus, caseStatus } from '../src';

const base = { intent: 'AUTHORIZE', status: 'delivered', paypalOrderId: 'PO1', authorizationId: 'AU1', captureId: null };

describe('shared status vocabulary', () => {
  it('never says on hold without a PayPal order', () => {
    expect(paymentStatus({ ...base, paypalOrderId: null }).word).toBe('Not paid');
    expect(paymentStatus(base).word).toBe('On hold');
  });
  it('decides from PayPal state, not delivery', () => {
    expect(paymentStatus({ ...base, captureId: 'CA1' }).word).toBe('Paid');
    expect(paymentStatus({ ...base, status: 'voided' }).word).toBe('Hold released');
    expect(paymentStatus({ ...base, status: 'confirmed' }).word).toBe('Checking with PayPal');
  });
  it('has a glyph for every verdict and case stage', () => {
    expect(verdictStatus('unsure').glyph).toBe('?');
    expect(verdictStatus(null).word).toBe('Not checked');
    expect(caseStatus('seller_contacted').word).toBe('Waiting for the store');
    expect(caseStatus('accepted').word).toBe('Offer accepted');
    expect(caseStatus('declined').word).toBe('Offer declined');
  });
  it('writes reasons in the third person for sellers', () => {
    const s = reasonForSeller({ module: 'size', finding: 'disagree', confidence: 'fairly_sure', expected: 'M', observed: 'L', sentence: '' });
    expect(s).toBe('The size tag reads L; the order was for M (fairly sure).');
    expect(s).not.toMatch(/\byou\b/i);
  });
});
