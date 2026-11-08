import 'server-only';
import { and, desc, eq } from 'drizzle-orm';
import { tables } from '@sightline/db';
import { addBusinessDays, formatMoney, newId, type OrderStatus, type Readback, type Verdict } from '@sightline/core';
import { buildManifest, paypalRequestId, signHash, type EvidenceManifest } from '@sightline/evidence';
import { db } from './runtime';
import { getBlob } from './blobs';
import { receiptKeyPair } from './keys';
import { paypal } from './paypal';
import { dbReservations } from './gate-ports';
import { audit } from './audit';
import { writeCaseNarrative } from './ai';
import { extractTokens } from '@sightline/agent';
import { isHeld } from './after-check';

export type CaseReasonCode = 'wrong_colour' | 'wrong_size' | 'wrong_item' | 'damaged' | 'not_received';

function reasonFromVerdict(v: Verdict | null): CaseReasonCode {
  if (!v) return 'not_received';
  const bad = v.reasons.filter((r) => r.finding === 'disagree');
  if (bad.some((r) => r.module === 'damage')) return 'damaged';
  if (bad.some((r) => r.module === 'size')) return 'wrong_size';
  if (bad.some((r) => r.module === 'colour')) return 'wrong_colour';
  return 'wrong_item';
}

/** Template narrative used when no model is available, and as the facts given to the model. */
function templateNarrative(title: string, v: Verdict | null, amount: string): { summary: string; seller: string } {
  const findings = (v?.reasons ?? []).filter((r) => r.finding === 'disagree').map((r) => r.sentence);
  const what = findings.length ? findings.join(' ') : 'The item that arrived does not look like the listing.';
  const sure = v?.kind === 'mismatch';
  return {
    summary: sure
      ? `The ${title} that arrived does not match what you ordered. ${what} I'll ask Demo Store for your ${amount} back.`
      : `The ${title} that arrived may not be what you ordered. ${what} I'll ask Demo Store to look at the evidence and refund your ${amount} if it's wrong.`,
    seller: sure
      ? `Hello. The ${title} delivered for this order does not match the listing the buyer paid for. ${what} The buyer checked the parcel with photos and a size-tag reading, and the evidence pack is attached with its signature. Please refund ${amount}; the buyer can return the item.`
      : `Hello. The buyer of this ${title} is not sure the delivered item matches the listing. ${what} The photos and the check are attached with a signature. Please look at the evidence and let the buyer know; if it is the wrong item, please refund ${amount}.`,
  };
}

function narrativeGrounded(text: string, f: { amountCents: number; verdict: Verdict; snapshot: { attributes?: Record<string, string | undefined> } | undefined }): boolean {
  const allowed = new Set<string>();
  allowed.add(`USD ${f.amountCents}`);
  for (const v of [f.snapshot?.attributes?.colour, f.snapshot?.attributes?.size, ...f.verdict.reasons.flatMap((r) => [r.expected, r.observed])])
    if (v) for (const t of extractTokens(v)) allowed.add(`${t.kind}:${t.value}`);
  for (const t of extractTokens(text)) {
    if (t.kind === 'money' && !allowed.has(t.value)) return false;
    if ((t.kind === 'size' || t.kind === 'colour' || t.kind === 'date') && !allowed.has(`${t.kind}:${t.value}`)) return false;
  }
  return true;
}

export interface MoneyBackPreview {
  caseId: string;
  evidencePackId: string;
  summary: string;
  path: 'void' | 'refund-request';
  amount: string;
}

/**
 * Build the evidence pack and a draft case, but send nothing. The buyer hears the summary and
 * confirms first.
 */
