import { describe, expect, it } from 'vitest';
import { parseIntent, parseShoppingQuery, queryToSearchText, type GrammarContext } from '../src/grammar';
import { usd } from './helpers';

const options: GrammarContext = {
  options: [
    { index: 1, price: usd(3400), colour: 'Navy' },
    { index: 2, price: usd(2900), colour: 'Black' },
    { index: 3, price: usd(4500), colour: 'Heather Grey' },
  ],
};

describe('parseShoppingQuery', () => {
  it('reads the reference query', () => {
    expect(parseShoppingQuery('navy crew-neck sweater, medium, under forty dollars')).toMatchObject({
      category: 'sweater',
      colour: 'navy',
      attributes: { neckline: 'crew-neck' },
      size: 'M',
      sizeSource: 'spoken',
      maxPrice: usd(4000),
    });
  });

  it.each([
    ['under $40', 4000],
    ['under 40 bucks', 4000],
    ['less than 40 dollars', 4000],
    ['no more than fifty dollars', 5000],
    ['under twenty nine ninety nine', 2999],
    ['up to $39.99', 3999],
    ['under a hundred and twenty dollars', 12000],
    ['under forty-five dollars', 4500],
    ['for at most 30', 3000],
    ['a $40 hoodie', 4000],
  ])('price %j', (text, cents) => {
    expect(parseShoppingQuery(text).maxPrice).toEqual(usd(cents));
  });

  it('reads a price range', () => {
    expect(parseShoppingQuery('jeans between 20 and 40 dollars')).toMatchObject({ minPrice: usd(2000), maxPrice: usd(4000), category: 'jeans' });
    expect(parseShoppingQuery('boots from $50 to $80')).toMatchObject({ minPrice: usd(5000), maxPrice: usd(8000) });
  });

  it('reads other currencies', () => {
    expect(parseShoppingQuery('scarf under 30 pounds').maxPrice).toEqual({ cents: 3000, currency: 'GBP' });
    expect(parseShoppingQuery('mug under ₹500').maxPrice).toEqual({ cents: 50000, currency: 'INR' });
  });

  it.each([
    ['small sweater', 'S'],
    ['sweater in extra large', 'XL'],
    ['xxl hoodie', 'XXL'],
    ['t-shirt size L', 'L'],
    ['boots size 9', '9'],
    ['boots size nine and a half', '9.5'],
    ['size 10.5 sneakers', '10.5'],
  ])('size %j -> %s', (text, size) => {
    expect(parseShoppingQuery(text).size).toBe(size);
  });

  it('fills the saved size for the category when none is spoken', () => {
    const saved = { tops: 'M', bottoms: '32', shoes: '9' };
    expect(parseShoppingQuery('navy sweater', { savedSizes: saved })).toMatchObject({ size: 'M', sizeSource: 'saved' });
    expect(parseShoppingQuery('black jeans', { savedSizes: saved })).toMatchObject({ size: '32', sizeSource: 'saved' });
    expect(parseShoppingQuery('running shoes', { savedSizes: saved })).toMatchObject({ size: '9', category: 'running shoes' });
    expect(parseShoppingQuery('large sweater', { savedSizes: saved })).toMatchObject({ size: 'L', sizeSource: 'spoken' });
    expect(parseShoppingQuery('a mug', { savedSizes: saved }).size).toBeUndefined();
  });

  it('reads attributes, materials, free returns and keywords', () => {
    const q = parseShoppingQuery('slim fit striped merino wool v-neck jumpers with free returns, waterproof');
    expect(q).toMatchObject({
      category: 'sweater',
      freeReturns: true,
      attributes: { neckline: 'v-neck', fit: 'slim', pattern: 'striped', material: 'merino' },
    });
    expect(q.keywords).toContain('waterproof');
  });

  it('treats the last category word as the head noun', () => {
    expect(parseShoppingQuery('polo neck sweater').category).toBe('sweater');
    expect(parseShoppingQuery('t-shirt dress').category).toBe('dress');
  });

  it('turns a query into search text', () => {
    expect(queryToSearchText(parseShoppingQuery('navy crew-neck sweater, medium, under forty dollars'))).toBe('navy crew-neck sweater');
  });
});

