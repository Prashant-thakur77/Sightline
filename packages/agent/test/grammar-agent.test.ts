import { describe, expect, it } from 'vitest';
import { parseIntent } from '../src/grammar';

/** The deterministic fast path for money, memory and reorder commands. */
describe('grammar: money, memory and reorder commands', () => {
  it.each([
    ["what's on hold", 'on_hold'],
    ['how much did I spend this month', 'spent'],
    ['when does my hold expire', 'hold_ends'],
    ['did I get my refund', 'refunds'],
    ['what did I order last week', 'orders'],
  ])('"%s" is a money question (%s)', (said, question) => {
    expect(parseIntent(said)).toMatchObject({ intent: 'money', slots: { question } });
  });

  it('recalls and forgets memories', () => {
    expect(parseIntent('what do you remember about me')).toMatchObject({ intent: 'memory', slots: { action: 'recall' } });
    expect(parseIntent('forget my size')).toMatchObject({ intent: 'memory', slots: { action: 'forget', target: { kind: 'size' } } });
    expect(parseIntent('forget everything about me')).toMatchObject({ intent: 'memory', slots: { action: 'forget', target: { all: true } } });
    // "forget it" still cancels.
    expect(parseIntent('forget it').intent).toBe('cancel');
  });

  it('reads a lasting preference said on its own, and leaves searches to search', () => {
    expect(parseIntent("I'm a medium in sweaters")).toMatchObject({ intent: 'memory', slots: { action: 'state', drafts: [{ kind: 'size', value: 'M', scope: 'sweater' }] } });
    expect(parseIntent('nothing with wool')).toMatchObject({ intent: 'memory', slots: { action: 'state' } });
    expect(parseIntent('remember that I prefer navy')).toMatchObject({ intent: 'memory', slots: { action: 'state', explicit: true } });
    expect(parseIntent('I need a navy crew-neck sweater, medium, under forty dollars').intent).toBe('search');
    expect(parseIntent('I like the navy one', { options: [{ index: 1, colour: 'navy' }, { index: 2, colour: 'black' }] }).intent).toBe('choose');
  });

  it('reads "buy my usual again" and other reorders', () => {
    expect(parseIntent('buy my usual again')).toMatchObject({ intent: 'reorder', slots: { what: 'usual' } });
    expect(parseIntent('the usual please')).toMatchObject({ intent: 'reorder', slots: { what: 'usual' } });
    expect(parseIntent('order the same again')).toMatchObject({ intent: 'reorder', slots: { what: 'last' } });
    expect(parseIntent('buy the sweater again')).toMatchObject({ intent: 'reorder', slots: { what: 'sweater' } });
    expect(parseIntent('buy number two').intent).toBe('cart');
  });
});
