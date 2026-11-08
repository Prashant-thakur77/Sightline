/**
 * Readback composer. A pure, template-only function: the text the user hears before paying is
 * built from the cart's snapshots and totals, never from model output. textHash is the hash of
 * exactly that text (hashReadbackText); the gate binds it to the cart hash separately, so any
 * change to the cart or the words invalidates the confirmation.
 */
import {
  addMoney,
  equalMoney,
  multiplyMoney,
  spokenDate,
  type Cart,
  type CartLine,
  type Money,
  type PaymentSourceDescription,
  type ReadbackField,
  type Verbosity,
} from '@sightline/core';
import { LISTING_DOESNT_SAY, en, mFull, returnsPhrase } from './copy/en';
import { hashReadbackText } from './hash';
import { quantityWord, numberToWords } from './numbers';
import { capitalise } from './text';

export interface ComposeReadbackInput {
  cart: Cart;
  paymentSource: PaymentSourceDescription;
  /** Latest delivery date the seller commits to, or null when unknown. */
  deliveryEstimate: Date | null;
  locale: 'en-US';
  verbosity: Verbosity;
  /** Used for "tomorrow", for adding the year when it differs, and to ignore past estimates. */
  now: Date;
  /** PayPal only authorizes now and the seller is paid after the parcel check. Said at every verbosity. */
  payAfterCheck?: boolean;
}

export interface ComposedReadback {
  text: string;
  fields: ReadbackField[];
  textHash: string;
}

export type ReadbackErrorCode = 'empty_cart' | 'bad_quantity' | 'currency_mismatch' | 'totals_mismatch';

/** The composer refuses carts it cannot describe truthfully rather than reading something wrong. */
export class ReadbackError extends Error {
  readonly code: ReadbackErrorCode;
  constructor(code: ReadbackErrorCode, detail: string) {
    super(`Cannot compose readback (${code}): ${detail}`);
    this.name = 'ReadbackError';
    this.code = code;
  }
}

const L = en.readback.labels;

/** Attributes read in the detailed readback, after colour and size, in this order. */
const DETAILED_ATTRIBUTES: Array<{ key: 'material' | 'fit' | 'neckline' | 'pattern' | 'care'; alwaysSay?: boolean }> = [
  { key: 'material', alwaysSay: true },
  { key: 'fit' },
  { key: 'neckline' },
  { key: 'pattern' },
  { key: 'care' },
];

function clean(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const v = value.replace(/\s+/g, ' ').trim().replace(/[.;:,]+$/, '');
  return v.length > 0 ? v : undefined;
}

function titleOf(line: CartLine): string {
  return clean(line.snapshot.title) ?? en.readback.fallbackTitle;
}

function colourOf(line: CartLine): string | undefined {
  const c = clean(line.snapshot.attributes.colour);
  return c?.toLowerCase();
}

function sizeOf(line: CartLine): string | undefined {
  return clean(line.snapshot.attributes.size);
}

function sellerOf(line: CartLine): string {
  return clean(line.snapshot.seller.name) ?? en.readback.fallbackSeller;
}

function validate(cart: Cart): void {
  if (cart.lines.length === 0) throw new ReadbackError('empty_cart', 'the cart has no lines');
  const currency = cart.totals.total.currency;
  for (const [i, line] of cart.lines.entries()) {
    if (!Number.isInteger(line.quantity) || line.quantity < 1)
      throw new ReadbackError('bad_quantity', `line ${i + 1} has quantity ${line.quantity}`);
    if (line.snapshot.price.currency !== currency)
      throw new ReadbackError('currency_mismatch', `line ${i + 1} is in ${line.snapshot.price.currency}`);
  }
  for (const k of ['items', 'shipping', 'tax'] as const) {
    if (cart.totals[k].currency !== currency) throw new ReadbackError('currency_mismatch', `${k} is in ${cart.totals[k].currency}`);
  }
  const items = addMoney(...cart.lines.map((l) => multiplyMoney(l.snapshot.price, l.quantity)));
  if (!equalMoney(items, cart.totals.items))
    throw new ReadbackError('totals_mismatch', `items should be ${mFull(items)}, cart says ${mFull(cart.totals.items)}`);
  const total = addMoney(cart.totals.items, cart.totals.shipping, cart.totals.tax);
  if (!equalMoney(total, cart.totals.total))
    throw new ReadbackError('totals_mismatch', `total should be ${mFull(total)}, cart says ${mFull(cart.totals.total)}`);
}