export async function prepareMoneyBack(userId: string, orderId: string): Promise<MoneyBackPreview> {
  const [o] = await db()
    .select()
    .from(tables.orders)
    .where(and(eq(tables.orders.id, orderId), eq(tables.orders.userId, userId)))
    .limit(1);
  if (!o) throw new Error('Order not found');
  const [existing] = await db().select().from(tables.cases).where(eq(tables.cases.orderId, orderId)).orderBy(desc(tables.cases.createdAt)).limit(1);
  const amount = formatMoney({ cents: o.amountCents, currency: o.currency });
  if (existing && existing.stage !== 'draft') {
    return { caseId: existing.id, evidencePackId: existing.evidencePackId ?? '', summary: 'This case is already open.', path: isHeld(o) ? 'void' : 'refund-request', amount };
  }
  const [snapRow] = await db().select().from(tables.productSnapshots).where(eq(tables.productSnapshots.id, o.snapshotId)).limit(1);
  const [rb] = await db().select().from(tables.readbacks).where(eq(tables.readbacks.id, o.readbackId)).limit(1);
  const [ver] = await db().select().from(tables.verifications).where(eq(tables.verifications.orderId, orderId)).orderBy(desc(tables.verifications.createdAt)).limit(1);
  const verdict = (ver?.verdict ?? null) as Verdict | null;
  if (!verdict || verdict.kind === 'match')
    throw new Error('Money back needs a check that says the item does not match, or is not sure. Check the parcel first.');
  const tpl = templateNarrative(o.title, verdict, amount);
  let narrative = tpl;
  const ai = await writeCaseNarrative({ item: o.title, amount, findings: verdict?.reasons, merchant: 'Demo Store' }).catch(() => null);
  // The model's text may only use facts we hold: every amount, size and colour it mentions must
  // appear in the facts; otherwise the template text is used instead.
  if (ai && narrativeGrounded(`${ai.summary_for_buyer} ${ai.message_to_seller}`, { amountCents: o.amountCents, verdict, snapshot: snapRow?.body as never })) {
    narrative = { summary: ai.summary_for_buyer, seller: ai.message_to_seller };
  }

  const photos = [];
  for (const p of ver?.photos ?? []) {
    const b = await getBlob(p.blobId);
    if (b) photos.push({ name: `${p.kind}.jpg`, mime: b.mime, takenAt: ver!.createdAt, bytes: new Uint8Array(b.bytes) });
  }
  const readback: Readback = {
    id: rb!.id,
    cartId: rb!.cartId,
    cartHash: rb!.cartHash,
    text: rb!.text,
    fields: rb!.fields as Readback['fields'],
    textHash: rb!.textHash,
    createdAt: rb!.createdAt,
  };
  const built = buildManifest<Verdict | { kind: 'none' }>({
    order: {
      id: o.id,
      paypalOrderId: o.paypalOrderId ?? undefined,
      captureId: o.captureId ?? undefined,
      status: o.status as OrderStatus,
      amount: { cents: o.amountCents, currency: o.currency },
      payee: { merchantId: o.merchantId, name: 'Demo Store' },
      placedAt: o.createdAt,
      requestId: o.paypalRequestId,
    },
    readback,
    snapshot: snapRow!.body as never,
    photos,
    verification: verdict ?? { kind: 'none' },
    narrative: narrative.seller,
    createdAt: new Date().toISOString(),
  });
  const evidencePackId = newId('evp');
  await db()
    .insert(tables.evidencePacks)
    .values({
      id: evidencePackId,
      orderId,
      verificationId: ver?.id ?? null,
      manifest: { ...(built.manifest as unknown as Record<string, unknown>), ed25519: signHash(built.manifestHash, receiptKeyPair()) },
      manifestHash: built.manifestHash,
      narrative: narrative.summary,
    });
  const caseId = existing?.id ?? newId('cas');
  if (!existing)
    await db()
      .insert(tables.cases)
      .values({
        id: caseId,
        orderId,
        userId,
        kind: isHeld(o) ? 'void' : 'inquiry',
        stage: 'evidence_built',
        status: 'draft',
        reason: reasonFromVerdict(verdict),
        evidencePackId,
      });
  else await db().update(tables.cases).set({ stage: 'evidence_built', evidencePackId, updatedAt: new Date().toISOString() }).where(eq(tables.cases.id, caseId));
  await audit({ userId, actor: 'agent', action: 'evidence.built', subjectId: orderId, payload: { evidencePackId, manifestHash: built.manifestHash } });
  return { caseId, evidencePackId, summary: narrative.summary, path: isHeld(o) ? 'void' : 'refund-request', amount };
}

export interface MoneyBackResult {
  say: string;
  stage: string;
}

/** After the buyer confirms: void the hold, or send the case to the seller. */
export async function sendMoneyBack(userId: string, caseId: string): Promise<MoneyBackResult> {
  const [c] = await db()
    .select()
    .from(tables.cases)
    .where(and(eq(tables.cases.id, caseId), eq(tables.cases.userId, userId)))
    .limit(1);
  if (!c) throw new Error('Case not found');
  const [o] = await db().select().from(tables.orders).where(eq(tables.orders.id, c.orderId)).limit(1);
  const amount = formatMoney({ cents: o!.amountCents, currency: o!.currency });
  const now = new Date();

  if (isHeld(o!)) {
    await paypal().payments.voidAuthorization(o!.authorizationId!, { requestId: paypalRequestId('void', o!.authorizationId!) });
    await db().update(tables.orders).set({ status: 'voided', updatedAt: now.toISOString() }).where(eq(tables.orders.id, o!.id));
    await db()
      .update(tables.cases)
      .set({ stage: 'resolved', status: 'resolved', outcome: { kind: 'voided', amount: o!.amountCents }, updatedAt: now.toISOString() })
      .where(eq(tables.cases.id, c.id));
    const [rsv] = await db().select().from(tables.reservations).where(eq(tables.reservations.key, o!.paypalRequestId)).limit(1);
    if (rsv && rsv.status === 'reserved') await dbReservations.release(rsv.id, 'voided_after_check', now);
    await audit({ userId, actor: 'paypal', action: 'payment.voided_after_check', subjectId: o!.id, payload: { caseId: c.id } });
    await notify(userId, 'case', `Payment hold cancelled. Demo Store was never paid. ${amount} is released back to you.`, `/app/orders/${o!.id}`);
    return {
      stage: 'resolved',
      say: `Done. I cancelled the payment hold with PayPal. Demo Store was never paid, and your ${amount} is released. I've told Demo Store, so they can arrange to collect the item.`,
    };
  }

  const due = addBusinessDays(now, 3);
  await db()
    .update(tables.cases)
    .set({ stage: 'seller_contacted', status: 'open', dueAt: due.toISOString(), updatedAt: now.toISOString() })
    .where(eq(tables.cases.id, c.id));
  await db().update(tables.orders).set({ status: 'case_open', updatedAt: now.toISOString() }).where(eq(tables.orders.id, o!.id));
  await audit({ userId, actor: 'user', action: 'case.sent_to_seller', subjectId: o!.id, payload: { caseId: c.id, dueAt: due.toISOString() } });
  return {
    stage: 'seller_contacted',
    say: `I sent your case to Demo Store with the evidence. They have until ${new Intl.DateTimeFormat('en-US', { weekday: 'long', timeZone: 'UTC' }).format(due)} to reply. If they don't, I'll ask PayPal to step in. I'll tell you as soon as anything changes.`,
  };
}

export async function notify(userId: string, kind: string, text: string, link?: string) {
  await db().insert(tables.notifications).values({ id: newId('ntf'), userId, kind, text, link: link ?? null });
}

export type { EvidenceManifest };
