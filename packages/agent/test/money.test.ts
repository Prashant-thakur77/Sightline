import { describe, expect, it } from 'vitest';
import { answerMoneyQuestion, parseMoneyQuestion, periodRange, type MoneyOrder } from '../src/money';

// Monday 9 November 2026, noon UTC.
const NOW = new Date('2026-11-09T12:00:00Z');
const RULES = { autoCaptureDays: 7 };

function order(over: Partial<MoneyOrder>): MoneyOrder {
  return {
    id: 'ord_1',
    title: 'Harbor knit crew-neck sweater',
    amountCents: 3672,
    currency: 'USD',
    status: 'authorized',
    intent: 'AUTHORIZE',
    paypalOrderId: 'PP1',
    authorizationId: 'AUTH1',
    captureId: null,
    authorizationExpiresAt: '2026-12-07T10:00:00Z',
    createdAt: '2026-11-05T10:00:00Z',
    ...over,
  };
}

const held = order({});
const paid = order({ id: 'ord_2', title: 'Mill heavyweight cotton T-shirt', amountCents: 1944, status: 'captured', intent: 'CAPTURE', authorizationId: null, captureId: 'CAP2', paidAt: '2026-11-02T09:00:00Z', createdAt: '2026-11-02T09:00:00Z' });
const lastMonth = order({ id: 'ord_3', title: 'Canvas tote bag', amountCents: 2376, status: 'verified_match', captureId: 'CAP3', paidAt: '2026-10-20T09:00:00Z', createdAt: '2026-10-18T09:00:00Z' });
const refunded = order({ id: 'ord_4', title: 'Trail Runner 2 running shoes', amountCents: 7776, status: 'resolved_refund', captureId: 'CAP4', paidAt: '2026-10-28T09:00:00Z', refundedAt: '2026-11-06T15:00:00Z', createdAt: '2026-10-27T09:00:00Z' });
const released = order({ id: 'ord_5', title: 'Tidewater merino crew-neck', amountCents: 4212, status: 'voided', releasedAt: '2026-11-04T15:00:00Z', createdAt: '2026-11-03T09:00:00Z' });

describe('understanding money questions', () => {
  it('reads each question and its period', () => {
    expect(parseMoneyQuestion("What's on hold?")).toEqual({ question: 'on_hold' });
    expect(parseMoneyQuestion('How much did I spend this month?')).toEqual({ question: 'spent', period: 'this_month' });
    expect(parseMoneyQuestion('When does my hold expire?')).toEqual({ question: 'hold_ends' });
    expect(parseMoneyQuestion('Did I get my refund?')).toEqual({ question: 'refunds' });
    expect(parseMoneyQuestion('What did I order last week?')).toEqual({ question: 'orders', period: 'last_week' });
    expect(parseMoneyQuestion('where is my money')).toEqual({ question: 'overview' });
    expect(parseMoneyQuestion('find me a navy sweater')).toBeNull();
  });

  it('says periods as plain dates', () => {
    expect(periodRange('last_week', NOW).words).toBe('last week, from Monday 2 November to Sunday 8 November');
    expect(periodRange('last_month', NOW).words).toBe('last month, in October');
  });
});

