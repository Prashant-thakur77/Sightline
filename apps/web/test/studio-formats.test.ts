import { describe, expect, it } from 'vitest';
import { hoursText, shortHoursText } from '@/components/studio/formats';

describe('dashboard durations', () => {
  const h = (ms: number) => ms / 3_600_000;
  it('says the same span short on the tile and in full on the ticket', () => {
    const cases: [number, string, string][] = [
      [20_000, '<1 min', 'under a minute'],
      [60_000, '1 min', '1 minute'],
      [90_000, '1 min', '1 minute'],
      [125 * 60_000, '2 h 5 min', '2 hours 5 minutes'],
      [120 * 60_000, '2 h', '2 hours'],
      [(3 * 1440 + 4 * 60) * 60_000, '3 d 4 h', '3 days 4 hours'],
    ];
    for (const [ms, tile, ticket] of cases) {
      expect(shortHoursText(h(ms))).toBe(tile);
      expect(hoursText(h(ms))).toBe(ticket);
    }
  });
  it('says None yet without a figure', () => {
    expect(shortHoursText(null)).toBe('None yet');
    expect(hoursText(null)).toBe('None yet');
  });
});
