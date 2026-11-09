import { describe, expect, it } from 'vitest';
import { parseShoppingQuery } from '../src/grammar';
import {
  applyPreferences,
  describeMemory,
  draftFromProposal,
  isForSomeoneElse,
  memoriesToForget,
  memoryLabel,
  memoryWords,
  parseForget,
  parsePreferenceStatement,
  recallSpeech,
  type MemoryDraft,
} from '../src/memory';

const drafts = (t: string) => parsePreferenceStatement(t).drafts.map(({ kind, value, scope }) => ({ kind, value, ...(scope ? { scope } : {}) }));

describe('reading lasting preferences', () => {
  it('reads sizes with their category', () => {
    expect(drafts("I'm a medium in sweaters")).toEqual([{ kind: 'size', value: 'M', scope: 'sweater' }]);
    expect(drafts('I wear size 9 shoes')).toEqual([{ kind: 'size', value: '9', scope: 'shoes' }]);
    expect(drafts('my jeans size is 32')).toEqual([{ kind: 'size', value: '32', scope: 'jeans' }]);
    expect(drafts("I'm usually an extra large in hoodies")).toEqual([{ kind: 'size', value: 'XL', scope: 'hoodie' }]);
    expect(drafts("I'm a medium")).toEqual([{ kind: 'size', value: 'M', scope: 'tops' }]);
  });

  it('never reads a size out of ordinary sentences', () => {
    expect(drafts('I am a small business owner')).toEqual([]);
    expect(drafts("I'm looking for a medium sweater")).toEqual([]);
    expect(drafts('I am 9')).toEqual([]);
    expect(drafts('I like the navy one')).toEqual([]);
  });

  it('reads materials and colours to avoid or that the buyer likes', () => {
    expect(drafts('nothing with wool')).toEqual([{ kind: 'avoid_material', value: 'wool' }]);
    expect(drafts("I'm allergic to wool")).toEqual([{ kind: 'avoid_material', value: 'wool' }]);
    expect(drafts('wool makes me itch')).toEqual([{ kind: 'avoid_material', value: 'wool' }]);
    expect(drafts('I prefer navy')).toEqual([{ kind: 'like_colour', value: 'navy' }]);
    expect(drafts('my favourite colour is green')).toEqual([{ kind: 'like_colour', value: 'green' }]);
    expect(drafts('I never wear orange')).toEqual([{ kind: 'avoid_colour', value: 'orange' }]);
    expect(drafts('I love linen')).toEqual([{ kind: 'like_material', value: 'linen' }]);
  });

  it('reads a usual budget', () => {
    expect(drafts('keep it under $60')).toEqual([{ kind: 'budget', value: '6000' }]);
    expect(drafts('my budget is sixty dollars')).toEqual([{ kind: 'budget', value: '6000' }]);
  });

  it('says whether it was explicit, lasting, or part of a search', () => {
    expect(parsePreferenceStatement('remember that I avoid wool')).toMatchObject({ explicit: true, lasting: true });
    expect(parsePreferenceStatement("I'm a medium in sweaters, find me a navy one")).toMatchObject({ hasSearch: true, lasting: true });
    expect(parsePreferenceStatement('find me a sweater, nothing with wool')).toMatchObject({ hasSearch: true, lasting: false });
    expect(parsePreferenceStatement('find me a sweater, I never wear wool')).toMatchObject({ hasSearch: true, lasting: true });
  });
});

describe('a model’s proposal is checked against the buyer’s own words', () => {
  const said = "I'm a medium in sweaters, and I can't stand wool. Keep it under $60.";
  it('accepts values the buyer said', () => {
    expect(draftFromProposal({ kind: 'size', value: 'medium', category: 'sweaters' }, said)).toMatchObject({ kind: 'size', value: 'M', scope: 'sweater' });
    expect(draftFromProposal({ kind: 'avoid_material', value: 'wool' }, said)).toMatchObject({ value: 'wool' });
    expect(draftFromProposal({ kind: 'budget', value: '$60' }, said)).toMatchObject({ value: '6000' });
  });
  it('refuses values the buyer never said', () => {
    expect(draftFromProposal({ kind: 'size', value: 'L', category: 'sweaters' }, said)).toBeNull();
    expect(draftFromProposal({ kind: 'avoid_material', value: 'cashmere' }, said)).toBeNull();
    expect(draftFromProposal({ kind: 'budget', value: '80' }, said)).toBeNull();
    expect(draftFromProposal({ kind: 'like_colour', value: 'navy' }, said)).toBeNull();
    expect(draftFromProposal({ kind: 'size', value: 'M', category: 'jeans' }, said)).toBeNull();
    expect(draftFromProposal({ kind: 'password', value: 'x' }, said)).toBeNull();
  });
});

