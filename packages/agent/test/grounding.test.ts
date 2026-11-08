import { describe, expect, it } from 'vitest';
import { GroundingTurn, checkGrounding, checkSegment, extractTokens, quoteAppears, type GroundingInput, type Segment } from '../src/grounding';
import { snapshot, usd } from './helpers';

const PAGE =
  'Harbor Knit Crew-Neck Sweater. Soft 100% merino wool. Customer review: “Runs a size small, so order up.” ' +
  'Another review: "Lovely colour,   true navy in daylight." Free returns within 30 days of delivery.';

function run(segments: Segment[], over: Partial<GroundingInput> = {}) {
  return checkGrounding({ segments, snapshots: [snapshot()], archives: { page1: PAGE }, ...over });
}

describe('extractTokens', () => {
  it('finds money, numbers, sizes, colours, materials, dates and policy terms', () => {
    const kinds = extractTokens('Navy merino, size M, $34, free returns for 30 days, arrives Tuesday 17 November.').map((t) => `${t.kind}:${t.value}`);
    expect(kinds).toEqual(
      expect.arrayContaining(['colour:navy', 'material:merino', 'size:M', 'money:USD 3400', 'policy:free returns', 'number:30', 'date:tuesday', 'date:17 november']),
    );
  });

  it('ignores number words that are not quantities and rating scales', () => {
    const values = extractTokens('One of the options is rated 4.6 out of 5.').map((t) => t.value);
    expect(values).toContain('4.6');
    expect(values).not.toContain('5');
    expect(values).not.toContain('1');
  });

  it('reads size words only near sizing language', () => {
    expect(extractTokens('It comes in small, medium and large sizes.').filter((t) => t.kind === 'size').map((t) => t.value)).toEqual(['S', 'M', 'L']);
    expect(extractTokens('A large selection of colours.').some((t) => t.kind === 'size')).toBe(false);
  });

  it('normalises "30-day" and "thirty days" to the same number', () => {
    expect(extractTokens('30-day returns').find((t) => t.kind === 'number')?.value).toBe('30');
    expect(extractTokens('thirty days to return it').find((t) => t.kind === 'number')?.value).toBe('30');
  });
});

describe('checkGrounding: supported', () => {
  it('accepts a field-backed colour, size and price', () => {
    const r = run([
      { text: "It's navy, size M, and costs $34.", claims: [{ kind: 'field', ref: 'attributes.colour' }, { kind: 'field', ref: 'attributes.size' }, { kind: 'field', ref: 'price' }] },
    ]);
    expect(r.supported).toBe(true);
    expect(r.text).toBe("It's navy, size M, and costs $34.");
  });

  it('matches "$34" against 34.00 and "$34.00" against 3400 cents', () => {
    expect(run([{ text: 'It costs $34.00.', claims: [{ kind: 'field', ref: 'price' }] }]).supported).toBe(true);
    expect(run([{ text: 'It costs 34 dollars.', claims: [{ kind: 'field', ref: 'price' }] }]).supported).toBe(true);
  });

  it('matches "30-day" against windowDays 30 and "free returns" against free: true', () => {
    expect(run([{ text: 'It has a 30-day return window.', claims: [{ kind: 'field', ref: 'returnPolicy.windowDays' }] }]).supported).toBe(true);
    expect(run([{ text: 'Free returns for thirty days.', claims: [{ kind: 'field', ref: 'returnPolicy' }] }]).supported).toBe(true);
  });

  it('lets "navy" stand for a listing that says "Navy Blue"', () => {
    const r = checkGrounding({
      segments: [{ text: 'The colour is navy.', claims: [{ kind: 'field', ref: 'attributes.colour' }] }],
      snapshots: [snapshot({ attributes: { colour: 'Navy Blue' } })],
    });
    expect(r.supported).toBe(true);
  });

  it('accepts "medium" for size "M" and the rating with its count', () => {
    expect(run([{ text: 'It is a size medium.', claims: [{ kind: 'field', ref: 'attributes.size' }] }]).supported).toBe(true);
    expect(run([{ text: 'Rated 4.6 out of 5 from 212 reviews.', claims: [{ kind: 'field', ref: 'rating' }] }]).supported).toBe(true);
  });

  it('accepts a quote present in the archived page, with whitespace, case and quote marks normalised', () => {
    const r = run([
      {
        text: 'One reviewer says "runs a size small, so order up."',
        claims: [{ kind: 'quote', quote: 'Runs a size small, so order up.', sourceId: 'page1' }],
      },
      { text: 'Another says it is a true navy in daylight.', claims: [{ kind: 'quote', quote: 'lovely colour, true navy in daylight', sourceId: 'page1' }] },
    ]);
    expect(r.supported).toBe(true);
    expect(r.replaced).toBe(0);
  });

  it('passes sentences with no product-specific tokens', () => {
    expect(run([{ text: 'Say a number for details.', claims: [] }]).supported).toBe(true);
  });

  it('accepts system facts such as the delivery date', () => {
    const r = run([{ text: 'It should arrive by Tuesday 17 November.', claims: [{ kind: 'field', ref: 'delivery.estimate' }] }], {
      facts: { 'delivery.estimate': new Date('2026-11-17T12:00:00Z') },
    });
    expect(r.supported).toBe(true);
  });

  it('checks each product against its own snapshot when comparing', () => {
    const black = snapshot({ id: 'snap_b', attributes: { colour: 'Black', size: 'M' }, price: usd(2900) });
    const r = checkGrounding({
      segments: [
        {
          text: 'One is navy and three is black.',
          claims: [
            { kind: 'field', ref: 'attributes.colour', snapshotId: 'snap_harbor_navy_m' },
            { kind: 'field', ref: 'attributes.colour', snapshotId: 'snap_b' },
          ],
        },
      ],
      snapshots: [snapshot(), black],
    });
    expect(r.supported).toBe(true);
  });
});

