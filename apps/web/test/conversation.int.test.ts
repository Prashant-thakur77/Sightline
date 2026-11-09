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

  /** An order with a store's replacement offer waiting, and the store's notice of it unread. */
  async function offerWaiting(userId: string) {
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
    await rt.db().insert(t.notifications).values({
      id: newId('ntf'),
      userId,
      kind: 'case',
      text: 'Demo Store offered to send a replacement Harbor knit crew-neck sweater. Nothing changes until you answer.',
      link: `/app/orders/${orderId}`,
    });
    return { orderId, caseId, offerId: offer.id };
  }

  it('Accept on the offer card takes two presses, and a double-click counts as one', async () => {
    const userId = await personas.ensurePersona('maya');
    const { caseId, offerId } = await offerWaiting(userId);
    const heard = await conductor.handleTurn(userId, { action: 'offer' });
    expect(heard.card).toMatchObject({ kind: 'offer', offerId, needsSecondPress: false });
    // The card's own buttons answer; the chips never repeat them.
    expect(heard.suggestions.map((s) => s.label)).toEqual(['Hear the offer again', 'Not now']);

    const first = await conductor.handleTurn(userId, { action: 'offer-accept', offerId });
    expect(first.card).toMatchObject({ kind: 'offer', needsSecondPress: true });
    expect(first.say).toBe("Press Accept again to accept. You can't undo accepting. To leave the offer open, say 'not now'.");
    // Straight away is a double-click: still the first press, and nothing is answered.
    const bounce = await conductor.handleTurn(userId, { action: 'offer-accept', offerId });
    expect(bounce.card).toMatchObject({ kind: 'offer', needsSecondPress: true });
    expect((await rt.db().select().from(t.cases).where(eq(t.cases.id, caseId)))[0]!.stage).toBe('offer_received');

    await new Promise((r) => setTimeout(r, 550));
    const second = await conductor.handleTurn(userId, { action: 'offer-accept', offerId });
    expect(second.say).toBe('Accepted. Demo Store sends a new sweater next, and your case is closed.');
    expect((await rt.db().select().from(t.cases).where(eq(t.cases.id, caseId)))[0]!.stage).toBe('resolved');
  });

  it('any other turn between the two presses starts Accept over', async () => {
    const userId = await personas.ensurePersona('maya');
    const { caseId, offerId } = await offerWaiting(userId);
    await conductor.handleTurn(userId, { action: 'offer' });
    await conductor.handleTurn(userId, { action: 'offer-accept', offerId });
    const yes = await say(userId, 'yes');
    expect(yes.card).toMatchObject({ kind: 'offer', needsSecondPress: false });
    await new Promise((r) => setTimeout(r, 550));
    const again = await conductor.handleTurn(userId, { action: 'offer-accept', offerId });
    expect(again.card).toMatchObject({ kind: 'offer', needsSecondPress: true });
    expect((await rt.db().select().from(t.cases).where(eq(t.cases.id, caseId)))[0]!.stage).toBe('offer_received');
  });

  it('the greeting never reads an offer that was already answered', async () => {
    const userId = await personas.ensurePersona('maya');
    await conductor.handleTurn(userId, { action: 'start' });
    const { offerId } = await offerWaiting(userId);
    // Answered by voice from the order page's link: the notice is spent.
    await conductor.handleTurn(userId, { action: 'offer' });
    await say(userId, 'accept the offer');
    const hello = await conductor.handleTurn(userId, { action: 'start' });
    expect(hello.say).not.toMatch(/offer|until you answer/i);
    expect(offerId).toBeTruthy();
  });

  it('the greeting drops an offer notice whose offer has gone, even if it was never read', async () => {
    const userId = await personas.ensurePersona('maya');
    await conductor.handleTurn(userId, { action: 'start' });
    const { caseId } = await offerWaiting(userId);
    // Settled elsewhere (the store's desk, PayPal) without the buyer hearing it here.
    await rt.db().update(t.cases).set({ stage: 'resolved', status: 'resolved' }).where(eq(t.cases.id, caseId));
    const hello = await conductor.handleTurn(userId, { action: 'start' });
    expect(hello.say).not.toMatch(/until you answer/);
    const unread = await rt.db().select().from(t.notifications).where(eq(t.notifications.userId, userId));
    expect(unread.every((n) => n.readAt)).toBe(true);
  });

  it('an offer still open is read in the greeting once, then not again', async () => {
    const userId = await personas.ensurePersona('maya');
    await conductor.handleTurn(userId, { action: 'start' });
    await offerWaiting(userId);
    expect((await conductor.handleTurn(userId, { action: 'start' })).say).toMatch(/One update\. Demo Store offered to send a replacement/);
    expect((await conductor.handleTurn(userId, { action: 'start' })).say).not.toMatch(/until you answer/);
  });

  it('welcomes on the first visit only', async () => {
    const userId = await personas.ensurePersona('maya');
    const first = await conductor.handleTurn(userId, { action: 'start' });
    expect(first.say).toMatch(/^Hi Maya\. Welcome to /);
    const again = await conductor.handleTurn(userId, { action: 'start' });
    expect(again.say).toBe('Hi Maya. What do you need today?');
  });

  it('a reload brings a waiting readback back at its first press, and the options too', async () => {
    const userId = await personas.ensurePersona('maya');
    await conductor.handleTurn(userId, { action: 'start' });
    const found = await say(userId, 'navy crew-neck sweater');
    expect(found.card?.kind).toBe('options');
    // Options come back after a reload.
    const page1 = await conductor.resumeTurn(userId);
    expect(page1?.card?.kind).toBe('options');
    expect(page1?.messages.some((m) => m.role === 'user' && m.text === 'navy crew-neck sweater')).toBe(true);
    const back1 = await conductor.handleTurn(userId, { action: 'start' });
    expect(back1.card?.kind).toBe('options');
    expect(back1.say).toMatch(/options from before are still here/);

    const rb = await conductor.handleTurn(userId, { action: 'buy', index: 1 });
    const readbackId = rb.card?.kind === 'readback' ? rb.card.readbackId : '';
    const first = await conductor.handleTurn(userId, { action: 'confirm-button', readbackId });
    expect(first.card?.kind === 'readback' && first.card.needsSecondPress).toBe(true);

    // The page shows the readback again before the greeting arrives, at its first press.
    const page2 = await conductor.resumeTurn(userId);
    expect(page2?.card).toMatchObject({ kind: 'readback', readbackId, needsSecondPress: false });
    const back2 = await conductor.handleTurn(userId, { action: 'start' });
    expect(back2.card).toMatchObject({ kind: 'readback', readbackId, needsSecondPress: false });
    expect(back2.phase).toBe('readback');
    expect(back2.say).toMatch(/Your readback is still here: .+, \$\d+\.\d\d\. Nothing is paid until you confirm\./);
    // The reload was not a press: the next press is a first press again, and nothing is paid.
    const after = await conductor.handleTurn(userId, { action: 'confirm-button', readbackId });
    expect(after.card?.kind === 'readback' && after.card.needsSecondPress).toBe(true);
    expect(await rt.db().select().from(t.orders).where(eq(t.orders.userId, userId))).toHaveLength(0);
    await say(userId, 'cancel');
    // A cancelled readback is not brought back.
    expect((await conductor.resumeTurn(userId))?.card?.kind).not.toBe('readback');
  });

  it('without PayPal keys the readback says so before the first press, outside the signed text', async () => {
    if (rt.INTEGRATIONS.paypal) return;
    const userId = await personas.ensurePersona('maya');
    await say(userId, 'navy crew-neck sweater');
    const rb = await conductor.handleTurn(userId, { action: 'buy', index: 1 });
    expect(rb.card).toMatchObject({ kind: 'readback', paypalConnected: false });
    expect(rb.say.endsWith("PayPal isn't connected on this server, so confirming won't charge anything.")).toBe(true);
    expect(rb.card?.kind === 'readback' && rb.card.text).not.toContain('connected');
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

  it('return visits never store another greeting, whatever they restate (options, a parcel, nothing new)', async () => {
    const userId = await personas.ensurePersona('maya');
    const start = () => conductor.handleTurn(userId, { action: 'start' });
    await start();
    await say(userId, 'navy crew-neck sweater');
    const count = async () => {
      const [c] = await rt.db().select({ id: t.conversations.id }).from(t.conversations).where(eq(t.conversations.userId, userId));
      return (await rt.db().select({ id: t.messages.id }).from(t.messages).where(eq(t.messages.conversationId, c!.id))).length;
    };
    const before = await count();
    for (let i = 0; i < 3; i++) {
      const r = await start();
      expect(r.say).toMatch(/^Hi Maya\./);
    }
    expect(await count()).toBe(before);
  });

  it('shows a repeated agent line once when the conversation is restored', async () => {
    const userId = await personas.ensurePersona('maya');
    await conductor.handleTurn(userId, { action: 'start' });
    const [c] = await rt.db().select({ id: t.conversations.id }).from(t.conversations).where(eq(t.conversations.userId, userId));
    const line = 'Hi Maya. Nothing new since last time.';
    for (let i = 0; i < 3; i++) await rt.db().insert(t.messages).values({ id: `msg_dup${i}${Date.now()}`, conversationId: c!.id, role: 'agent', text: line });
    const page = await conductor.resumeTurn(userId);
    expect(page!.messages.filter((m) => m.text === line)).toHaveLength(1);
  });
});
