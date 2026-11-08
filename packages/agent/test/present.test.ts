import { describe, expect, it } from 'vitest';
import type { Verdict } from '@sightline/core';
import { parseShoppingQuery } from '../src/grammar';
import { rankProducts, type Candidate } from '../src/ranking';
import {
  deadlinePhrase,
  describeQuery,
  presentCaseUpdate,
  presentComparison,
  presentDetails,
  presentMoneyTimeline,
  presentNone,
  presentOptions,
  presentPaid,
  presentVerdict,
  presentWhy,
  shortTitle,
} from '../src/present';
import { en } from '../src/copy/en';
import { NOW, snapshot, usd } from './helpers';

const q = parseShoppingQuery('navy crew-neck sweater, medium, under forty dollars');
const harbor: Candidate = { snapshot: snapshot(), availableSizes: ['S', 'M', 'L'] };
const coast: Candidate = {
  snapshot: snapshot({
    id: 'coast',
    productId: 'p_coast',
    variantId: 'v_coast',
    title: 'Coastline cotton crew-neck sweater',
    attributes: { colour: 'Navy', size: 'M', material: 'cotton' },
    price: usd(2900),
    returnPolicy: { windowDays: 14, free: false },
    rating: { average: 4.2, count: 40 },
  }),
  availableSizes: ['M'],
};
const lark: Candidate = {
  snapshot: snapshot({
    id: 'lark',
    productId: 'p_lark',
    variantId: 'v_lark',
    title: 'Lark merino jumper',
    attributes: { colour: 'Navy Blue', size: 'M' },
    price: usd(3850),
    returnPolicy: null,
    rating: undefined,
  }),
};
const extra: Candidate = { snapshot: snapshot({ id: 'x', productId: 'p_x', variantId: 'v_x', title: 'Spare crew-neck sweater', price: usd(3990) }) };

describe('shortTitle', () => {
  it('drops a trailing category word when enough remains', () => {
    expect(shortTitle('Harbor knit crew-neck sweater', 'sweater')).toBe('Harbor knit crew-neck');
    expect(shortTitle('Lark merino jumper', 'sweater')).toBe('Lark merino');
    expect(shortTitle('Navy sweaters', 'sweater')).toBe('Navy sweaters');
    expect(shortTitle('Stoneware mug')).toBe('Stoneware mug');
  });
});

describe('presentOptions', () => {
  const result = rankProducts({ candidates: [harbor, coast, lark, extra], query: q });

  it('reads at most three options in the reference shape', () => {
    const p = presentOptions(result, { query: q });
    expect(p.sentences[0]).toBe('I found three.');
    expect(p.sentences[1]).toBe('One: Harbor knit crew-neck, navy, size M in stock, $34, free returns for 30 days.');
    expect(p.text).toMatchInlineSnapshot(
      `"I found three. One: Harbor knit crew-neck, navy, size M in stock, $34, free returns for 30 days. Two: Spare crew-neck, navy, size M, $39.90, free returns for 30 days. Three: Coastline cotton crew-neck, navy, size M in stock, $29, returns for 14 days, not free. Say a number for details, 'compare' to compare, or 'more' for other options."`,
    );
    expect(p.context.map((c) => c.index)).toEqual([1, 2, 3]);
    expect(p.context[0]).toMatchObject({ price: usd(3400), colour: 'Navy', size: 'M' });
  });

  it('leaves out "more" when nothing is left', () => {
    const two = rankProducts({ candidates: [harbor, coast], query: q });
    expect(presentOptions(two, { query: q }).text).toContain("Say a number for details, or 'compare' to compare.");
    const one = rankProducts({ candidates: [harbor], query: q });
    expect(presentOptions(one, { query: q }).text).toBe(
      "I found one. One: Harbor knit crew-neck, navy, size M in stock, $34, free returns for 30 days. Say 'tell me more' for details.",
    );
  });

  it('brief and detailed variants', () => {
    const one = rankProducts({ candidates: [harbor], query: q });
    expect(presentOptions(one, { query: q, verbosity: 'brief' }).sentences[1]).toBe('One: Harbor knit crew-neck, navy, $34.');
    expect(presentOptions(one, { query: q, verbosity: 'detailed' }).sentences[1]).toBe(
      'One: Harbor knit crew-neck, navy, size M in stock, $34, free returns for 30 days, rated 4.6 from 212 reviews.',
    );
  });

  it('later pages say "more" and number from one again', () => {
    const page2 = rankProducts({ candidates: [harbor, coast, lark, extra], query: q, offset: 3 });
    const p = presentOptions(page2, { query: q, firstPage: false });
    expect(p.sentences[0]).toBe('Here is one more.');
    expect(p.sentences[1]!.startsWith('One: Lark merino, navy blue')).toBe(true);
  });

  it('says what is missing instead of guessing', () => {
    const bare: Candidate = { snapshot: snapshot({ id: 'bare', attributes: {}, returnPolicy: null }) };
    const p = presentOptions(rankProducts({ candidates: [bare], query: { ...q, size: undefined } }), {});
    expect(p.sentences[1]).toBe('One: Harbor knit crew-neck, colour not given, size not given, $34, return policy not given.');
  });
});

