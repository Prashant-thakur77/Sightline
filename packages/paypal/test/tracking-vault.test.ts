import { describe, expect, it } from 'vitest';
import { PayPalApiError, PayPalValidationError } from '../src';
import { orderTracked, paymentTokens, trackersBatchOk, trackersBatchPartialError } from './fixtures';
import { jsonOf, mockPayPal, testClient } from './helpers';

const common = { captureId: '8MC585209K746392H', trackingNumber: '443844607820', carrier: 'FEDEX' };

describe('tracking', () => {
  it('orders-track strategy posts to the order and returns the tracker id', async () => {
    const mock = mockPayPal().on('POST', '/v2/checkout/orders/5O190127TN364715T/track', {
      status: 201,
      json: orderTracked,
    });
    const res = await testClient(mock).client.tracking.addTracking({
      strategy: 'orders-track',
      orderId: '5O190127TN364715T',
      ...common,
      notifyPayer: true,
      items: [{ name: 'T-Shirt', quantity: 1, sku: 'sku01' }],
    });
    expect(res.trackerId).toBe('8MC585209K746392H-443844607820');
    expect(jsonOf(mock.api()[0]!)).toEqual({
      capture_id: '8MC585209K746392H',
      tracking_number: '443844607820',
      carrier: 'FEDEX',
      notify_payer: true,
      items: [{ name: 'T-Shirt', quantity: '1', sku: 'sku01' }],
    });
  });

  it('trackers-batch strategy posts one tracker with transaction_id = capture id', async () => {
    const mock = mockPayPal().on('POST', '/v1/shipping/trackers-batch', {
      status: 200,
      json: trackersBatchOk,
    });
    const res = await testClient(mock).client.tracking.addTracking({
      strategy: 'trackers-batch',
      ...common,
      shipmentDate: '2026-11-09',
    });
    expect(res.trackerId).toBe('8MC585209K746392H-443844607820');
    expect(jsonOf(mock.api()[0]!)).toEqual({
      trackers: [
        {
          transaction_id: '8MC585209K746392H',
          tracking_number: '443844607820',
          status: 'SHIPPED',
          carrier: 'FEDEX',
          notify_buyer: false,
          shipment_date: '2026-11-09',
        },
      ],
    });
  });

  it('turns a 200 batch answer with errors into a typed error', async () => {
    const mock = mockPayPal().on('POST', '/v1/shipping/trackers-batch', {
      status: 200,
      json: trackersBatchPartialError,
    });
    const err = await testClient(mock)
      .client.tracking.addTracking({ strategy: 'trackers-batch', ...common })
      .catch((e) => e);
    expect(err).toBeInstanceOf(PayPalApiError);
    expect(err.name).toBe('RESOURCE_NOT_FOUND');
    expect(err.issue).toBe('INVALID_TRANSACTION_ID');
    expect(err.debugId).toBe('46735c7461f3d');
  });

  it('validates before sending', async () => {
    const mock = mockPayPal();
    const { client } = testClient(mock);
    await expect(client.tracking.addTracking({ strategy: 'orders-track', ...common })).rejects.toThrow(
      /orderId/,
    );
    await expect(
      client.tracking.addTracking({ strategy: 'trackers-batch', ...common, carrier: 'OTHER' }),
    ).rejects.toThrow(/carrierNameOther/);
    await expect(
      client.tracking.addTracking({ strategy: 'trackers-batch', ...common, trackingNumber: 'x'.repeat(65) }),
    ).rejects.toBeInstanceOf(PayPalValidationError);
    await expect(
      client.tracking.addTracking({ strategy: 'nope' as 'orders-track', ...common }),
    ).rejects.toThrow(/strategy/);
    expect(mock.calls).toHaveLength(0);
  });

  it('lists trackers for a capture', async () => {
    const mock = mockPayPal().on('GET', '/v1/shipping/trackers', {
      status: 200,
      json: {
        trackers: [
          {
            transaction_id: '8MC585209K746392H',
            tracking_number: '443844607820',
            status: 'DELIVERED',
            carrier: 'FEDEX',
          },
        ],
        links: [],
      },
    });
    const res = await testClient(mock).client.tracking.getTrackers({ transactionId: '8MC585209K746392H' });
    expect(res.trackers[0]!.status).toBe('DELIVERED');
    expect(mock.api()[0]!.query.get('transaction_id')).toBe('8MC585209K746392H');
  });
});

describe('vault', () => {
  it('lists payment tokens by customer', async () => {
    const mock = mockPayPal().on('GET', '/v3/vault/payment-tokens', { status: 200, json: paymentTokens });
    const list = await testClient(mock).client.vault.listPaymentTokens({
      customerId: 'ROaPMoZUaV',
      pageSize: 5,
    });
    expect(list.payment_tokens.map((t) => t.id)).toEqual(['nkq2y9g']);
    const q = mock.api()[0]!.query;
    expect(q.get('customer_id')).toBe('ROaPMoZUaV');
    expect(q.get('page_size')).toBe('5');
  });

  it('gets and deletes a payment token', async () => {
    const mock = mockPayPal()
      .on('GET', '/v3/vault/payment-tokens/nkq2y9g', { status: 200, json: paymentTokens.payment_tokens[0] })
      .on('DELETE', '/v3/vault/payment-tokens/nkq2y9g', { status: 204 });
    const { client } = testClient(mock);
    expect((await client.vault.getPaymentToken('nkq2y9g')).customer?.id).toBe('ROaPMoZUaV');
    await expect(client.vault.deletePaymentToken('nkq2y9g')).resolves.toBeUndefined();
    expect(mock.api().map((c) => c.method)).toEqual(['GET', 'DELETE']);
  });

  it("rejects page sizes above PayPal's limit of 5 and short customer ids", async () => {
    const { client } = testClient(mockPayPal());
    await expect(
      client.vault.listPaymentTokens({ customerId: 'ROaPMoZUaV', pageSize: 6 }),
    ).rejects.toBeInstanceOf(PayPalValidationError);
    await expect(client.vault.listPaymentTokens({ customerId: 'abc' })).rejects.toBeInstanceOf(
      PayPalValidationError,
    );
  });
});
