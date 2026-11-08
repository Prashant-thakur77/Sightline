import { addBusinessDays, addMoney, money, multiplyMoney, type Money, type Totals } from '@sightline/core';

/** Demo Store rules, applied server-side. The gate recomputes these; the model never sets them. */
export const DEMO_TAX_RATE_BPS = 800; // 8.00% sales tax
export const FREE_SHIPPING_THRESHOLD_CENTS = 3000;
export const FLAT_SHIPPING_CENTS = 499;
export const DELIVERY_BUSINESS_DAYS = 3;

export function computeTotals(lines: { price: Money; quantity: number }[]): Totals {
  if (lines.length === 0) throw new Error('A cart needs at least one line');
  const currency = lines[0]!.price.currency;
  const items = addMoney(...lines.map((l) => multiplyMoney(l.price, l.quantity)));
  const shipping = money(items.cents >= FREE_SHIPPING_THRESHOLD_CENTS ? 0 : FLAT_SHIPPING_CENTS, currency);
  // Round half up on the tax in cents.
  const tax = money(Math.floor((items.cents * DEMO_TAX_RATE_BPS + 5000) / 10000), currency);
  return { items, shipping, tax, total: addMoney(items, shipping, tax) };
}

export function deliveryEstimate(from: Date): Date {
  return addBusinessDays(from, DELIVERY_BUSINESS_DAYS);
}