describe('parseIntent', () => {
  it.each([
    ['I need a navy sweater', 'search'],
    ['find me running shoes', 'search'],
    ['show me wool socks under 40 bucks', 'search'],
    ["I'm looking for a black hoodie", 'search'],
    ['navy crew-neck sweater, medium', 'search'],
    ['tell me more', 'details'],
    ["what's it made of", 'details'],
    ['return policy', 'details'],
    ['is it machine washable?', 'details'],
    ['is the sweater wool?', 'details'],
    ['compare one and three', 'compare'],
    ['which is softer', 'compare'],
    ['cheaper', 'refine'],
    ['in black', 'refine'],
    ['size large', 'refine'],
    ['only free returns', 'refine'],
    ['more', 'refine'],
    ['buy this', 'cart'],
    ['add to cart', 'cart'],
    ['change size to L', 'cart'],
    ['remove it', 'cart'],
    ["where's my order", 'status'],
    ['where is my money', 'status'],
    ['did it ship', 'status'],
    ['check my delivery', 'check'],
    ['it arrived', 'check'],
    ['this is wrong', 'case'],
    ['get my money back', 'case'],
    ["it's damaged", 'case'],
    ['it never came', 'case'],
    ['accept', 'offer'],
    ['decline', 'offer'],
    ['what did they offer', 'offer'],
    ['help', 'help'],
    ['what can I say', 'help'],
    ['repeat', 'help'],
    ['talk faster', 'settings'],
    ['be brief', 'settings'],
    ['change my spending limit', 'settings'],
    ['cancel', 'cancel'],
    ['hold on', 'hold'],
    ["what's the weather like", 'freeform'],
    ['is this a good gift for my dad', 'freeform'],
  ])('%j -> %s', (u, intent) => {
    expect(parseIntent(u, options).intent).toBe(intent);
  });

  it('chooses by position', () => {
    expect(parseIntent('one', options)).toMatchObject({ intent: 'choose', slots: { index: 1 }, confidence: 'sure' });
    expect(parseIntent('number two', options)).toMatchObject({ intent: 'choose', slots: { index: 2 } });
    expect(parseIntent('the second one', options)).toMatchObject({ intent: 'choose', slots: { index: 2 } });
    expect(parseIntent('option 3', options)).toMatchObject({ intent: 'choose', slots: { index: 3 } });
    expect(parseIntent('the last one', options)).toMatchObject({ intent: 'choose', slots: { index: 3 } });
    expect(parseIntent("let's go with the first", options)).toMatchObject({ intent: 'choose', slots: { index: 1 } });
  });

  it('flags an option number that was never read', () => {
    expect(parseIntent('five', options)).toMatchObject({ intent: 'choose', slots: { index: 5 }, confidence: 'not_sure' });
  });

  it('resolves "the cheaper one" only with context', () => {
    expect(parseIntent('the cheaper one', options)).toMatchObject({ intent: 'choose', slots: { index: 2, by: 'price_low' }, confidence: 'fairly_sure' });
    expect(parseIntent('the cheaper one')).toMatchObject({ intent: 'choose', slots: { needsContext: true }, confidence: 'not_sure' });
    expect(parseIntent('the most expensive one', options)).toMatchObject({ slots: { index: 3 } });
  });

  it('does not guess between options at the same price', () => {
    const tie: GrammarContext = { options: [{ index: 1, price: usd(3000) }, { index: 2, price: usd(3000) }] };
    expect(parseIntent('the cheaper one', tie)).toMatchObject({ intent: 'choose', confidence: 'not_sure' });
    expect(parseIntent('the cheaper one', tie).slots).not.toHaveProperty('index');
  });

  it('chooses by colour', () => {
    expect(parseIntent('the navy one', options)).toMatchObject({ intent: 'choose', slots: { index: 1, by: 'colour' } });
    expect(parseIntent('I want the grey one', options)).toMatchObject({ intent: 'choose', slots: { index: 3 } });
    expect(parseIntent('the red one', options)).toMatchObject({ intent: 'choose', confidence: 'not_sure' });
  });

  it('reads details topics and targets', () => {
    expect(parseIntent('what do reviews say about sizing')).toMatchObject({ intent: 'details', slots: { topic: 'reviews', aspect: 'sizing' } });
    expect(parseIntent('tell me more about two')).toMatchObject({ intent: 'details', slots: { topic: 'general', index: 2 } });
    expect(parseIntent('how does it fit')).toMatchObject({ intent: 'details', slots: { topic: 'sizing' } });
    expect(parseIntent('who sells it')).toMatchObject({ intent: 'details', slots: { topic: 'seller' } });
  });

  it('reads compare targets', () => {
    expect(parseIntent('compare one and three')).toMatchObject({ slots: { indices: [1, 3] }, confidence: 'sure' });
    expect(parseIntent('compare them')).toMatchObject({ slots: { indices: 'all' } });
    expect(parseIntent('compare the first and the second by price')).toMatchObject({ slots: { indices: [1, 2], aspect: 'price' } });
  });

  it('reads refinements', () => {
    expect(parseIntent('under 30 dollars')).toMatchObject({ intent: 'refine', slots: { maxPrice: usd(3000) } });
    expect(parseIntent('any colour')).toMatchObject({ intent: 'refine', slots: { anyColour: true } });
    expect(parseIntent('something cheaper in black')).toMatchObject({ intent: 'refine', slots: { cheaper: true, colour: 'black' } });
  });

  it('reads cart actions and changes', () => {
    expect(parseIntent('buy number two')).toMatchObject({ intent: 'cart', slots: { action: 'buy', index: 2 } });
    expect(parseIntent('change size to L')).toMatchObject({ slots: { action: 'change', changes: { size: 'L' } } });
    expect(parseIntent('change the colour to black')).toMatchObject({ slots: { action: 'change', changes: { colour: 'black' } } });
    expect(parseIntent('make it two')).toMatchObject({ slots: { action: 'change', changes: { quantity: 2 } } });
    expect(parseIntent('change quantity to 3')).toMatchObject({ slots: { action: 'change', changes: { quantity: 3 } } });
  });

  it('reads status, case and settings slots', () => {
    expect(parseIntent('where is my money')).toMatchObject({ slots: { topic: 'money' } });
    expect(parseIntent('has it shipped')).toMatchObject({ slots: { topic: 'shipping' } });
    expect(parseIntent('they sent the wrong colour')).toMatchObject({ intent: 'case', slots: { reason: 'wrong_colour' } });
    expect(parseIntent('it never came')).toMatchObject({ slots: { reason: 'not_received' } });
    expect(parseIntent('talk slower')).toMatchObject({ slots: { setting: 'speech_rate', change: 'slower' } });
    expect(parseIntent('more detail')).toMatchObject({ slots: { setting: 'verbosity', verbosity: 'detailed' } });
    expect(parseIntent('set my daily limit to 300 dollars')).toMatchObject({ slots: { setting: 'daily_limit', amount: usd(30000) } });
  });

  it('strips leading fillers', () => {
    expect(parseIntent('um, okay, where is my order').intent).toBe('status');
  });

  it('search uses saved sizes from context', () => {
    const r = parseIntent('find me a navy sweater', { savedSizes: { tops: 'M' } });
    expect(r).toMatchObject({ intent: 'search', confidence: 'sure', slots: { query: { size: 'M', sizeSource: 'saved', colour: 'navy' } } });
  });

  it('returns freeform with the original text for the model', () => {
    expect(parseIntent('  Hmm, what would you pick for a wedding? ')).toEqual({
      intent: 'freeform',
      slots: { text: 'Hmm, what would you pick for a wedding?' },
      confidence: 'not_sure',
    });
    expect(parseIntent('')).toMatchObject({ intent: 'freeform', confidence: 'not_sure' });
  });
});

