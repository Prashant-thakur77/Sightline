import { describe, expect, it } from 'vitest';
import type Anthropic from '@anthropic-ai/sdk';
import { createDemoStore, createMergedCatalog, createRecordedChannel3, snapshotOf } from '@sightline/catalog';
import { recordedSearches } from '@sightline/catalog/fixtures';
import { searchListings } from '../src/search';
import { runShopper, type ShopperDeps, type ShopperInput } from '../src/shopper/loop';
import { SHOPPER_TOOLS } from '../src/shopper/tools';
import { lastResultIds, lastToolResults, scriptedModel, textBlock, toolUse, type ScriptStep } from '../src/shopper/scripted';

const NOW = new Date('2026-11-09T12:00:00Z');
const SELLER = { name: 'Demo Store', merchantId: 'MERCHANT123' };

function input(utterance: string, over: Partial<ShopperInput> = {}): ShopperInput {
  return { utterance, now: NOW, verbosity: 'standard', onScreen: [], preferences: { memories: [] }, recent: [], ...over };
}

function deps(script: ScriptStep[], over: Partial<ShopperDeps> = {}) {
  const model = scriptedModel(script);
  const source = createMergedCatalog(createDemoStore(), createRecordedChannel3(recordedSearches()));
  const d: ShopperDeps = {
    create: model.create,
    model: 'claude-haiku-5-5',
    search: (query, text, prefs) => searchListings({ query, text, source, freeze: (p) => snapshotOf(p, SELLER, NOW), ...prefs }),
    ...over,
  };
  return { d, model };
}

