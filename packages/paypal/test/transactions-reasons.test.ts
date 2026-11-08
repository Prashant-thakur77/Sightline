import type { Verdict } from '@sightline/core';
import { describe, expect, it } from 'vitest';
import {
  DISPUTE_REASONS,
  PayPalValidationError,
  buildTransactionQuery,
  disputeReasonFor,
  issueFromShippedVariant,
  issueFromVerdict,
  type SightlineIssue,
} from '../src';
import { transactionSearch } from './fixtures';
import { mockPayPal, testClient } from './helpers';

const NOW = Date.parse('2026-11-09T12:00:00Z');

describe('transaction search', () => {
  it('builds the query with ISO dates and all fields', () => {
    const q = buildTransactionQuery(
      {
        startDate: '2026-10-15T00:00:00Z',
        endDate: '2026-11-09T00:00:00Z',
        transactionId: '5TY05013RG002845M',
      },
      NOW,
    );
    expect(q).toEqual({
      start_date: '2026-10-15T00:00:00.000Z',
      end_date: '2026-11-09T00:00:00.000Z',
      fields: 'all',
      transaction_id: '5TY05013RG002845M',
    });
  });

  it('enforces the 31-day window, ordering and 3-year history', () => {
    expect(() =>
      buildTransactionQuery({ startDate: '2026-10-01T00:00:00Z', endDate: '2026-11-02T00:00:01Z' }, NOW),
    ).toThrow(/31 days/);
    expect(() =>
      buildTransactionQuery({ startDate: '2026-10-01T00:00:00Z', endDate: '2026-11-01T00:00:00Z' }, NOW),
    ).not.toThrow();
    expect(() =>
      buildTransactionQuery({ startDate: '2026-11-02T00:00:00Z', endDate: '2026-11-01T00:00:00Z' }, NOW),
    ).toThrow(/after/);
    expect(() =>
      buildTransactionQuery({ startDate: '2023-11-01T00:00:00Z', endDate: '2023-11-20T00:00:00Z' }, NOW),
    ).toThrow(/3 years/);
    expect(() =>
      buildTransactionQuery({ startDate: 'yesterday', endDate: '2026-11-01T00:00:00Z' }, NOW),
    ).toThrow(PayPalValidationError);
    expect(() =>
      buildTransactionQuery(
        { startDate: '2026-11-01T00:00:00Z', endDate: '2026-11-02T00:00:00Z', pageSize: 501 },
        NOW,
      ),
    ).toThrow(/500/);
  });

  it('calls GET /v1/reporting/transactions and parses details', async () => {
    const mock = mockPayPal().on('GET', '/v1/reporting/transactions', {
      status: 200,
      json: transactionSearch,
    });
    const res = await testClient(mock).client.transactions.search({
      startDate: '2026-10-15T00:00:00Z',
      endDate: '2026-11-09T00:00:00Z',
    });
    expect(res.transaction_details[0]!.transaction_info.custom_field).toBe('rb_9f2c');
    expect(mock.api()[0]!.query.get('fields')).toBe('all');
    expect(mock.api()[0]!.headers['paypal-auth-assertion']).toBeUndefined();
  });

  it('can search as the buyer with the auth assertion (spike S1)', async () => {
    const mock = mockPayPal().on('GET', '/v1/reporting/transactions', {
      status: 200,
      json: transactionSearch,
    });
    const buyer = testClient(mock).client.buyer({ email: 'b@personal.example.com' });
    await buyer.searchTransactions({ startDate: '2026-10-15T00:00:00Z', endDate: '2026-11-09T00:00:00Z' });
    expect(mock.api()[0]!.headers['paypal-auth-assertion']).toBe(buyer.authAssertion);
  });
});

describe('dispute reason mapping', () => {
  it('maps item problems to not-as-described with issue type PRODUCT', () => {
    for (const i of ['wrong_colour', 'wrong_size', 'wrong_model', 'damaged'] as SightlineIssue[])
      expect(disputeReasonFor(i)).toEqual({
        reason: 'MERCHANDISE_OR_SERVICE_NOT_AS_DESCRIBED',
        issueType: 'PRODUCT',
      });
  });

  it('maps non-arrival, double charge and wrong amount', () => {
    expect(disputeReasonFor('never_arrived').reason).toBe('MERCHANDISE_OR_SERVICE_NOT_RECEIVED');
    expect(disputeReasonFor('charged_twice')).toEqual({ reason: 'DUPLICATE_TRANSACTION' });
    expect(disputeReasonFor('wrong_amount')).toEqual({ reason: 'INCORRECT_AMOUNT' });
  });

  it("only produces codes in PayPal's live reason enum", () => {
    const all: SightlineIssue[] = [
      'wrong_colour',
      'wrong_size',
      'wrong_model',
      'damaged',
      'never_arrived',
      'charged_twice',
      'wrong_amount',
    ];
    for (const i of all) expect(DISPUTE_REASONS).toContain(disputeReasonFor(i).reason);
  });

  it('reads the issue from a mismatch verdict and from the demo shipped variant', () => {
    const verdict: Verdict = {
      kind: 'mismatch',
      headline: 'This is green, not blue.',
      nextSteps: [],
      reasons: [
        { module: 'quality', finding: 'disagree', confidence: 'sure', sentence: 'Photo is dim.' },
        {
          module: 'colour',
          finding: 'disagree',
          confidence: 'sure',
          expected: 'blue',
          observed: 'green',
          sentence: 'Green, not blue.',
        },
      ],
    };
    expect(issueFromVerdict(verdict)).toBe('wrong_colour');
    expect(issueFromVerdict({ ...verdict, kind: 'match' })).toBeUndefined();
    expect(issueFromShippedVariant('nothing')).toBe('never_arrived');
    expect(issueFromShippedVariant('wrong_size')).toBe('wrong_size');
    expect(issueFromShippedVariant('correct')).toBeUndefined();
  });
});
