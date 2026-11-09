import 'server-only';
import { and, desc, eq, inArray, isNotNull, isNull } from 'drizzle-orm';
import { tables } from '@sightline/db';
import { formatMoney } from '@sightline/core';
import { paypalRequestId } from '@sightline/evidence';
import type { PayPalClient } from '@sightline/paypal';
import { db } from './runtime';
import { paypal } from './paypal';
import { dbReservations } from './gate-ports';
import { audit } from './audit';
import { notify } from './cases';
import { isHeld } from './after-check';

/**
 * The life of a pay-after-check hold, fair to both sides.
 *
 * - Wrong item: the store has RETURN_WINDOW business days to accept the return (which voids the
 *   hold) or offer a replacement. If it does not answer, the hold is voided anyway: the buyer's
 *   money never leaves.
 * - No check: the buyer is reminded on day CHECK_REMINDER_DAYS after delivery; on day
 *   AUTO_CAPTURE_DAYS the store is paid as usual. A store is never left unpaid by silence.
 * - A capture that failed after a match is retried, up to MAX_CAPTURE_ATTEMPTS times.
 * - A hold kept past PayPal's three-day honour period is reauthorized once.
 *
 * Every money step is a PayPal call with a request id derived from the authorization, so running
 * the sweep twice never moves money twice.
 */
export const CHECK_REMINDER_DAYS = 5;
export const AUTO_CAPTURE_DAYS = 7;
export const HONOR_PERIOD_DAYS = 3;
export const MAX_CAPTURE_ATTEMPTS = 5;
const DAY = 86_400_000;
/** Case stages in which a wrong-item case on a held payment is still open and its deadline applies. */
const OPEN_STAGES = new Set(['seller_contacted', 'offer_received', 'accepted', 'declined']);

type Payments = Pick<PayPalClient['payments'], 'captureAuthorization' | 'voidAuthorization' | 'reauthorize'>;
type Order = typeof tables.orders.$inferSelect;

export interface SweepReport {
  voidedNoReply: string[];
  captured: string[];
  reminded: string[];
  reauthorized: string[];
  failed: { orderId: string; step: string; error: string }[];
}

async function auditCount(orderId: string, action: string): Promise<number> {
  const rows = await db()
    .select({ seq: tables.auditLog.seq })
    .from(tables.auditLog)
    .where(and(eq(tables.auditLog.subjectId, orderId), eq(tables.auditLog.action, action)));
  return rows.length;
}

async function settleHold(o: Order, how: 'commit' | 'release', reason: string, now: Date) {
  const [rsv] = await db().select().from(tables.reservations).where(eq(tables.reservations.key, o.paypalRequestId)).limit(1);
  if (!rsv || rsv.status !== 'reserved') return;
  if (how === 'commit') await dbReservations.commit(rsv.id, now);
  else await dbReservations.release(rsv.id, reason, now);
}

async function capture(o: Order, pp: Payments, now: Date, action: string, note: string) {
  const cap = await pp.captureAuthorization(o.authorizationId!, {
    requestId: paypalRequestId('capture', o.authorizationId!),
    invoiceId: o.id,
    finalCapture: true,
    noteToPayer: note,
  });
  await db().update(tables.orders).set({ captureId: cap.id, updatedAt: now.toISOString() }).where(eq(tables.orders.id, o.id));
  await settleHold(o, 'commit', action, now);
  await audit({ userId: o.userId, actor: 'paypal', action, subjectId: o.id, payload: { captureId: cap.id } });
}