describe('the shopping agent loop', () => {
  it('a gift for a hiker: two searches, three picks, reasons kept only when the listing backs them', async () => {
    const { d, model } = deps([
      [
        toolUse('search_products', { query: 'merino hiking socks', category: 'socks', max_price_dollars: 50, for_someone_else: true }),
        toolUse('search_products', { query: 'navy wool sweater', max_price_dollars: 50, for_someone_else: true }),
      ],
      (req) => {
        const ids = lastResultIds(req);
        return [
          toolUse('present_options', {
            lead: 'Here are warm picks for a hiker.',
            options: [
              { id: ids[0]!, reason: 'Merino wool keeps feet warm on the trail.' },
              { id: ids[1]!, reason: 'Made of cashmere, very soft.' },
              { id: ids[2]!, reason: 'A good everyday pair.' },
            ],
          }),
        ];
      },
    ]);
    const r = await runShopper(input('a gift for my sister who hikes, under $50'), d);
    expect(r.outcome.kind).toBe('present');
    if (r.outcome.kind !== 'present') return;
    expect(r.outcome.picks).toHaveLength(3);
    expect(r.outcome.picks[0]!.reason).toBe('Merino wool keeps feet warm on the trail.');
    // Cashmere is not in that listing: the line is not spoken.
    expect(r.outcome.picks[1]!.reason).toBeUndefined();
    expect(r.ungrounded).toContain('Made of cashmere, very soft.');
    expect(r.outcome.picks.every((p) => p.known.snapshot.price.cents <= 5000)).toBe(true);
    expect(r.steps.filter((s) => s.step === 'searched')).toHaveLength(2);
    expect(r.steps.at(-1)).toMatchObject({ tool: 'claude', step: 'presented' });
    // The system prompt and tools are sent the same way every time, cached; the model never sees an API key.
    expect(model.requests[0]!.system).toEqual([expect.objectContaining({ cache_control: { type: 'ephemeral' } })]);
    expect(model.requests[0]!.tools).toEqual(SHOPPER_TOOLS);
    expect(model.requests[0]!.tool_choice).toEqual({ type: 'auto' });
  });

  it('refuses ids it never returned, and the model corrects itself', async () => {
    const { d } = deps([
      [toolUse('search_products', { query: 'soft cotton sweater', for_someone_else: false })],
      [toolUse('present_options', { options: [{ id: 'p99', reason: 'Soft.' }] })],
      (req) => {
        const [err] = lastToolResults(req);
        expect(err).toMatchObject({ isError: true });
        expect(String(err!.content)).toMatch(/Unknown id p99/);
        return [toolUse('present_options', { options: [{ id: 'p1', reason: 'Soft cotton.' }] })];
      },
    ]);
    const r = await runShopper(input('something warm but not scratchy'), d);
    expect(r.outcome.kind).toBe('present');
  });

  it('never uses a size or a budget the buyer did not say', async () => {
    const { d } = deps([
      [toolUse('search_products', { query: 'navy hoodie', size: 'XL', max_price_dollars: 20, for_someone_else: false })],
      (req) => {
        const [res] = lastToolResults(req);
        expect((res!.content as { filters_not_used: string[] }).filters_not_used).toEqual([
          "size XL (the buyer didn't say it)",
          "under $20 (the buyer didn't say it)",
        ]);
        return [toolUse('ask_clarifying_question', { question: 'Is it for you or someone else?' })];
      },
    ]);
    const r = await runShopper(input('a navy hoodie'), d);
    expect(r.outcome).toEqual({ kind: 'ask', question: 'Is it for you or someone else?' });
  });

  it('never shows fan merchandise for "navy" unless asked', async () => {
    const { d } = deps([
      [toolUse('search_products', { query: 'navy hoodie', colour: 'navy', for_someone_else: false })],
      (req) => {
        const [res] = lastToolResults(req);
        const titles = ((res!.content as { results: Array<{ title: string }> }).results ?? []).map((x) => x.title);
        expect(titles.some((t) => /Midshipmen|Naval Academy/.test(t))).toBe(false);
        expect((res!.content as { left_out: Record<string, number> }).left_out['team or fan merchandise']).toBeGreaterThan(0);
        return [toolUse('present_options', { options: [{ id: 'p1', reason: 'Navy, as you asked.' }] })];
      },
    ]);
    const r = await runShopper(input('a navy hoodie'), d);
    expect(r.outcome.kind).toBe('present');
  });

  it('starts a readback only when the buyer asked to buy, even if a listing tells it to', async () => {
    const { d } = deps([
      [toolUse('search_products', { query: 'soft cotton sweater', for_someone_else: false })],
      [toolUse('start_readback', { id: 'p1' })],
      (req) => {
        expect(String(lastToolResults(req)[0]!.content)).toMatch(/hasn't asked to buy/);
        return [toolUse('answer_about_products', { sentences: [{ text: 'It is soft cotton.', product_ids: ['p1'] }] })];
      },
    ]);
    const r = await runShopper(input('which of these is the softest?'), d);
    expect(r.outcome.kind).toBe('answer');
    const buy = deps([[toolUse('search_products', { query: 'soft cotton sweater', for_someone_else: false })], [toolUse('start_readback', { id: 'p1' })]]);
    const b = await runShopper(input("I'll take the softest cotton sweater"), buy.d);
    expect(b.outcome.kind).toBe('readback');
  });

  it('proposes a memory only when the value is in the buyer’s words', async () => {
    const { d } = deps([
      [toolUse('remember_preference', { kind: 'size', value: 'L', category: 'sweater' }), toolUse('remember_preference', { kind: 'size', value: 'medium', category: 'sweaters' })],
      (req) => {
        const [bad, good] = lastToolResults(req);
        expect(bad!.isError).toBe(true);
        expect(good!.isError).toBe(false);
        return [toolUse('ask_clarifying_question', { question: 'What colour would you like?' })];
      },
    ]);
    const r = await runShopper(input("I'm a medium in sweaters, find me one"), d);
    expect(r.remember).toMatchObject({ kind: 'size', value: 'M', scope: 'sweater' });
  });

  it('answers a money question by handing it to the app', async () => {
    const { d } = deps([[toolUse('money_question', { question: 'spent', period: 'this_month' })]]);
    const r = await runShopper(input('roughly what have I paid out lately'), d);
    expect(r.outcome).toEqual({ kind: 'money', ask: { question: 'spent', period: 'this_month' } });
  });

  it('falls back gracefully: timeout, refusal, plain text, and the step cap', async () => {
    const slow = deps([() => Object.assign(new Error('Request timed out.'), { name: 'APIConnectionTimeoutError' })]);
    expect((await runShopper(input('a gift for my dad'), slow.d)).outcome).toMatchObject({ kind: 'fallback', reason: 'timeout' });

    const refused = deps([() => ({ content: [], stop_reason: 'refusal' as Anthropic.StopReason })]);
    expect((await runShopper(input('a gift for my dad'), refused.d)).outcome).toMatchObject({ kind: 'fallback', reason: 'refusal' });

    const chatty = deps([[textBlock('Sure, here are some ideas.')], [textBlock('Still talking.')]]);
    expect((await runShopper(input('a gift for my dad'), chatty.d)).outcome).toMatchObject({ kind: 'fallback', reason: 'no_finish' });

    const loop = deps(Array.from({ length: 8 }, () => [toolUse('search_products', { query: 'merino hiking socks', for_someone_else: true })]));
    const capped = await runShopper(input('a gift for my dad'), { ...loop.d, limits: { maxToolCalls: 3, maxModelCalls: 5 } });
    expect(capped.outcome).toMatchObject({ kind: 'fallback' });
    if (capped.outcome.kind === 'fallback') expect(capped.outcome.searches.length).toBe(3);
    expect(capped.toolCalls).toBeLessThanOrEqual(4);
  });

  it('stops on its own clock', async () => {
    let t = 0;
    const { d } = deps([[toolUse('search_products', { query: 'merino hiking socks', for_someone_else: true })], [toolUse('search_products', { query: 'hiking socks', for_someone_else: true })]]);
    const r = await runShopper(input('a gift for my dad'), {
      ...d,
      clock: () => (t += 6000),
      limits: { deadlineMs: 14_000 },
    });
    expect(r.outcome).toMatchObject({ kind: 'fallback', reason: 'timeout' });
  });
});