describe('parseIntent during a readback', () => {
  const rb: GrammarContext = { phase: 'readback' };
  it('delegates confirm, hold and cancel to the phrase matcher', () => {
    expect(parseIntent('confirm purchase', rb)).toMatchObject({ intent: 'confirm', slots: { phrase: { decision: 'confirm' } } });
    expect(parseIntent('wait', rb).intent).toBe('hold');
    expect(parseIntent('not yet', rb).intent).toBe('hold');
    expect(parseIntent("don't buy it", rb).intent).toBe('cancel');
  });

  it('reads changes with their slots', () => {
    expect(parseIntent('make it two', rb)).toMatchObject({ intent: 'cart', slots: { action: 'change', changes: { quantity: 2 } } });
    expect(parseIntent('can I get it in black', rb)).toMatchObject({ slots: { changes: { colour: 'black' } } });
    expect(parseIntent('actually I want the large', rb)).toMatchObject({ slots: { changes: { size: 'L' } } });
  });

  it('never turns a non-confirmation into confirm', () => {
    for (const u of ['yes', 'should I confirm?', 'he said confirm', 'confirm your subscription today']) expect(parseIntent(u, rb).intent).not.toBe('confirm');
  });

  it('still answers questions and help during the readback', () => {
    expect(parseIntent('repeat', rb).intent).toBe('help');
    expect(parseIntent("what's it made of", rb).intent).toBe('details');
  });

  it('buy it outside a readback starts the cart, inside it confirms', () => {
    expect(parseIntent('buy it').intent).toBe('cart');
    expect(parseIntent('buy it', rb).intent).toBe('confirm');
  });
});

describe('parseIntent during an offer', () => {
  const offer: GrammarContext = { phase: 'offer' };
  it('accept and decline', () => {
    expect(parseIntent('accept the offer', offer)).toMatchObject({ intent: 'offer', slots: { action: 'accept' }, confidence: 'sure' });
    expect(parseIntent('decline', offer)).toMatchObject({ intent: 'offer', slots: { action: 'decline' } });
    expect(parseIntent('wait', offer).intent).toBe('hold');
  });
});

describe('buying by number', () => {
  const ctx = { phase: 'browsing' as const, options: [{ index: 1 }, { index: 2 }, { index: 3 }] };
  it.each([
    ['buy number one', 1],
    ['buy number 2', 2],
    ['buy option two', 2],
    ['buy the first one', 1],
    ['buy one', 1],
  ])('%s', (u, idx) => {
    const p = parseIntent(u, ctx);
    expect(p.intent).toBe('cart');
    expect((p.slots as { index?: number }).index).toBe(idx);
  });
  it('still reads "the second one" as a choice', () => {
    expect(parseIntent('the second one', ctx).intent).toBe('choose');
  });
});
