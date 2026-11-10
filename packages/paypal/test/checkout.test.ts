import type { Cart } from '@sightline/core';
import { describe, expect, it } from 'vitest';
import {
  PayPalApiError,
  PayPalNetworkError,
  buildOrderRequest,
  completeOrder,
  createVaultOrder,
  isAmbiguous,
  orderInputFromCart,
} from '../src';
import { orderAuthorized, orderCreated } from './fixtures';
import { jsonOf, mockPayPal, testClient, usd } from './helpers';

const cart = {
  id: 'cart_1',
  userId: 'usr_1',
  hash: 'h1',
  createdAt: '2026-11-09T12:00:00Z',
  totals: { subtotal: usd(6800), shipping: usd(0), tax: usd(578), total: usd(7378) },
  lines: [
    {
      quantity: 2,
      snapshot: {
        id: 'snap_1',
        productId: 'p1',
        variantId: 'v1',
        title: 'Crew-neck sweater',
        price: usd(3400),
        attributes: { colour: 'Navy', size: 'M' },
        images: [{ url: 'https://store.example/a.jpg' }],
      },
    },
  ],
} as unknown as Cart;

describe('orderInputFromCart', () => {
  it('takes amounts, quantity and payee from the cart and configuration only', () => {
    const input = orderInputFromCart(cart, { readbackBinding: 'bind', orderId: 'ord_1', intent: 'AUTHORIZE', payeeMerchantId: 'MERCHANT1' });
    expect(input.items).toEqual([
      { name: 'Crew-neck sweater', quantity: 2, unitAmount: usd(3400), sku: 'p1|v1', description: 'Navy, size M', imageUrl: 'https://store.example/a.jpg' },
    ]);
    expect(input).toMatchObject({ intent: 'AUTHORIZE', expectedTotal: usd(7378), customId: 'bind', invoiceId: 'ord_1', payeeMerchantId: 'MERCHANT1' });
    const body = buildOrderRequest(input) as { purchase_units: Array<{ amount: { value: string }; payee: unknown }> };
    expect(body.purchase_units[0]!.amount.value).toBe('73.78');
    expect(body.purchase_units[0]!.payee).toEqual({ merchant_id: 'MERCHANT1' });
  });
});

describe('isAmbiguous', () => {
  it('is true for network errors and 5xx, false for 4xx', () => {
    expect(isAmbiguous(new PayPalNetworkError('/x', 3))).toBe(true);
    expect(isAmbiguous(new PayPalApiError({ status: 503, path: '/x' } as never))).toBe(true);
    expect(isAmbiguous(new PayPalApiError({ status: 422, path: '/x' } as never))).toBe(false);
    expect(isAmbiguous(new Error('x'))).toBe(false);
  });
});

describe('createVaultOrder and completeOrder', () => {
  it('creates with the vault and the given request id, then authorizes with a derived id', async () => {
    const mock = mockPayPal()
      .on('POST', '/v2/checkout/orders', { status: 201, json: { ...orderCreated, status: 'CREATED' } })
      .on('POST', `/v2/checkout/orders/${orderCreated.id}/authorize`, { status: 201, json: orderAuthorized });
    const { client } = testClient(mock);
    const input = orderInputFromCart(cart, { readbackBinding: 'bind', orderId: 'ord_1', intent: 'AUTHORIZE', payeeMerchantId: 'M1' });
    const created = await createVaultOrder(client.orders, input, { requestId: 'REQ1', vaultId: 'vault_1' });
    const done = await completeOrder(client.orders, created, 'AUTHORIZE', (kind, id) => `${kind}-${id}`);
    const [create, authorize] = mock.api();
    expect(create!.headers['paypal-request-id']).toBe('REQ1');
    expect(jsonOf(create!)).toMatchObject({ payment_source: { paypal: { vault_id: 'vault_1', stored_credential: { payment_initiator: 'CUSTOMER', usage: 'SUBSEQUENT' } } } });
    expect(authorize!.headers['paypal-request-id']).toBe(`authorize-${orderCreated.id}`);
    expect(done.id).toBe(orderAuthorized.id);
  });

  it('does not authorize again when the order completed on create', async () => {
    const mock = mockPayPal();
    const { client } = testClient(mock);
    const done = await completeOrder(client.orders, orderAuthorized as never, 'AUTHORIZE', () => 'x');
    expect(done).toBe(orderAuthorized);
    expect(mock.api()).toHaveLength(0);
  });
});
