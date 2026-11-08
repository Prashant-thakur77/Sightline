import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { PRODUCT_NAME } from '@sightline/core';
import { CONFIDENCE_WORDS, en, returnsPhrase, returnsShort } from '../src/copy/en';
import { categoryOf, colourSupport, findPhrases, materialSupport, normaliseSize, sameSize, CATEGORIES } from '../src/lexicon';
import { numberToWords, parseNumberPhrase, quantityWord, readMoneyAt, readNumber } from '../src/numbers';
import { expandContractions, joinAnd, joinOr, normaliseForQuote, normaliseText, tokenize, words } from '../src/text';
import * as api from '../src';

describe('numbers', () => {
  it.each([
    [0, 'zero'],
    [1, 'one'],
    [13, 'thirteen'],
    [20, 'twenty'],
    [45, 'forty-five'],
    [100, 'one hundred'],
    [120, 'one hundred twenty'],
    [3672, 'three thousand six hundred seventy-two'],
  ])('numberToWords(%i) = %s', (n, w) => {
    expect(numberToWords(n)).toBe(w);
  });

  it('keeps digits beyond one hundred for quantities', () => {
    expect(quantityWord(2)).toBe('two');
    expect(quantityWord(250)).toBe('250');
  });

  it.each([
    ['forty five', 45],
    ['a hundred and twenty', 120],
    ['two thousand five hundred', 2500],
    ['nine and a half', 9.5],
    ['four point five', 4.5],
    ['1,200', 1200],
    ['39.99', 39.99],
  ])('parseNumberPhrase(%j) = %d', (text, n) => {
    expect(parseNumberPhrase(words(text))).toBe(n);
  });

  it('stops at a word that cannot continue the number', () => {
    expect(readNumber(words('twenty nine ninety nine'), 0)).toMatchObject({ value: 29, end: 2 });
    expect(parseNumberPhrase(words('forty bananas'))).toBeUndefined();
  });

  it('reads spoken money with cents', () => {
    expect(readMoneyAt(words('thirty dollars and fifty cents'), 0, 'USD', true)?.money).toEqual({ cents: 3050, currency: 'USD' });
    expect(readMoneyAt(words('40'), 0, 'USD', true)).toBeNull();
  });
});

describe('text', () => {
  it('normalises quotes, dashes and space', () => {
    expect(normaliseText('  “Confirm” — ‘now’ ')).toBe('"confirm" - \'now\'');
    expect(normaliseForQuote('Runs  a size small – order “up”')).toBe('runs a size small-order up');
  });

  it('tokenises numbers, sizes and signs', () => {
    expect(tokenize('$39.99 for 2XL, 30-day returns, 100%')).toEqual(['$', '39.99', 'for', '2xl', '30-day', 'returns', '100', '%']);
    expect(words("crew-neck, it's")).toEqual(['crew', 'neck', "it's"]);
  });

  it('expands contractions and joins lists', () => {
    expect(expandContractions(["don't", "i'll", 'wanna'])).toEqual(['do', 'not', 'i', 'will', 'want', 'to']);
    expect(joinAnd(['a', 'b', 'c'])).toBe('a, b and c');
    expect(joinOr(['a', 'b'])).toBe('a or b');
  });
});

describe('lexicon', () => {
  it('colour support handles synonyms, compounds and atomic names', () => {
    expect([...colourSupport('Navy Blue')].sort()).toEqual(['blue', 'navy']);
    expect(colourSupport('Grey Heather').has('grey')).toBe(true);
    expect(colourSupport('gray').has('grey')).toBe(true);
    expect([...colourSupport('Off-White')]).toEqual(['off-white']);
    expect(colourSupport(undefined).size).toBe(0);
  });

  it('material support includes the words inside compound names', () => {
    expect([...materialSupport('100% Merino Wool')].sort()).toEqual(['merino', 'wool']);
    expect(materialSupport('slow down').size).toBe(0);
  });

  it.each([
    ['Medium', 'M'],
    ['m', 'M'],
    ['extra large', 'XL'],
    ['2XL', 'XXL'],
    ['size 9', '9'],
    ['9.50', '9.5'],
    ['UK 9', 'UK 9'],
  ])('normaliseSize(%j) = %s', (raw, n) => {
    expect(normaliseSize(raw)).toBe(n);
  });

  it('compares sizes after normalising', () => {
    expect(sameSize('Medium', 'M')).toBe(true);
    expect(sameSize('M', 'L')).toBe(false);
    expect(sameSize(undefined, 'M')).toBe(false);
  });

  it('matches plural category names and longest phrases first', () => {
    expect(categoryOf('Navy T-Shirts')?.canonical).toBe('t-shirt');
    expect(findPhrases(words('running shoes'), CATEGORIES, true)[0]?.canonical).toBe('running shoes');
  });
});