describe('presentNone and presentWhy', () => {
  it('describes the search and offers the closest price', () => {
    const r = rankProducts({ candidates: [{ snapshot: snapshot({ price: usd(4500) }) }], query: q });
    expect(presentNone(q, r).text).toBe(
      "I couldn't find a navy crew-neck sweater in size M under $40. The closest one is $45. Want me to try up to $45, or any colour?",
    );
  });

  it('suggests a wider budget or other words when nothing was excluded', () => {
    expect(presentNone(q).text).toBe("I couldn't find a navy crew-neck sweater in size M under $40. Want me to try up to $50, or any colour?");
    expect(presentNone(parseShoppingQuery('waterproof')).text).toBe("I couldn't find anything. Want me to try different words?");
    expect(describeQuery(parseShoppingQuery('orange anorak with free returns'))).toBe('anything orange with free returns');
  });

  it('explains up to two reasons and one caveat per option', () => {
    const r = rankProducts({ candidates: [harbor, lark], query: q });
    expect(presentWhy(r.options).text).toBe(
      "Here's why I picked these. One: Size M is in stock. Navy, as you asked. Two: Size M is listed. Navy, as you asked. The listing doesn't give a return policy.",
    );
  });
});

describe('presentDetails', () => {
  it('general, from listing fields only', () => {
    expect(presentDetails(snapshot()).text).toBe(
      "Harbor knit crew-neck sweater, sold by Demo Store. It costs $34. The listing calls the colour navy. Size: M. It's made of 100% merino wool. Free returns within 30 days. Rated 4.6 out of 5 from 212 reviews.",
    );
  });

  it('says when the listing does not say', () => {
    const s = snapshot({ attributes: {}, rating: undefined });
    expect(presentDetails(s, 'material').text).toBe("The listing doesn't say what it's made of.");
    expect(presentDetails(s, 'colour').text).toBe("The listing doesn't say what colour it is.");
    expect(presentDetails(s, 'care').text).toBe("The listing doesn't give care instructions.");
    expect(presentDetails(s, 'reviews').text).toBe("There are no ratings yet. I haven't read the reviews for that yet. Want me to?");
  });

  it('topic answers', () => {
    expect(presentDetails(snapshot(), 'returns').text).toBe('Free returns within 30 days.');
    expect(presentDetails(snapshot(), 'price').text).toBe('It costs $34.');
    expect(presentDetails(snapshot(), 'seller').text).toBe('Sold by Demo Store.');
    expect(presentDetails(snapshot(), 'general', 'brief').text).toBe(
      'Harbor knit crew-neck sweater, sold by Demo Store. It costs $34. The listing calls the colour navy. Size: M. Free returns within 30 days.',
    );
  });
});

describe('presentComparison', () => {
  const items = [
    { label: 1, snapshot: harbor.snapshot },
    { label: 3, snapshot: coast.snapshot },
  ];

  it('compares field by field and says which is cheaper', () => {
    const c = presentComparison(items);
    expect(c.rows.map((r) => r.key)).toEqual(['price', 'colour', 'size', 'material', 'returns', 'rating']);
    expect(c.rows[0]!.values).toEqual(['$34', '$29']);
    expect(c.text).toMatchInlineSnapshot(
      `"Comparing one and three. Price: one is $34, three is $29. Colour: one is navy, three is navy. Size: one is M, three is M. Material: one is 100% merino wool, three is cotton. Returns: one has free returns for 30 days, three has returns for 14 days, not free. Rating: one is rated 4.6 out of 5 from 212 reviews, three is rated 4.2 out of 5 from 40 reviews. Three is cheaper by $5."`,
    );
  });

  it('answers a single aspect, and is honest about what it cannot feel', () => {
    expect(presentComparison(items, 'price').text).toBe('Comparing one and three. Price: one is $34, three is $29. Three is cheaper by $5.');
    expect(presentComparison(items, 'softer').text).toBe(
      "Comparing one and three. I can't tell which is softer for sure. Here's what each listing says it's made of. Material: one is 100% merino wool, three is cotton.",
    );
  });

  it('says when a listing is missing a field, and picks the cheapest of three', () => {
    const c = presentComparison([...items, { label: 2, snapshot: lark.snapshot }], 'material');
    expect(c.text).toContain("for two the listing doesn't say");
    expect(presentComparison([...items, { label: 2, snapshot: lark.snapshot }], 'price').text).toContain('Three is the cheapest, at $29.');
  });
});