function utcDayNumber(d: Date): number {
  return Math.floor(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) / 86_400_000);
}

/** "Tuesday 17 November", "tomorrow, Tuesday 17 November", or with the year when it differs. */
export function deliveryPhrase(estimate: Date | null, now: Date, locale = 'en-US'): string | null {
  if (!estimate || Number.isNaN(estimate.getTime())) return null;
  const days = utcDayNumber(estimate) - utcDayNumber(now);
  if (days < 0) return null;
  let date = spokenDate(estimate, locale);
  if (estimate.getUTCFullYear() !== now.getUTCFullYear()) date = `${date} ${estimate.getUTCFullYear()}`;
  if (days === 0) return en.readback.today(date);
  if (days === 1) return en.readback.tomorrow(date);
  return date;
}

function quantitySentence(line: CartLine, verbosity: Verbosity): string {
  const q = quantityWord(line.quantity);
  if (line.quantity > 1 && verbosity !== 'brief') return en.readback.quantityEach(q, line.snapshot.price);
  return en.readback.quantity(q);
}

function lineSentences(line: CartLine, verbosity: Verbosity, includeReturns: boolean): string[] {
  const s: string[] = [];
  const attrs = line.snapshot.attributes;
  s.push(en.readback.title(titleOf(line)));
  if (verbosity === 'detailed') {
    const brand = clean(line.snapshot.brand);
    if (brand && !titleOf(line).toLowerCase().includes(brand.toLowerCase())) s.push(en.readback.attribute(L.brand, brand));
  }
  s.push(en.readback.attribute(L.colour, colourOf(line) ?? LISTING_DOESNT_SAY));
  s.push(en.readback.attribute(L.size, sizeOf(line) ?? LISTING_DOESNT_SAY));
  if (verbosity === 'detailed') {
    for (const a of DETAILED_ATTRIBUTES) {
      const v = clean(attrs[a.key]);
      if (v) s.push(en.readback.attribute(L[a.key], v));
      else if (a.alwaysSay) s.push(en.readback.attribute(L[a.key], LISTING_DOESNT_SAY));
    }
  }
  s.push(quantitySentence(line, verbosity));
  s.push(en.readback.soldBy(sellerOf(line)));
  if (includeReturns) s.push(returnsPhrase(line.snapshot.returnPolicy));
  return s;
}

function moneySentence(cart: Cart, payment: PaymentSourceDescription, verbosity: Verbosity): string {
  const t = cart.totals;
  const label = clean(payment.label) ?? en.readback.fallbackPayment;
  if (verbosity === 'brief') return en.readback.moneyBrief(t.total, label);
  const units = cart.lines.reduce((a, l) => a + l.quantity, 0);
  return en.readback.money(units === 1 ? L.itemSingular : L.items, t.items, t.shipping, t.tax, t.total, label);
}