describe('copy bank', () => {
  function strings(value: unknown, out: string[] = []): string[] {
    if (typeof value === 'string') out.push(value);
    else if (Array.isArray(value)) value.forEach((v) => strings(v, out));
    else if (value && typeof value === 'object') Object.values(value).forEach((v) => strings(v, out));
    return out;
  }
  const all = [
    ...strings(en),
    en.general.welcome(),
    en.general.intro(),
    en.confirm.pressAgain({ cents: 3672, currency: 'USD' }),
    en.payment.paid({ cents: 3672, currency: 'USD' }, 'Demo Store'),
    en.cases.sent('Demo Store', 'Friday'),
    en.gate.priceChanged({ cents: 3400, currency: 'USD' }, { cents: 3900, currency: 'USD' }),
    en.gate.overOrderLimit({ cents: 10000, currency: 'USD' }),
    returnsPhrase(null),
    returnsShort({ windowDays: 30, free: true }),
  ];

  it('includes the reference lines', () => {
    expect(en.general.listening).toBe('Listening.');
    expect(en.general.notHeard).toBe("I didn't catch that. Press Talk and try again, or type it.");
    expect(en.payment.paid({ cents: 3672, currency: 'USD' }, 'Demo Store')).toBe(
      "Paid. $36.72 to Demo Store. Your receipt is saved. I'll tell you when it ships.",
    );
    expect(en.cases.sent('Demo Store', 'Friday')).toBe(
      "I sent your case to Demo Store through PayPal. They have until Friday to reply. I'll tell you when they do.",
    );
    expect(en.gate.priceChanged({ cents: 3400, currency: 'USD' }, { cents: 3900, currency: 'USD' })).toContain('from $34 to $39');
    expect(en.gate.overOrderLimit({ cents: 10000, currency: 'USD' })).toBe(
      "That's over your $100 limit for one order. You can raise the limit in settings, or pick something else.",
    );
  });

  it('never says "oops", gives percentages, or points at the screen', () => {
    for (const s of all) {
      expect(s.toLowerCase()).not.toContain('oops');
      expect(s).not.toMatch(/\d\s?%|percent/i);
      expect(s).not.toMatch(/\b(click|on the left|on the right|highlighted|icon|blue button|green button|red button|see below|see above)\b/i);
    }
  });

  it('keeps sentences short', () => {
    for (const s of all) for (const sentence of s.split(/(?<=[.!?])\s+/)) expect(sentence.split(/\s+/).length).toBeLessThanOrEqual(25);
  });

  it('speaks confidence as words', () => {
    expect(Object.values(CONFIDENCE_WORDS)).toEqual(['sure', 'fairly sure', 'not sure']);
  });

  it('names the product through PRODUCT_NAME, never a literal', () => {
    expect(en.general.welcome()).toContain(PRODUCT_NAME);
    const src = join(__dirname, '..', 'src');
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const f of readdirSync(dir)) {
        const p = join(dir, f);
        if (statSync(p).isDirectory()) walk(p);
        else if (p.endsWith('.ts')) files.push(p);
      }
    };
    walk(src);
    for (const f of files) expect(readFileSync(f, 'utf8')).not.toMatch(/sightline(?!\/)/i);
  });
});

describe('package exports', () => {
  it('exposes the public API from the index', () => {
    for (const name of [
      'composeReadback',
      'matchConfirmationPhrase',
      'decideConfirmation',
      'parseIntent',
      'parseShoppingQuery',
      'checkGrounding',
      'GroundingTurn',
      'rankProducts',
      'presentOptions',
      'presentVerdict',
      'presentCaseUpdate',
      'presentMoneyTimeline',
      'en',
    ])
      expect(api).toHaveProperty(name);
  });
});
