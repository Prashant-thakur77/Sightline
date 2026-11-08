import { describe, expect, it } from 'vitest';
import { pickQuotes, verifyQuotes } from '../src';

const page = `Harbor knit crew-neck sweater. Made from 70% cotton and 30% recycled polyester.
Free returns within 30 days of delivery. Machine wash cold, lay flat to dry.
Runs true to size. Ships in 2 to 3 business days.`;

describe('quoted answers', () => {
  it('picks a verbatim sentence per topic', () => {
    const a = pickQuotes(page, ['returns', 'sizing', 'material', 'care']);
    expect(a[0]!.quote).toBe('Free returns within 30 days of delivery.');
    expect(a[1]!.quote).toBe('Runs true to size.');
    expect(a[2]!.quote).toContain('70% cotton');
    expect(a[3]!.quote).toContain('Machine wash cold');
  });
  it('drops quotes that are not on the page', () => {
    const v = verifyQuotes(page, [
      { question: 'returns', quote: 'Free returns within 60 days.' },
      { question: 'sizing', quote: 'runs  TRUE to size.' },
    ]);
    expect(v[0]!.quote).toBeNull();
    expect(v[1]!.quote).toBe('runs  TRUE to size.');
  });
  it('returns null when a topic is absent', () => {
    expect(pickQuotes('A plain page with nothing useful.', ['warranty'])[0]!.quote).toBeNull();
  });
});