describe('checkGrounding: adversarial', () => {
  it('replaces an invented size', () => {
    const r = run([{ text: 'It also comes in size XL.', claims: [{ kind: 'field', ref: 'attributes.size' }] }]);
    expect(r.supported).toBe(false);
    expect(r.text).toBe("The listing doesn't say.");
    expect(r.unsupported[0]!.unsupportedTokens.map((t) => t.value)).toEqual(['XL']);
  });

  it('replaces an invented material', () => {
    const r = run([{ text: "It's made of cashmere.", claims: [{ kind: 'field', ref: 'attributes.material' }] }]);
    expect(r.supported).toBe(false);
    expect(r.unsupported[0]!.reasons.join(' ')).toContain('cashmere');
  });

  it('replaces a material claim when the listing has no material at all', () => {
    const r = checkGrounding({
      segments: [{ text: "It's 100% cotton.", claims: [{ kind: 'field', ref: 'attributes.material' }] }],
      snapshots: [snapshot({ attributes: { colour: 'Navy', size: 'M' } })],
    });
    expect(r.supported).toBe(false);
    expect(r.unsupported[0]!.reasons[0]).toBe('the listing has no attributes.material');
  });

  it('replaces a wrong price', () => {
    const r = run([{ text: 'It costs $29.', claims: [{ kind: 'field', ref: 'price' }] }]);
    expect(r.supported).toBe(false);
  });

  it('replaces a wrong return window and an unbacked "free returns"', () => {
    expect(run([{ text: 'You get 60 days to return it.', claims: [{ kind: 'field', ref: 'returnPolicy.windowDays' }] }]).supported).toBe(false);
    const notFree = checkGrounding({
      segments: [{ text: 'Free returns.', claims: [{ kind: 'field', ref: 'returnPolicy.free' }] }],
      snapshots: [snapshot({ returnPolicy: { windowDays: 30, free: false } })],
    });
    expect(notFree.supported).toBe(false);
  });

  it('replaces a more specific colour than the listing gives', () => {
    const r = run([{ text: 'It is a light blue.', claims: [{ kind: 'field', ref: 'attributes.colour' }] }]);
    expect(r.supported).toBe(false);
  });

  it('replaces a quote that is not on the page', () => {
    const r = run([{ text: 'A reviewer says "fits true to size".', claims: [{ kind: 'quote', quote: 'Fits true to size', sourceId: 'page1' }] }]);
    expect(r.supported).toBe(false);
    expect(r.unsupported[0]!.reasons).toContain('quote not found in page1');
  });

  it('replaces a quote from a source that was never archived', () => {
    const r = run([{ text: 'Reviews say "very warm".', claims: [{ kind: 'quote', quote: 'very warm', sourceId: 'page9' }] }]);
    expect(r.unsupported[0]!.reasons).toContain('no archived text for page9');
  });

  it('rejects one-word quotes as too short to verify', () => {
    const r = run([{ text: 'Someone said "lovely".', claims: [{ kind: 'quote', quote: 'Lovely', sourceId: 'page1' }] }]);
    expect(r.supported).toBe(false);
  });

  it('rejects quoted words in the text that no quote claim backs', () => {
    const r = run([{ text: 'Reviewers call it "the warmest sweater ever".', claims: [{ kind: 'field', ref: 'title' }] }]);
    expect(r.supported).toBe(false);
  });

  it('rejects a real quote used to back a number it does not contain', () => {
    const r = run([{ text: 'Reviewers say it runs small and lasts 5 years.', claims: [{ kind: 'quote', quote: 'Runs a size small, so order up.', sourceId: 'page1' }] }]);
    expect(r.supported).toBe(false);
    expect(r.unsupported[0]!.unsupportedTokens.map((t) => t.value)).toEqual(['5']);
  });

  it('rejects facts with no claims at all', () => {
    expect(run([{ text: 'It is navy.', claims: [] }]).supported).toBe(false);
  });

  it('needs a snapshot id when several products are in play', () => {
    const r = checkGrounding({
      segments: [{ text: 'It is navy.', claims: [{ kind: 'field', ref: 'attributes.colour' }] }],
      snapshots: [snapshot(), snapshot({ id: 'snap_b' })],
    });
    expect(r.supported).toBe(false);
  });

  it('does not let one product back a claim about another', () => {
    const black = snapshot({ id: 'snap_b', attributes: { colour: 'Black' } });
    const r = checkGrounding({
      segments: [{ text: 'Three is navy.', claims: [{ kind: 'field', ref: 'attributes.colour', snapshotId: 'snap_b' }] }],
      snapshots: [snapshot(), black],
    });
    expect(r.supported).toBe(false);
  });

  it('a field claim cannot launder a number into a different field', () => {
    const r = run([{ text: 'Free returns within 34 days.', claims: [{ kind: 'field', ref: 'returnPolicy' }, { kind: 'field', ref: 'attributes.colour' }] }]);
    expect(r.supported).toBe(false);
  });
});

