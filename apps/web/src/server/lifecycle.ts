import 'server-only';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { and, desc, eq } from 'drizzle-orm';
import { tables } from '@sightline/db';
import { newId } from '@sightline/core';
import { handleTurn } from './conductor';
import { db } from './runtime';
import { verifyDelivery } from './vision';
import { putBlob } from './blobs';
import { afterVerdict } from './after-check';
import { prepareMoneyBack, sendMoneyBack, notify } from './cases';
import { deliveredNotice, respondToCase } from './merchant';
import { runStoreAgent, sendProposal } from './store-agent';
import { findOpenOffer } from './offers';
import { audit } from './audit';

export interface StepEvent {
  step: number;
  title: string;
  status: 'running' | 'done' | 'failed' | 'skipped';
  /** What a screen reader would announce at this point. */
  spoken?: string;
  detail?: string;
  link?: string;
}

/**
 * The scripted run's shoppers share this address pattern; the judge page shows the newest run's order
 * to visitors without one. Each run gets its own shopper, so the payment gate's per-shopper limits
 * (for example at most 5 orders an hour) apply to every run in full and never stop the next judge.
 */
export const JUDGE_EMAIL_PATTERN = 'maya.run%@demo.sightline.app';

/** The run's shopper has the sandbox demo buyer's saved PayPal once DEMO_VAULT_ID is set. */
async function ensureDemoVault(userId: string): Promise<void> {
  const vaultId = process.env.DEMO_VAULT_ID?.trim();
  if (!vaultId) return;
  const [has] = await db()
    .select({ id: tables.vaultTokens.id })
    .from(tables.vaultTokens)
    .where(and(eq(tables.vaultTokens.userId, userId), eq(tables.vaultTokens.status, 'ACTIVE')))
    .limit(1);
  if (!has) await db().insert(tables.vaultTokens).values({ id: newId('vlt'), userId, vaultId, status: 'ACTIVE', label: 'your saved PayPal (sandbox demo buyer)' });
}

/** A fresh shopper for this run: Maya's preferences, a verified helper and the saved sandbox PayPal. */
async function judgeUser(): Promise<string> {
  const id = newId('usr');
  await db().insert(tables.users).values({ id, email: `maya.run+${id.slice(-10)}@demo.sightline.app`, displayName: 'Maya', isDemo: true });
  await db().insert(tables.preferences).values({ userId: id, verbosity: 'standard', sizes: { tops: 'M' }, payAfterCheck: true, onboardedAt: new Date().toISOString() });
  await db().insert(tables.helpers).values({ id: newId('hlp'), userId: id, name: 'Asha', contact: 'asha@demo.sightline.app', verifiedAt: new Date().toISOString() });
  await ensureDemoVault(id);
  return id;
}

/**
 * The whole lifecycle in about two minutes, against the real sandbox: shop, read back, confirm with
 * two keys, PayPal hold, wrong item shipped, camera check, money back, then the store's agent
 * answering the case and Maya's agent answering the store's offer.
 */
