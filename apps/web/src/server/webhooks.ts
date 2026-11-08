import 'server-only';
import { and, eq, isNull, lt, or } from 'drizzle-orm';
import { tables } from '@sightline/db';
import { formatMoney, newId } from '@sightline/core';
import { parseWebhookEvent } from '@sightline/paypal';
import { db } from './runtime';
import { audit } from './audit';
import { notify } from './cases';

type Resource = Record<string, unknown> & {
  id?: string;
  status?: string;
  amount?: { value?: string; currency_code?: string };
  supplementary_data?: { related_ids?: { order_id?: string; capture_id?: string; authorization_id?: string } };
  disputed_transactions?: { seller_transaction_id?: string }[];
  dispute_id?: string;
  dispute_life_cycle_stage?: string;
  outcome?: { outcome_code?: string };
};

async function orderByPayPal(r: Resource) {
  const rel = r.supplementary_data?.related_ids ?? {};
  const keys = [rel.order_id, rel.capture_id, rel.authorization_id, r.id].filter(Boolean) as string[];
  for (const k of keys) {
    const [o] = await db()
      .select()
      .from(tables.orders)
      .where(or(eq(tables.orders.paypalOrderId, k), eq(tables.orders.captureId, k), eq(tables.orders.authorizationId, k)))
      .limit(1);
    if (o) return o;
  }
  return null;
}

/** Apply one verified, de-duplicated event. Safe to run more than once for the same event. */
export async function processWebhookEvent(eventRowId: string): Promise<void> {
  const [row] = await db().select().from(tables.webhookEvents).where(eq(tables.webhookEvents.id, eventRowId)).limit(1);
  if (!row || row.processedAt || !row.signatureOk) return;
  try {
    const ev = parseWebhookEvent(row.raw).event;
    const r = (ev.resource ?? {}) as Resource;
    const now = new Date().toISOString();
    const order = await orderByPayPal(r);
    switch (ev.event_type) {
      case 'PAYMENT.CAPTURE.COMPLETED':
        if (order && ['approval_pending', 'confirmed', 'authorized'].includes(order.status))
          await db().update(tables.orders).set({ status: order.status === 'authorized' ? 'verified_match' : 'captured', captureId: order.captureId ?? r.id ?? null, updatedAt: now }).where(eq(tables.orders.id, order.id));
        break;
      case 'PAYMENT.CAPTURE.REFUNDED':
        if (order) {
          await db().update(tables.orders).set({ status: 'resolved_refund', updatedAt: now }).where(eq(tables.orders.id, order.id));
          const amt = r.amount?.value ? formatMoney({ cents: Math.round(Number(r.amount.value) * 100), currency: r.amount.currency_code ?? 'USD' }) : 'Your money';
          await notify(order.userId, 'refund', `PayPal refunded ${amt}. It should reach your PayPal balance within minutes.`, `/app/orders/${order.id}`);
        }
        break;
      case 'PAYMENT.CAPTURE.REVERSED':
        if (order) await db().update(tables.orders).set({ status: 'resolved_refund', updatedAt: now }).where(eq(tables.orders.id, order.id));
        break;
      case 'PAYMENT.AUTHORIZATION.VOIDED':
        if (order && order.status !== 'voided') await db().update(tables.orders).set({ status: 'voided', updatedAt: now }).where(eq(tables.orders.id, order.id));
        break;
      case 'CUSTOMER.DISPUTE.CREATED':
      case 'CUSTOMER.DISPUTE.UPDATED':
      case 'CUSTOMER.DISPUTE.RESOLVED': {
        const disputeId = r.dispute_id ?? r.id;
        if (!disputeId) break;
        const [kase] = await db().select().from(tables.cases).where(eq(tables.cases.paypalDisputeId, disputeId)).limit(1);
        let target = kase;
        if (!target) {
          const txn = r.disputed_transactions?.[0]?.seller_transaction_id;
          const [o] = txn ? await db().select().from(tables.orders).where(eq(tables.orders.captureId, txn)).limit(1) : [];
          const [c] = o ? await db().select().from(tables.cases).where(eq(tables.cases.orderId, o.id)).limit(1) : [];
          if (c) {
            await db().update(tables.cases).set({ paypalDisputeId: disputeId }).where(eq(tables.cases.id, c.id));
            target = { ...c, paypalDisputeId: disputeId };
          }
        }
        if (target) {
          const resolved = ev.event_type === 'CUSTOMER.DISPUTE.RESOLVED';
          await db()
            .update(tables.cases)
            .set({
              stage: resolved ? 'resolved' : r.dispute_life_cycle_stage === 'CLAIM' ? 'escalated' : target.stage,
              status: resolved ? 'resolved' : (r.status ?? target.status),
              outcome: resolved ? (r.outcome ?? null) : target.outcome,
              updatedAt: now,
            })
            .where(eq(tables.cases.id, target.id));
          await notify(
            target.userId,
            'case',
            resolved
              ? r.outcome?.outcome_code === 'RESOLVED_BUYER_FAVOUR'
                ? 'PayPal decided in your favour. Your refund is on its way.'
                : 'PayPal closed your case. Open the order to hear the outcome.'
              : 'There is an update on your PayPal case.',
            `/app/orders/${target.orderId}`,
          );
        }
        break;
      }
      case 'VAULT.PAYMENT-TOKEN.DELETED':
        if (r.id) await db().update(tables.vaultTokens).set({ status: 'DELETED' }).where(eq(tables.vaultTokens.vaultId, r.id));
        break;
      default:
        break;
    }
    await db().update(tables.webhookEvents).set({ processedAt: now, attempts: row.attempts + 1, lastError: null }).where(eq(tables.webhookEvents.id, row.id));
    await audit({ actor: 'paypal', action: `webhook.${ev.event_type.toLowerCase()}`, subjectId: order?.id ?? null, userId: order?.userId ?? null, payload: { eventId: ev.id } });
  } catch (e) {
    await db().update(tables.webhookEvents).set({ attempts: row.attempts + 1, lastError: (e as Error).message.slice(0, 500) }).where(eq(tables.webhookEvents.id, row.id));
    throw e;
  }
}

