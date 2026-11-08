import 'server-only';
import { and, eq } from 'drizzle-orm';
import { tables } from '@sightline/db';
import { formatMoney, newId, type Cart, type Money } from '@sightline/core';
import { runGate, type ConfirmedReadback, type GateDecision } from '@sightline/gate';
import { paypalRequestId, hashReadbackBinding } from '@sightline/evidence';
import { authorizationFromOrder, captureFromOrder, vaultFromOrder, isInstrumentDeclined, type PayPalClient } from '@sightline/paypal';
import { db, ENV, appUrl } from './runtime';
import { gatePorts, dbReservations } from './gate-ports';
import { signingSecret } from './keys';
import { paypal } from './paypal';
import { audit } from './audit';

export type PayOutcome =
  | { kind: 'refused'; say: string; code: string; receiptId?: string }
  | { kind: 'needs-approval'; paypalOrderId: string; orderId: string; receiptId?: string }
  | { kind: 'paid'; orderId: string; status: 'captured' | 'authorized'; amount: Money; receiptId?: string }
  | { kind: 'declined'; say: string }
  | { kind: 'error'; say: string };

async function loadReadback(readbackId: string, userId: string) {
  const [rb] = await db().select().from(tables.readbacks).where(eq(tables.readbacks.id, readbackId)).limit(1);
  if (!rb) return null;
  const [cartRow] = await db()
    .select()
    .from(tables.carts)
    .where(and(eq(tables.carts.id, rb.cartId), eq(tables.carts.userId, userId)))
    .limit(1);
  if (!cartRow) return null;
  return { rb, cart: cartRow.body as Cart, cartRow };
}

async function latestReceiptId(requestId: string): Promise<string | undefined> {
  const rows = await db().select({ id: tables.receipts.id, createdAt: tables.receipts.createdAt }).from(tables.receipts).where(eq(tables.receipts.subjectId, requestId));
  return rows.sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0]?.id;
}

async function vaultIdFor(userId: string): Promise<string | null> {
  const [v] = await db()
    .select()
    .from(tables.vaultTokens)
    .where(and(eq(tables.vaultTokens.userId, userId), eq(tables.vaultTokens.status, 'ACTIVE')))
    .limit(1);
  return v?.vaultId ?? null;
}

async function prefsFor(userId: string) {
  const [p] = await db().select().from(tables.preferences).where(eq(tables.preferences.userId, userId)).limit(1);
  return p;
}

function orderBody(cart: Cart, readbackBinding: string, orderId: string, intent: 'CAPTURE' | 'AUTHORIZE') {
  const line = cart.lines[0]!;
  return {
    intent,
    items: cart.lines.map((l) => ({
      name: l.snapshot.title.slice(0, 127),
      quantity: l.quantity,
      unitAmount: l.snapshot.price,
      sku: `${l.snapshot.productId}|${l.snapshot.variantId}`.slice(0, 127),
      description: [l.snapshot.attributes.colour, l.snapshot.attributes.size && `size ${l.snapshot.attributes.size}`].filter(Boolean).join(', ').slice(0, 127) || undefined,
      imageUrl: l.snapshot.images[0]?.url.startsWith('http') ? l.snapshot.images[0]?.url : undefined,
    })),
    shipping: cart.totals.shipping,
    taxTotal: cart.totals.tax,
    expectedTotal: cart.totals.total,
    customId: readbackBinding,
    invoiceId: orderId,
    description: `${line.snapshot.title} via accessible readback`.slice(0, 127),
    payeeMerchantId: ENV.PAYPAL_MERCHANT_ID,
  };
}

/**
 * Turn a confirmed readback into a PayPal order. The gate runs first and decides; amounts,
 * payee and confirmation all come from database rows, never from model output. The
 * PayPal-Request-Id is derived from the cart hash and readback id, so a repeated "yes", a double
 * click or a network retry returns the original order instead of creating a second one.
 */
