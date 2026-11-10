import { describe, expect, it } from 'vitest';
import { checkGrounding, type Claim, type Segment } from '../src/grounding';
import { dayLabel, readDates } from '../src/when';
import { words } from '../src/text';
import { snapshot } from './helpers';

// Monday 9 November 2026; the store's estimate is Thursday 12 November.
const NOW = new Date('2026-11-09T12:00:00.000Z');
const ESTIMATE = new Date('2026-11-12T12:00:00.000Z');
const field = (ref: string): Claim => ({ kind: 'field', ref });
const quote = (q: string): Claim => ({ kind: 'quote', quote: q, sourceId: 'reviews' });
const REVIEWS = 'Runs a size small, so order up.\nLovely colour, true navy in daylight.\nNot scratchy, even on bare skin.';

function supported(segment: Segment, over: { now?: Date } = { now: NOW }): boolean {
  return checkGrounding({
    segments: [segment],
    snapshots: [snapshot()],
    archives: { reviews: REVIEWS },
    facts: { 'delivery.estimate': ESTIMATE },
    ...over,
  }).supported;
}
const delivery = (text: string) => supported({ text, claims: [field('delivery.estimate')] });

function read(text: string, relative = true): string[] {
  return readDates(words(text), NOW, relative).map((s) => (s.from === s.to ? dayLabel(s.from) : `${dayLabel(s.from)}..${dayLabel(s.to)}`));
}

describe('readDates', () => {
  it('reads weekdays from the clock, "next" as the following week', () => {
    expect(read('arrives Thursday')).toEqual(['2026-11-12']);
    expect(read('arrives this Friday')).toEqual(['2026-11-13']);
    expect(read('arrives next Thursday')).toEqual(['2026-11-19']);
    expect(read('arrives Monday')).toEqual(['2026-11-09']);
  });

  it('reads written and spoken month-day forms', () => {
    for (const t of ['Nov 12', '12 Nov', 'November 12th', '12th of November', 'the twelfth of November', 'November twelfth', 'Dec 1st 2026'])
      expect(read(t)[0]).toMatch(/^2026-1[12]-(12|01)$/);
    expect(read('the 12th')).toEqual(['2026-11-12']);
    expect(read('on the 3rd')).toEqual(['2026-12-03']);
    expect(read('Jan 4')).toEqual(['2027-01-04']);
  });

  it('reads relative days and ranges', () => {
    expect(read('tomorrow')).toEqual(['2026-11-10']);
    expect(read('the day after tomorrow')).toEqual(['2026-11-11']);
    expect(read('in 3 days')).toEqual(['2026-11-12']);
    expect(read('in four business days')).toEqual(['2026-11-13']);
    expect(read('within a week')).toEqual(['2026-11-09..2026-11-16']);
    expect(read('next week')).toEqual(['2026-11-16..2026-11-22']);
    expect(read('this weekend')).toEqual(['2026-11-14..2026-11-15']);
    expect(read('by the weekend')).toEqual(['2026-11-09..2026-11-14']);
    expect(read('two days from now')).toEqual(['2026-11-11']);
  });

  it('leaves relative words alone outside delivery talk', () => {
    expect(read('tomorrow', false)).toEqual([]);
  });

  it('flags a weekday that disagrees with its date', () => {
    expect(readDates(words('Friday 12 November'), NOW, true)[0]!.conflict).toBe(true);
    expect(readDates(words('Thursday 12 November'), NOW, true)[0]!.conflict).toBe(false);
  });
});

describe('delivery dates against the estimate', () => {
  it('accepts the estimate in any form', () => {
    for (const t of [
      'It arrives Thursday.',
      'It should be there on the 12th.',
      'Delivery is due Nov 12.',
      'It arrives in 3 days.',
      'You will have it in three business days.',
      'It should arrive this week.',
      'It arrives Thursday the twelfth.',
      'Expected delivery is 12 November 2026.',
    ])
      expect(delivery(t), t).toBe(true);
  });

  it('catches any other day', () => {
    for (const t of [
      'It arrives tomorrow.',
      'It should arrive by Friday.',
      'It ships in two days.',
      "You'll have it next week.",
      'It arrives next Thursday.',
      'Delivery is on Nov 13.',
      'It arrives on the 14th.',
      'It will be there this weekend.',
      'It arrives Friday 12 November.',
    ])
      expect(delivery(t), t).toBe(false);
  });

  it('without a clock, relative dates cannot be backed', () => {
    expect(supported({ text: 'It arrives tomorrow.', claims: [field('delivery.estimate')] }, {})).toBe(false);
    expect(supported({ text: 'It arrives Thursday.', claims: [field('delivery.estimate')] }, {})).toBe(true);
  });

  it('does not read a return window as a delivery date', () => {
    expect(supported({ text: 'You can return it within 30 days of delivery.', claims: [field('returnPolicy')] })).toBe(true);
  });
});