export async function* runLifecycle(): AsyncGenerator<StepEvent> {
  const userId = await judgeUser();
  // Fresh conversation for each run.
  await db().delete(tables.conversations).where(eq(tables.conversations.userId, userId));

  yield { step: 1, title: 'Maya asks by voice', status: 'running' };
  const search = await handleTurn(userId, { text: 'I need a navy crew-neck sweater, medium, under forty dollars', source: 'voice' });
  yield { step: 1, title: 'Maya asks by voice', status: search.card?.kind === 'options' ? 'done' : 'failed', spoken: search.say };
  if (search.card?.kind !== 'options') return;

  yield { step: 2, title: 'She picks one and hears the readback', status: 'running' };
  const rb = await handleTurn(userId, { action: 'buy', index: 1 });
  yield { step: 2, title: 'She picks one and hears the readback', status: rb.card?.kind === 'readback' ? 'done' : 'failed', spoken: rb.say };
  if (rb.card?.kind !== 'readback') return;

  yield { step: 3, title: 'She confirms twice: her words, then an independent check', status: 'running' };
  let paid = await handleTurn(userId, { text: 'confirm purchase', source: 'voice' });
  // Without the model classifier, two separate Confirm presses stand in for key 2.
  for (let i = 0; i < 3 && paid.card?.kind === 'readback'; i++) {
    yield { step: 3, title: 'She confirms twice: her words, then an independent check', status: 'running', spoken: paid.say };
    await new Promise((r) => setTimeout(r, 800));
    paid = await handleTurn(userId, { action: 'confirm-button', readbackId: paid.card.readbackId });
  }
  if (paid.card?.kind === 'paypal') {
    yield {
      step: 3,
      title: 'She confirms twice: her words, then an independent check',
      status: 'failed',
      spoken: paid.say,
      detail: 'This demo account has no saved PayPal yet, so PayPal asks the buyer to log in once. Shop as Maya to approve once, then run this again.',
    };
    return;
  }
  const paidOk = paid.card?.kind === 'paid';
  yield {
    step: 3,
    title: 'She confirms twice: her words, then an independent check',
    status: paidOk ? 'done' : 'failed',
    spoken: paid.say,
    link: paid.card?.kind === 'paid' && paid.card.receiptId ? `/receipts/${paid.card.receiptId}` : undefined,
  };
  if (paid.card?.kind !== 'paid') return;
  const orderId = paid.card.orderId;

  yield { step: 4, title: 'Demo Store ships the wrong size (demo control)', status: 'running' };
  await db()
    .insert(tables.shipments)
    .values({ orderId, carrier: 'USPS', trackingNumber: `9400${Date.now()}`.slice(0, 22), status: 'delivered', shippedVariant: 'wrong_size', shippedAt: new Date().toISOString(), deliveredAt: new Date().toISOString() })
    .onConflictDoUpdate({
      target: tables.shipments.orderId,
      set: { carrier: 'USPS', status: 'delivered', shippedVariant: 'wrong_size', shippedAt: new Date().toISOString(), deliveredAt: new Date().toISOString() },
    });
  await db().update(tables.orders).set({ status: 'delivered', updatedAt: new Date().toISOString() }).where(eq(tables.orders.id, orderId));
  await audit({ userId, actor: 'merchant', action: 'shipment.delivered', subjectId: orderId, payload: { demoControl: 'wrong_size' } });
  const [shippedOrder] = await db().select().from(tables.orders).where(eq(tables.orders.id, orderId)).limit(1);
  const deliveredSay = deliveredNotice(shippedOrder!);
  await notify(userId, 'delivery', deliveredSay, `/app/check/${orderId}`);
  yield { step: 4, title: 'Demo Store ships the wrong size (demo control)', status: 'done', spoken: deliveredSay };

  yield { step: 5, title: 'She checks the parcel with her camera', status: 'running', detail: 'Using the demo parcel photos: a black sweater with a size L tag.' };
  const [order] = await db().select().from(tables.orders).where(eq(tables.orders.id, orderId)).limit(1);
  const [snap] = await db().select().from(tables.productSnapshots).where(eq(tables.productSnapshots.id, order!.snapshotId)).limit(1);
  const dir = path.join(process.cwd(), 'public', 'demo-parcel');
  const photos = [
    { kind: 'item' as const, bytes: await readFile(path.join(dir, 'wrong-item.jpg')) },
    { kind: 'label' as const, bytes: await readFile(path.join(dir, 'wrong-tag.jpg')) },
  ];

  try {
    const result = await verifyDelivery({ snapshot: snap!.body as never, photos });
    const stored = [];
    for (const p of photos) {
      const b = await putBlob(p.bytes, 'image/jpeg', userId);
      stored.push({ kind: p.kind, blobId: b.id, sha256: b.sha256 });
    }
    const verificationId = newId('ver');
    await db()
      .insert(tables.verifications)
      .values({ id: verificationId, orderId, status: result.verdict.kind, photos: stored, verdict: result.verdict, moduleOutputs: { modules: result.modules, timings_ms: result.timings_ms } });
    const next = await afterVerdict({ userId, orderId, verificationId, verdict: result.verdict });

    yield { step: 5, title: 'She checks the parcel with her camera', status: 'done', spoken: next.say };
    if (result.verdict.kind !== 'mismatch') {
      yield { step: 6, title: 'Money back', status: 'skipped', detail: 'The check was not sure, so nothing is sent; she can ask her helper or try again in daylight.' };
      return;
    }
  } catch (e) {
    yield { step: 5, title: 'She checks the parcel with her camera', status: 'failed', detail: `The vision service is not reachable: ${(e as Error).message}` };
    return;
  }

  yield { step: 6, title: '“Get my money back”', status: 'running' };
  const preview = await prepareMoneyBack(userId, orderId);
  yield { step: 6, title: '“Get my money back”', status: 'running', spoken: preview.summary, link: `/evidence/${preview.evidencePackId}` };
  try {
    const sent = await sendMoneyBack(userId, preview.caseId);
    yield { step: 6, title: '“Get my money back”', status: 'done', spoken: sent.say, link: `/evidence/${preview.evidencePackId}` };
  } catch (e) {
    yield { step: 6, title: '“Get my money back”', status: 'failed', detail: (e as Error).message };
    return;
  }
  const [kase] = await db().select().from(tables.cases).where(and(eq(tables.cases.orderId, orderId), eq(tables.cases.userId, userId))).orderBy(desc(tables.cases.createdAt)).limit(1);
  if (!kase) {
    yield { step: 7, title: 'Demo Store’s agent reads the case', status: 'failed', detail: 'No case was found for this order.' };
    return;
  }
  // The store's agent answers, inside the store's policy; Maya's agent reads her the offer and its
  // reasons; she declines once (she wants her money back), and the store's agent revises once.
  let n = 7;
  for (let round = 1; round <= 2; round++) {
    const title = round === 1 ? 'Demo Store’s agent reads the signed evidence and answers' : 'Demo Store’s agent revises its offer, once';
    yield { step: n, title, status: 'running' };
    const [current] = await db().select().from(tables.cases).where(eq(tables.cases.id, kase.id)).limit(1);
    const lastOffer = ((current?.offers as { id: string }[] | null) ?? []).at(-1);
    const run = await runStoreAgent(kase.id, round === 1 || !lastOffer ? { kind: 'case_received' } : { kind: 'offer_declined', offerId: lastOffer.id });
    if (run.kind === 'sent' || run.kind === 'waiting') {
      const who = run.source === 'model' ? 'Claude chose among the replies the store policy allows' : 'The store rules chose (Claude is not connected here)';
      yield {
        step: n,
        title,
        status: 'done',
        detail: `${who}: ${run.title}. ${(run.reasons ?? []).join(' ')} ${run.kind === 'sent' ? 'Inside the store policy, so it was sent at once.' : `It waits for staff: ${run.message}`}`,
      };
      n++;
      if (run.kind === 'waiting' && run.proposalId) {
        yield { step: n, title: 'Store staff approve the proposal (demo control)', status: 'running' };
        const sent = await sendProposal(run.proposalId, 'staff');
        yield { step: n, title: 'Store staff approve the proposal (demo control)', status: sent.kind === 'sent' ? 'done' : 'failed', detail: sent.message };
        n++;
        if (sent.kind !== 'sent') return;
      }
    } else {
      // The agent stopped (no key needed for this, so only a broken pack or no allowed reply): staff answer instead.
      yield { step: n, title, status: 'skipped', detail: run.message };
      n++;
      yield { step: n, title: 'Demo Store accepts the return (demo control)', status: 'running' };
      const reply = await respondToCase(kase.id, 'refund');
      yield { step: n, title: 'Demo Store accepts the return (demo control)', status: reply.ok ? 'done' : 'failed', detail: reply.message };
      n++;
      break;
    }
    const open = await findOpenOffer(userId);
    if (!open || open.caseId !== kase.id) break;
    const answer = round === 1 ? 'decline' : 'accept';
    const answerTitle = round === 1 ? 'Maya hears the offer and its reasons, and declines: she wants her money back' : 'Maya hears the new offer and accepts it, with two presses';
    yield { step: n, title: answerTitle, status: 'running' };
    const heard = await handleTurn(userId, { action: 'offer' });
    yield { step: n, title: answerTitle, status: 'running', spoken: heard.say };
    let answered = await handleTurn(userId, { action: answer === 'decline' ? 'offer-decline' : 'offer-accept', offerId: open.offer.id });
    if (answer === 'accept') {
      await new Promise((r) => setTimeout(r, 650));
      answered = await handleTurn(userId, { action: 'offer-accept', offerId: open.offer.id });
    }
    yield { step: n, title: answerTitle, status: 'done', spoken: answered.say };
    n++;
    if (answer === 'accept') break;
  }
  const [o] = await db().select().from(tables.orders).where(eq(tables.orders.id, orderId)).limit(1);
  yield {
    step: n,
    title: 'Done',
    status: 'done',
    detail:
      o?.status === 'voided'
        ? 'PayPal cancelled the hold. Demo Store was never paid, and Maya was never charged.'
        : o?.status === 'resolved_partial_refund'
          ? 'Maya kept the item for less: PayPal took only the agreed part of the hold and released the rest.'
          : o?.status === 'resolved_replacement'
            ? 'Maya accepted a replacement. The hold stays until a week after the agreement, then Demo Store is paid.'
            : o?.status === 'resolved_refund'
              ? 'Demo Store refunded the payment through PayPal.'
              : 'The case is with Demo Store.',
  };
}
