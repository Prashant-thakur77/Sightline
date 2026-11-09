import 'server-only';
import { and, asc, eq } from 'drizzle-orm';
import { tables } from '@sightline/db';
import type { ProductSnapshot, Verdict } from '@sightline/core';
import { hashManifest, verifyHashSignature } from '@sightline/evidence';
import { caseFactsFor, storeOptions, type CaseFact, type CaseFacts, type Resolution, type StoreOption, type StorePolicy } from '@sightline/agent';
import { db } from './runtime';
import { receiptKeyPair } from './keys';
import { isHeld } from './after-check';
import { loadStorePolicy } from './store-policy';
import type { CaseOffer } from './merchant';

/*
 * A money-back case as the store's agent reads it: the signed evidence pack (checked first), the
 * order's payment state, the store's own shipping record, what the buyer already declined, and
 * the store's policy. Everything the agent may say comes from here; nothing comes from the model.
 */

export type CaseRow = typeof tables.cases.$inferSelect;
export type OrderRow = typeof tables.orders.$inferSelect;

/** Case stages in which the store still owes the buyer a reply. */
export const AWAITING_STORE = new Set(['seller_contacted', 'declined']);

export interface PackCheck {
  verified: boolean;
  verdict: Verdict | null;
  photos: number;
}

/** Recompute the pack's hash and check its Ed25519 signature, as the evidence page does. */
export async function readEvidencePack(packId: string | null): Promise<PackCheck> {
  if (!packId) return { verified: false, verdict: null, photos: 0 };
  const [pack] = await db().select().from(tables.evidencePacks).where(eq(tables.evidencePacks.id, packId)).limit(1);
  if (!pack) return { verified: false, verdict: null, photos: 0 };
  const { ed25519, ...manifest } = pack.manifest as Record<string, unknown> & { ed25519?: string };
  let verified: boolean;
  try {
    verified = hashManifest(manifest as never) === pack.manifestHash && Boolean(ed25519) && verifyHashSignature(pack.manifestHash, ed25519!, receiptKeyPair().publicKeyHex);
  } catch {
    verified = false;
  }
  const m = manifest as { verification?: Verdict | { kind: 'none' }; files?: unknown[] };
  const verdict = m.verification && 'reasons' in m.verification ? m.verification : null;
  return { verified, verdict, photos: Array.isArray(m.files) ? m.files.length : 0 };
}

/** The resolution an offer stood for, so a declined one is never offered again. */
export function offerResolution(o: Pick<CaseOffer, 'type' | 'partial'>): { resolution: Resolution; percent: number | null } {
  if (o.partial) return { resolution: 'partial_refund', percent: o.partial.percent };
  if (o.type === 'REFUND_WITH_RETURN') return { resolution: 'return', percent: null };
  if (o.type === 'REFUND') return { resolution: 'refund', percent: null };
  return { resolution: 'replacement', percent: null };
}

export interface StoreCase {
  kase: CaseRow;
  order: OrderRow;
  policy: StorePolicy;
  pack: PackCheck;
  facts: CaseFacts;
  options: StoreOption[];
  factList: CaseFact[];
}

/** Everything the store's agent knows about one case, for the given round. Null when the case or order is gone. */
export async function loadStoreCase(caseId: string, round: number, merchant = 'Demo Store'): Promise<StoreCase | null> {
  const [kase] = await db().select().from(tables.cases).where(eq(tables.cases.id, caseId)).limit(1);
  if (!kase) return null;
  const [order] = await db().select().from(tables.orders).where(eq(tables.orders.id, kase.orderId)).limit(1);
  if (!order) return null;
  const [policy, pack, [ship], [snap], declinedRows] = await Promise.all([
    loadStorePolicy(kase.userId),
    readEvidencePack(kase.evidencePackId),
    db().select().from(tables.shipments).where(eq(tables.shipments.orderId, order.id)).limit(1),
    db().select({ body: tables.productSnapshots.body }).from(tables.productSnapshots).where(eq(tables.productSnapshots.id, order.snapshotId)).limit(1),
    db()
      .select({ payload: tables.auditLog.payload })
      .from(tables.auditLog)
      .where(and(eq(tables.auditLog.subjectId, order.id), eq(tables.auditLog.action, 'case.offer_declined')))
      .orderBy(asc(tables.auditLog.seq)),
  ]);
  const offers = (kase.offers as CaseOffer[] | null) ?? [];
  const declined = declinedRows
    .map((r) => r.payload as { caseId?: string; offerId?: string })
    .filter((p) => p.caseId === kase.id)
    .map((p) => offers.find((o) => o.id === p.offerId))
    .filter((o): o is CaseOffer => Boolean(o))
    .map(offerResolution);
  const attrs = (snap?.body as ProductSnapshot | undefined)?.attributes;
  const facts: CaseFacts = {
    merchant,
    item: order.title,
    colour: attrs?.colour ?? null,
    size: attrs?.size ?? null,
    amount: { cents: order.amountCents, currency: order.currency },
    payment: isHeld(order) ? 'held' : order.captureId ? 'captured' : 'none',
    dispute: Boolean(kase.paypalDisputeId),
    reason: kase.reason,
    verdict: pack.verdict,
    shippedVariant: ship?.shippedVariant && ship.status !== 'awaiting_shipment' ? ship.shippedVariant : null,
    evidenceVerified: pack.verified,
    photos: pack.photos,
    dueAt: kase.dueAt,
    declined,
    round,
  };
  const options = storeOptions(facts, policy);
  return { kase, order, policy, pack, facts, options, factList: caseFactsFor(facts, policy, options) };
}