describe('negation', () => {
  // The helper snapshot: navy merino, size M, $34, free returns within 30 days.
  const at = (text: string, ref: string) => supported({ text, claims: [field(ref)] });

  it('catches a negation of what the listing says', () => {
    expect(at("It isn't navy.", 'attributes.colour')).toBe(false);
    expect(at('It is not made of merino.', 'attributes.material')).toBe(false);
    expect(at("It isn't wool.", 'attributes.material')).toBe(false);
    expect(at('Size M is not available.', 'attributes.size')).toBe(false);
    expect(at("It doesn't cost $34.", 'price')).toBe(false);
    expect(at('Returns are not free.', 'returnPolicy')).toBe(false);
    expect(at("You can't send it back within 30 days.", 'returnPolicy')).toBe(false);
  });

  it('accepts a negation the listing rules out', () => {
    expect(at("It isn't cotton.", 'attributes.material')).toBe(true);
    expect(at('This one is not grey.', 'attributes.colour')).toBe(true);
    expect(at("It doesn't cost $50, it costs $34.", 'price')).toBe(true);
    expect(at("You don't get 60 days; you get 30.", 'returnPolicy')).toBe(true);
  });

  it('does not let a negation stand on a listing that does not say', () => {
    expect(at("It doesn't come in black.", 'attributes.colour')).toBe(false);
    expect(at("It isn't waterproof.", 'description')).toBe(false);
  });

  it('accepts a positive clause next to a negated one', () => {
    expect(at("It's not grey, it's navy.", 'attributes.colour')).toBe(true);
  });

  it('reads polarity in the source too', () => {
    const r = checkGrounding({
      segments: [{ text: 'It is machine washable.', claims: [field('attributes.care')] }],
      snapshots: [snapshot({ attributes: { care: 'Do not machine wash. Dry clean only.' } })],
    });
    expect(r.supported).toBe(false);
    const ok = checkGrounding({
      segments: [{ text: "It isn't machine washable.", claims: [field('attributes.care')] }],
      snapshots: [snapshot({ attributes: { care: 'Do not machine wash. Dry clean only.' } })],
    });
    expect(ok.supported).toBe(true);
  });

  it('a feature needs the cited field to state it', () => {
    const snap = snapshot({ attributes: { care: 'machine wash cold' } });
    const run = (text: string, ref: string) => checkGrounding({ segments: [{ text, claims: [field(ref)] }], snapshots: [snap] }).supported;
    expect(run('It is machine washable.', 'attributes.care')).toBe(true);
    expect(run('It is machine washable.', 'attributes.colour')).toBe(false);
    expect(run('It is not machine washable.', 'attributes.care')).toBe(false);
  });
});

describe('citations', () => {
  it('a review claim needs a verbatim quote behind it', () => {
    expect(supported({ text: 'Reviewers say it never pills.', claims: [] })).toBe(false);
    expect(supported({ text: 'Reviewers say it never pills.', claims: [field('description')] })).toBe(false);
    expect(supported({ text: 'Reviewers say it runs a size small.', claims: [quote('Runs a size small, so order up.')] })).toBe(true);
    expect(supported({ text: 'Reviewers say it pills after one wash.', claims: [quote('Runs a size small, so order up.')] })).toBe(false);
  });

  it('ignores punctuation at the edge of a quoted span', () => {
    expect(supported({ text: 'One reviewer wrote "Lovely colour."', claims: [quote('Lovely colour')] })).toBe(true);
    expect(supported({ text: 'One reviewer wrote "Lovely colour, deep red."', claims: [quote('Lovely colour')] })).toBe(false);
  });

  it('keeps a quote whose own words are negated', () => {
    expect(supported({ text: 'A reviewer says it is "not scratchy, even on bare skin".', claims: [quote('Not scratchy, even on bare skin.')] })).toBe(true);
  });

  it('a rating with a review count is not a review claim', () => {
    expect(supported({ text: 'It has 4.6 stars from 212 reviews.', claims: [field('rating')] })).toBe(true);
  });
});
