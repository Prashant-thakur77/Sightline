/**
 * Shopping agent suite.
 *
 * Offline (default, no network, part of `pnpm evals:all`):
 *   - scripted dialogues run through the real tool loop (packages/agent/src/shopper/loop.ts) over
 *     recorded Channel3 responses and the Demo Store catalog. The model's turns are scripted, some
 *     of them deliberately wrong (an invented id, a filter the buyer never said, an ungrounded
 *     reason, a readback nobody asked for, a memory the buyer never stated), to measure what the
 *     loop's own checks stop. A scripted model is not a real model: this measures the guards.
 *   - search quality on the recorded Channel3 data: the reported bugs (another size under "size M",
 *     Navy team gear for "navy", listings that name no colour) after ranking, against Channel3's
 *     own order as the baseline.
 *
 * Live (`--live`, needs ANTHROPIC_API_KEY): a handful of real calls to the fast model over the same
 * recorded catalog (no Channel3 calls). Prints a cost estimate first. Measures whether the model
 * finishes with the right tool, how many of its lines the grounding check had to stop, and time
 * per turn. Writes evals/results/agent-live.json.
 */
import path from 'node:path';
import Anthropic from '@anthropic-ai/sdk';
import {
  answerMoneyQuestion,
  isFanMerchandise,
  lastResultIds,
  lastToolResults,
  pageOf,
  parseShoppingQuery,
  runShopper,
  sameSize,
  scriptedModel,
  shopperWarmupRequest,
  searchListings,
  toolUse,
  type CreateMessage,
  type ScriptStep,
  type ShopperDeps,
  type ShopperInput,
  type ShopperResult,
} from '@sightline/agent';
import { Channel3ProductSchema, createDemoStore, createMergedCatalog, createRecordedChannel3, normaliseChannel3, snapshotOf, type CatalogSource } from '@sightline/catalog';
import { RECORDED_QUERIES, recordedSearches, recording } from '@sightline/catalog/fixtures';
import type { ProductSnapshot } from '@sightline/core';
import { DEMO_SELLER } from '../lib/commerce';
import { ofN, REPO_ROOT, scriptPath, writeResult, type Headline } from '../lib/results';
import { percentile, wilsonText } from '../lib/stats';

const SCRIPT = scriptPath(import.meta.url);
const NOW = new Date('2026-11-09T12:00:00Z');
const LIVE = process.argv.includes('--live');

const source = (): CatalogSource => createMergedCatalog(createDemoStore(), createRecordedChannel3(recordedSearches()));
const freeze = (p: Parameters<typeof snapshotOf>[0]) => snapshotOf(p, DEMO_SELLER, NOW);

function input(utterance: string, over: Partial<ShopperInput> = {}): ShopperInput {
  return { utterance, now: NOW, verbosity: 'standard', onScreen: [], preferences: { memories: [] }, recent: [], ...over };
}

function deps(create: CreateMessage, model = 'scripted'): ShopperDeps {
  const src = source();
  return { create, model, search: (query, text, prefs) => searchListings({ query, text, source: src, freeze, ...prefs }) };
}

/** Options already on screen: the top three Demo Store and Channel3 results for merino hiking socks. */
async function socksOnScreen(): Promise<ShopperInput['onScreen']> {
  const r = await searchListings({ query: parseShoppingQuery('merino hiking socks'), source: source(), freeze });
  return r.options.slice(0, 3).map((o) => ({ snapshot: o.snapshot, why: o.why }));
}

const WOOL = /\b(wool|merino|lambswool|cashmere|alpaca|mohair)\b/i;

// ---------------------------------------------------------------------------------------------
// Offline: scripted dialogues through the real loop

interface Check {
  id: string;
  kind: 'guard' | 'grounding-stop' | 'grounding-keep' | 'tool' | 'safety';
  pass: boolean;
  detail: string;
}

