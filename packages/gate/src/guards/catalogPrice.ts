import type { Money } from '@sightline/core';
import { fail, isMoney, pass } from '../guard';
import type { Guard, GuardContext, GuardResult } from '../types';

/** Generous ceiling that keeps every product below Number.MAX_SAFE_INTEGER. */
export const MAX_LINE_QUANTITY = 999;

function same(a: Money, b: Money): boolean {
  return a.cents === b.cents && a.currency === b.currency;
}

/**
 * The amount to charge is recomputed from the snapshots, never taken on trust:
 *   sum(snapshot.price x quantity) + shipping + tax, tolerance 0.
 * The cart's stored totals must agree with the recomputation too.
 */
export class CatalogPriceGuard implements Guard {
  readonly name = 'CatalogPriceGuard';

  async run({ intent, ports }: GuardContext): Promise<GuardResult> {
    const { cart, amount } = intent;
    const lines = cart?.lines;
    if (!Array.isArray(lines) || lines.length === 0) return fail(this.name, 'CART_EMPTY', 'The cart has no lines');

    if (!isMoney(amount) || amount.cents <= 0) {
      return fail(this.name, 'AMOUNT_INVALID', 'The amount is not a positive whole number of cents', {
        received: typeof amount === 'object' ? 'object' : typeof amount,
      });
    }
    const currency = amount.currency;

    let itemsCents = 0;
    for (const [i, line] of lines.entries()) {
      const q = line?.quantity;
      if (typeof q !== 'number' || !Number.isInteger(q) || q < 1 || q > MAX_LINE_QUANTITY) {
        return fail(this.name, 'INVALID_QUANTITY', 'A line has an invalid quantity', { line: i });
      }
      const price = line.snapshot?.price;
      if (!isMoney(price) || price.cents < 0) {
        return fail(this.name, 'TOTALS_MISMATCH', 'A snapshot has an invalid price', { line: i });
      }
      if (price.currency !== currency) {
        return fail(this.name, 'CURRENCY_MISMATCH', 'Line currency differs from the amount', {
          line: i,
          expected: currency,
          got: price.currency,
        });
      }
      itemsCents += price.cents * q;
    }

    const extras = ports.quoteExtras
      ? await ports.quoteExtras(cart)
      : { shipping: cart.totals?.shipping, tax: cart.totals?.tax };
    for (const [key, m] of Object.entries(extras) as Array<[string, unknown]>) {
      if (!isMoney(m) || m.cents < 0) return fail(this.name, 'TOTALS_MISMATCH', `Invalid ${key}`, { field: key });
      if (m.currency !== currency) {
        return fail(this.name, 'CURRENCY_MISMATCH', `${key} currency differs from the amount`, { field: key });
      }
    }
    const shipping = extras.shipping as Money;
    const tax = extras.tax as Money;
    const expected = {
      items: { cents: itemsCents, currency },
      shipping,
      tax,
      total: { cents: itemsCents + shipping.cents + tax.cents, currency },
    };
    if (!Number.isSafeInteger(expected.total.cents)) {
      return fail(this.name, 'TOTALS_MISMATCH', 'Total is out of range');
    }

    const t = cart.totals;
    const totalsAgree =
      !!t &&
      [t.items, t.shipping, t.tax, t.total].every(isMoney) &&
      same(t.items, expected.items) &&
      same(t.shipping, expected.shipping) &&
      same(t.tax, expected.tax) &&
      same(t.total, expected.total);
    if (!totalsAgree) {
      return fail(this.name, 'TOTALS_MISMATCH', 'Cart totals do not match the snapshot prices', {
        expected,
        cart: t ?? null,
      });
    }

    if (!same(amount, expected.total)) {
      return fail(this.name, 'AMOUNT_MISMATCH', 'Amount does not equal the recomputed total', {
        expected: expected.total,
        got: amount,
      });
    }

    return pass(this.name, 'Amount equals the recomputed total', { ...expected });
  }
}