export async function payForReadback(input: { userId: string; readbackId: string; mode: 'auto' | 'popup' }): Promise<PayOutcome> {
  const loaded = await loadReadback(input.readbackId, input.userId);
  if (!loaded) return { kind: 'error', say: "I couldn't find that readback. Nothing was charged." };
  const { rb, cart } = loaded;
  const prefs = await prefsFor(input.userId);
  const intent: 'CAPTURE' | 'AUTHORIZE' = prefs?.payAfterCheck ? 'AUTHORIZE' : 'CAPTURE';
  const vaultId = input.mode === 'auto' ? await vaultIdFor(input.userId) : null;
  const readback: ConfirmedReadback = {
    id: rb.id,
    cartId: rb.cartId,
    cartHash: rb.cartHash,
    text: rb.text,
    fields: rb.fields as ConfirmedReadback['fields'],
    textHash: rb.textHash,
    createdAt: rb.createdAt,
    confirmedAt: rb.confirmedAt ?? undefined,
    confirmation: (rb.confirmation as ConfirmedReadback['confirmation']) ?? undefined,
    holdOpen: rb.holdOpen,
  };
  const decision: GateDecision = await runGate(
    {
      userId: input.userId,
      cart,
      readback,
      payee: { merchantId: ENV.PAYPAL_MERCHANT_ID ?? 'DEMO-STORE-UNCONFIGURED' },
      amount: cart.totals.total,
      paymentSource: vaultId ? 'vault' : 'paypal-popup',
      intent,
      now: new Date(),
    },
    gatePorts(),
    { env: { PAYPAL_ENV: ENV.PAYPAL_ENV, PAYPAL_API_BASE: ENV.PAYPAL_API_BASE }, signingKey: signingSecret() },
  );
  const receiptId = await latestReceiptId(decision.requestId);
  await audit({
    userId: input.userId,
    actor: 'gate',
    action: decision.allowed ? 'gate.allowed' : 'gate.refused',
    subjectId: rb.id,
    payload: { requestId: decision.requestId, firstFailure: decision.firstFailure?.code ?? null, receiptHash: decision.receipt.hash },
  });
  if (!decision.allowed) {
    return { kind: 'refused', say: decision.refusal ?? "I didn't pay. Something didn't check out.", code: decision.firstFailure?.code ?? 'REFUSED', receiptId };
  }

  // Idempotent on our side too: the same request id always maps to the same local order.
  const [existing] = await db().select().from(tables.orders).where(eq(tables.orders.paypalRequestId, decision.requestId)).limit(1);
  if (existing && ['authorized', 'captured'].includes(existing.status))
    return { kind: 'paid', orderId: existing.id, status: existing.status as 'captured' | 'authorized', amount: cart.totals.total, receiptId };

  const orderId = existing?.id ?? newId('ord');
  const binding = hashReadbackBinding(readback);
  let pp: PayPalClient;
  try {
    pp = paypal();
  } catch {
    if (decision.reservation) await dbReservations.release(decision.reservation.id, 'paypal_not_configured', new Date());
    return { kind: 'error', say: "PayPal isn't connected yet, so I didn't charge anything." };
  }
  if (!existing)
    await db()
      .insert(tables.orders)
      .values({
        id: orderId,
        userId: input.userId,
        cartId: cart.id,
        readbackId: rb.id,
        snapshotId: cart.lines[0]!.snapshot.id,
        paypalRequestId: decision.requestId,
        intent,
        paymentSource: vaultId ? 'vault' : 'paypal-popup',
        status: 'confirmed',
        amountCents: cart.totals.total.cents,
        currency: cart.totals.total.currency,
        merchantId: ENV.PAYPAL_MERCHANT_ID ?? 'DEMO-STORE-UNCONFIGURED',
        title: cart.lines[0]!.snapshot.title,
        receiptId: receiptId ?? null,
      });

  try {
    const body = orderBody(cart, binding, orderId, intent);
    if (vaultId) {
      const created = await pp.orders.create({
        ...body,
        requestId: decision.requestId,
        paymentSource: { type: 'vault', vaultId, storedCredential: { payment_initiator: 'CUSTOMER', usage: 'SUBSEQUENT' } },
      });
      return await settleCreatedOrder({ userId: input.userId, orderId, intent, created, amount: cart.totals.total, receiptId, reservationId: decision.reservation?.id });
    }
    const created = await pp.orders.create({
      ...body,
      requestId: decision.requestId,
      paymentSource: {
        type: 'paypal',
        storeInVault: true,
        experienceContext: {
          brandName: 'Demo Store',
          shippingPreference: 'NO_SHIPPING',
          userAction: 'PAY_NOW',
          returnUrl: `${appUrl()}/app`,
          cancelUrl: `${appUrl()}/app`,
        },
      },
    });
    await db().update(tables.orders).set({ paypalOrderId: created.id, status: 'approval_pending', updatedAt: new Date().toISOString() }).where(eq(tables.orders.id, orderId));
    await audit({ userId: input.userId, actor: 'paypal', action: 'order.created', subjectId: orderId, payload: { paypalOrderId: created.id, intent, requestId: decision.requestId } });
    return { kind: 'needs-approval', paypalOrderId: created.id, orderId, receiptId };
  } catch (e) {
    if (decision.reservation) await dbReservations.release(decision.reservation.id, 'paypal_error', new Date());
    await db().update(tables.orders).set({ status: 'failed', updatedAt: new Date().toISOString() }).where(eq(tables.orders.id, orderId));
    if (isInstrumentDeclined(e)) return { kind: 'declined', say: 'PayPal declined that payment method. Nothing was charged. You can choose another one in PayPal.' };
    console.error('[pay] order create failed', e);
    return { kind: 'error', say: 'PayPal could not take the payment right now. Nothing was charged.' };
  }
}