describe('memory words', () => {
  const size: MemoryDraft = { kind: 'size', value: 'M', scope: 'sweater', said: '' };
  it('asks, confirms with an undo, and labels', () => {
    expect(memoryWords.ask(size)).toBe("Shall I remember that you're a medium in sweaters?");
    expect(memoryWords.stored(size)).toBe("Okay, I'll remember that you're a medium in sweaters. To undo it, say 'forget my sweater size'.");
    expect(describeMemory({ kind: 'budget', value: '6000' })).toBe('you keep it under $60');
    expect(describeMemory({ kind: 'size', value: '9', scope: 'shoes' })).toBe("you're size 9 in shoes");
    expect(memoryLabel(size)).toBe('Size M in sweaters');
  });
  it('recalls memories and what Settings hold', () => {
    expect(recallSpeech([size, { kind: 'avoid_material', value: 'wool' }], { sizes: { shoes: '9' } })).toBe(
      "Here are the 2 things I remember. You're a medium in sweaters. You avoid wool. Your Settings also have size 9 for shoes. To change one, say 'forget' and what to forget, or use Settings.",
    );
    expect(recallSpeech([])).toBe(memoryWords.nothing);
  });
});

describe('forgetting', () => {
  const all: MemoryDraft[] = [
    { kind: 'size', value: 'M', scope: 'sweater', said: '' },
    { kind: 'size', value: '9', scope: 'shoes', said: '' },
    { kind: 'avoid_material', value: 'wool', said: '' },
    { kind: 'like_colour', value: 'navy', said: '' },
  ];
  it('reads what to forget', () => {
    expect(parseForget('forget my size')).toMatchObject({ kind: 'size' });
    expect(parseForget('forget my sweater size')).toMatchObject({ kind: 'size', scope: 'sweater' });
    expect(parseForget('forget that I avoid wool')).toMatchObject({ kind: 'material', value: 'wool' });
    expect(parseForget('forget everything you remember about me')).toEqual({ all: true });
    expect(parseForget('forget it')).toBeNull();
    expect(parseForget('find me a sweater')).toBeNull();
  });
  it('picks the memories it names', () => {
    expect(memoriesToForget(all, parseForget('forget my size')!)).toHaveLength(2);
    expect(memoriesToForget(all, parseForget('forget my sweater size')!).map((m) => m.value)).toEqual(['M']);
    expect(memoriesToForget(all, parseForget('forget navy')!).map((m) => m.value)).toEqual(['navy']);
    expect(memoriesToForget(all, { all: true })).toHaveLength(4);
  });
});

describe('using memories in a search', () => {
  const mem: MemoryDraft[] = [
    { kind: 'size', value: 'M', scope: 'sweater', said: '' },
    { kind: 'avoid_material', value: 'wool', said: '' },
    { kind: 'budget', value: '6000', said: '' },
  ];
  it('fills the size and budget, and says so; spoken words win', () => {
    const a = applyPreferences(parseShoppingQuery('navy cardigan'), mem);
    expect(a.query.size).toBe('M');
    expect(a.query.sizeSource).toBe('memory');
    expect(a.query.maxPrice?.cents).toBe(6000);
    expect(a.notes).toEqual(['Using your usual size M.', 'Keeping it under $60, as you asked me to remember.']);
    expect(a.avoidMaterials).toEqual(['wool']);
    const spoken = applyPreferences(parseShoppingQuery('navy sweater size large under $90'), mem);
    expect(spoken.query.size).toBe('L');
    expect(spoken.query.maxPrice?.cents).toBe(9000);
    expect(spoken.notes).toEqual([]);
  });
  it('uses none of the buyer’s own preferences for a gift, and says so', () => {
    const q = parseShoppingQuery('a sweater for my sister', { savedSizes: { tops: 'M' } });
    expect(q.size).toBe('M');
    const a = applyPreferences(q, mem, {}, { forSomeoneElse: isForSomeoneElse('a sweater for my sister') });
    expect(a.query.size).toBeUndefined();
    expect(a.avoidMaterials).toEqual([]);
    expect(a.notes).toEqual([memoryWords.notForYou]);
    expect(isForSomeoneElse('a gift for my sister who hikes')).toBe(true);
    expect(isForSomeoneElse('a navy sweater for me')).toBe(false);
  });
});
