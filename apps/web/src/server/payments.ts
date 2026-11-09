import 'server-only';
import { and, eq, inArray, ne } from 'drizzle-orm';
import { tables } from '@sightline/db';
import { formatMoney, newId, type Cart, type Money } from '@sightline/core';
import { runGate, type ConfirmedReadback, type GateDecision } from '@sightline/gate';
import { paypalRequestId, hashReadbackBinding } from '@sightline/evidence';
import { authorizationFromOrder, captureFromOrder, vaultFromOrder, isInstrumentDeclined, PayPalApiError, PayPalNetworkError, type PayPalClient } from '@sightline/paypal';
import { db, ENV, appUrl } from './runtime';
import { gatePorts, dbReservations } from './gate-ports';
import { signingSecret } from './keys';
import { paypal } from './paypal';
import { audit } from './audit';
import { shipToForDisplayName } from './personas';

type ShipTo = NonNullable<ReturnType<typeof shipToForDisplayName>>;

async function shipToFor(userId: string): Promise<ShipTo | undefined> {
  const [u] = await db().select({ displayName: tables.users.displayName }).from(tables.users).where(eq(tables.users.id, userId)).limit(1);
  return u ? shipToForDisplayName(u.displayName) : undefined;
}

/** How long a lost create may be re-sent with the same PayPal-Request-Id. PayPal keeps request ids
 *  for a limited time (hours); after that a re-send could create a second payment, so we stop well inside it. */
export const RECONCILE_RESEND_MS = 3 * 60 * 60 * 1000;

export type PayOutcome =
  | { kind: 'refused'; say: string; code: string; receiptId?: string }
  | { kind: 'needs-approval'; paypalOrderId: string; orderId: string; intent: 'CAPTURE' | 'AUTHORIZE'; receiptId?: string }
  | { kind: 'paid'; orderId: string; status: 'captured' | 'authorized'; amount: Money; receiptId?: string }
  | { kind: 'declined'; say: string }
  /** notConnected: no PayPal keys on this server, so no payment can be made at all. */
  | { kind: 'error'; say: string; notConnected?: boolean }
  /** PayPal may or may not have taken the payment (timeout, network, 5xx). The hold stays. */
  | { kind: 'unknown'; say: string; orderId: string };

/** Errors after which PayPal may still have created the order. Never tell the buyer "nothing was charged" then. */
export function isAmbiguous(e: unknown): boolean {
  return e instanceof PayPalNetworkError || (e instanceof PayPalApiError && e.status >= 500);
}

export const PENDING_SAY =
  "PayPal is still reviewing this payment. I won't charge you again for it, and I'll tell you as soon as PayPal decides.";

export const UNKNOWN_SAY =
  "PayPal didn't answer in time, so I can't tell yet whether that payment went through. I've paused this purchase so you can't be charged twice, and I'll check with PayPal before anything else happens.";

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

