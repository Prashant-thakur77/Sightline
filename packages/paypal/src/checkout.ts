/**
 * The PayPal half of paying for a confirmed readback, without any database: the order body built
 * from the cart rows, the vault create, and the authorize or capture that follows. The web app's
 * payment step (apps/web/src/server/payments.ts) and the sandbox-ledger evals both call these, so
 * the evals send exactly what the app sends.
 */
import type { Cart } from '@sightline/core';
import { PayPalApiError, PayPalNetworkError } from './errors';
import type { AddressInput, OrderInput, OrderIntent, OrdersApi } from './orders';
import type { Order } from './schemas';

export interface ShipToInput {
  fullName: string;
  address: AddressInput;
}

export interface CartOrderOptions {
  /** hashReadbackBinding of the confirmed readback; sent as custom_id. */
  readbackBinding: string;
  /** The local order id; sent as invoice_id. */
  orderId: string;
  intent: OrderIntent;
  /** The store merchant from configuration, never from a listing or a model. */
  payeeMerchantId?: string;
  shipTo?: ShipToInput;
}

/** The Orders v2 input for a cart: every amount, quantity and the payee come from the cart rows and configuration. */
export function orderInputFromCart(cart: Cart, o: CartOrderOptions): OrderInput {
  const line = cart.lines[0]!;
  return {
    // Physical goods carry a delivery address, which keeps seller protection and tracking meaningful.
    ...(o.shipTo && { shipTo: o.shipTo }),
    intent: o.intent,
    items: cart.lines.map((l) => ({
      name: l.snapshot.title.slice(0, 127),
      quantity: l.quantity,
      unitAmount: l.snapshot.price,
      sku: `${l.snapshot.productId}|${l.snapshot.variantId}`.slice(0, 127),
      description:
        [l.snapshot.attributes.colour, l.snapshot.attributes.size && `size ${l.snapshot.attributes.size}`]
          .filter(Boolean)
          .join(', ')
          .slice(0, 127) || undefined,
      imageUrl: l.snapshot.images[0]?.url.startsWith('http') ? l.snapshot.images[0]?.url : undefined,
    })),
    shipping: cart.totals.shipping,
    taxTotal: cart.totals.tax,
    expectedTotal: cart.totals.total,
    customId: o.readbackBinding,
    invoiceId: o.orderId,
    description: `${line.snapshot.title} via accessible readback`.slice(0, 127),
    payeeMerchantId: o.payeeMerchantId,
  };
}

/** Errors after which PayPal may still have created the order. Never tell the buyer "nothing was charged" then. */
export function isAmbiguous(e: unknown): boolean {
  return e instanceof PayPalNetworkError || (e instanceof PayPalApiError && e.status >= 500);
}

/** A buyer-present payment with the buyer's saved PayPal (vault), keyed by the gate's PayPal-Request-Id. */
export function createVaultOrder(
  orders: Pick<OrdersApi, 'create'>,
  input: OrderInput,
  o: { requestId: string; vaultId: string },
): Promise<Order> {
  return orders.create({
    ...input,
    requestId: o.requestId,
    paymentSource: {
      type: 'vault',
      vaultId: o.vaultId,
      storedCredential: { payment_initiator: 'CUSTOMER', usage: 'SUBSEQUENT' },
    },
  });
}

/**
 * Vault orders usually complete on create; otherwise authorize or capture now, with a request id
 * derived from the PayPal order id so a repeat returns the same authorization or capture.
 */
export async function completeOrder(
  orders: Pick<OrdersApi, 'authorize' | 'capture'>,
  order: Order,
  intent: OrderIntent,
  requestIdFor: (kind: 'authorize' | 'capture', paypalOrderId: string) => string,
): Promise<Order> {
  if (order.status === 'COMPLETED') return order;
  return intent === 'AUTHORIZE'
    ? orders.authorize(order.id, { requestId: requestIdFor('authorize', order.id) })
    : orders.capture(order.id, { requestId: requestIdFor('capture', order.id) });
}
