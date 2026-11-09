import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import path from 'node:path';
import type { RawProposal } from '@sightline/agent';

/**
 * The store's agent, end to end against the local Postgres, with a fake PayPal and a scripted model
 * (no network). A real case: a readback from the demo catalog, a held PayPal payment, the wrong
 * size shipped by the store's own record, a mismatch check, a signed evidence pack, the case sent.
 * Then the store's agent reads the pack and answers inside the store's policy, the buyer hears the
 * offer with its reasons, declines, and the agent revises once before handing over to staff.
 * Skipped without a database or a signing key.
 */
try {
  process.loadEnvFile(path.resolve(import.meta.dirname, '../../../.env.local'));
} catch {
  /* CI provides env directly */
}
/** The store agent's tables come with migration 0005: on a database without it, say so and skip. */
async function migrated(): Promise<boolean> {
  try {
    const { getDb } = await import('@sightline/db');
    const { sql } = await import('drizzle-orm');
    await getDb(process.env.DATABASE_URL).execute(sql`select 1 from store_agent_proposals limit 1`);
    return true;
  } catch {
    console.warn('store-agent tests skipped: run `pnpm db:migrate` to add the store agent tables.');
    return false;
  }
}
const ready = Boolean(process.env.DATABASE_URL && process.env.RECEIPT_SIGNING_KEY) && (await migrated());

const calls: { op: string; id: string; requestId: string; amount?: number; finalCapture?: boolean }[] = [];
const payments = {
  async captureAuthorization(id: string, i: { requestId: string; amount?: { cents: number }; finalCapture?: boolean }) {
    calls.push({ op: 'capture', id, requestId: i.requestId, amount: i.amount?.cents, finalCapture: i.finalCapture });
    return { id: `CAP-${id}`, status: 'COMPLETED' };
  },
  async voidAuthorization(id: string, i: { requestId: string }) {
    calls.push({ op: 'void', id, requestId: i.requestId });
    return undefined;
  },
  async refundCapture(id: string, i: { requestId: string; amount?: { cents: number } }) {
    calls.push({ op: 'refund', id, requestId: i.requestId, amount: i.amount?.cents });
    return { id: `REF-${id}`, status: 'COMPLETED' };
  },
  async reauthorize(id: string, i: { requestId: string }) {
    calls.push({ op: 'reauthorize', id, requestId: i.requestId });
    return { id: `RE-${id}`, status: 'CREATED' };
  },
};
vi.mock('../src/server/paypal', () => ({
  paypal: () => ({ payments }),
  PayPalNotConfiguredError: class PayPalNotConfiguredError extends Error {},
}));
// A guard: nothing here may reach the real model.
vi.mock('@anthropic-ai/sdk', () => ({
  default: class {
    constructor() {
      throw new Error('tests never call the Anthropic API');
    }
  },
}));

