import { describe, expect, it } from 'vitest';
import { composeReadback, type ComposeReadbackInput } from '../src/readback';
import { answerReadbackQuestion } from '../src/readback-answers';
import { parseYesNo } from '../src/grammar';
import { presentOfferAnswer, presentOfferChoice } from '../src/present';
import { NOW, SAVED_PAYPAL, TUE_17_NOV, cart, snapshot, usd } from './helpers';

function readback(over: Partial<ComposeReadbackInput> = {}) {
  return composeReadback({
    cart: cart([{ snapshot: snapshot(), quantity: 1 }]),
    paymentSource: SAVED_PAYPAL,
    deliveryEstimate: TUE_17_NOV,
    locale: 'en-US',
    verbosity: 'standard',
    now: NOW,
    ...over,
  });
}

const HOW_TO_PAY = "To pay, say 'confirm purchase'. To change something, say what to change.";

describe('answerReadbackQuestion', () => {
  const rb = readback();
  const ask = (utterance: string, verbosity?: 'brief' | 'standard' | 'detailed') =>
    answerReadbackQuestion({ utterance, fields: rb.fields, text: rb.text, verbosity })?.text ?? null;

  it("answers \"what's the total\" from the readback's own total, then says how to pay", () => {
    expect(ask("what's the total")).toBe(`The total is $36.72, with shipping and tax. ${HOW_TO_PAY}`);
    expect(ask('how much is it?')).toBe(`The total is $36.72, with shipping and tax. ${HOW_TO_PAY}`);
    expect(ask('total')).toBe(`The total is $36.72, with shipping and tax. ${HOW_TO_PAY}`);
  });

  it('answers size, colour, seller and delivery from the fields', () => {
    expect(ask('what size is it')).toBe(`Size: M. ${HOW_TO_PAY}`);
    expect(ask('what colour is it?')).toBe(`Colour: navy. ${HOW_TO_PAY}`);
    expect(ask('is it navy')).toBe(`Colour: navy. ${HOW_TO_PAY}`);
    expect(ask('who sells it')).toBe(`Sold by Demo Store. ${HOW_TO_PAY}`);
    expect(ask('when does it arrive')).toBe(`It arrives by Tuesday 17 November. ${HOW_TO_PAY}`);
    expect(ask('how much is shipping')).toBe(`Shipping: Free. ${HOW_TO_PAY}`);
    expect(ask('what am I paying with')).toBe(`Paid with: your saved PayPal. ${HOW_TO_PAY}`);
    expect(ask('can I return it')).toBe(`Returns: Free returns within 30 days. ${HOW_TO_PAY}`);
  });

  it('never answers with "Nothing is paid yet" alone', () => {
    for (const q of ["what's the total", 'what size', 'who sells it', 'when will it come']) {
      const a = ask(q)!;
      expect(a).not.toMatch(/^Nothing is paid yet/);
      expect(a.endsWith(HOW_TO_PAY)).toBe(true);
    }
  });

  it('reads the whole readback again on request, and follows the verbosity for the closing', () => {
    expect(ask('read it again')).toBe(rb.text);
    expect(ask('what size is it', 'brief')).toBe("Size: M. Say 'confirm purchase' to pay, or say what to change.");
  });

  it('says when the listing does not give a field', () => {
    const plain = readback({ cart: cart([{ snapshot: snapshot({ attributes: { colour: 'Navy', size: 'M' } }), quantity: 1 }]) });
    expect(answerReadbackQuestion({ utterance: 'what is it made of', fields: plain.fields, text: plain.text })?.text).toBe(
      `Material: the listing doesn't say. ${HOW_TO_PAY}`,
    );
  });

  it('leaves changes, confirmations and other talk alone', () => {
    expect(ask('confirm purchase')).toBeNull();
    expect(ask('make it a large instead please')).toBeNull();
    expect(ask('yes')).toBeNull();
    expect(ask('I need a navy crew-neck sweater, medium, under forty dollars')).toBeNull();
  });

  it('answers per item for a cart with two lines', () => {
    const two = readback({ cart: cart([{ snapshot: snapshot(), quantity: 1 }, { snapshot: snapshot({ id: 's2', productId: 'p2', attributes: { colour: 'Black', size: 'L' } }), quantity: 1 }], 0, 544) });
    expect(answerReadbackQuestion({ utterance: 'what size', fields: two.fields, text: two.text })?.text).toBe(
      `First item, size: M. Second item, size: L. ${HOW_TO_PAY}`,
    );
  });
});

describe('parseYesNo', () => {
  it('reads plain answers to a question I asked', () => {
    for (const y of ['yes', 'Yes please.', 'yeah', 'sure', 'okay', 'ok thanks', 'go ahead', 'do it', 'yes, do that', 'um yes'])
      expect(parseYesNo(y), y).toBe('yes');
    for (const n of ['no', 'No thanks.', 'nope', 'not now', 'no thank you', 'nah'])
      expect(parseYesNo(n), n).toBe('no');
  });

  it('ignores anything that is more than an answer', () => {
    for (const x of ['yes the navy one', 'no I want black', 'confirm purchase', 'buy it', 'I need jeans', 'maybe', ''])
      expect(parseYesNo(x), x).toBeNull();
  });
});

describe('offers', () => {
  it('reads what accepting means before the buyer chooses', () => {
    expect(presentOfferChoice({ merchant: 'Demo Store', kind: 'replacement', itemNoun: 'sweater' }).text).toBe(
      'Demo Store offered to send a replacement sweater. If you accept, Demo Store sends a new sweater and your case closes. ' +
        "You don't get money back. You can't undo accepting. Say 'accept' to accept the offer, or 'decline' to say no. Nothing changes until you choose.",
    );
    expect(presentOfferChoice({ merchant: 'Demo Store', kind: 'refund_with_return', amount: usd(3672), itemNoun: 'sweater' }).text).toBe(
      'Demo Store offered a full refund of $36.72 if you send the sweater back. ' +
        'If you accept, you send the sweater back, and Demo Store refunds $36.72 once it arrives. ' +
        "You can't undo accepting. Say 'accept' to accept the offer, or 'decline' to say no. Nothing changes until you choose.",
    );
    expect(presentOfferChoice({ merchant: 'Demo Store', kind: 'refund', amount: usd(3672), itemNoun: 'sweater' }).sentences[0]).toBe(
      'Demo Store offered a full refund of $36.72, and you keep the sweater.',
    );
  });

  it('says what happens next after an answer', () => {
    expect(presentOfferAnswer({ merchant: 'Demo Store', kind: 'replacement', itemNoun: 'sweater', answer: 'accept' }).text).toBe(
      'Accepted. Demo Store sends a new sweater next, and your case is closed.',
    );
    expect(presentOfferAnswer({ merchant: 'Demo Store', kind: 'refund_with_return', amount: usd(3672), itemNoun: 'sweater', answer: 'accept' }).text).toBe(
      "Accepted. Send the sweater back to Demo Store. They refund $36.72 once it arrives, and I'll tell you when they do.",
    );
    expect(presentOfferAnswer({ merchant: 'Demo Store', kind: 'replacement', answer: 'decline' }).text).toBe(
      'Okay, I declined. Your case with Demo Store stays open, and they can make another offer.',
    );
  });
});
