import { describe, expect, it } from 'vitest';
import { spokenWhen } from '@/lib/when';
import { withoutConfidence } from '@/components/check/verdict-view';

describe('spokenWhen', () => {
  it('says a time the way it is spoken, in UTC', () => {
    expect(spokenWhen('2026-11-08T23:40:00Z')).toBe('Sunday 8 November, 11:40 pm UTC');
    expect(spokenWhen('2026-11-09T00:05:00Z')).toBe('Monday 9 November, 12:05 am UTC');
    expect(spokenWhen('2026-11-09T12:00:00Z')).toBe('Monday 9 November, 12:00 pm UTC');
    expect(spokenWhen(null)).toBe('date unknown');
  });
});

describe('withoutConfidence', () => {
  it('leaves how sure to its own column, and keeps what made it less sure', () => {
    expect(withoutConfidence("The size tag reads L, you ordered M. I'm sure about that.")).toBe('The size tag reads L, you ordered M.');
    expect(withoutConfidence("The size tag seems to read L, you ordered M, but I'm only fairly sure.")).toBe('The size tag seems to read L, you ordered M.');
    expect(withoutConfidence("There might be a tear, but I'm not sure.")).toBe('There might be a tear.');
    expect(withoutConfidence("It looks like the same sweater. I'm fairly sure.")).toBe('It looks like the same sweater.');
    expect(withoutConfidence("The colour looks grey, but the light is dim so I'm less sure.")).toBe('The colour looks grey. The light is dim.');
    expect(withoutConfidence('The colour matches.')).toBe('The colour matches.');
  });
});