describe.skipIf(!ready)('the store agent (Postgres, fake PayPal, scripted model)', () => {
  let rt: typeof import('../src/server/runtime');
  let t: typeof import('@sightline/db').tables;
  let eq: typeof import('drizzle-orm').eq;
  let newId: typeof import('@sightline/core').newId;
  let conductor: typeof import('../src/server/conductor');
  let personas: typeof import('../src/server/personas');
  let cases: typeof import('../src/server/cases');
  let agent: typeof import('../src/server/store-agent');
  let merchant: typeof import('../src/server/merchant');
  let policy: typeof import('../src/server/store-policy');
  let offers: typeof import('../src/server/offers');
  let timeline: typeof import('../src/server/timeline');

  beforeAll(async () => {
    rt = await import('../src/server/runtime');
    ({ tables: t } = await import('@sightline/db'));
    ({ eq } = await import('drizzle-orm'));
    ({ newId } = await import('@sightline/core'));
    conductor = await import('../src/server/conductor');
    personas = await import('../src/server/personas');
    cases = await import('../src/server/cases');
    agent = await import('../src/server/store-agent');
    merchant = await import('../src/server/merchant');
    policy = await import('../src/server/store-policy');
    offers = await import('../src/server/offers');
    timeline = await import('../src/server/timeline');
  });
  beforeEach(() => {
    calls.length = 0;
  });

  /** A held order for a real readback, the wrong size shipped, a mismatch check, and the case sent to the store. */
  async function caseAtStore(o: { shipped?: string; verdict?: 'sure' | 'unsure' } = {}) {
    const userId = await personas.ensurePersona('maya');
    await conductor.handleTurn(userId, { text: 'navy crew-neck sweater', source: 'keyboard' });
    const rb = await conductor.handleTurn(userId, { action: 'buy', index: 1 });
    if (rb.card?.kind !== 'readback') throw new Error('no readback');
    const [readback] = await rt.db().select().from(t.readbacks).where(eq(t.readbacks.id, rb.card.readbackId));
    const [cart] = await rt.db().select().from(t.carts).where(eq(t.carts.id, readback!.cartId));
    const body = cart!.body as { lines: { snapshot: { id: string; title: string } }[]; totals: { total: { cents: number } } };
    const orderId = newId('ord');
    const auth = `AUTH-${orderId}`;
    await rt.db().insert(t.orders).values({
      id: orderId,
      userId,
      cartId: cart!.id,
      readbackId: readback!.id,
      snapshotId: body.lines[0]!.snapshot.id,
      paypalRequestId: newId('req'),
      paypalOrderId: `PP-${orderId}`,
      intent: 'AUTHORIZE',
      paymentSource: 'vault',
      status: 'verified_mismatch',
      amountCents: body.totals.total.cents,
      merchantId: 'demo-store',
      title: body.lines[0]!.snapshot.title,
      authorizationId: auth,
    });
    await rt.db().insert(t.shipments).values({ orderId, status: 'delivered', shippedVariant: o.shipped ?? 'wrong_size', deliveredAt: new Date().toISOString() });
    const sure = o.verdict !== 'unsure';
    await rt.db().insert(t.verifications).values({
      id: newId('ver'),
      orderId,
      status: sure ? 'mismatch' : 'unsure',
      photos: [],
      verdict: {
        kind: sure ? 'mismatch' : 'unsure',
        headline: sure ? "This doesn't match." : "I'm not sure about this one.",
        reasons: [
          { module: 'size', finding: 'disagree', confidence: sure ? 'sure' : 'fairly_sure', expected: 'M', observed: 'L', sentence: 'The size tag reads L, you ordered M.' },
          { module: 'colour', finding: 'agree', confidence: 'fairly_sure', expected: 'navy', observed: 'navy', sentence: 'The colour matches.' },
        ],
        nextSteps: [],
      },
    });
    const preview = await cases.prepareMoneyBack(userId, orderId);
    await cases.sendMoneyBack(userId, preview.caseId);
    return { userId, orderId, caseId: preview.caseId, auth, amountCents: body.totals.total.cents };
  }

  /** A scripted model: picks the given option with the given reasons, and records what it was shown. */
  const scripted = (pick: (ids: string[]) => RawProposal) => {
    const seen: { prompt: string; optionIds: string[] }[] = [];
    const model = async (input: { prompt: string; optionIds: string[] }) => {
      seen.push({ prompt: input.prompt, optionIds: input.optionIds });
      return { raw: pick(input.optionIds), model: 'scripted' };
    };
    return { model, seen };
  };
  const proposals = async (caseId: string) =>
    rt.db().select().from(t.storeAgentProposals).where(eq(t.storeAgentProposals.caseId, caseId));
  const kase = async (caseId: string) => (await rt.db().select().from(t.cases).where(eq(t.cases.id, caseId)))[0]!;
  const notes = async (userId: string) => (await rt.db().select().from(t.notifications).where(eq(t.notifications.userId, userId))).map((n) => ({ kind: n.kind, text: n.text }));
  const steps = async (orderId: string) =>
    (await rt.db().select().from(t.auditLog).where(eq(t.auditLog.subjectId, orderId)))
      .filter((r) => r.action === 'store_agent.step')
      .map((r) => (r.payload as { step: string }).step);

  it('reads the signed pack, offers a replacement inside the policy, and the buyer hears why', async () => {
    const c = await caseAtStore();
    const { model, seen } = scripted(() => ({
      option_id: 'replacement',
      reasons: [
        { text: "Demo Store's own shipping record shows the wrong size (L) went out.", facts: ['shipping'] },
        { text: 'The size tag reads L, and the order was for size M.', facts: ['check-size', 'order'] },
      ],
      staff_note: 'The store sent the wrong size, so a replacement in the right size fixes it.',
    }));
    const run = await agent.runStoreAgent(c.caseId, { kind: 'case_received' }, { model });
    expect(run.kind).toBe('sent');
    expect(seen[0]!.prompt).toContain("[shipping] Demo Store's shipping record says it sent the wrong size (L).");
    expect(seen[0]!.prompt).toContain('[evidence] The signed evidence pack checks out');
    expect(seen[0]!.optionIds).toEqual(['replacement', 'refund', 'return', 'partial_20']);
    expect(calls).toEqual([]);

    const k = await kase(c.caseId);
    expect(k.stage).toBe('offer_received');
    const offer = (k.offers as { type: string; by: string; reasons: string[] }[]).at(-1)!;
    expect(offer).toMatchObject({ type: 'REPLACEMENT_WITHOUT_REFUND', by: 'store_agent' });
    expect(offer.reasons).toHaveLength(2);
    const [p] = await proposals(c.caseId);
    expect(p).toMatchObject({ status: 'sent', source: 'model', auto: true, decidedBy: 'store_agent', optionId: 'replacement' });
    expect(await steps(c.orderId)).toEqual(['read_evidence', 'proposed', 'sent']);

    // Told proactively, in one plain sentence, through the existing notices.
    const told = (await notes(c.userId)).filter((n) => n.kind === 'offer');
    expect(told).toHaveLength(1);
    expect(told[0]!.text).toMatch(/^Demo Store’s agent offered to send a replacement .+, and nothing changes until you answer\.$/);

    // The buyer's agent reads the offer with the store agent's reasons before anything can be accepted.
    const heard = await conductor.handleTurn(c.userId, { action: 'offer' });
    expect(heard.say).toMatch(/^Demo Store’s agent offered to send a replacement sweater\. Its reasons: Demo Store's own shipping record shows the wrong size \(L\) went out\. The size tag reads L, and the order was for size M\. If you accept/);
    expect(heard.card).toMatchObject({ kind: 'offer', byAgent: true, reasons: offer.reasons });

    // The same trigger again does nothing.
    expect((await agent.runStoreAgent(c.caseId, { kind: 'case_received' }, { model })).kind).toBe('skipped');
    expect(await proposals(c.caseId)).toHaveLength(1);
  });

  it('after a decline, revises once inside the policy (releases the hold through PayPal), then hands over to staff', async () => {
    const c = await caseAtStore();
    const first = scripted(() => ({ option_id: 'replacement', reasons: [{ text: 'The size tag reads L.', facts: ['check-size'] }], staff_note: 'x' }));
    await agent.runStoreAgent(c.caseId, { kind: 'case_received' }, { model: first.model });
    await conductor.handleTurn(c.userId, { action: 'offer' });
    const open = await offers.findOpenOffer(c.userId);
    const declined = await conductor.handleTurn(c.userId, { action: 'offer-decline', offerId: open!.offer.id });
    expect(declined.say).toBe('Okay, I declined. Your case with Demo Store stays open, and they can make another offer.');
    expect((await kase(c.caseId)).stage).toBe('declined');

    const second = scripted((ids) => {
      expect(ids).not.toContain('replacement');
      return { option_id: 'refund', reasons: [{ text: "Demo Store's shipping record says it sent the wrong size (L).", facts: ['shipping'] }], staff_note: 'Release it.' };
    });
    const run = await agent.runStoreAgent(c.caseId, { kind: 'offer_declined', offerId: open!.offer.id }, { model: second.model });
    expect(run.kind).toBe('sent');
    expect(calls).toEqual([{ op: 'void', id: c.auth, requestId: expect.any(String), amount: undefined, finalCapture: undefined }]);
    const [o] = await rt.db().select().from(t.orders).where(eq(t.orders.id, c.orderId));
    expect(o!.status).toBe('voided');
    expect((await kase(c.caseId)).outcome).toMatchObject({ kind: 'voided', by: 'store_agent' });
    expect((await notes(c.userId)).some((n) => n.text === `Demo Store’s agent released your $${(c.amountCents / 100).toFixed(2)} payment hold, so you were never charged.`)).toBe(true);
    // The same decline again makes no second revision.
    expect((await agent.runStoreAgent(c.caseId, { kind: 'offer_declined', offerId: open!.offer.id }, { model: second.model })).kind).toBe('skipped');
  });

  it('hands the case to staff after a second declined offer, and never makes a third', async () => {
    const c = await caseAtStore();
    const pick = (id: string) => scripted(() => ({ option_id: id, reasons: [{ text: 'The size tag reads L.', facts: ['check-size'] }], staff_note: 'x' })).model;
    await agent.runStoreAgent(c.caseId, { kind: 'case_received' }, { model: pick('replacement') });
    let open = await offers.findOpenOffer(c.userId);
    await offers.answerOffer(c.userId, c.caseId, open!.offer.id, 'decline');
    await agent.runStoreAgent(c.caseId, { kind: 'offer_declined', offerId: open!.offer.id }, { model: pick('partial_20') });
    open = await offers.findOpenOffer(c.userId);
    expect(open!.offer.partial).toEqual({ percent: 20, held: true });
    await offers.answerOffer(c.userId, c.caseId, open!.offer.id, 'decline');
    const model = vi.fn(pick('refund'));
    const run = await agent.runStoreAgent(c.caseId, { kind: 'offer_declined', offerId: open!.offer.id }, { model });
    expect(run.kind).toBe('handed_over');
    expect(model).not.toHaveBeenCalled();
    expect(calls).toEqual([]);
    const list = await merchant.listMerchantCases(c.userId);
    const desk = list.find((x) => x.id === c.caseId)!;
    expect(desk.agent.handedOver).toBe('The revised offer was declined too, so the store agent handed the case to store staff.');
    expect(desk.agent.canAsk).toBe(false);
  });

  it('over the staff limit, waits on the desk; staff can Change it to keeping the item for less, and accepting captures only the rest', async () => {
    const c = await caseAtStore();
    await policy.saveStorePolicy(c.userId, { agentOn: true, autoSend: true, autoReplaceMaxCents: 6000, askStaffAboveCents: 1000, partialRefunds: 'up_to_50' });
    const { model } = scripted(() => ({ option_id: 'replacement', reasons: [{ text: 'The size tag reads L.', facts: ['check-size'] }], staff_note: 'x' }));
    const run = await agent.runStoreAgent(c.caseId, { kind: 'case_received' }, { model });
    expect(run.kind).toBe('waiting');
    expect(run.message).toBe('The order is over your $10.00 limit, so staff decide.');
    expect((await kase(c.caseId)).stage).toBe('seller_contacted');
    expect((await notes(c.userId)).filter((n) => n.kind === 'offer')).toEqual([]);

    const desk = (await merchant.listMerchantCases(c.userId)).find((x) => x.id === c.caseId)!;
    expect(desk.agent.pending).toMatchObject({ title: 'Offer a replacement', auto: false, source: 'model' });
    expect(desk.agent.choices.map((x) => x.id)).toEqual(['replacement', 'refund', 'return', 'partial_20', 'partial_50']);

    const half = Math.round(c.amountCents * 0.5);
    const sent = await agent.sendProposal(desk.agent.pending!.id, 'staff', { optionId: 'partial_50' });
    expect(sent.kind).toBe('sent');
    const open = await offers.findOpenOffer(c.userId);
    expect(open).toMatchObject({ amountCents: half, held: true, offer: { partial: { percent: 50 }, by: 'staff' } });

    const heard = await conductor.handleTurn(c.userId, { action: 'offer' });
    expect(heard.say).toContain(`offered to take $${(half / 100).toFixed(2)} off if you keep the sweater.`);
    expect(heard.say).not.toMatch(/refund/i);
    const accepted = await offers.answerOffer(c.userId, c.caseId, open!.offer.id, 'accept');
    expect(accepted.ok).toBe(true);
    expect(calls).toEqual([{ op: 'capture', id: c.auth, requestId: expect.any(String), amount: c.amountCents - half, finalCapture: true }]);
    const [o] = await rt.db().select().from(t.orders).where(eq(t.orders.id, c.orderId));
    expect(o).toMatchObject({ status: 'resolved_partial_refund', captureId: `CAP-${c.auth}` });
    expect((await kase(c.caseId)).outcome).toMatchObject({ kind: 'partial_refund', amountCents: half, via: 'capture' });

    // The timeline shows the PayPal capture with its id and status, and who decided each step.
    const steps2 = await timeline.orderTimeline(c.orderId, c.userId);
    const cap = steps2.find((s) => s.action === 'case.partial_refunded')!;
    expect(cap.paypal).toEqual({ label: 'Capture', id: `CAP-${c.auth}`, status: 'COMPLETED', source: 'answer' });
    expect(steps2.find((s) => s.action === 'store_agent.step' && s.what.startsWith('Proposed'))!.decided).toBe('model');
  });

  it('sets aside a model answer that invents facts or picks outside the policy, and the store rules decide', async () => {
    const c = await caseAtStore();
    const { model } = scripted(() => ({
      option_id: 'refund',
      reasons: [
        { text: 'A $50.00 store credit is added for the trouble.', facts: ['payment'] },
        { text: 'The tag reads XL.', facts: ['check-size'] },
      ],
      staff_note: 'Refund and add credit.',
    }));
    const run = await agent.runStoreAgent(c.caseId, { kind: 'case_received' }, { model });
    expect(run.source).toBe('rules');
    const [p] = await proposals(c.caseId);
    expect(p!.reasons.join(' ')).not.toMatch(/\$50|XL/);
    expect(p!.checkNotes.map((n) => n.why)).toContain('Claude’s answer was set aside (no reason held up against the facts), so the store rules decided.');
  });

  it('without a model key, the store rules decide and say so', async () => {
    const c = await caseAtStore({ shipped: 'correct', verdict: 'unsure' });
    const run = await agent.runStoreAgent(c.caseId, { kind: 'case_received' }, { model: null });
    expect(run).toMatchObject({ source: 'rules', title: 'Ask for the item back first' });
    const [p] = await proposals(c.caseId);
    expect(p!.checkNotes.at(-1)!.why).toBe('Claude is not connected on this server, so the store rules decided.');
  });

  it('stops and hands over when the evidence pack does not verify', async () => {
    const c = await caseAtStore();
    const k = await kase(c.caseId);
    await rt.db().update(t.evidencePacks).set({ manifestHash: 'f'.repeat(64) }).where(eq(t.evidencePacks.id, k.evidencePackId!));
    const model = vi.fn();
    const run = await agent.runStoreAgent(c.caseId, { kind: 'case_received' }, { model });
    expect(run.kind).toBe('handed_over');
    expect(model).not.toHaveBeenCalled();
    expect(calls).toEqual([]);
  });

  it('keeping it for less never moves money twice: a retry after a failure and a second accept are both safe', async () => {
    const c = await caseAtStore();
    await policy.saveStorePolicy(c.userId, { agentOn: true, autoSend: true, autoReplaceMaxCents: 6000, askStaffAboveCents: 10000, partialRefunds: 'up_to_20' });
    await agent.runStoreAgent(c.caseId, { kind: 'case_received' }, { model: scripted(() => ({ option_id: 'partial_20', reasons: [{ text: 'The size tag reads L.', facts: ['check-size'] }], staff_note: 'x' })).model });
    const open = await offers.findOpenOffer(c.userId);
    expect(open!.offer.partial).toEqual({ percent: 20, held: true });
    const part = Math.round(c.amountCents * 0.2);
    // PayPal answers the capture, then something fails before the case is closed.
    const failing = {
      ...payments,
      async captureAuthorization(id: string, i: { requestId: string; amount?: { cents: number }; finalCapture?: boolean }) {
        await payments.captureAuthorization(id, i);
        throw new Error('connection reset');
      },
    };
    expect(await offers.answerOffer(c.userId, c.caseId, open!.offer.id, 'accept', { payments: failing as never })).toEqual({ ok: false, reason: 'paypal-failed' });
    expect((await kase(c.caseId)).stage).toBe('offer_received');
    // The buyer tries again: the same capture is asked for (same request id), nothing is refunded.
    const [again, twice] = await Promise.all([
      offers.answerOffer(c.userId, c.caseId, open!.offer.id, 'accept'),
      offers.answerOffer(c.userId, c.caseId, open!.offer.id, 'accept'),
    ]);
    expect([again.ok, twice.ok].sort()).toEqual([false, true]);
    expect(calls.map((x) => x.op)).toEqual(['capture', 'capture']);
    expect(new Set(calls.map((x) => x.requestId)).size).toBe(1);
    expect(calls.every((x) => x.amount === c.amountCents - part && x.finalCapture)).toBe(true);
    expect((await kase(c.caseId)).stage).toBe('resolved');
  });

  it('a staff reply while the agent is reading wins, and the agent stops without proposing', async () => {
    const c = await caseAtStore();
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const slow = async () => {
      await gate;
      return { raw: { option_id: 'replacement', reasons: [{ text: 'The size tag reads L.', facts: ['check-size'] }], staff_note: 'x' }, model: 'scripted' };
    };
    const running = agent.runStoreAgent(c.caseId, { kind: 'case_received' }, { model: slow });
    await new Promise((r) => setTimeout(r, 150));
    const staff = await merchant.respondToCase(c.caseId, 'return');
    expect(staff.ok).toBe(true);
    release();
    const run = await running;
    expect(run).toMatchObject({ kind: 'skipped', message: 'Store staff replied while the agent was reading the case.' });
    const k = await kase(c.caseId);
    expect((k.offers as unknown[]).length).toBe(1);
    expect(k.stage).toBe('offer_received');
    expect((await proposals(c.caseId))[0]!.status).toBe('superseded');
  });

  it('the agent and staff sending at once: one reply goes out, the other is refused, nothing is reopened', async () => {
    const c = await caseAtStore();
    await policy.saveStorePolicy(c.userId, { agentOn: true, autoSend: false, autoReplaceMaxCents: 6000, askStaffAboveCents: 10000, partialRefunds: 'none' });
    await agent.runStoreAgent(c.caseId, { kind: 'case_received' }, { model: scripted(() => ({ option_id: 'replacement', reasons: [{ text: 'The size tag reads L.', facts: ['check-size'] }], staff_note: 'x' })).model });
    const [p] = await proposals(c.caseId);
    const [sent, refund] = await Promise.allSettled([agent.sendProposal(p!.id, 'staff'), merchant.respondToCase(c.caseId, 'refund')]);
    const k = await kase(c.caseId);
    const offersMade = (k.offers as unknown[]).length;
    // Either the refund closed the case first (no offer), or the offer went out and the refund then released the hold.
    expect(refund.status === 'fulfilled' && refund.value.ok).toBe(true);
    expect(k.stage).toBe('resolved');
    expect(offersMade).toBeLessThanOrEqual(1);
    expect(calls.filter((x) => x.op === 'void')).toHaveLength(1);
    if (sent.status === 'fulfilled' && sent.value.kind !== 'sent') expect(offersMade).toBe(0);
  });

  it('two triggers racing for the same round make one proposal', async () => {
    const c = await caseAtStore();
    const { model } = scripted(() => ({ option_id: 'replacement', reasons: [{ text: 'The size tag reads L.', facts: ['check-size'] }], staff_note: 'x' }));
    await policy.saveStorePolicy(c.userId, { agentOn: true, autoSend: false, autoReplaceMaxCents: 6000, askStaffAboveCents: 10000, partialRefunds: 'none' });
    const runs = await Promise.all([
      agent.runStoreAgent(c.caseId, { kind: 'case_received' }, { model }),
      agent.runStoreAgent(c.caseId, { kind: 'staff_asked' }, { model }),
    ]);
    expect(runs.map((r) => r.kind).sort()).toEqual(['skipped', 'waiting']);
    expect((await proposals(c.caseId)).filter((p) => p.round === 1)).toHaveLength(1);
  });

  it('staff can dismiss a proposal; their own reply supersedes any that waits', async () => {
    const c = await caseAtStore();
    await policy.saveStorePolicy(c.userId, { agentOn: true, autoSend: false, autoReplaceMaxCents: 6000, askStaffAboveCents: 10000, partialRefunds: 'none' });
    await agent.runStoreAgent(c.caseId, { kind: 'case_received' }, { model: null });
    const [p] = await proposals(c.caseId);
    expect(p!.status).toBe('proposed');
    expect((await agent.dismissProposal(p!.id)).message).toBe('Set aside. Nothing was sent. You can reply yourself below.');
    expect((await proposals(c.caseId))[0]!.status).toBe('dismissed');
    const r = await merchant.respondToCase(c.caseId, 'return');
    expect(r.ok).toBe(true);
  });
});