export async function recordWebhook(raw: string, signatureOk: boolean): Promise<{ id: string; duplicate: boolean }> {
  const ev = parseWebhookEvent(raw).event;
  const id = newId('whe');
  const inserted = await db()
    .insert(tables.webhookEvents)
    .values({ id, paypalEventId: ev.id, type: ev.event_type, raw, signatureOk })
    .onConflictDoNothing()
    .returning({ id: tables.webhookEvents.id });
  if (inserted.length === 0) {
    const [existing] = await db().select({ id: tables.webhookEvents.id }).from(tables.webhookEvents).where(eq(tables.webhookEvents.paypalEventId, ev.id)).limit(1);
    return { id: existing!.id, duplicate: true };
  }
  return { id, duplicate: false };
}

/**
 * Retry events that failed processing, with backoff by attempt count, giving up (dead letter)
 * after 8 attempts. Runs opportunistically after each new webhook and on demand.
 */
export async function retryFailedWebhooks(limit = 5): Promise<number> {
  const rows = await db()
    .select()
    .from(tables.webhookEvents)
    .where(and(isNull(tables.webhookEvents.processedAt), eq(tables.webhookEvents.signatureOk, true), lt(tables.webhookEvents.attempts, 8)))
    .limit(limit);
  let done = 0;
  for (const r of rows) {
    const backoffMs = Math.min(2 ** r.attempts * 15_000, 60 * 60_000);
    if (r.attempts > 0 && Date.now() - Date.parse(r.receivedAt) < backoffMs) continue;
    try {
      await processWebhookEvent(r.id);
      done++;
    } catch {
      /* attempts already incremented */
    }
  }
  return done;
}