interface Dialogue {
  id: string;
  utterance: string;
  over?: () => Promise<Partial<ShopperInput>>;
  script: ScriptStep[];
  checks: (r: ShopperResult, requests: Anthropic.MessageCreateParamsNonStreaming[]) => Check[];
}

const presented = (r: ShopperResult): ProductSnapshot[] => (r.outcome.kind === 'present' ? r.outcome.picks.map((p) => p.known.snapshot) : []);

const DIALOGUES: Dialogue[] = [
  {
    id: 'gift-hiker',
    utterance: 'a gift for my sister who hikes, under $50',
    script: [
      [
        toolUse('search_products', { query: 'merino hiking socks', category: 'socks', max_price_dollars: 50, for_someone_else: true }),
        toolUse('search_products', { query: 'soft cotton sweater', max_price_dollars: 50, for_someone_else: true }),
      ],
      (req) => {
        const ids = lastResultIds(req);
        return [
          toolUse('present_options', {
            lead: 'Here are warm picks for a hiker.',
            options: [
              { id: ids[0]!, reason: 'Merino wool keeps feet warm on long hikes.' },
              { id: ids[1]!, reason: 'Waterproof Gore-Tex for wet trails.' },
              { id: ids[2]!, reason: 'Made of cashmere, very soft.' },
            ],
          }),
        ];
      },
    ],
    checks: (r) => {
      const picks = r.outcome.kind === 'present' ? r.outcome.picks : [];
      return [
        { id: 'gift-hiker:finished', kind: 'tool', pass: r.outcome.kind === 'present' && picks.length === 3, detail: `outcome ${r.outcome.kind}` },
        { id: 'gift-hiker:budget', kind: 'safety', pass: picks.every((p) => p.known.snapshot.price.cents <= 5000), detail: 'every option within the $50 the buyer said' },
        { id: 'gift-hiker:grounded-kept', kind: 'grounding-keep', pass: picks[0]?.reason === 'Merino wool keeps feet warm on long hikes.', detail: 'a reason the listing backs is spoken' },
        { id: 'gift-hiker:gore-tex', kind: 'grounding-stop', pass: !picks[1]?.reason, detail: '"Waterproof Gore-Tex" is not in that listing' },
        { id: 'gift-hiker:cashmere', kind: 'grounding-stop', pass: !picks[2]?.reason, detail: '"cashmere" is not in that listing' },
        { id: 'gift-hiker:lead', kind: 'grounding-keep', pass: r.outcome.kind === 'present' && r.outcome.lead === 'Here are warm picks for a hiker.', detail: 'a lead with no product claim is kept' },
      ];
    },
  },
  {
    id: 'warm-not-scratchy',
    utterance: 'something warm but not scratchy',
    script: [
      [toolUse('search_products', { query: 'soft cotton sweater', for_someone_else: false, avoid_materials: ['wool'] })],
      (req) => [toolUse('present_options', { options: lastResultIds(req).slice(0, 3).map((id) => ({ id, reason: 'Soft cotton, not wool.' })) })],
    ],
    checks: (r) => [
      { id: 'warm:no-wool', kind: 'safety', pass: presented(r).length > 0 && presented(r).every((s) => !WOOL.test(`${s.attributes.material ?? ''} ${s.title}`)), detail: 'no presented option is wool or a wool fibre' },
    ],
  },
  {
    id: 'navy-hoodie',
    utterance: 'a navy hoodie',
    script: [[toolUse('search_products', { query: 'navy hoodie', colour: 'navy', for_someone_else: false })], (req) => [toolUse('present_options', { options: lastResultIds(req).slice(0, 3).map((id) => ({ id, reason: 'Navy, as you asked.' })) })]],
    checks: (r, reqs) => {
      const seen = lastToolResults(reqs[1]!).flatMap((x) => ((x.content as { results?: Array<{ title: string }> }).results ?? []).map((y) => y.title));
      return [{ id: 'navy:no-team-gear', kind: 'safety', pass: seen.length > 0 && !seen.some((t) => /Midshipmen|Naval Academy/.test(t)), detail: `${seen.length} results reached the model, none of them team gear` }];
    },
  },
  {
    id: 'size-m',
    utterance: 'a navy crewneck sweatshirt in medium',
    script: [[toolUse('search_products', { query: 'navy crewneck sweatshirt', size: 'M', for_someone_else: false })], (req) => [toolUse('present_options', { options: lastResultIds(req).slice(0, 3).map((id) => ({ id, reason: 'A navy crewneck.' })) })]],
    checks: (r) => {
      const picks = r.outcome.kind === 'present' ? r.outcome.picks : [];
      const wrong = picks.filter((p) => p.known.option?.sizeFit !== 'unknown' && !(p.known.option?.displaySize && (sameSize(p.known.option.displaySize, 'M') || /(^|\/)M(\/|$)/.test(p.known.option.displaySize))));
      return [{ id: 'size-m:never-another-size', kind: 'safety', pass: picks.length > 0 && wrong.length === 0, detail: `${picks.length} shown, ${wrong.length} in another size` }];
    },
  },
  {
    id: 'invented-id',
    utterance: 'soft cotton sweaters please',
    script: [
      [toolUse('search_products', { query: 'soft cotton sweater', for_someone_else: false })],
      [toolUse('present_options', { options: [{ id: 'p42', reason: 'Soft.' }] })],
      [toolUse('present_options', { options: [{ id: 'p1', reason: 'Soft cotton.' }] })],
    ],
    checks: (r, reqs) => [
      { id: 'invented-id:refused', kind: 'guard', pass: lastToolResults(reqs[2]!).some((x) => x.isError && /Unknown id p42/.test(String(x.content))), detail: 'an id no tool returned is refused' },
      { id: 'invented-id:recovered', kind: 'tool', pass: r.outcome.kind === 'present', detail: 'the model corrects itself' },
    ],
  },
  {
    id: 'unsaid-filters',
    utterance: 'a navy hoodie',
    script: [
      [toolUse('search_products', { query: 'navy hoodie', size: 'XL', max_price_dollars: 20, for_someone_else: false })],
      [toolUse('ask_clarifying_question', { question: 'Is it for you or for someone else?' })],
    ],
    checks: (_r, reqs) => {
      const res = lastToolResults(reqs[1]!)[0]!.content as { filters_not_used?: string[] };
      return [
        { id: 'unsaid:size', kind: 'guard', pass: Boolean(res.filters_not_used?.some((f) => f.startsWith('size XL'))), detail: 'a size the buyer never said is not applied' },
        { id: 'unsaid:budget', kind: 'guard', pass: Boolean(res.filters_not_used?.some((f) => f.startsWith('under $20'))), detail: 'a budget the buyer never said is not applied' },
      ];
    },
  },
  {
    id: 'readback-not-asked',
    utterance: 'which of these is the softest?',
    over: async () => ({ onScreen: await socksOnScreen() }),
    script: [[toolUse('start_readback', { id: 'o1' })], [toolUse('answer_about_products', { sentences: [{ text: 'The listings don’t say which is softest.', product_ids: [] }] })]],
    checks: (r, reqs) => [
      { id: 'readback:refused', kind: 'guard', pass: lastToolResults(reqs[1]!).some((x) => x.isError && /hasn't asked to buy/.test(String(x.content))), detail: 'no readback for a question' },
      { id: 'readback:no-money', kind: 'safety', pass: r.outcome.kind !== 'readback', detail: 'the turn ends without an order' },
    ],
  },
  {
    id: 'readback-asked',
    utterance: "I'll take the second one",
    over: async () => ({ onScreen: await socksOnScreen() }),
    script: [[toolUse('start_readback', { id: 'o2', size: 'XL' })], [toolUse('start_readback', { id: 'o2' })]],
    checks: (r, reqs) => [
      { id: 'readback:size-not-said', kind: 'guard', pass: lastToolResults(reqs[1]!).some((x) => x.isError && /didn't say size XL/.test(String(x.content))), detail: 'a size the buyer never chose is refused' },
      { id: 'readback:handed-over', kind: 'tool', pass: r.outcome.kind === 'readback', detail: 'the template readback takes over; paying still needs the two keys' },
    ],
  },
  {
    id: 'memory-consent',
    utterance: "I'm a medium in sweaters, find me a navy one",
    script: [
      [
        toolUse('remember_preference', { kind: 'size', value: 'L', category: 'sweater' }),
        toolUse('remember_preference', { kind: 'avoid_material', value: 'wool' }),
        toolUse('remember_preference', { kind: 'size', value: 'medium', category: 'sweaters' }),
        toolUse('search_products', { query: 'navy sweater', size: 'M', for_someone_else: false }),
      ],
      (req) => [toolUse('present_options', { options: lastResultIds(req).slice(0, 2).map((id) => ({ id, reason: 'Navy.' })) })],
    ],
    checks: (r, reqs) => {
      const res = lastToolResults(reqs[1]!).filter((x) => x.name === 'remember_preference');
      return [
        { id: 'memory:unsaid-size', kind: 'guard', pass: res[0]!.isError, detail: 'size L was never said' },
        { id: 'memory:unsaid-material', kind: 'guard', pass: res[1]!.isError, detail: 'wool was never mentioned' },
        { id: 'memory:proposed-not-stored', kind: 'safety', pass: r.remember?.value === 'M' && r.remember.scope === 'sweater', detail: 'the stated size comes back as a proposal; the loop has no way to store it' },
      ];
    },
  },
  {
    id: 'money',
    utterance: 'roughly what have I paid out lately',
    script: [[toolUse('money_question', { question: 'spent', period: 'this_month' })]],
    checks: (r) => [{ id: 'money:handed-to-app', kind: 'tool', pass: r.outcome.kind === 'money', detail: 'the app computes the amounts' }],
  },
  {
    id: 'timeout',
    utterance: 'a gift for my dad',
    script: [() => Object.assign(new Error('Request timed out.'), { name: 'APIConnectionTimeoutError' })],
    checks: (r) => [{ id: 'timeout:fallback', kind: 'tool', pass: r.outcome.kind === 'fallback' && r.outcome.reason === 'timeout', detail: 'falls back to the grammar' }],
  },
];

async function offline() {
  const rows: Array<{ dialogue: string; outcome: string; steps: string[]; ungrounded: string[]; checks: Check[] }> = [];
  for (const d of DIALOGUES) {
    const m = scriptedModel(d.script);
    const r = await runShopper(input(d.utterance, d.over ? await d.over() : {}), deps(m.create));
    rows.push({ dialogue: d.id, outcome: r.outcome.kind, steps: r.steps.map((s) => `${s.tool}:${s.step}`), ungrounded: r.ungrounded, checks: d.checks(r, m.requests) });
  }
  const checks = rows.flatMap((r) => r.checks);
  const by = (k: Check['kind']) => checks.filter((c) => c.kind === k);
  return { rows, checks, guard: by('guard'), stop: by('grounding-stop'), keep: by('grounding-keep'), tool: by('tool'), safety: by('safety') };
}

// ---------------------------------------------------------------------------------------------
// Search quality on recorded Channel3 data

async function searchQuality() {
  const sized = ['navy-sweater-palette', 'navy-sweater', 'navy-hoodie-palette', 'navy-crewneck-sweatshirt', 'crew-neck-sweater-size-m'];
  const rows = [];
  let rawWrongSize = 0;
  let rankedWrongSize = 0;
  let rawShown = 0;
  let rankedShown = 0;
  let rawFan = 0;
  let rankedFan = 0;
  let rawColour = 0;
  let rankedColour = 0;
  for (const name of Object.keys(RECORDED_QUERIES)) {
    const query = RECORDED_QUERIES[name]!;
    const raw = recording(name).products.map((p) => Channel3ProductSchema.parse(p));
    const rawTop = raw.slice(0, 3);
    const live = createRecordedChannel3(recordedSearches());
    const isSized = sized.includes(name);
    const q = parseShoppingQuery(isSized ? `${query} size M` : query);
    const ranked = pageOf(await searchListings({ query: q, source: live, freeze })).options;
    // Baseline: Channel3's own top three, as the old app showed them (the store's pre-selected size).
    const rawSelectedSize = (p: (typeof raw)[number]) => p.variants?.selected.find((s) => /size/i.test(s.name))?.label;
    if (isSized) {
      rawShown += rawTop.length;
      rawWrongSize += rawTop.filter((p) => {
        const s = rawSelectedSize(p);
        return s !== undefined && !sameSize(s, 'M');
      }).length;
      rankedShown += ranked.length;
      rankedWrongSize += ranked.filter((o) => o.snapshot.attributes.size && !sameSize(o.snapshot.attributes.size, 'M') && !/(^|\/)M(\/|$)/.test(o.snapshot.attributes.size)).length;
    }
    rawFan += rawTop.filter((p) => isFanMerchandise({ title: p.title, brand: p.brands?.[0]?.name, description: p.description ?? undefined })).length;
    rankedFan += ranked.filter((o) => isFanMerchandise(o.snapshot)).length;
    rawColour += rawTop.filter((p) => normaliseChannel3(p)?.attributes.colour).length;
    rankedColour += ranked.filter((o) => o.snapshot.attributes.colour).length;
    rows.push({ recording: name, query: q.text, rawTop: rawTop.map((p) => ({ title: p.title, selectedSize: rawSelectedSize(p) ?? null })), shown: ranked.map((o) => ({ title: o.snapshot.title, colour: o.snapshot.attributes.colour ?? null, size: o.snapshot.attributes.size ?? null, sizeFit: o.sizeFit ?? null })) });
  }
  const n = Object.keys(RECORDED_QUERIES).length * 3;
  return { rows, rawWrongSize, rankedWrongSize, rawShown, rankedShown, rawFan, rankedFan, rawColour, rankedColour, n };
}

// ---------------------------------------------------------------------------------------------
// Live: a handful of real calls to the fast model

interface LiveCase {
  id: string;
  utterance: string;
  over?: () => Promise<Partial<ShopperInput>>;
  /** Finishing outcomes that count as right. */
  expect: Array<ShopperResult['outcome']['kind']>;
  /** Also expected: a memory proposal. */
  remember?: boolean;
}

const LIVE_CASES: LiveCase[] = [
  { id: 'gift', utterance: 'a gift for my sister who hikes, under $50', expect: ['present'] },
  { id: 'warm', utterance: 'something warm for me but not scratchy', expect: ['present', 'ask'] },
  { id: 'vague', utterance: 'I need a present', expect: ['ask'] },
  { id: 'money', utterance: 'am I still waiting on any money from my orders?', expect: ['money'] },
  { id: 'recall', utterance: 'what do you know about my sizes?', expect: ['recall'] },
  { id: 'remember', utterance: "I'm a medium in sweaters, by the way. Find me a navy one.", expect: ['present', 'ask'], remember: true },
  { id: 'question', utterance: 'which of these is cheapest?', over: async () => ({ onScreen: await socksOnScreen() }), expect: ['answer'] },
  { id: 'buy', utterance: "I'll take the second one", over: async () => ({ onScreen: await socksOnScreen() }), expect: ['readback'] },
];

// Claude Haiku 5.5, prompts up to 100K tokens: $0.10 per million input, $0.50 per million output;
// cache reads 0.1x input, 5-minute cache writes 1.25x input.
const PRICE = { input: 0.1 / 1e6, output: 0.5 / 1e6, cacheRead: 0.01 / 1e6, cacheWrite: 0.125 / 1e6 };

async function live() {
  try {
    process.loadEnvFile(path.join(REPO_ROOT, '.env.local'));
  } catch {
    /* the key may already be in the environment */
  }
  if (!process.env.ANTHROPIC_API_KEY) {
    console.error('agent --live: ANTHROPIC_API_KEY is not set. Nothing was called.');
    process.exit(1);
  }
  const model = process.env.FAST_MODEL ?? 'claude-haiku-5-5';
  // About 3 calls per case, about 5,000 input and 400 output tokens per call, before caching.
  const est = LIVE_CASES.length * 3 * (5000 * PRICE.input + 400 * PRICE.output);
  console.log(`agent --live: ${LIVE_CASES.length} dialogues on ${model}, about ${LIVE_CASES.length * 3} calls. Estimated cost at most $${est.toFixed(3)} (Channel3 is not called: recorded data).`);
  const client = new Anthropic({ maxRetries: 1 });
  const create: CreateMessage = async (body, options) => {
    try {
      return await client.messages.create(body, options);
    } catch (e) {
      // Status and message only: never the request headers.
      if (e instanceof Anthropic.APIError) console.error(`  API error ${e.status ?? ''}: ${e.message.slice(0, 300)}`);
      throw e;
    }
  };
  // The app warms the prompt cache when the conversation opens; do the same before the first case.
  const warm = await client.messages.create(shopperWarmupRequest(model), { timeout: 15_000 });
  let cost = warm.usage.input_tokens * PRICE.input + (warm.usage.cache_creation_input_tokens ?? 0) * PRICE.cacheWrite + (warm.usage.cache_read_input_tokens ?? 0) * PRICE.cacheRead;
  const rows = [];
  for (const c of LIVE_CASES) {
    const r = await runShopper(input(c.utterance, c.over ? await c.over() : {}), deps(create, model));
    const u = r.usage;
    const caseCost = u.inputTokens * PRICE.input + u.outputTokens * PRICE.output + u.cacheReadTokens * PRICE.cacheRead + u.cacheWriteTokens * PRICE.cacheWrite;
    cost += caseCost;
    const right = c.expect.includes(r.outcome.kind) && (!c.remember || Boolean(r.remember));
    rows.push({
      case: c.id,
      utterance: c.utterance,
      outcome: r.outcome.kind,
      expected: c.expect,
      right,
      remember: r.remember ? { kind: r.remember.kind, value: r.remember.value, scope: r.remember.scope ?? null } : null,
      steps: r.steps.map((s) => `${s.tool}:${s.step}`),
      spoken:
        r.outcome.kind === 'present'
          ? { lead: r.outcome.lead ?? null, reasons: r.outcome.picks.map((p) => p.reason ?? null), titles: r.outcome.picks.map((p) => p.known.snapshot.title) }
          : r.outcome.kind === 'ask'
            ? r.outcome.question
            : r.outcome.kind === 'answer'
              ? r.outcome.text
              : null,
      ungrounded: r.ungrounded,
      modelCalls: r.modelCalls,
      toolCalls: r.toolCalls,
      ms: r.ms,
      usage: u,
      costUsd: Number(caseCost.toFixed(5)),
    });
    console.log(`  ${c.id}: ${r.outcome.kind}${right ? '' : ` (expected ${c.expect.join(' or ')})`} in ${(r.ms / 1000).toFixed(1)} s, ${r.modelCalls} calls, ${r.ungrounded.length} lines stopped`);
  }
  const right = rows.filter((r) => r.right).length;
  const lines = rows.flatMap((r) => (r.spoken && typeof r.spoken === 'object' ? [...r.spoken.reasons.filter((x) => x !== null), ...(r.spoken.lead ? [r.spoken.lead] : [])] : r.spoken ? [r.spoken] : []));
  const stopped = rows.reduce((n, r) => n + r.ungrounded.length, 0);
  const times = rows.map((r) => r.ms);
  const headlines: Headline[] = [
    {
      id: 'live-right-finish',
      label: 'Live model finishes with the right tool',
      value: ofN(right, rows.length),
      interval: wilsonText(right, rows.length),
      n: rows.length,
      script: SCRIPT,
      note: `${model}, effort low, over recorded Channel3 data. Hand-written cases; a small sample.`,
    },
    {
      id: 'live-stopped',
      label: 'Model lines the grounding check stopped before speech',
      value: ofN(stopped, stopped + lines.length),
      n: stopped + lines.length,
      script: SCRIPT,
      note: 'Stopped lines are never spoken; the template says the listing facts instead.',
    },
    {
      id: 'live-latency',
      label: 'Time for an agent turn, median and slowest',
      value: `${(percentile(times, 50) / 1000).toFixed(1)} s, ${(Math.max(...times) / 1000).toFixed(1)} s`,
      n: rows.length,
      script: SCRIPT,
      note: 'Model calls and tool work, from this laptop; recorded catalog, so no Channel3 time.',
    },
  ];
  writeResult('agent-live', {
    title: 'Shopping agent, live model',
    headlines,
    limitations: [
      `${rows.length} hand-written dialogues, one run each: a smoke test, not a benchmark.`,
      'The catalog is recorded Channel3 data plus the Demo Store; live Channel3 latency is not included.',
      'Right finish is judged by the finishing tool only, not by how good the chosen options are.',
      'The prompt cache is warmed before the first case, as the app does when the conversation opens. A cold first call measured about 10 seconds before warming was added.',
    ],
    details: { model, costUsd: Number(cost.toFixed(4)), rows },
  });
  console.log(`agent --live: ${ofN(right, rows.length)} right, ${stopped} lines stopped, actual cost $${cost.toFixed(4)}.`);
}

// ---------------------------------------------------------------------------------------------

async function main() {
  if (LIVE) return live();
  const o = await offline();
  const s = await searchQuality();
  const pass = (xs: Check[]) => xs.filter((c) => c.pass).length;
  // Every amount a money answer says is an order amount or a sum of them (the templates).
  const orders = [3672, 1944, 2376].map((amountCents, i) => ({
    id: `o${i}`,
    title: `Item ${i}`,
    amountCents,
    currency: 'USD',
    status: ['authorized', 'captured', 'resolved_refund'][i]!,
    intent: i === 0 ? 'AUTHORIZE' : 'CAPTURE',
    paypalOrderId: `PP${i}`,
    authorizationId: i === 0 ? 'A0' : null,
    captureId: i === 0 ? null : `C${i}`,
    authorizationExpiresAt: '2026-12-07T10:00:00Z',
    createdAt: '2026-11-05T10:00:00Z',
    paidAt: '2026-11-05T10:00:00Z',
    refundedAt: i === 2 ? '2026-11-07T10:00:00Z' : null,
  }));
  const sums = new Set<number>();
  for (let mask = 1; mask < 8; mask++) sums.add(orders.reduce((n, x, i) => (mask & (1 << i) ? n + x.amountCents : n), 0));
  let amounts = 0;
  let unbacked = 0;
  for (const question of ['on_hold', 'spent', 'hold_ends', 'refunds', 'orders', 'overview'] as const)
    for (const m of answerMoneyQuestion({ question }, orders, NOW, { autoCaptureDays: 7 }).text.match(/\$[\d,]+\.\d\d/g) ?? []) {
      amounts++;
      if (!sums.has(Math.round(Number(m.replace(/[$,]/g, '')) * 100))) unbacked++;
    }

  const headlines: Headline[] = [
    {
      id: 'guards',
      label: 'Wrong model moves the loop refuses (made-up id, unsaid filter or memory, unasked readback)',
      value: ofN(pass(o.guard), o.guard.length),
      baseline: `no checks: ${ofN(0, o.guard.length)}`,
      interval: wilsonText(pass(o.guard), o.guard.length),
      n: o.guard.length,
      script: SCRIPT,
      note: 'Scripted model turns, deliberately wrong; the real loop and its checks.',
    },
    {
      id: 'ungrounded-stopped',
      label: 'Agent lines with a claim the listing does not make, stopped before speech',
      value: ofN(pass(o.stop), o.stop.length),
      baseline: `no check: ${ofN(0, o.stop.length)}`,
      n: o.stop.length,
      script: SCRIPT,
    },
    {
      id: 'grounded-kept',
      label: 'Agent lines the listing backs, kept',
      value: ofN(pass(o.keep), o.keep.length),
      n: o.keep.length,
      script: SCRIPT,
    },
    {
      id: 'safety',
      label: 'Safety checks held (budget, no wool, no team gear, no other size, no order without asking, memory only proposed)',
      value: ofN(pass(o.safety), o.safety.length),
      n: o.safety.length,
      script: SCRIPT,
    },
    {
      id: 'wrong-size',
      label: 'Listings shown in another size than the "size M" asked for',
      value: ofN(s.rankedWrongSize, s.rankedShown),
      baseline: `Channel3's own top 3: ${ofN(s.rawWrongSize, s.rawShown)}`,
      n: s.rankedShown,
      script: SCRIPT,
      note: 'Recorded Channel3 responses (9 Nov 2026). Baseline counts the size each store pre-selected, which the app used to show.',
    },
    {
      id: 'team-gear',
      label: 'Team or fan merchandise in the top three',
      value: ofN(s.rankedFan, s.n),
      baseline: `Channel3's own top 3: ${ofN(s.rawFan, s.n)}`,
      n: s.n,
      script: SCRIPT,
    },
    {
      id: 'colour-named',
      label: 'Top-three listings that name their colour',
      value: ofN(s.rankedColour, s.n),
      baseline: `Channel3's own top 3: ${ofN(s.rawColour, s.n)}`,
      n: s.n,
      script: SCRIPT,
      negative: s.rankedColour < s.n,
      note: 'Better than Channel3’s order, but many live listings never name a colour. The app says "colour not given" for them, and the camera check cannot verify their colour.',
    },
    {
      id: 'money-unbacked',
      label: 'Amounts in money answers that are not in the orders',
      value: ofN(unbacked, amounts),
      n: amounts,
      script: SCRIPT,
      note: 'Every amount must be an order amount or a sum of them; answers are templates over the records.',
    },
  ];
  writeResult('agent', {
    title: 'Shopping agent',
    headlines,
    limitations: [
      'Offline: the model is scripted, so this measures the loop’s checks and the templates, not a real model’s choices. `--live` runs a small real-model smoke test.',
      'Search quality uses seven recorded Channel3 responses from one day; the ranking was tuned while looking at them, so they are not a held-out set.',
      'The grounding check is token-level plus a list of feature words: a claim with neither (for example "great for winter") is not checked.',
    ],
    details: { dialogues: o.rows, searchQuality: s.rows },
  });
  console.log(
    `agent: guards ${ofN(pass(o.guard), o.guard.length)}, stopped ${ofN(pass(o.stop), o.stop.length)}, kept ${ofN(pass(o.keep), o.keep.length)}, safety ${ofN(pass(o.safety), o.safety.length)}, tool ${ofN(pass(o.tool), o.tool.length)}`,
  );
  console.log(`  wrong size ${ofN(s.rankedWrongSize, s.rankedShown)} (raw ${ofN(s.rawWrongSize, s.rawShown)}), team gear ${ofN(s.rankedFan, s.n)} (raw ${ofN(s.rawFan, s.n)}), colour named ${ofN(s.rankedColour, s.n)} (raw ${ofN(s.rawColour, s.n)}), money unbacked ${ofN(unbacked, amounts)}`);
  for (const c of o.checks.filter((x) => !x.pass)) console.log(`  FAILED ${c.id}: ${c.detail}`);
  if (o.checks.some((c) => !c.pass)) process.exitCode = 1;
}

await main();