type CreatedOrder = Awaited<ReturnType<PayPalClient['orders']['create']>>;

async function settleCreatedOrder(a: {
  userId: string;
  orderId: string;
  intent: 'CAPTURE' | 'AUTHORIZE';
  created: CreatedOrder;
  amount: Money;
  receiptId?: string;
  reservationId?: string;
}): Promise<PayOutcome> {
  const pp = paypal();
  let order = a.created;
  // Vault orders usually complete on create; otherwise authorize or capture now.
  if (order.status !== 'COMPLETED') {
    order =
      a.intent === 'AUTHORIZE'
        ? await pp.orders.authorize(order.id, { requestId: paypalRequestId('authorize', order.id) })
        : await pp.orders.capture(order.id, { requestId: paypalRequestId('capture', order.id) });
  }
  const now = new Date().toISOString();
  if (a.intent === 'AUTHORIZE') {
    const auth = authorizationFromOrder(order);
    await db()
      .update(tables.orders)
      .set({ paypalOrderId: order.id, status: 'authorized', authorizationId: auth?.id ?? null, authorizationExpiresAt: auth?.expiration_time ?? null, updatedAt: now })
      .where(eq(tables.orders.id, a.orderId));
  } else {
    const cap = captureFromOrder(order);
    await db().update(tables.orders).set({ paypalOrderId: order.id, status: 'captured', captureId: cap?.id ?? null, updatedAt: now }).where(eq(tables.orders.id, a.orderId));
    if (a.reservationId) await dbReservations.commit(a.reservationId, new Date());
  }
  const vault = vaultFromOrder(order);
  if (vault?.id) {
    await db()
      .insert(tables.vaultTokens)
      .values({ id: newId('vlt'), userId: a.userId, vaultId: vault.id, paypalCustomerId: vault.customerId ?? null, status: vault.status ?? 'ACTIVE', label: 'your saved PayPal' })
      .onConflictDoNothing();
  }
  await db().insert(tables.shipments).values({ orderId: a.orderId, status: 'awaiting_shipment', shippedVariant: 'correct' }).onConflictDoNothing();
  await audit({
    userId: a.userId,
    actor: 'paypal',
    action: a.intent === 'AUTHORIZE' ? 'payment.authorized' : 'payment.captured',
    subjectId: a.orderId,
    payload: { paypalOrderId: order.id, amount: formatMoney(a.amount) },
  });
  return { kind: 'paid', orderId: a.orderId, status: a.intent === 'AUTHORIZE' ? 'authorized' : 'captured', amount: a.amount, receiptId: a.receiptId };
}

/** The buyer approved in PayPal's window: authorize or capture with a derived request id. */
export async function completeApprovedOrder(input: { userId: string; paypalOrderId: string }): Promise<PayOutcome> {
  const [o] = await db()
    .select()
    .from(tables.orders)
    .where(and(eq(tables.orders.paypalOrderId, input.paypalOrderId), eq(tables.orders.userId, input.userId)))
    .limit(1);
  if (!o) return { kind: 'error', say: "I couldn't match that PayPal approval to an order. Nothing was charged." };
  if (o.status === 'authorized' || o.status === 'captured')
    return { kind: 'paid', orderId: o.id, status: o.status, amount: { cents: o.amountCents, currency: o.currency }, receiptId: o.receiptId ?? undefined };
  const [rsv] = await db().select().from(tables.reservations).where(eq(tables.reservations.key, o.paypalRequestId)).limit(1);
  try {
    const order = await paypal().orders.get(o.paypalOrderId!);
    return await settleCreatedOrder({
      userId: input.userId,
      orderId: o.id,
      intent: o.intent as 'CAPTURE' | 'AUTHORIZE',
      created: order,
      amount: { cents: o.amountCents, currency: o.currency },
      receiptId: o.receiptId ?? undefined,
      reservationId: rsv?.id,
    });
  } catch (e) {
    if (isInstrumentDeclined(e)) return { kind: 'declined', say: 'PayPal declined that payment method. Nothing was charged. Try again and pick another one.' };
    console.error('[pay] approval completion failed', e);
    return { kind: 'error', say: 'PayPal could not finish the payment. Nothing was charged.' };
  }
}