function buildFields(cart: Cart, payment: PaymentSourceDescription, delivery: string | null): ReadbackField[] {
  const f: ReadbackField[] = [];
  cart.lines.forEach((line, i) => {
    const p = `line${i + 1}`;
    const attrs = line.snapshot.attributes;
    f.push({ key: `${p}.title`, label: L.item, value: titleOf(line) });
    const brand = clean(line.snapshot.brand);
    if (brand) f.push({ key: `${p}.brand`, label: L.brand, value: brand });
    f.push({ key: `${p}.colour`, label: L.colour, value: colourOf(line) ?? LISTING_DOESNT_SAY });
    f.push({ key: `${p}.size`, label: L.size, value: sizeOf(line) ?? LISTING_DOESNT_SAY });
    for (const a of DETAILED_ATTRIBUTES) {
      const v = clean(attrs[a.key]);
      if (v) f.push({ key: `${p}.${a.key}`, label: L[a.key], value: v });
    }
    f.push({ key: `${p}.quantity`, label: L.quantity, value: String(line.quantity) });
    f.push({ key: `${p}.unitPrice`, label: L.unitPrice, value: mFull(line.snapshot.price) });
    if (line.quantity > 1)
      f.push({ key: `${p}.lineTotal`, label: L.lineTotal, value: mFull(multiplyMoney(line.snapshot.price, line.quantity)) });
    f.push({ key: `${p}.seller`, label: L.seller, value: sellerOf(line) });
    f.push({ key: `${p}.returns`, label: L.returns, value: returnsPhrase(line.snapshot.returnPolicy).replace(/\.$/, '') });
  });
  const t = cart.totals;
  f.push({ key: 'items', label: L.items, value: mFull(t.items) });
  f.push({ key: 'shipping', label: L.shipping, value: t.shipping.cents === 0 ? L.free : mFull(t.shipping) });
  f.push({ key: 'tax', label: L.tax, value: mFull(t.tax) });
  f.push({ key: 'total', label: L.total, value: mFull(t.total) });
  f.push({ key: 'paymentSource', label: L.paymentSource, value: clean(payment.label) ?? en.readback.fallbackPayment });
  f.push({ key: 'delivery', label: L.delivery, value: delivery ? capitalise(delivery) : L.notGivenYet });
  return f;
}

/**
 * Compose the spoken readback. Brief drops the money breakdown and extra attributes but always
 * keeps colour, size, quantity, seller and total. Detailed adds brand, material and other listed
 * attributes, and the cancel instruction. Fields are the same at every verbosity.
 */
export function composeReadback(input: ComposeReadbackInput): ComposedReadback {
  const { cart, paymentSource, verbosity, now } = input;
  validate(cart);
  const delivery = deliveryPhrase(input.deliveryEstimate, now, input.locale);
  const single = cart.lines.length === 1;

  const parts: string[] = [en.readback.intro];
  if (single) {
    parts.push(...lineSentences(cart.lines[0]!, verbosity, false));
  } else {
    parts.push(en.readback.itemCount(capitalise(numberToWords(cart.lines.length))));
    cart.lines.forEach((line, i) => {
      const lead = en.readback.ordinals[i] ?? en.readback.itemN(i + 1);
      const [, ...rest] = lineSentences(line, verbosity, true);
      parts.push(en.readback.lead(lead, titleOf(line)), ...rest);
    });
  }
  parts.push(moneySentence(cart, paymentSource, verbosity));
  if (input.payAfterCheck) parts.push(en.readback.payAfterCheck(sellerOf(cart.lines[0]!)));
  parts.push(delivery ? en.readback.deliveryBy(delivery) : en.readback.deliveryUnknown);
  if (single) parts.push(returnsPhrase(cart.lines[0]!.snapshot.returnPolicy));
  parts.push(
    verbosity === 'brief'
      ? en.readback.closingBrief
      : verbosity === 'detailed'
        ? en.readback.closingDetailed
        : en.readback.closingStandard,
  );

  const text = parts.join(' ');
  const fields = buildFields(cart, paymentSource, delivery);
  if (input.payAfterCheck) {
    const at = fields.findIndex((f) => f.key === 'paymentSource');
    fields.splice(at + 1, 0, { key: 'payAfterCheck', label: L.payAfterCheck, value: en.readback.payAfterCheckValue });
  }
  const textHash = hashReadbackText(text);
  return { text, fields, textHash };
}

/** Total being charged, for confirmation prompts ("Press confirm again to pay $36.72"). */
export function readbackTotal(cart: Cart): Money {
  return cart.totals.total;
}