describe('money answers, from the orders only', () => {
  it("what's on hold", () => {
    expect(answerMoneyQuestion({ question: 'on_hold' }, [held, paid], NOW, RULES).text).toBe(
      '$36.72 is on hold for your Harbor knit crew-neck sweater. Demo Store is paid only after you check it.',
    );
    expect(answerMoneyQuestion({ question: 'on_hold' }, [paid], NOW, RULES).text).toBe('Nothing is on hold right now.');
    const two = answerMoneyQuestion({ question: 'on_hold' }, [held, order({ id: 'ord_9', title: 'Canvas tote bag', amountCents: 2376 })], NOW, RULES);
    expect(two.text).toBe(
      '$60.48 is on hold, for two orders: your Harbor knit crew-neck sweater, $36.72; and your Canvas tote bag, $23.76. Demo Store is paid for each only after you check it.',
    );
  });

  it('how much did I spend this month: payments only, holds and refunds said apart', () => {
    const a = answerMoneyQuestion({ question: 'spent', period: 'this_month' }, [held, paid, lastMonth, refunded], NOW, RULES);
    expect(a.text).toBe(
      'This month, you paid $19.44, for one order: your Mill heavyweight cotton T-shirt, $19.44. $36.72 more is on hold, and isn\'t spent yet. $77.76 came back to you as a refund this month.',
    );
    expect(answerMoneyQuestion({ question: 'spent', period: 'today' }, [paid], NOW, RULES).text).toBe("You haven't paid for anything today.");
  });

  it('when does my hold expire: the rule that applies, with dates', () => {
    const delivered = order({ deliveredAt: '2026-11-08T15:00:00Z' });
    expect(answerMoneyQuestion({ question: 'hold_ends' }, [delivered], NOW, RULES).text).toBe(
      "Your Harbor knit crew-neck sweater arrived on Sunday 8 November. If you don't check it, Demo Store is paid $36.72 on Sunday 15 November. PayPal's hold can last until Monday 7 December at the latest.",
    );
    const inCase = order({ status: 'case_open', kase: { stage: 'seller_contacted', dueAt: '2026-11-12T12:00:00Z' } });
    expect(answerMoneyQuestion({ question: 'hold_ends' }, [inCase], NOW, RULES).text).toMatch(
      /^\$36\.72 for your Harbor knit crew-neck sweater stays on hold while your case is open\. If it isn't settled by Thursday 12 November, the hold is cancelled and you're never charged\./,
    );
    expect(answerMoneyQuestion({ question: 'hold_ends' }, [paid], NOW, RULES).text).toBe("Nothing is on hold, so there's no hold to end.");
  });

  it('did I get my refund: refunds, released holds and open cases, newest first', () => {
    const a = answerMoneyQuestion({ question: 'refunds' }, [refunded, released], NOW, RULES);
    expect(a.text).toBe(
      "Yes. PayPal refunded $77.76 for your Trail Runner 2 running shoes on Friday 6 November. You weren't charged for your Tidewater merino crew-neck: the $42.12 hold was released on Wednesday 4 November, so there was nothing to refund.",
    );
    expect(answerMoneyQuestion({ question: 'refunds' }, [paid], NOW, RULES).text).toBe("You haven't had any refunds, and you have no open cases.");
  });

  it('what did I order last week', () => {
    const a = answerMoneyQuestion({ question: 'orders', period: 'last_week' }, [held, paid, released, lastMonth], NOW, RULES);
    expect(a.text).toBe(
      'Last week, from Monday 2 November to Sunday 8 November, you ordered three things: your Harbor knit crew-neck sweater, $36.72, on hold; your Mill heavyweight cotton T-shirt, $19.44, paid; and your Tidewater merino crew-neck, $42.12, hold released.',
    );
    expect(a.orderIds.sort()).toEqual(['ord_1', 'ord_2', 'ord_5']);
  });

  it('never says an amount that is not an order amount or a sum of order amounts', () => {
    const orders = [held, paid, lastMonth, refunded, released, order({ id: 'ord_6', title: 'Canvas tote bag', amountCents: 2376 })];
    const sums = new Set<number>();
    for (let mask = 1; mask < 1 << orders.length; mask++) sums.add(orders.reduce((n, o, i) => (mask & (1 << i) ? n + o.amountCents : n), 0));
    for (const question of ['on_hold', 'spent', 'hold_ends', 'refunds', 'orders', 'overview'] as const)
      for (const period of [undefined, 'today', 'this_week', 'last_week', 'this_month', 'last_month', 'all'] as const) {
        const text = answerMoneyQuestion({ question, ...(period ? { period } : {}) }, orders, NOW, RULES).text;
        for (const m of text.match(/\$[\d,]+\.\d\d/g) ?? []) expect(sums.has(Math.round(Number(m.replace(/[$,]/g, '')) * 100))).toBe(true);
      }
  });
});
