import { money, type Money } from '@sightline/core';

/**
 * Number words in both directions: "forty-five" to 45 for the grammar, 2 to "two" for speech.
 */

const ONES = [
  'zero',
  'one',
  'two',
  'three',
  'four',
  'five',
  'six',
  'seven',
  'eight',
  'nine',
  'ten',
  'eleven',
  'twelve',
  'thirteen',
  'fourteen',
  'fifteen',
  'sixteen',
  'seventeen',
  'eighteen',
  'nineteen',
] as const;
const TENS = ['', '', 'twenty', 'thirty', 'forty', 'fifty', 'sixty', 'seventy', 'eighty', 'ninety'] as const;

const ORDINALS: Record<string, number> = {
  first: 1,
  second: 2,
  third: 3,
  fourth: 4,
  fifth: 5,
  sixth: 6,
  seventh: 7,
  eighth: 8,
  ninth: 9,
  tenth: 10,
  '1st': 1,
  '2nd': 2,
  '3rd': 3,
  '4th': 4,
  '5th': 5,
};

/** English words for a whole number from 0 to 999,999. Larger or fractional values stay as digits. */
export function numberToWords(n: number): string {
  if (!Number.isInteger(n) || n < 0 || n > 999_999) return String(n);
  if (n < 20) return ONES[n]!;
  if (n < 100) {
    const t = TENS[Math.floor(n / 10)]!;
    return n % 10 === 0 ? t : `${t}-${ONES[n % 10]}`;
  }
  if (n < 1000) {
    const h = `${ONES[Math.floor(n / 100)]} hundred`;
    return n % 100 === 0 ? h : `${h} ${numberToWords(n % 100)}`;
  }
  const th = `${numberToWords(Math.floor(n / 1000))} thousand`;
  return n % 1000 === 0 ? th : `${th} ${numberToWords(n % 1000)}`;
}

/** Quantities are spoken as words up to one hundred, then as digits. */
export function quantityWord(n: number): string {
  return n <= 100 ? numberToWords(n) : String(n);
}

/** "One", "Two", ... for option lists. */
export function optionWord(n: number): string {
  const w = numberToWords(n);
  return w[0]!.toUpperCase() + w.slice(1);
}

export function ordinalValue(word: string): number | undefined {
  return ORDINALS[word];
}

function smallValue(w: string): number | undefined {
  const i = (ONES as readonly string[]).indexOf(w);
  return i >= 0 ? i : undefined;
}

function tensValue(w: string): number | undefined {
  const i = (TENS as readonly string[]).indexOf(w);
  return i >= 2 ? i * 10 : undefined;
}

export function isNumberWord(w: string): boolean {
  return smallValue(w) !== undefined || tensValue(w) !== undefined || w === 'hundred' || w === 'thousand';
}

export interface NumberRead {
  value: number;
  /** Index just after the last consumed word. */
  end: number;
  /** True when spoken as words rather than digits. */
  spoken: boolean;
}

/**
 * Read a number starting at words[start]. Accepts digits ("40", "39.99", "1,200") or words
 * ("forty", "forty five", "a hundred and twenty", "nine and a half", "four point five").
 * Expects words already split on hyphens.
 */