/** Run every rule once. Safe to call often: each step is idempotent and checks state first. */
export async function sweepHolds(now: Date, pp: Payments = paypal().payments, opts: { orderIds?: string[] } = {}): Promise<SweepReport> {
  const report: SweepReport = { voidedNoReply: [], captured: [], reminded: [], reauthorized: [], failed: [] };
  const held = (
    await db()
      .select()
      .from(tables.orders)
      .where(
        and(
          eq(tables.orders.intent, 'AUTHORIZE'),
          isNotNull(tables.orders.authorizationId),
          isNull(tables.orders.captureId),
          opts.orderIds ? inArray(tables.orders.id, opts.orderIds) : undefined,
        ),
      )
  ).filter(isHeld);
  if (!held.length) return report;
  const ids = held.map((o) => o.id);
  const cases = await db().select().from(tables.cases).where(inArray(tables.cases.orderId, ids)).orderBy(desc(tables.cases.createdAt));
  const shipments = await db().select().from(tables.shipments).where(inArray(tables.shipments.orderId, ids));
  const checks = await db().select().from(tables.verifications).where(inArray(tables.verifications.orderId, ids)).orderBy(desc(tables.verifications.createdAt));

  for (const o of held) {
    const amount = formatMoney({ cents: o.amountCents, currency: o.currency });
    const link = `/app/orders/${o.id}`;
    const kase = cases.find((c) => c.orderId === o.id);
    const verdict = (checks.find((v) => v.orderId === o.id)?.verdict as { kind?: string } | null)?.kind ?? null;
    const delivered = shipments.find((s) => s.orderId === o.id)?.deliveredAt;
    try {
      // 1. A wrong-item case on a held payment that is still open when its deadline passes (no
      //    answer, an offer nobody settled, a return that never came back): void, never charge.
      if (kase && kase.kind === 'void' && OPEN_STAGES.has(kase.stage) && kase.dueAt && Date.parse(kase.dueAt) < now.getTime()) {
        await pp.voidAuthorization(o.authorizationId!, { requestId: paypalRequestId('void', o.authorizationId!) });
        await db().update(tables.orders).set({ status: 'voided', updatedAt: now.toISOString() }).where(eq(tables.orders.id, o.id));
        await db()
          .update(tables.cases)
          .set({ stage: 'resolved', status: 'resolved', outcome: { kind: 'voided', amountCents: o.amountCents, by: 'deadline', at: now.toISOString() }, updatedAt: now.toISOString() })
          .where(eq(tables.cases.id, kase.id));
        await settleHold(o, 'release', 'voided_no_reply', now);
        await audit({ userId: o.userId, actor: 'paypal', action: 'payment.voided_no_reply', subjectId: o.id, payload: { caseId: kase.id } });
        await notify(
          o.userId,
          'case',
          kase.stage === 'seller_contacted'
            ? `Demo Store didn't answer in time, so I cancelled the payment hold. Your ${amount} is released. You were never charged.`
            : `Your case with Demo Store wasn't settled by the deadline, so I cancelled the payment hold. Your ${amount} is released. You were never charged.`,
          link,
        );
        report.voidedNoReply.push(o.id);
        continue;
      }
      // 2a. A replacement was agreed: the buyer keeps the order, so the store is paid a week later,
      //     like any delivery nobody reports a problem with.
      if (kase && kase.stage === 'resolved' && o.status === 'resolved_replacement') {
        if ((now.getTime() - Date.parse(kase.updatedAt)) / DAY >= AUTO_CAPTURE_DAYS) {
          await capture(o, pp, now, 'payment.captured_after_replacement', 'The buyer agreed to a replacement a week ago.');
          await notify(o.userId, 'payment', `You agreed to a replacement for your ${o.title} a week ago, so Demo Store is now paid ${amount}.`, link);
          report.captured.push(o.id);
        }
        continue;
      }
      // An open case or a wrong-item verdict keeps the money on hold; nothing else applies.
      if ((kase && kase.stage !== 'resolved') || verdict === 'mismatch') continue;

      // 2. A match whose capture failed: try again, a bounded number of times.
      if (verdict === 'match') {
        const tries = await auditCount(o.id, 'payment.capture_retry_failed');
        if (tries >= MAX_CAPTURE_ATTEMPTS) continue;
        try {
          await capture(o, pp, now, 'payment.captured_after_check', 'Captured after the buyer checked the item.');
          await notify(o.userId, 'payment', `PayPal completed the payment of ${amount} to Demo Store, after your check matched.`, link);
          report.captured.push(o.id);
        } catch (e) {
          await audit({ userId: o.userId, actor: 'paypal', action: 'payment.capture_retry_failed', subjectId: o.id, payload: { attempt: tries + 1 } });
          report.failed.push({ orderId: o.id, step: 'capture-retry', error: (e as Error).message });
        }
        continue;
      }

      // 3. Delivered but not decided (no check, or the check was not sure).
      if (delivered) {
        const days = (now.getTime() - Date.parse(delivered)) / DAY;
        if (days >= AUTO_CAPTURE_DAYS) {
          await capture(o, pp, now, 'payment.captured_no_check', 'The buyer did not report a problem within a week of delivery.');
          await db().update(tables.orders).set({ status: 'captured', updatedAt: now.toISOString() }).where(eq(tables.orders.id, o.id));
          await notify(
            o.userId,
            'payment',
            `A week has passed since your ${o.title} arrived without a problem reported, so Demo Store is now paid ${amount}, as usual. If something is wrong, you can still ask Demo Store for your money back.`,
            link,
          );
          report.captured.push(o.id);
          continue;
        }
        if (days >= CHECK_REMINDER_DAYS && (await auditCount(o.id, 'hold.reminder_sent')) === 0) {
          await audit({ userId: o.userId, actor: 'system', action: 'hold.reminder_sent', subjectId: o.id, payload: { days: Math.floor(days) } });
          await notify(
            o.userId,
            'reminder',
            `Your ${o.title} arrived ${Math.floor(days)} days ago and ${amount} is still on hold. Check it in the next ${AUTO_CAPTURE_DAYS - Math.floor(days)} days, or ask for your money back. After that, Demo Store is paid as usual.`,
            link,
          );
          report.reminded.push(o.id);
        }
      }

      // 4. Past PayPal's honour period: reauthorize once, so a later capture is still honoured.
      if (now.getTime() - Date.parse(o.createdAt) > HONOR_PERIOD_DAYS * DAY && (await auditCount(o.id, 'payment.reauthorized')) === 0) {
        const auth = await pp.reauthorize(o.authorizationId!, { requestId: paypalRequestId('reauthorize', o.authorizationId!) });
        await db()
          .update(tables.orders)
          .set({ authorizationId: auth.id ?? o.authorizationId, authorizationExpiresAt: auth.expiration_time ?? o.authorizationExpiresAt, updatedAt: now.toISOString() })
          .where(eq(tables.orders.id, o.id));
        await audit({ userId: o.userId, actor: 'paypal', action: 'payment.reauthorized', subjectId: o.id, payload: { from: o.authorizationId, to: auth.id ?? null } });
        report.reauthorized.push(o.id);
      }
    } catch (e) {
      report.failed.push({ orderId: o.id, step: 'sweep', error: (e as Error).message });
    }
  }
  return report;
}

let lastSweep = 0;
/** At most every ten minutes per process; called from busy routes and the maintenance job. */
export async function maybeSweepHolds(now = new Date()): Promise<void> {
  if (now.getTime() - lastSweep < 10 * 60_000) return;
  lastSweep = now.getTime();
  try {
    await sweepHolds(now);
  } catch {
    /* PayPal not configured: nothing can be held, so nothing to do */
  }
}