describe('presentVerdict', () => {
  const mismatch: Verdict = {
    kind: 'mismatch',
    headline: '',
    nextSteps: [],
    reasons: [
      { module: 'colour', finding: 'disagree', confidence: 'not_sure', expected: 'Navy', observed: 'black', sentence: '' },
      { module: 'size', finding: 'disagree', confidence: 'sure', expected: 'M', observed: 'L', sentence: '' },
      { module: 'identity', finding: 'agree', confidence: 'fairly_sure', sentence: '' },
    ],
  };

  it('reads the reference mismatch, sure reasons first', () => {
    expect(presentVerdict(mismatch, { productNoun: 'sweater', lowLight: true }).text).toBe(
      "This doesn't match. The size tag reads L, you ordered M. I'm sure about that. The colour looks black, not navy, but the light is dim so I'm less sure. Want me to get your money back?",
    );
  });

  it('uses confidence words, never percentages', () => {
    const t = presentVerdict(mismatch, { productNoun: 'sweater' }).text;
    expect(t).toContain("I'm not sure about that.");
    expect(t).not.toMatch(/\d+ ?%/);
  });

  it('pay-after-check mismatch cancels the payment instead of offering a refund', () => {
    expect(presentVerdict(mismatch, { payAfterCheck: true }).sentences.at(-1)).toBe(en.check.payAfterCheckVoided);
  });

  it('reads the reference match', () => {
    const match: Verdict = {
      kind: 'match',
      headline: '',
      nextSteps: [],
      reasons: [
        { module: 'colour', finding: 'agree', confidence: 'fairly_sure', expected: 'Navy', observed: 'navy', sentence: '' },
        { module: 'size', finding: 'agree', confidence: 'sure', expected: 'M', observed: 'M', sentence: '' },
        { module: 'identity', finding: 'agree', confidence: 'sure', sentence: '' },
      ],
    };
    expect(presentVerdict(match, { productNoun: 'sweater' }).text).toBe('This matches: navy, size M, the same sweater. Enjoy it.');
    expect(presentVerdict(match, { productNoun: 'sweater', payAfterCheck: true }).text).toBe(
      "This matches: navy, size M, the same sweater. I've told PayPal to complete the payment now.",
    );
  });

  it('reads an unsure verdict with next steps', () => {
    const unsure: Verdict = {
      kind: 'unsure',
      headline: '',
      nextSteps: [],
      reasons: [{ module: 'colour', finding: 'unknown', confidence: 'not_sure', expected: 'Navy', observed: 'black', sentence: '' }],
    };
    expect(presentVerdict(unsure, { helperName: 'Asha', lowLight: true }).text).toBe(
      "I'm not sure if this is navy or black. I can ask Asha to look, or you can try again in daylight.",
    );
    const noHelper: Verdict = { ...unsure, reasons: [{ module: 'size', finding: 'unknown', confidence: 'not_sure', sentence: '' }] };
    expect(presentVerdict(noHelper).text).toBe("I'm not sure about the size. Want to try again near a window?");
  });

  it('describes damage', () => {
    const damaged: Verdict = {
      kind: 'mismatch',
      headline: '',
      nextSteps: [],
      reasons: [{ module: 'damage', finding: 'disagree', confidence: 'sure', observed: 'a tear near the collar', sentence: '' }],
    };
    expect(presentVerdict(damaged).text).toBe("This doesn't match. I can see damage: a tear near the collar. I'm sure about that. Want me to get your money back?");
  });
});

