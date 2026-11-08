import { beforeAll, describe, expect, it } from 'vitest';
import path from 'node:path';

/**
 * Integration tests against the local Postgres and the demo catalog for the conversation's
 * honesty and dead ends: settings change by voice, "yes" answers the question just asked,
 * questions during a readback are answered from it, another kind of thing is never offered, and a
 * store's offer can be answered by voice after hearing what accepting means. Each test uses a
 * fresh demo shopper. Skipped without a database.
 */
try {
  process.loadEnvFile(path.resolve(import.meta.dirname, '../../../.env.local'));
} catch {
  /* CI provides env directly */
}
const hasDb = Boolean(process.env.DATABASE_URL);

describe.skipIf(!hasDb)('conversation turns (Postgres)', () => {
  let conductor: typeof import('../src/server/conductor');
  let personas: typeof import('../src/server/personas');
  let rt: typeof import('../src/server/runtime');
  let t: typeof import('@sightline/db').tables;
  let eq: typeof import('drizzle-orm').eq;
  let newId: typeof import('@sightline/core').newId;

  beforeAll(async () => {
    rt = await import('../src/server/runtime');
    conductor = await import('../src/server/conductor');
    personas = await import('../src/server/personas');
    ({ tables: t } = await import('@sightline/db'));
    ({ eq } = await import('drizzle-orm'));
    ({ newId } = await import('@sightline/core'));
  });

  const say = (userId: string, text: string) => conductor.handleTurn(userId, { text, source: 'keyboard' });
  const prefs = async (userId: string) => (await rt.db().select().from(t.preferences).where(eq(t.preferences.userId, userId)))[0]!;

  it('"talk faster" with a screen reader is honest, offers brief answers, and "yes" does it', async () => {
    const userId = await personas.ensurePersona('maya');
    const faster = await say(userId, 'talk faster');
    expect(faster.say).toBe(
      'Your screen reader reads my replies, so its own speech rate decides how fast I talk. I can keep my answers shorter instead. Want me to?',
    );
    expect(faster.say).not.toMatch(/opened/i);
    const yes = await say(userId, 'yes');
    expect(yes.say).toBe("Okay, I'll keep it brief. Say 'normal detail' to undo.");
    expect((await prefs(userId)).verbosity).toBe('brief');
    const undo = await say(userId, 'normal detail');
    expect(undo.say).toBe("Okay, back to normal detail. Say 'be brief' to undo.");
    expect((await prefs(userId)).verbosity).toBe('standard');
  });

  it('"be brief" changes verbosity by voice and says how to undo it', async () => {
    const userId = await personas.ensurePersona('maya');
    const brief = await say(userId, 'be brief');
    expect(brief.say).toBe("Okay, I'll keep it brief. Say 'normal detail' to undo.");
    expect((await prefs(userId)).verbosity).toBe('brief');
    expect((await say(userId, 'be brief')).say).toBe("That's already how I talk. To change it, say 'normal detail' or 'more detail'.");
  });

  it("changes the app's own voice rate when that voice is on, and says how to undo it", async () => {
    const userId = await personas.ensurePersona('raj');
    const before = (await prefs(userId)).speechRate;
    const faster = await say(userId, 'talk faster');
    expect(faster.say).toBe("Okay, I'll talk faster. Say 'slower' to undo.");
    expect(faster.settings).toEqual({ speechRate: before + 25 });
    expect((await prefs(userId)).speechRate).toBe(before + 25);
    const slower = await say(userId, 'slower');
    expect(slower.settings).toEqual({ speechRate: before });
  });

  it('other settings point to the Settings page without claiming it was opened', async () => {
    const userId = await personas.ensurePersona('maya');
    const r = await say(userId, 'change my spending limit');
    expect(r.say).not.toMatch(/opened/i);
    expect(r.card?.kind).toBe('link');
  });

  it('never offers another kind of thing, says so plainly, and "yes" asks what to look for', async () => {
    const userId = await personas.ensurePersona('maya');
    const r = await say(userId, 'black jeans size 32');
    expect(r.card).toBeNull();
    expect(r.say).toBe("I couldn't find jeans in Demo Store. Want me to look for something else?");
    const yes = await say(userId, 'yes');
    expect(yes.say).toBe('Okay. What should I look for?');
  });

  it('remembers the suggestion it just offered, so "yes" tries it', async () => {
    const userId = await personas.ensurePersona('maya');
    const none = await say(userId, 'navy crew-neck sweater under twenty five dollars');
    expect(none.say).toBe("I couldn't find a navy crew-neck sweater in size M under $25. Want me to try up to $35, or any colour?");
    const yes = await say(userId, 'yes');
    // Two offers were made ("up to …, or any colour"), so it asks which; the offer's own words pick it.
    expect(yes.say).toMatch(/^Which one: up to \$\d+, or any colour\?$/);
    const upTo = none.suggestions.find((s) => s.label.startsWith('Try up to'))!;
    const picked = await say(userId, upTo.utterance);
    expect(picked.card?.kind).toBe('options');
  });

  it('"no" drops the suggestion, and a later "yes" does not act on it', async () => {
    const userId = await personas.ensurePersona('maya');
    await say(userId, 'black jeans size 32');
    expect((await say(userId, 'no')).say).toBe("Okay. Say what you'd like instead.");
    expect((await say(userId, 'yes')).card).toBeNull();
  });

  it('answers "what\'s the total" during a readback from the readback, then says how to pay', async () => {
    const userId = await personas.ensurePersona('maya');
    await say(userId, 'navy crew-neck sweater');
    const rb = await conductor.handleTurn(userId, { action: 'buy', index: 1 });
    expect(rb.card?.kind).toBe('readback');
    const total = rb.card?.kind === 'readback' ? rb.card.total : '';
    const answer = await say(userId, "what's the total");
    expect(answer.say).toBe(`The total is ${total}, with shipping and tax. To pay, say 'confirm purchase'. To change something, say what to change.`);
    expect(answer.card?.kind).toBe('readback');
    expect(answer.phase).toBe('readback');
    const size = await say(userId, 'what size is it');
    expect(size.say).toMatch(/^Size: M\. To pay, say 'confirm purchase'\./);
    expect(size.card?.kind).toBe('readback');
    const arrives = await say(userId, 'when does it arrive');
    expect(arrives.say).toMatch(/^It arrives by .+\. To pay, say 'confirm purchase'\./);
    const seller = await say(userId, 'who sells it');
    expect(seller.say).toMatch(/^Sold by Demo Store\. To pay/);
    // Nothing was paid along the way.
    expect(await rt.db().select().from(t.orders).where(eq(t.orders.userId, userId))).toHaveLength(0);
  });

  it('readback chips never repeat the card controls: exactly one Confirm', async () => {
    const userId = await personas.ensurePersona('maya');
    await say(userId, 'navy crew-neck sweater');
    const rb = await conductor.handleTurn(userId, { action: 'buy', index: 1 });
    expect(rb.suggestions.map((s) => s.label.toLowerCase()).filter((l) => /confirm|wait|cancel/.test(l))).toEqual([]);
    // A first press keeps the readback and asks for the second press.
    const first = await conductor.handleTurn(userId, { action: 'confirm-button', readbackId: rb.card?.kind === 'readback' ? rb.card.readbackId : '' });
    expect(first.card?.kind === 'readback' && first.card.needsSecondPress).toBe(true);
    await say(userId, 'cancel');
  });

  it('"why these" names what differs instead of three identical reasons', async () => {
    const userId = await personas.ensurePersona('maya');
    const found = await say(userId, 'navy crew-neck sweater');
    expect(found.card?.kind).toBe('options');
    const why = await say(userId, 'why these?');
    const parts = why.say.split(/\b(?:One|Two|Three): /).slice(1);
    expect(new Set(parts).size).toBe(parts.length);
  });

  it('a store offer is read with what accepting means, then "accept" answers it', async () => {
    const userId = await personas.ensurePersona('maya');
    const orderId = newId('ord');
    await rt.db().insert(t.orders).values({
      id: orderId,
      userId,
      cartId: newId('crt'),
      readbackId: newId('rdb'),
      snapshotId: newId('snap'),
      paypalRequestId: newId('req'),
      intent: 'AUTHORIZE',
      paymentSource: 'vault',
      status: 'case_open',
      amountCents: 3672,
      merchantId: 'demo-store',
      title: 'Harbor knit crew-neck sweater',
    });
    const caseId = newId('cas');
    const offer = { id: newId('ofr'), type: 'REPLACEMENT_WITHOUT_REFUND', note: 'A new one.', at: new Date().toISOString(), via: 'local' };
    await rt.db().insert(t.cases).values({ id: caseId, orderId, userId, kind: 'inquiry', stage: 'offer_received', status: 'open', reason: 'wrong_size', offers: [offer] });

    // "accept" before hearing the offer only reads it.
    const heard = await say(userId, 'accept');
    expect(heard.say).toBe(
      'Demo Store offered to send a replacement sweater. If you accept, Demo Store sends a new sweater and your case closes. ' +
        "You don't get money back. You can't undo accepting. Say 'accept' to accept the offer, or 'decline' to say no. Nothing changes until you choose.",
    );
    expect(heard.phase).toBe('offer');
    expect((await rt.db().select().from(t.cases).where(eq(t.cases.id, caseId)))[0]!.stage).toBe('offer_received');

    // "yes" alone does not accept.
    expect((await say(userId, 'yes')).say).toBe("Say 'accept' to accept the offer, or 'decline' to say no. Nothing changes until you choose.");

    const accepted = await say(userId, 'accept the offer');
    expect(accepted.say).toBe('Accepted. Demo Store sends a new sweater next, and your case is closed.');
    const [c] = await rt.db().select().from(t.cases).where(eq(t.cases.id, caseId));
    expect(c!.stage).toBe('resolved');
    const [o] = await rt.db().select().from(t.orders).where(eq(t.orders.id, orderId));
    expect(o!.status).toBe('resolved_replacement');
  });

  it('"no" leaves an offer open; "decline" declines it', async () => {
    const userId = await personas.ensurePersona('maya');
    const orderId = newId('ord');
    await rt.db().insert(t.orders).values({
      id: orderId,
      userId,
      cartId: newId('crt'),
      readbackId: newId('rdb'),
      snapshotId: newId('snap'),
      paypalRequestId: newId('req'),
      intent: 'AUTHORIZE',
      paymentSource: 'vault',
      status: 'case_open',
      amountCents: 3672,
      merchantId: 'demo-store',
      title: 'Harbor knit crew-neck sweater',
    });
    const caseId = newId('cas');
    const offer = { id: newId('ofr'), type: 'REFUND_WITH_RETURN', note: 'Send it back.', amountCents: 3672, at: new Date().toISOString(), via: 'local' };
    await rt.db().insert(t.cases).values({ id: caseId, orderId, userId, kind: 'inquiry', stage: 'offer_received', status: 'open', reason: 'wrong_size', offers: [offer] });

    await say(userId, 'what did they offer');
    expect((await say(userId, 'no')).say).toBe("Okay, I haven't answered. The offer stays open. Say 'what did they offer' to hear it again.");
    expect((await rt.db().select().from(t.cases).where(eq(t.cases.id, caseId)))[0]!.stage).toBe('offer_received');

    await say(userId, 'what did they offer');
    const declined = await say(userId, 'decline');
    expect(declined.say).toBe('Okay, I declined. Your case with Demo Store stays open, and they can make another offer.');
    const [c] = await rt.db().select().from(t.cases).where(eq(t.cases.id, caseId));
    expect(c!.stage).toBe('declined');
    expect(c!.status).toBe('open');
  });

  it('"check it now" points to the camera check link without claiming to open it', async () => {
    const userId = await personas.ensurePersona('maya');
    const orderId = newId('ord');
    await rt.db().insert(t.orders).values({
      id: orderId,
      userId,
      cartId: newId('crt'),
      readbackId: newId('rdb'),
      snapshotId: newId('snap'),
      paypalRequestId: newId('req'),
      intent: 'AUTHORIZE',
      paymentSource: 'vault',
      status: 'delivered',
      amountCents: 3672,
      merchantId: 'demo-store',
      title: 'Harbor knit crew-neck sweater',
    });
    const r = await say(userId, 'check my parcel');
    expect(r.say).not.toMatch(/I'll open/);
    expect(r.say).toContain("'Open the camera check'");
    expect(r.card?.kind === 'link' && r.card.label).toBe('Open the camera check');
  });
});