function orderBody(cart: Cart, readbackBinding: string, orderId: string, intent: 'CAPTURE' | 'AUTHORIZE', shipTo?: ShipTo) {
  const line = cart.lines[0]!;
  return {
    // Physical goods carry a delivery address, which keeps seller protection and tracking meaningful.
    ...(shipTo && { shipTo }),
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
  // An earlier order for the same item whose PayPal outcome is unknown must be settled first.
  const line0 = cart.lines[0]!.snapshot;
  const unknown = await db()
    .select({ id: tables.orders.id, snapshotId: tables.orders.snapshotId })
    .from(tables.orders)
    // The same readback is handled by the idempotent request id (a double press), not as unknown.
    .where(and(eq(tables.orders.userId, input.userId), eq(tables.orders.status, 'confirmed'), ne(tables.orders.readbackId, rb.id)));
  if (unknown.length) {
    const snaps = await db().select({ id: tables.productSnapshots.id, productId: tables.productSnapshots.productId, variantId: tables.productSnapshots.variantId }).from(tables.productSnapshots).where(inArray(tables.productSnapshots.id, unknown.map((u) => u.snapshotId)));
    const same = snaps.find((x) => x.productId === line0.productId && x.variantId === line0.variantId);
    if (same)
      return {
        kind: 'refused',
        code: 'OUTCOME_UNKNOWN',
        say: "I'm still checking with PayPal whether your earlier order for this item went through, so I didn't charge you again. I'll tell you as soon as PayPal answers.",
      };
  }
  // The readback is the contract: if it told the buyer PayPal holds the money until the check,
  // the payment is an authorization, whatever the settings say now.
  const saidHold = (rb.fields as { key: string }[]).some((f) => f.key === 'payAfterCheck');
  const intent: 'CAPTURE' | 'AUTHORIZE' = saidHold ? 'AUTHORIZE' : 'CAPTURE';
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
    return { kind: 'error', say: "PayPal isn't connected yet, so I didn't charge anything.", notConnected: true };
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
    const body = orderBody(cart, binding, orderId, intent, await shipToFor(input.userId));
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
          userAction: 'PAY_NOW',
          returnUrl: `${appUrl()}/app`,
          cancelUrl: `${appUrl()}/app`,
        },
      },
    });
    await db().update(tables.orders).set({ paypalOrderId: created.id, status: 'approval_pending', updatedAt: new Date().toISOString() }).where(eq(tables.orders.id, orderId));
    await audit({ userId: input.userId, actor: 'paypal', action: 'order.created', subjectId: orderId, payload: { paypalOrderId: created.id, paypalStatus: created.status ?? null, intent, requestId: decision.requestId } });
    return { kind: 'needs-approval', intent, paypalOrderId: created.id, orderId, receiptId };
  } catch (e) {
    // A popup order cannot charge until the buyer approves it in PayPal, so an unanswered create is
    // not a money risk there; only saved-PayPal (vault) orders can be charged without the buyer.
    if (isAmbiguous(e) && vaultId) {
      // Keep the budget hold and the order row: retrying with the same PayPal-Request-Id later
      // returns the original order if PayPal did create it.
      await db().update(tables.orders).set({ status: 'confirmed', updatedAt: new Date().toISOString() }).where(eq(tables.orders.id, orderId));
      await audit({ userId: input.userId, actor: 'paypal', action: 'order.outcome_unknown', subjectId: orderId, payload: { requestId: decision.requestId } });
      return { kind: 'unknown', say: UNKNOWN_SAY, orderId };
    }
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
  // PayPal can answer an authorize or capture with a payment that is still pending review, or
  // denied. Only a created authorization or a completed capture counts as paid.
  const auth0 = a.intent === 'AUTHORIZE' ? authorizationFromOrder(order) : undefined;
  const cap0 = a.intent === 'CAPTURE' ? captureFromOrder(order) : undefined;
  const state = (a.intent === 'AUTHORIZE' ? auth0?.status : cap0?.status)?.toUpperCase();
  if (state && ['DENIED', 'DECLINED', 'FAILED', 'VOIDED', 'EXPIRED'].includes(state)) {
    await db().update(tables.orders).set({ paypalOrderId: order.id, status: 'failed', updatedAt: now }).where(eq(tables.orders.id, a.orderId));
    if (a.reservationId) await dbReservations.release(a.reservationId, `paypal_${state.toLowerCase()}`, new Date());
    await audit({ userId: a.userId, actor: 'paypal', action: 'payment.declined', subjectId: a.orderId, payload: { paypalOrderId: order.id, state } });
    return { kind: 'declined', say: 'PayPal declined this payment, so nothing was charged. You can try again and choose another way to pay in PayPal.' };
  }
  if (state === 'PENDING') {
    await db()
      .update(tables.orders)
      .set({ paypalOrderId: order.id, status: 'confirmed', authorizationId: auth0?.id ?? null, captureId: cap0?.id ?? null, updatedAt: now })
      .where(eq(tables.orders.id, a.orderId));
    await audit({ userId: a.userId, actor: 'paypal', action: 'payment.pending', subjectId: a.orderId, payload: { paypalOrderId: order.id } });
    return { kind: 'unknown', orderId: a.orderId, say: PENDING_SAY };
  }
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
    // PayPal's own ids and status as it answered, so the order's timeline can show them.
    payload: {
      paypalOrderId: order.id,
      paypalOrderStatus: order.status ?? null,
      ...(a.intent === 'AUTHORIZE'
        ? { authorizationId: auth0?.id ?? null, paypalStatus: auth0?.status ?? null }
        : { captureId: cap0?.id ?? null, paypalStatus: cap0?.status ?? null }),
      amount: formatMoney(a.amount),
    },
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
    if (isAmbiguous(e)) return { kind: 'unknown', say: UNKNOWN_SAY, orderId: o.id };
    if (isInstrumentDeclined(e)) return { kind: 'declined', say: 'PayPal declined that payment method. Nothing was charged. Try again and pick another one.' };
    console.error('[pay] approval completion failed', e);
    return { kind: 'error', say: 'PayPal could not finish the payment. Nothing was charged.' };
  }
}

/**
 * Settle orders whose PayPal outcome was unknown. Re-sending the create with the same
 * PayPal-Request-Id returns the original order if PayPal created it, so this can never charge
 * twice. Called when the buyer comes back.
 */
