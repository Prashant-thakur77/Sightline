import { describe, expect, it } from 'vitest';
import { verifyReceipt } from '@sightline/evidence';
import { IntentGuard, MAX_BUYER_UTTERANCES, refusalSentence, runGate } from '../src';
import { KEY, OPTS, ctx, makeCart, makeIntent, makePorts, makeReadback, makeSnapshot } from './fixtures';

/** A confirmed purchase of one variant, with what the buyer said in this conversation. */
function intentFor(attributes: Record<string, string>, said: string[]) {
  const cart = makeCart([{ snapshot: makeSnapshot({ attributes }), quantity: 1 }]);
  return makeIntent({ cart, readback: makeReadback(cart), buyerUtterances: said.map((text) => ({ text })) });
}

describe('IntentGuard', () => {
  const g = new IntentGuard();

  it('blocks a cart colour the buyer did not ask for, even with both confirmation keys', async () => {
    const r = await g.run(ctx(intentFor({ colour: 'charcoal', size: 'M' }, ['I need a navy sweater, medium', 'buy option one', 'confirm purchase'])));
    expect(r).toMatchObject({ ok: false, code: 'INTENT_MISMATCH', guard: 'IntentGuard' });
    expect(r.details.conflicts).toEqual([{ line: 1, attribute: 'colour', asked: 'navy', cart: 'charcoal', utterance: 'I need a navy sweater, medium' }]);
  });

  it('passes when the buyer changed their mind out loud', async () => {
    for (const change of ['actually charcoal is fine', 'charcoal is fine', 'make it charcoal']) {
      const r = await g.run(ctx(intentFor({ colour: 'charcoal', size: 'M' }, ['I need a navy sweater, medium', change, 'confirm purchase'])));
      expect(r.ok, change).toBe(true);
    }
  });

  it('blocks a size or material the buyer did not ask for', async () => {
    const size = await g.run(ctx(intentFor({ colour: 'navy', size: 'L' }, ['navy sweater in medium'])));
    expect(size.details.conflicts).toMatchObject([{ attribute: 'size', asked: 'M', cart: 'L' }]);
    const material = await g.run(ctx(intentFor({ colour: 'navy', material: 'Acrylic' }, ['navy wool sweater'])));
    expect(material.details.conflicts).toMatchObject([{ attribute: 'material', asked: 'wool', cart: 'Acrylic' }]);
  });

  it('passes when nothing was stated, or the listing does not say', async () => {
    expect((await g.run(ctx(intentFor({ colour: 'charcoal' }, ['buy it', 'confirm purchase'])))).ok).toBe(true);
    expect((await g.run(ctx(makeIntent()))).ok).toBe(true);
    expect((await g.run(ctx(intentFor({}, ['navy sweater, medium'])))).ok).toBe(true);
  });

  it('ignores anything that is not buyer text and reads only the newest utterances', async () => {
    const junk = [null, 7, { text: 42 }] as unknown as { text: string }[];
    const many = Array.from({ length: MAX_BUYER_UTTERANCES }, () => ({ text: 'confirm purchase' }));
    const cart = makeCart([{ snapshot: makeSnapshot({ attributes: { colour: 'charcoal' } }), quantity: 1 }]);
    const intent = makeIntent({ cart, readback: makeReadback(cart), buyerUtterances: [{ text: 'navy sweater' }, ...junk, ...many] });
    const r = await g.run(ctx(intent));
    expect(r.ok).toBe(true);
    expect(r.details.utterancesRead).toBe(MAX_BUYER_UTTERANCES);
  });
});

describe('IntentGuard in the gate', () => {
  it('appears in the signed receipt of every decision', async () => {
    const blocked = await runGate(intentFor({ colour: 'charcoal', size: 'M' }, ['navy sweater', 'confirm purchase']), makePorts(), OPTS);
    expect(blocked.allowed).toBe(false);
    expect(blocked.receipt.body.firstFailure).toBe('INTENT_MISMATCH');
    expect(blocked.receipt.body.results.find((r) => r.guard === 'IntentGuard')).toMatchObject({ ok: false, details: { asked: { colour: { value: 'navy' } } } });
    expect(verifyReceipt(blocked.receipt, KEY)).toMatchObject({ ok: true });

    const allowed = await runGate(intentFor({ colour: 'navy', size: 'M' }, ['navy sweater', 'confirm purchase']), makePorts(), OPTS);
    expect(allowed.allowed).toBe(true);
    expect(allowed.receipt.body.results.find((r) => r.guard === 'IntentGuard')).toMatchObject({ ok: true });
  });

  it('says what was asked, what is in the cart, and how to go ahead', async () => {
    const d = await runGate(intentFor({ colour: 'Charcoal', size: 'M' }, ['navy sweater']), makePorts(), OPTS);
    expect(d.refusal).toBe("You asked for navy, but this one is charcoal, so I didn't buy it. Your cart is saved. If charcoal is fine, say 'charcoal is fine'. Or ask me for navy.");
    expect(refusalSentence('INTENT_MISMATCH', { conflicts: [{ attribute: 'size', asked: 'M', cart: 'l' }] })).toBe(
      "You asked for size M, but this one is size L, so I didn't buy it. Your cart is saved. If size L is fine, say 'size L is fine'. Or ask me for size M.",
    );
    expect(refusalSentence('INTENT_MISMATCH', {})).toContain("didn't buy it");
  });
});