describe('presentCaseUpdate', () => {
  it('case sent, with a weekday deadline', () => {
    const p = presentCaseUpdate({ kind: 'sent', merchant: 'Demo Store', deadline: new Date('2026-11-13T23:00:00Z'), now: NOW });
    expect(p.text).toBe("I sent your case to Demo Store through PayPal. They have until Friday to reply. I'll tell you when they do.");
  });

  it('offers', () => {
    expect(presentCaseUpdate({ kind: 'offer', merchant: 'Demo Store', offer: 'full_refund', amount: usd(3672), returnRequired: true, itemNoun: 'sweater' }).text).toBe(
      "Demo Store offered a full refund of $36.72 if you send the sweater back. Say 'accept' to accept.",
    );
    expect(
      presentCaseUpdate({ kind: 'offer', merchant: 'Demo Store', offer: 'full_refund', amount: usd(3672), returnRequired: true, itemNoun: 'sweater', labelInEmail: true }, 'detailed').text,
    ).toBe("Demo Store offered a full refund of $36.72 if you send the sweater back. The return label is in your email. Say 'accept' to accept. Say 'decline' to say no.");
    expect(presentCaseUpdate({ kind: 'offer', merchant: 'Demo Store', offer: 'partial_refund', amount: usd(1000), returnRequired: false, itemNoun: 'sweater' }).text).toBe(
      "Demo Store offered a partial refund of $10.00, and you keep the sweater. Say 'accept' to accept.",
    );
    expect(presentCaseUpdate({ kind: 'offer', merchant: 'Demo Store', offer: 'replacement', returnRequired: false, itemNoun: 'sweater' }).text).toBe(
      "Demo Store offered to send a replacement sweater. Say 'accept' to accept.",
    );
  });

  it('other updates', () => {
    expect(presentCaseUpdate({ kind: 'no_reply', merchant: 'Demo Store' }).text).toBe("Demo Store hasn't replied. Want me to ask PayPal to step in?");
    expect(presentCaseUpdate({ kind: 'refunded', amount: usd(3672) }).text).toBe('PayPal refunded $36.72. It should reach your PayPal balance within minutes.');
    expect(presentCaseUpdate({ kind: 'escalated' }).text).toBe("I asked PayPal to step in. I'll tell you when they decide.");
  });

  it('deadline phrase uses a weekday inside a week and a date after', () => {
    expect(deadlinePhrase(new Date('2026-11-13T12:00:00Z'), NOW)).toBe('Friday');
    expect(deadlinePhrase(new Date('2026-11-20T12:00:00Z'), NOW)).toBe('Friday 20 November');
  });
});

describe('presentMoneyTimeline and presentPaid', () => {
  const events = [
    { kind: 'paid' as const, merchant: 'Demo Store', amount: usd(3672), at: new Date('2026-11-02T10:00:00Z') },
    { kind: 'case_opened' as const, merchant: 'Demo Store', at: new Date('2026-11-08T10:00:00Z') },
    { kind: 'refunded' as const, merchant: 'Demo Store', amount: usd(3672), at: new Date('2026-11-09T09:00:00Z') },
    { kind: 'deadline' as const, merchant: 'Clay Co', at: new Date('2026-11-13T23:00:00Z') },
    { kind: 'authorised' as const, merchant: 'Clay Co', amount: usd(1200), at: new Date('2026-11-05T10:00:00Z') },
  ];

  it('reads upcoming deadlines first, then newest first, three at a time', () => {
    const p = presentMoneyTimeline(events, { now: NOW });
    expect(p.text).toBe(
      "Coming up: Clay Co has until Friday to reply to your case. Today, PayPal refunded $36.72 from Demo Store. Yesterday, you opened a case with Demo Store. Say 'more' to hear older ones.",
    );
    expect(p.remaining).toBe(2);
    const older = presentMoneyTimeline(events, { now: NOW, offset: 3 });
    expect(older.text).toBe(
      'On Thursday, $12.00 was put on hold for Clay Co. You pay only if the check matches. On Monday 2 November, you paid Demo Store $36.72.',
    );
  });

  it('has a line for no payments', () => {
    expect(presentMoneyTimeline([], { now: NOW }).text).toBe('No payments yet.');
  });

  it('paid', () => {
    expect(presentPaid({ total: usd(3672), merchant: 'Demo Store' }).text).toBe(
      "Paid. $36.72 to Demo Store. Your receipt is saved. I'll tell you when it ships.",
    );
  });
});