describe('checkGrounding: output and fallback', () => {
  const bad: Segment = { text: 'It comes in XL.', claims: [{ kind: 'field', ref: 'attributes.size' }] };
  const good: Segment = { text: 'It is navy.', claims: [{ kind: 'field', ref: 'attributes.colour' }] };

  it('keeps supported segments and collapses repeated replacements', () => {
    const r = run([good, bad, { ...bad, text: 'And in XXL.' }]);
    expect(r.text).toBe("It is navy. The listing doesn't say.");
    expect(r.replaced).toBe(2);
    expect(r.unsupported.map((u) => u.index)).toEqual([1, 2]);
  });

  it('can remove instead of replace', () => {
    const r = run([good, bad], { mode: 'remove' });
    expect(r.text).toBe('It is navy.');
    expect(r.removed).toBe(1);
  });

  it('signals a template fallback after two failures in one answer', () => {
    expect(run([good, bad]).fallbackToTemplate).toBe(false);
    expect(run([bad, { ...bad, text: 'Or XXL.' }]).fallbackToTemplate).toBe(true);
  });

  it('counts failures across attempts in one turn', () => {
    const turn = new GroundingTurn();
    const first = turn.check({ segments: [good, bad], snapshots: [snapshot()] });
    expect(first.fallbackToTemplate).toBe(false);
    expect(turn.failureCount).toBe(1);
    const second = turn.check({ segments: [bad], snapshots: [snapshot()] });
    expect(second.fallbackToTemplate).toBe(true);
    expect(turn.shouldFallBack).toBe(true);
  });

  it('checkSegment reports why', () => {
    const r = checkSegment(bad, { segments: [], snapshots: [snapshot()] });
    expect(r.supported).toBe(false);
    expect(r.reasons).toEqual(['"XL" (size) is not backed by a claim']);
  });

  it('quoteAppears normalises curly quotes, dashes and spacing', () => {
    expect(quoteAppears('runs a size small – so order up', 'Runs a size small - so order up.')).toBe(true);
    expect(quoteAppears('runs large', PAGE)).toBe(false);
  });
});
