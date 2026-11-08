/** Money is always integer minor units (cents) plus an ISO currency code. */
export interface Money {
  cents: number;
  currency: string;
}

export function money(cents: number, currency = 'USD'): Money {
  if (!Number.isInteger(cents)) throw new Error(`Money must be integer cents, got ${cents}`);
  return { cents, currency };
}

/** Parse a decimal string such as "34.00" or "34" into cents without floating point drift. */
export function parseMoney(value: string | number, currency = 'USD'): Money {
  const s = typeof value === 'number' ? value.toFixed(2) : value.trim();
  const m = /^(-)?(\d+)(?:\.(\d{1,2}))?$/.exec(s);
  if (!m) throw new Error(`Not a money amount: ${value}`);
  const whole = Number(m[2]);
  const frac = Number((m[3] ?? '0').padEnd(2, '0'));
  const cents = whole * 100 + frac;
  return { cents: m[1] ? -cents : cents, currency };
}

/** PayPal wants "36.72" strings. */
export function toDecimalString(m: Money): string {
  const sign = m.cents < 0 ? '-' : '';
  const abs = Math.abs(m.cents);
  return `${sign}${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, '0')}`;
}

export function formatMoney(m: Money, locale = 'en-US'): string {
  return new Intl.NumberFormat(locale, { style: 'currency', currency: m.currency }).format(m.cents / 100);
}

/** Short form used in speech: "$34" when whole, "$36.72" otherwise. */
export function formatMoneyShort(m: Money, locale = 'en-US'): string {
  const whole = m.cents % 100 === 0;
  return new Intl.NumberFormat(locale, {
    style: 'currency',
    currency: m.currency,
    minimumFractionDigits: whole ? 0 : 2,
    maximumFractionDigits: 2,
  }).format(m.cents / 100);
}

export function addMoney(...items: Money[]): Money {
  if (items.length === 0) throw new Error('addMoney needs at least one value');
  const currency = items[0]!.currency;
  for (const i of items) if (i.currency !== currency) throw new Error('Currency mismatch');
  return { cents: items.reduce((a, b) => a + b.cents, 0), currency };
}

export function multiplyMoney(m: Money, qty: number): Money {
  if (!Number.isInteger(qty) || qty < 0) throw new Error('Quantity must be a non-negative integer');
  return { cents: m.cents * qty, currency: m.currency };
}

export function equalMoney(a: Money, b: Money): boolean {
  return a.cents === b.cents && a.currency === b.currency;
}