export function readNumber(ws: string[], start: number): NumberRead | null {
  const first = ws[start];
  if (first === undefined) return null;
  if (/^\d+(?:,\d{3})*(?:\.\d+)?$/.test(first)) {
    let value = Number(first.replace(/,/g, ''));
    let end = start + 1;
    const half = readHalf(ws, end);
    if (half) {
      value += 0.5;
      end = half;
    }
    return { value, end, spoken: false };
  }

  let total = 0;
  let current = 0;
  let last: 'none' | 'unit' | 'teen' | 'tens' | 'hundred' | 'thousand' = 'none';
  let i = start;
  for (; i < ws.length; i++) {
    const w = ws[i]!;
    const small = smallValue(w);
    const tens = tensValue(w);
    if (w === 'a' && last === 'none' && (ws[i + 1] === 'hundred' || ws[i + 1] === 'thousand')) {
      current = 1;
      last = 'unit';
      continue;
    }
    if (small !== undefined && small < 10) {
      if (last === 'unit' || last === 'teen') break;
      current += small;
      last = 'unit';
    } else if (small !== undefined) {
      if (last === 'unit' || last === 'teen' || last === 'tens') break;
      current += small;
      last = 'teen';
    } else if (tens !== undefined) {
      if (last === 'unit' || last === 'teen' || last === 'tens') break;
      current += tens;
      last = 'tens';
    } else if (w === 'hundred') {
      if (last === 'none' || last === 'hundred' || current >= 100) break;
      current *= 100;
      last = 'hundred';
    } else if (w === 'thousand') {
      if (last === 'none' || last === 'thousand') break;
      total += current * 1000;
      current = 0;
      last = 'thousand';
    } else if (w === 'and' && (last === 'hundred' || last === 'thousand')) {
      const nxt = ws[i + 1];
      if (nxt !== undefined && (smallValue(nxt) !== undefined || tensValue(nxt) !== undefined)) continue;
      break;
    } else {
      break;
    }
  }
  if (last === 'none') return null;
  let value = total + current;
  let end = i;
  if (ws[end] === 'point') {
    const digits: string[] = [];
    let j = end + 1;
    while (j < ws.length) {
      const d = smallValue(ws[j]!);
      if (d === undefined || d > 9) break;
      digits.push(String(d));
      j++;
    }
    if (digits.length > 0) {
      value = Number(`${value}.${digits.join('')}`);
      end = j;
    }
  }
  const half = readHalf(ws, end);
  if (half) {
    value += 0.5;
    end = half;
  }
  return { value, end, spoken: true };
}

/** "and a half" or "and half" after a number. Returns the end index or 0. */
function readHalf(ws: string[], i: number): number {
  if (ws[i] === 'and' && ws[i + 1] === 'a' && ws[i + 2] === 'half') return i + 3;
  if (ws[i] === 'and' && ws[i + 1] === 'half') return i + 2;
  return 0;
}

/** Parse a whole phrase as a single number, or undefined if anything is left over. */
export function parseNumberPhrase(phrase: string[]): number | undefined {
  const r = readNumber(phrase, 0);
  return r && r.end === phrase.length ? r.value : undefined;
}

// ---------------------------------------------------------------------------------------------
// Spoken money

/** Currency words and signs. null means the caller's default currency (dollars may be USD, CAD, AUD). */
export const CURRENCY_WORDS: Record<string, string | null> = {
  $: null,
  dollar: null,
  dollars: null,
  bucks: null,
  buck: null,
  usd: 'USD',
  '£': 'GBP',
  pound: 'GBP',
  pounds: 'GBP',
  quid: 'GBP',
  gbp: 'GBP',
  '€': 'EUR',
  euro: 'EUR',
  euros: 'EUR',
  eur: 'EUR',
  '₹': 'INR',
  rupee: 'INR',
  rupees: 'INR',
  rs: 'INR',
  inr: 'INR',
};

function toMoney(value: number, currency: string): Money {
  return money(Math.round(value * 100), currency);
}

export interface MoneyRead {
  money: Money;
  start: number;
  end: number;
}

/** Read an amount at i: "$40", "40 dollars", "forty bucks", "39.99", "twenty nine ninety nine". */
export function readMoneyAt(ws: string[], i: number, defaultCurrency: string, requireCurrency: boolean): MoneyRead | null {
  let start = i;
  let currency: string | undefined;
  let j = i;
  const sign = ws[j];
  if (sign !== undefined && sign in CURRENCY_WORDS && /^[$£€₹]$/.test(sign)) {
    currency = CURRENCY_WORDS[sign] ?? defaultCurrency;
    j++;
  }
  const n = readNumber(ws, j);
  if (!n) return null;
  let value = n.value;
  let end = n.end;
  // Spoken prices: "twenty nine ninety nine" is 29.99.
  if (n.spoken && Number.isInteger(value) && value < 1000) {
    const cents = readNumber(ws, end);
    if (cents && cents.spoken && Number.isInteger(cents.value) && cents.value >= 10 && cents.value <= 99) {
      value = value + cents.value / 100;
      end = cents.end;
    }
  }
  const after = ws[end];
  if (currency === undefined && after !== undefined && after in CURRENCY_WORDS) {
    currency = CURRENCY_WORDS[after] ?? defaultCurrency;
    end++;
    if (ws[end] === 'and') {
      const c = readNumber(ws, end + 1);
      if (c && (ws[c.end] === 'cents' || ws[c.end] === 'cent') && c.value < 100) {
        value += c.value / 100;
        end = c.end + 1;
      }
    }
  }
  if (currency === undefined) {
    if (requireCurrency) return null;
    currency = defaultCurrency;
  }
  return { money: toMoney(value, currency), start, end };
}