export async function reconcileUnknownOrders(userId: string): Promise<string[]> {
  const pending = await db()
    .select()
    .from(tables.orders)
    .where(and(eq(tables.orders.userId, userId), eq(tables.orders.status, 'confirmed')));
  const said: string[] = [];
  for (const o of pending) {
    if (Date.now() - Date.parse(o.updatedAt) < 20_000) continue;
    const loaded = await loadReadback(o.readbackId, userId);
    if (!loaded) continue;
    let pp: PayPalClient;
    try {
      pp = paypal();
    } catch {
      return said;
    }
    const [rsv0] = await db().select().from(tables.reservations).where(eq(tables.reservations.key, o.paypalRequestId)).limit(1);
    // A known PayPal order (for example one pending review) is read, never re-created.
    if (o.paypalOrderId) {
      try {
        const out = await settleCreatedOrder({
          userId,
          orderId: o.id,
          intent: o.intent as 'CAPTURE' | 'AUTHORIZE',
          created: await pp.orders.get(o.paypalOrderId),
          amount: { cents: o.amountCents, currency: o.currency },
          receiptId: o.receiptId ?? undefined,
          reservationId: rsv0?.id,
        });
        if (out.kind === 'paid') said.push(`PayPal confirmed your order for the ${o.title}. It went through once, for ${formatMoney(out.amount)}.`);
        if (out.kind === 'declined') said.push(`PayPal declined your order for the ${o.title}, so nothing was charged.`);
      } catch {
        /* still unknown; try again next time */
      }
      continue;
    }
    // Past the re-send window a create could charge a second time, so stop and say so, once.
    if (Date.now() - Date.parse(o.createdAt) > RECONCILE_RESEND_MS) {
      const [told] = await db()
        .select({ seq: tables.auditLog.seq })
        .from(tables.auditLog)
        .where(and(eq(tables.auditLog.subjectId, o.id), eq(tables.auditLog.action, 'order.reconcile_stopped')))
        .limit(1);
      if (!told) {
        await audit({ userId, actor: 'system', action: 'order.reconcile_stopped', subjectId: o.id, payload: { requestId: o.paypalRequestId } });
        said.push(
          `I still can't tell whether your order for the ${o.title} went through, and it's too late to ask PayPal again safely, so I won't. You can't be charged twice for it. Your PayPal activity will show it if it went through, and I'll tell you if PayPal sends word.`,
        );
      }
      continue;
    }
    const { rb, cart } = loaded;
    const binding = hashReadbackBinding({ id: rb.id, cartId: rb.cartId, cartHash: rb.cartHash, textHash: rb.textHash });
    const [vault] = await db().select().from(tables.vaultTokens).where(and(eq(tables.vaultTokens.userId, userId), eq(tables.vaultTokens.status, 'ACTIVE'))).limit(1);
    if (o.paymentSource !== 'vault' || !vault) continue;
    try {
      const created = await pp.orders.create({
        ...orderBody(cart, binding, o.id, o.intent as 'CAPTURE' | 'AUTHORIZE', await shipToFor(userId)),
        requestId: o.paypalRequestId,
        paymentSource: { type: 'vault', vaultId: vault.vaultId, storedCredential: { payment_initiator: 'CUSTOMER', usage: 'SUBSEQUENT' } },
      });
      const [rsv] = await db().select().from(tables.reservations).where(eq(tables.reservations.key, o.paypalRequestId)).limit(1);
      const out = await settleCreatedOrder({
        userId,
        orderId: o.id,
        intent: o.intent as 'CAPTURE' | 'AUTHORIZE',
        created,
        amount: { cents: o.amountCents, currency: o.currency },
        receiptId: o.receiptId ?? undefined,
        reservationId: rsv?.id,
      });
      if (out.kind === 'paid') said.push(`PayPal confirmed your earlier order for the ${o.title}. It went through once, for ${formatMoney(out.amount)}.`);
    } catch (e) {
      // The store already has an order with this invoice id: the first create went through.
      if (e instanceof PayPalApiError && e.issue === 'DUPLICATE_INVOICE_ID') {
        await audit({ userId, actor: 'paypal', action: 'order.duplicate_invoice', subjectId: o.id, payload: { requestId: o.paypalRequestId } });
        said.push(`PayPal says your earlier order for the ${o.title} already exists, so it did go through, once. I'm waiting for PayPal to confirm the details.`);
        continue;
      }
      if (!isAmbiguous(e)) {
        await db().update(tables.orders).set({ status: 'failed', updatedAt: new Date().toISOString() }).where(eq(tables.orders.id, o.id));
        const [rsv] = await db().select().from(tables.reservations).where(eq(tables.reservations.key, o.paypalRequestId)).limit(1);
        if (rsv && rsv.status === 'reserved') await dbReservations.release(rsv.id, 'paypal_refused_on_reconcile', new Date());
        said.push(`PayPal says your earlier order for the ${o.title} did not go through, so nothing was charged.`);
      }
    }
  }
  return said;
}
