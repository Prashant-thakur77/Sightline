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
import { respondToCase } from './merchant';
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

const JUDGE_EMAIL = 'maya.run@demo.sightline.app';

async function judgeUser(): Promise<string> {
  const [u] = await db().select({ id: tables.users.id }).from(tables.users).where(eq(tables.users.email, JUDGE_EMAIL)).limit(1);
  if (u) return u.id;
  const id = newId('usr');
  await db().insert(tables.users).values({ id, email: JUDGE_EMAIL, displayName: 'Maya', isDemo: true });
  await db().insert(tables.preferences).values({ userId: id, verbosity: 'standard', sizes: { tops: 'M' }, payAfterCheck: true, onboardedAt: new Date().toISOString() });
  await db().insert(tables.helpers).values({ id: newId('hlp'), userId: id, name: 'Asha', contact: 'asha@demo.sightline.app', verifiedAt: new Date().toISOString() });
  if (process.env.DEMO_VAULT_ID)
    await db().insert(tables.vaultTokens).values({ id: newId('vlt'), userId: id, vaultId: process.env.DEMO_VAULT_ID, status: 'ACTIVE', label: 'your saved PayPal (sandbox demo buyer)' });
  return id;
}

/**
 * The whole lifecycle in about ninety seconds, against the real sandbox: shop, read back,
 * confirm with two keys, PayPal hold, wrong item shipped, camera check, money back.
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
  await notify(userId, 'delivery', 'Your parcel from Demo Store was delivered. Want to check it now?', `/app/check/${orderId}`);
  yield { step: 4, title: 'Demo Store ships the wrong size (demo control)', status: 'done', spoken: 'Your parcel from Demo Store was delivered. Want to check it now?' };

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
  // The store sees the evidence and accepts the return; for a held payment that voids the hold.
  yield { step: 7, title: 'Demo Store accepts the return (demo control)', status: 'running' };
  const reply = kase ? await respondToCase(kase.id, 'refund') : null;
  if (!reply?.ok) {
    yield { step: 7, title: 'Demo Store accepts the return (demo control)', status: 'failed', detail: reply?.message ?? 'No case was found for this order.' };
    return;
  }
  yield { step: 7, title: 'Demo Store accepts the return (demo control)', status: 'done', detail: reply.message };
  const [o] = await db().select().from(tables.orders).where(eq(tables.orders.id, orderId)).limit(1);
  yield {
    step: 8,
    title: 'Done',
    status: 'done',
    detail: o?.status === 'voided' ? 'PayPal cancelled the hold. Demo Store was never paid, and Maya was never charged.' : 'Demo Store refunded the payment through PayPal.',
  };
}
