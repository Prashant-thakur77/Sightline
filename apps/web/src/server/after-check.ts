import 'server-only';
import { eq } from 'drizzle-orm';
import { tables } from '@sightline/db';
import { formatMoney, type Verdict } from '@sightline/core';
import { paypalRequestId } from '@sightline/evidence';
import { db } from './runtime';
import { paypal } from './paypal';
import { dbReservations } from './gate-ports';
import { audit } from './audit';

export type NextStep =
  | { kind: 'captured'; say: string }
  | { kind: 'match'; say: string }
  | { kind: 'money-back'; say: string; payAfterCheck: boolean }
  | { kind: 'unsure'; say: string; helperName?: string }
  | { kind: 'capture-failed'; say: string };

/**
 * What happens to the money after a verdict. Pay-after-check orders (AUTHORIZE) are captured
 * only on a match; on a mismatch the hold stays in place until the buyer chooses what to do.
 * A model never decides this: only the verdict kind, which itself needs a "sure" reason to be a
 * mismatch, drives it.
 */
export async function afterVerdict(a: { userId: string; orderId: string; verificationId: string; verdict: Verdict }): Promise<NextStep> {
  const [o] = await db().select().from(tables.orders).where(eq(tables.orders.id, a.orderId)).limit(1);
  if (!o) throw new Error('order not found');
  const amount = formatMoney({ cents: o.amountCents, currency: o.currency });
  const now = new Date().toISOString();

  if (a.verdict.kind === 'match') {
    if (o.status === 'authorized' || (o.intent === 'AUTHORIZE' && o.authorizationId && !o.captureId)) {
      try {
        const cap = await paypal().payments.captureAuthorization(o.authorizationId!, {
          requestId: paypalRequestId('capture', o.authorizationId!),
          invoiceId: o.id,
          finalCapture: true,
          noteToPayer: 'Captured after the buyer checked the item.',
        });
        await db().update(tables.orders).set({ status: 'verified_match', captureId: cap.id, updatedAt: now }).where(eq(tables.orders.id, o.id));
        const [rsv] = await db().select().from(tables.reservations).where(eq(tables.reservations.key, o.paypalRequestId)).limit(1);
        if (rsv && rsv.status === 'reserved') await dbReservations.commit(rsv.id, new Date());
        await audit({ userId: a.userId, actor: 'paypal', action: 'payment.captured_after_check', subjectId: o.id, payload: { captureId: cap.id, verificationId: a.verificationId } });
        return { kind: 'captured', say: `${a.verdict.headline} I've told PayPal to complete the payment of ${amount} to Demo Store now.` };
      } catch (e) {
        console.error('[after-check] capture failed', e);
        await db().update(tables.orders).set({ status: 'verified_match', updatedAt: now }).where(eq(tables.orders.id, o.id));
        return { kind: 'capture-failed', say: `${a.verdict.headline} PayPal could not complete the payment just now. Your money is still on hold, and I'll try again.` };
      }
    }
    await db().update(tables.orders).set({ status: 'verified_match', updatedAt: now }).where(eq(tables.orders.id, o.id));
    return { kind: 'match', say: a.verdict.headline };
  }

  if (a.verdict.kind === 'mismatch') {
    await db().update(tables.orders).set({ status: 'verified_mismatch', updatedAt: now }).where(eq(tables.orders.id, o.id));
    const held = o.status === 'authorized';
    return {
      kind: 'money-back',
      payAfterCheck: held,
      say: held
        ? `${a.verdict.headline} Demo Store has not been paid yet: the ${amount} is only on hold. Say “get my money back” and I'll cancel the hold.`
        : `${a.verdict.headline} Say “get my money back” and I'll build the evidence and ask Demo Store through PayPal.`,
    };
  }

  await db().update(tables.orders).set({ status: 'verified_unsure', updatedAt: now }).where(eq(tables.orders.id, o.id));
  const [helper] = await db().select().from(tables.helpers).where(eq(tables.helpers.userId, a.userId)).limit(1);
  return {
    kind: 'unsure',
    helperName: helper?.name,
    say: `${a.verdict.headline} ${helper ? `I can ask ${helper.name} to look at the photos, or you can try again in better light.` : 'You can try again in better light.'} Your payment has not changed.`,
  };
}
