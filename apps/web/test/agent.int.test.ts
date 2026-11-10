import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import path from 'node:path';
import { lastResultIds, scriptedModel, toolUse, type ScriptStep } from '@sightline/agent';

/**
 * The shopping agent inside real conversation turns, against Postgres, with a scripted model and
 * recorded Channel3 data (no network): hybrid routing, grounded picks, the readback hand-off with
 * its step log, memory with consent, money answers, and "buy my usual again". Skipped without a
 * database.
 */
try {
  process.loadEnvFile(path.resolve(import.meta.dirname, '../../../.env.local'));
} catch {
  /* CI provides env directly */
}
const hasDb = Boolean(process.env.DATABASE_URL);

describe.skipIf(!hasDb)('shopping agent turns (Postgres)', () => {
  let conductor: typeof import('../src/server/conductor');
  let personas: typeof import('../src/server/personas');
  let shopper: typeof import('../src/server/shopper');
  let catalogMod: typeof import('../src/server/catalog');
  let rt: typeof import('../src/server/runtime');
  let t: typeof import('@sightline/db').tables;
  let q: typeof import('drizzle-orm');
  let newId: typeof import('@sightline/core').newId;
  let cat: typeof import('@sightline/catalog');
  let fixtures: typeof import('@sightline/catalog/fixtures');

  beforeAll(async () => {
    rt = await import('../src/server/runtime');
    conductor = await import('../src/server/conductor');
    personas = await import('../src/server/personas');
    shopper = await import('../src/server/shopper');
    catalogMod = await import('../src/server/catalog');
    ({ tables: t } = await import('@sightline/db'));
    q = await import('drizzle-orm');
    ({ newId } = await import('@sightline/core'));
    cat = await import('@sightline/catalog');
    fixtures = await import('@sightline/catalog/fixtures');
  });

  afterEach(() => {
    shopper.setShopperModelForTests(null);
    catalogMod.setCatalogForTests(null);
  });

  const say = (userId: string, text: string) => conductor.handleTurn(userId, { text, source: 'keyboard' });
  const useRecordedCatalog = () => catalogMod.setCatalogForTests(cat.createMergedCatalog(cat.createDemoStore(), cat.createRecordedChannel3(fixtures.recordedSearches())));
  const useModel = (script: ScriptStep[]) => {
    const m = scriptedModel(script);
    shopper.setShopperModelForTests(m.create);
    return m;
  };
  const steps = async (userId: string) =>
    (
      await rt
        .db()
        .select({ seq: t.auditLog.seq, subjectId: t.auditLog.subjectId, payload: t.auditLog.payload })
        .from(t.auditLog)
        .where(q.and(q.eq(t.auditLog.userId, userId), q.eq(t.auditLog.action, 'agent.step')))
        .orderBy(q.asc(t.auditLog.seq))
    ).map((r) => ({ seq: r.seq, subjectId: r.subjectId, ...(r.payload as Record<string, unknown>) }));

  it('hybrid: a request the grammar fully understands never calls the model', async () => {
    const userId = await personas.ensurePersona('maya');
    useRecordedCatalog();
    const m = useModel([() => new Error('the model must not be called')]);
    const r = await say(userId, 'I need a navy crew-neck sweater, medium, under forty dollars');
    expect(m.requests).toHaveLength(0);
    expect(r.card?.kind).toBe('options');
    const items = r.card?.kind === 'options' ? r.card.items : [];
    expect(items[0]!.title).toBe('Harbor knit crew-neck sweater');
    // The heading claims only what every option confirms.
    expect(r.card?.kind === 'options' && r.card.heading).toMatch(/^3 options: a navy (crew-neck )?sweater in size M under \$40/);
    const [searched] = await steps(userId);
    expect(searched).toMatchObject({ tool: 'channel3', step: 'searched' });
    expect(String(searched!.summary)).toMatch(/^Searched the Demo Store and Channel3 for "navy crew-neck sweater" \(a navy crew-neck sweater in size M under \$40\): \d+ listings, 3 kept/);
  });

  it('a gift goes to the agent: two searches, grounded picks, steps in the log, and "more"', async () => {
    const userId = await personas.ensurePersona('maya');
    useRecordedCatalog();
    useModel([
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
              { id: ids[2]!, reason: 'A comfortable everyday pair.' },
            ],
          }),
        ];
      },
    ]);
    const r = await say(userId, 'a gift for my sister who hikes, under $50');
    expect(r.card?.kind).toBe('options');
    const items = r.card?.kind === 'options' ? r.card.items : [];
    expect(items).toHaveLength(3);
    expect(items[0]!.pick).toBe('Merino wool keeps feet warm on long hikes.');
    // "Gore-Tex" isn't in that listing: not shown, not spoken.
    expect(items[1]!.pick).toBeUndefined();
    expect(r.say).not.toMatch(/Gore-Tex/);
    expect(r.say).toMatch(/^It's for someone else, so I didn't use your own sizes\. Here are warm picks for a hiker\. I found three\. One: /);
    // Prices are read from the listings by the template, every one under $50.
    for (const it of items) expect(Number(it.price.replace(/[$,]/g, ''))).toBeLessThanOrEqual(50);
    const log = await steps(userId);
    expect(log.map((s) => `${s.tool}:${s.step}`)).toEqual(['channel3:searched', 'channel3:searched', 'claude:presented', 'claude:lines_stopped']);
    // The stopped line is kept as evidence; the step itself says only how many.
    expect(log[3]).toMatchObject({ summary: "Left out one line it wrote that the listings don't back.", decided: 'model', stopped: ['Waterproof Gore-Tex for wet trails.'] });
    expect(new Set(log.map((s) => s.threadId)).size).toBe(1);
    expect(log.every((s) => s.subjectId === s.conversationId)).toBe(true);
    const more = await say(userId, 'more');
    expect(more.card?.kind).toBe('options');
    expect(more.say).toMatch(/^Here are three more\./);
  });

  it('a readback the agent asks for is the app’s template, logged with the whole thread by readbackId', async () => {
    const userId = await personas.ensurePersona('maya');
    useRecordedCatalog();
    useModel([
      [toolUse('search_products', { query: 'merino hiking socks', category: 'socks', for_someone_else: false })],
      (req) => [toolUse('present_options', { options: [{ id: lastResultIds(req)[0]!, reason: 'Merino wool.' }] })],
    ]);
    await say(userId, 'warm socks for hiking');
    // "Buy the first one" is the grammar's fast path. The socks come in several sizes, so it asks
    // which first, then the template readback runs as before.
    const ask = await conductor.handleTurn(userId, { action: 'buy', index: 1 });
    expect(ask.say).toMatch(/^Which size would you like\?/);
    const rb = await say(userId, 'medium');
    expect(rb.card?.kind).toBe('readback');
    const readbackId = rb.card?.kind === 'readback' ? rb.card.readbackId : '';
    const log = await steps(userId);
    const proposed = log.find((s) => s.step === 'proposed_readback')!;
    expect(proposed).toMatchObject({ subjectId: readbackId, readbackId, tool: 'app' });
    const earlier = log.filter((s) => s.seq < proposed.seq && s.threadId === proposed.threadId).map((s) => s.seq);
    expect(proposed.threadSteps).toEqual(earlier);
    expect(earlier.length).toBe(2);
    // Paying still takes two presses, and what PayPal did is a step about this readback.
    await conductor.handleTurn(userId, { action: 'confirm-button', readbackId });
    await new Promise((r) => setTimeout(r, 550));
    await conductor.handleTurn(userId, { action: 'confirm-button', readbackId });
    const after = await steps(userId);
    expect(after.at(-1)).toMatchObject({ tool: 'paypal', subjectId: readbackId, readbackId });
  }, 20_000);

  it('the agent can hand an item to the readback only when the buyer asked to buy it', async () => {
    const userId = await personas.ensurePersona('maya');
    useRecordedCatalog();
    useModel([
      [toolUse('search_products', { query: 'merino hiking socks', category: 'socks', for_someone_else: false })],
      (req) => [toolUse('start_readback', { id: lastResultIds(req)[0]! })],
    ]);
    const ask = await say(userId, "I'll take some merino hiking socks");
    // It never buys a size nobody chose; a size it doesn't come in gets the list again.
    expect(ask.say).toMatch(/^Which size would you like\? It comes in /);
    const notOffered = await say(userId, 'size 13');
    expect(notOffered.say).toMatch(/^It doesn't come in size 13\. It comes in .+\. Which would you like\?/);
    const r = await say(userId, ask.suggestions[0]!.utterance);
    expect(r.card?.kind).toBe('readback');
    expect(r.phase).toBe('readback');
    const log = await steps(userId);
    expect(log.find((s) => s.step === 'proposed_readback')).toMatchObject({ tool: 'claude' });
    // Nothing was paid along the way.
    expect(await rt.db().select().from(t.orders).where(q.eq(t.orders.userId, userId))).toHaveLength(0);
  });

  it('falls back to the grammar when the model times out', async () => {
    const userId = await personas.ensurePersona('maya');
    useRecordedCatalog();
    useModel([() => Object.assign(new Error('Request timed out.'), { name: 'APIConnectionTimeoutError' })]);
    const r = await say(userId, 'a gift for my dad who likes fishing');
    expect(r.say).toMatch(/^I can find things/);
    const log = await steps(userId);
    expect(log.at(-1)).toMatchObject({ tool: 'claude', step: 'fell_back' });
  });

  it('never shows another size under "size M" (the XL bug), on the fast path', async () => {
    const userId = await personas.ensurePersona('maya');
    useRecordedCatalog();
    const r = await say(userId, 'navy crewneck sweatshirt size M');
    const items = r.card?.kind === 'options' ? r.card.items : [];
    expect(items.length).toBeGreaterThan(0);
    for (const it of items) expect(it.size === undefined || /\bM\b/.test(it.size)).toBe(true);
    expect(r.say).not.toMatch(/\bXL\b/);
  });

  it('asks which size before a readback when the listing offers several, and never guesses', async () => {
    const userId = await personas.ensurePersona('maya');
    useRecordedCatalog();
    // Socks have no saved size, so the listings' own size lists stand.
    await say(userId, 'merino hiking socks');
    const options = await conductor.resumeTurn(userId);
    expect(options?.card?.kind).toBe('options');
    const items = options?.card?.kind === 'options' ? options.card.items : [];
    const multi = items.findIndex((it) => it.size?.startsWith('Choose from'));
    expect(multi).toBeGreaterThanOrEqual(0);
    const ask = await conductor.handleTurn(userId, { action: 'buy', index: multi + 1 });
    expect(ask.card).toBeNull();
    expect(ask.say).toMatch(/^Which size would you like\? It comes in .+\. Nothing is paid yet\.$/);
    const rb = await say(userId, 'medium');
    expect(rb.card?.kind).toBe('readback');
    // The listing's own label for the size it offers ("M", or "S/M").
    expect(rb.card?.kind === 'readback' && rb.card.fields.find((f) => f.key.endsWith('size'))?.value).toMatch(/(^|\/)M(\/|$)/);
    // Changing to a size it doesn't come in stops honestly, with nothing charged.
    const change = await say(userId, 'make it size 13');
    expect(change.say).toBe("That one doesn't come in size 13, so I stopped. Nothing was charged. Say another size, or 'more' for other options.");
  });

  it('remembers a size only after "yes", uses it in words, recalls and forgets it', async () => {
    const userId = await personas.ensurePersona('raj');
    const ask = await say(userId, "I'm a medium in sweaters");
    expect(ask.say).toBe("Shall I remember that you're a medium in sweaters?");
    expect(await rt.db().select().from(t.memories).where(q.eq(t.memories.userId, userId))).toHaveLength(0);
    const yes = await say(userId, 'yes');
    expect(yes.say).toBe("Okay, I'll remember that you're a medium in sweaters. To undo it, say 'forget my sweater size'.");
    const rows = await rt.db().select().from(t.memories).where(q.eq(t.memories.userId, userId));
    expect(rows).toMatchObject([{ kind: 'size', value: 'M', scope: 'sweater', said: "I'm a medium in sweaters" }]);

    const found = await say(userId, 'navy sweater');
    expect(found.say).toMatch(/^Using your usual size M\. /);
    const recall = await say(userId, 'what do you remember about me');
    expect(recall.say).toMatch(/^Here's what I remember\. You're a medium in sweaters\. Your Settings also have size L for tops/);

    const forget = await say(userId, 'forget my size');
    expect(forget.say).toMatch(/^Done\. I've forgotten that you're a medium in sweaters\. I also cleared size L for tops/);
    expect(await rt.db().select().from(t.memories).where(q.eq(t.memories.userId, userId))).toHaveLength(0);
    const [p] = await rt.db().select().from(t.preferences).where(q.eq(t.preferences.userId, userId));
    expect(p!.sizes).toEqual({ shoes: '10' });
  });

  it('"no" stores nothing; "remember that ..." is consent in itself', async () => {
    const userId = await personas.ensurePersona('maya');
    await say(userId, 'nothing with wool');
    expect((await say(userId, 'no')).say).toBe("Okay, I won't remember that.");
    expect(await rt.db().select().from(t.memories).where(q.eq(t.memories.userId, userId))).toHaveLength(0);
    const r = await say(userId, 'remember that I never wear orange');
    expect(r.say).toBe("Okay, I'll remember that you avoid orange. To undo it, say 'forget orange'.");
    expect(await rt.db().select().from(t.memories).where(q.eq(t.memories.userId, userId))).toHaveLength(1);
  });

  it('a memory the agent proposes is asked about after its answer, and the buyer decides', async () => {
    const userId = await personas.ensurePersona('maya');
    useRecordedCatalog();
    useModel([
      [toolUse('remember_preference', { kind: 'avoid_material', value: 'wool' }), toolUse('search_products', { query: 'soft cotton sweater', for_someone_else: false, avoid_materials: ['wool'] })],
      (req) => [toolUse('present_options', { options: [{ id: lastResultIds(req)[0]!, reason: 'Soft cotton.' }] })],
    ]);
    const r = await say(userId, 'a warm sweater but not scratchy, wool makes me itch');
    expect(r.say).toMatch(/Shall I remember that you avoid wool\?$/);
    const yes = await say(userId, 'yes');
    expect(yes.say).toBe("Okay, I'll remember that you avoid wool. To undo it, say 'forget wool'.");
    const log = await steps(userId);
    expect(log.map((s) => `${s.tool}:${s.step}`)).toContain('memory:remembered');
  });

  it('answers money questions from the records only', async () => {
    const userId = await personas.ensurePersona('maya');
    const base = { userId, cartId: newId('crt'), readbackId: newId('rdb'), snapshotId: newId('snap'), merchantId: 'demo-store', paymentSource: 'vault' };
    await rt.db().insert(t.orders).values({ ...base, id: newId('ord'), paypalRequestId: newId('req'), paypalOrderId: newId('pp'), intent: 'AUTHORIZE', authorizationId: 'AUTH-1', status: 'authorized', amountCents: 3672, title: 'Harbor knit crew-neck sweater' });
    await rt.db().insert(t.orders).values({ ...base, id: newId('ord'), paypalRequestId: newId('req'), paypalOrderId: newId('pp'), intent: 'CAPTURE', captureId: 'CAP-1', status: 'captured', amountCents: 1944, title: 'Mill heavyweight cotton T-shirt' });
    const hold = await say(userId, "what's on hold?");
    expect(hold.say).toBe('$36.72 is on hold for your Harbor knit crew-neck sweater. Demo Store is paid only after you check it.');
    const spent = await say(userId, 'how much did I spend this month?');
    expect(spent.say).toBe("This month, you paid $19.44, for one order: your Mill heavyweight cotton T-shirt, $19.44. $36.72 more is on hold, and isn't spent yet.");
    const refund = await say(userId, 'did I get my refund?');
    expect(refund.say).toBe("You haven't had any refunds, and you have no open cases.");
    const log = await steps(userId);
    expect(log.filter((s) => s.tool === 'money').map((s) => s.step)).toEqual(['answered', 'answered', 'answered']);
  });
});
