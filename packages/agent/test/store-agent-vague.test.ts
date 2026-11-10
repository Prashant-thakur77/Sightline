import { describe, expect, it } from 'vitest';
import type { Verdict } from '@sightline/core';
import { DEFAULT_STORE_POLICY, caseFactsFor, checkProposal, storeOptions, vagueReason, type CaseFacts } from '../src/store-agent';
import { usd } from './helpers';

const verdict: Verdict = {
  kind: 'mismatch',
  headline: "This doesn't match.",
  reasons: [{ module: 'size', finding: 'disagree', confidence: 'sure', expected: 'M', observed: 'L', sentence: 'The size tag reads L, you ordered M.' }],
  nextSteps: [],
};
const f: CaseFacts = {
  merchant: 'Demo Store',
  item: 'Harbor knit crew-neck sweater',
  colour: 'navy',
  size: 'M',
  amount: usd(3888),
  payment: 'held',
  dispute: false,
  reason: 'wrong_size',
  verdict,
  shippedVariant: 'wrong_size',
  evidenceVerified: true,
  photos: 2,
  dueAt: '2026-11-12T12:00:00.000Z',
  declined: [],
  round: 1,
};
const opts = storeOptions(f, DEFAULT_STORE_POLICY);
const list = caseFactsFor(f, DEFAULT_STORE_POLICY, opts);
const text = (id: string) => list.find((x) => x.id === id)!.text;
const grounded = { text: "Demo Store's own shipping record shows it sent the wrong size (L).", facts: ['shipping'] };

describe('vagueReason', () => {
  it('passes a reason that restates its facts', () => {
    expect(vagueReason(grounded.text, [text('shipping')])).toBeNull();
    expect(vagueReason('The size check is sure the tag reads L.', [text('check-size')])).toBeNull();
    expect(vagueReason('The order was for size M.', [text('order')])).toBeNull();
  });

  it('marks a reason with no checkable detail as vague', () => {
    expect(vagueReason('Shoppers like this colour a lot.', [text('order')])).toBe('vague');
    expect(vagueReason('This is the kindest way to help.', [text('verdict')])).toBe('vague');
  });

  it('marks a promise with no fact behind it', () => {
    expect(vagueReason('A replacement always fixes this.', [text('check-size')])).toBe('promise');
    expect(vagueReason('We guarantee it will be right next time.', [text('shipping')])).toBe('promise');
    expect(vagueReason('This will certainly be fine.', [text('verdict')])).toBe('promise');
  });

  it('lets a promise word stand when the cited fact uses it', () => {
    expect(vagueReason(text('option-refund'), [text('option-refund')])).toBeNull();
  });
});

describe('checkProposal with vague reasons', () => {
  it('rewrites a vague reason into an attributed one and keeps the grounded reason first', () => {
    const r = checkProposal({ option_id: 'refund', reasons: [grounded, { text: 'Shoppers like this colour a lot.', facts: ['order'] }], staff_note: 'x' }, list, opts, { held: true });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.reasons).toEqual([grounded.text, 'The store says: Shoppers like this colour a lot.']);
    expect(r.rewritten).toEqual([{ text: 'Shoppers like this colour a lot.', as: 'The store says: Shoppers like this colour a lot.' }]);
  });

  it('drops a promise', () => {
    const r = checkProposal({ option_id: 'refund', reasons: [grounded, { text: 'Demo Store never gets an order wrong twice.', facts: ['shipping'] }], staff_note: 'x' }, list, opts, { held: true });
    expect(r.ok && r.reasons).toEqual([grounded.text]);
    expect(r.dropped.map((d) => d.why)).toEqual(['makes a promise that no cited fact backs']);
  });

  it('does not accept an answer whose only reasons are vague', () => {
    const r = checkProposal({ option_id: 'refund', reasons: [{ text: 'Shoppers like this colour a lot.', facts: ['order'] }], staff_note: 'x' }, list, opts, { held: true });
    expect(r.ok).toBe(false);
  });

  it('keeps every fact quoted word for word', () => {
    // Policy, other replies' facts and facts that address the buyer as "you" are kept out by older rules.
    const usable = list.filter((x) => x.id !== 'policy' && (!x.id.startsWith('option-') || x.id === 'option-refund') && !/\byou\b/i.test(x.text));
    expect(usable.length).toBeGreaterThan(4);
    for (const fact of usable) {
      const r = checkProposal({ option_id: 'refund', reasons: [{ text: fact.text, facts: [fact.id] }], staff_note: 'x' }, list, opts, { held: true });
      expect(r.ok && r.reasons, fact.id).toEqual([fact.text]);
    }
  });
});
