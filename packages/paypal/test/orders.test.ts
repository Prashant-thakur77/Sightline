import { describe, expect, it } from 'vitest';
import {
  CUSTOM_ID_MAX_LENGTH,
  PayPalValidationError,
  approvalUrl,
  authorizationFromOrder,
  buildOrderRequest,
  captureFromOrder,
  vaultFromOrder,
  type OrderInput,
} from '../src';
import {
  authorizationCaptured,
  authorizationVoided,
  orderAuthorized,
  orderCapturedWithVault,
  orderCreated,
  orderCreatedNoSource,
  reauthorized,
  refunded,
} from './fixtures';
import { jsonOf, mockPayPal, testClient, usd } from './helpers';

const base: OrderInput = {
  intent: 'CAPTURE',
  items: [
    { name: 'Linen shirt, blue, M', quantity: 1, unitAmount: usd(3400), sku: 'LS-BLU-M' },
    { name: 'Socks', quantity: 2, unitAmount: usd(250) },
  ],
  shipping: usd(499),
  taxTotal: usd(272),
  customId: 'rb_' + 'a'.repeat(200),
  invoiceId: 'ord_01JC8Z',
  payeeMerchantId: 'HAAP3SNYZZ9NG',
  shipTo: {
    fullName: 'Asha Rao',
    address: {
      addressLine1: '1 Main St',
      adminArea2: 'San Jose',
      adminArea1: 'CA',
      postalCode: '95131',
      countryCode: 'US',
    },
  },
};

describe('buildOrderRequest', () => {
  it('builds the exact Orders v2 body with a breakdown that sums', () => {
    const body = buildOrderRequest({
      ...base,
      customId: 'rb_9f2c',
      paymentSource: {
        type: 'paypal',
        experienceContext: {
          returnUrl: 'https://s.example/ok',
          cancelUrl: 'https://s.example/no',
          userAction: 'PAY_NOW',
        },
      },
    });
    expect(body).toEqual({
      intent: 'CAPTURE',
      purchase_units: [
        {
          custom_id: 'rb_9f2c',
          invoice_id: 'ord_01JC8Z',
          amount: {
            currency_code: 'USD',
            value: '46.71',
            breakdown: {
              item_total: { currency_code: 'USD', value: '39.00' },
              shipping: { currency_code: 'USD', value: '4.99' },
              tax_total: { currency_code: 'USD', value: '2.72' },
            },
          },
          payee: { merchant_id: 'HAAP3SNYZZ9NG' },
          items: [
            {
              name: 'Linen shirt, blue, M',
              quantity: '1',
              unit_amount: { currency_code: 'USD', value: '34.00' },
              sku: 'LS-BLU-M',
              category: 'PHYSICAL_GOODS',
            },
            {
              name: 'Socks',
              quantity: '2',
              unit_amount: { currency_code: 'USD', value: '2.50' },
              category: 'PHYSICAL_GOODS',
            },
          ],
          shipping: {
            type: 'SHIPPING',
            name: { full_name: 'Asha Rao' },
            address: {
              address_line_1: '1 Main St',
              admin_area_2: 'San Jose',
              admin_area_1: 'CA',
              postal_code: '95131',
              country_code: 'US',
            },
          },
        },
      ],
      payment_source: {
        paypal: {
          experience_context: {
            shipping_preference: 'SET_PROVIDED_ADDRESS',
            user_action: 'PAY_NOW',
            return_url: 'https://s.example/ok',
            cancel_url: 'https://s.example/no',
          },
        },
      },
    });
  });

  it('truncates custom_id to 127 characters', () => {
    const unit = (buildOrderRequest(base).purchase_units as any[])[0];
    expect(unit.custom_id).toHaveLength(CUSTOM_ID_MAX_LENGTH);
    expect(unit.custom_id).toBe(base.customId!.slice(0, 127));
  });

  it('derives tax_total from per-item tax x quantity', () => {
    const body = buildOrderRequest({
      intent: 'AUTHORIZE',
      items: [{ name: 'Mug', quantity: 3, unitAmount: usd(1000), tax: usd(85) }],
    });
    const amount = (body.purchase_units as any[])[0].amount;
    expect(amount.breakdown.item_total.value).toBe('30.00');
    expect(amount.breakdown.tax_total.value).toBe('2.55');
    expect(amount.value).toBe('32.55');
    expect((body.purchase_units as any[])[0].items[0].tax).toEqual({ currency_code: 'USD', value: '0.85' });
    expect(body.intent).toBe('AUTHORIZE');
  });

  it('checks the computed total against the confirmed readback total', () => {
    expect(() => buildOrderRequest({ ...base, expectedTotal: usd(4671) })).not.toThrow();
    expect(() => buildOrderRequest({ ...base, expectedTotal: usd(4670) })).toThrow(
      /differs from the confirmed 46.70/,
    );
  });

  it('rejects mixed currencies, bad quantities, conflicting tax and long invoice ids', () => {
    expect(() => buildOrderRequest({ ...base, shipping: { cents: 499, currency: 'EUR' } })).toThrow(
      PayPalValidationError,
    );
    expect(() =>
      buildOrderRequest({ ...base, items: [{ name: 'x', quantity: 0, unitAmount: usd(1) }] }),
    ).toThrow(/quantity/);
    expect(() =>
      buildOrderRequest({ ...base, items: [{ name: 'x', quantity: 1.5, unitAmount: usd(1) }] }),
    ).toThrow(/quantity/);
    expect(() => buildOrderRequest({ ...base, items: [] })).toThrow(/at least one item/);
    expect(() =>
      buildOrderRequest({
        intent: 'CAPTURE',
        items: [{ name: 'x', quantity: 1, unitAmount: usd(100), tax: usd(8) }],
        taxTotal: usd(9),
      }),
    ).toThrow(/taxTotal/);
    expect(() => buildOrderRequest({ ...base, invoiceId: 'x'.repeat(128) })).toThrow(/invoiceId/);
    expect(() =>
      buildOrderRequest({ ...base, items: [{ name: 'x', quantity: 1, unitAmount: usd(-1) }] }),
    ).toThrow(/negative/);
  });

  it('asks PayPal to vault the wallet on success (MERCHANT, CONSUMER)', () => {
    const body = buildOrderRequest({
      ...base,
      paymentSource: {
        type: 'paypal',
        storeInVault: true,
        experienceContext: { returnUrl: 'https://s.example/ok', cancelUrl: 'https://s.example/no' },
      },
    });
    expect((body.payment_source as any).paypal.attributes).toEqual({
      vault: { store_in_vault: 'ON_SUCCESS', usage_type: 'MERCHANT', customer_type: 'CONSUMER' },
    });
  });

  it('links a returning PayPal customer when vaulting', () => {
    const body = buildOrderRequest({
      ...base,
      paymentSource: { type: 'paypal', storeInVault: true, customerId: 'ROaPMoZUaV' },
    });
    expect((body.payment_source as any).paypal.attributes.customer).toEqual({ id: 'ROaPMoZUaV' });
  });

  it('pays with a vaulted wallet by vault_id only', () => {
    const body = buildOrderRequest({ ...base, paymentSource: { type: 'vault', vaultId: 'nkq2y9g' } });
    expect(body.payment_source).toEqual({ paypal: { vault_id: 'nkq2y9g' } });
    expect(() =>
      buildOrderRequest({ ...base, paymentSource: { type: 'vault', vaultId: 'bad id!' } }),
    ).toThrow(PayPalValidationError);
  });

  it('omits payment_source when none is given', () => {
    expect(buildOrderRequest(base)).not.toHaveProperty('payment_source');
  });
});

describe('orders API', () => {
  it('creates with the request id, Prefer representation and optional risk metadata', async () => {
    const mock = mockPayPal().on('POST', '/v2/checkout/orders', { status: 200, json: orderCreated });
    const { client } = testClient(mock);
    const order = await client.orders.create({
      ...base,
      requestId: 'sl-ord-1',
      clientMetadataId: 'cmid-123',
    });
    const call = mock.api()[0]!;
    expect(call.headers['paypal-request-id']).toBe('sl-ord-1');
    expect(call.headers['prefer']).toBe('return=representation');
    expect(call.headers['content-type']).toBe('application/json');
    expect(call.headers['paypal-client-metadata-id']).toBe('cmid-123');
    expect(call.headers['paypal-partner-attribution-id']).toBeUndefined();
    expect(jsonOf(call)).toEqual(buildOrderRequest(base));
    expect(approvalUrl(order)).toBe('https://www.sandbox.paypal.com/checkoutnow?token=5O190127TN364715T');
  });

  it('finds the approve link for orders created without a payment source', () => {
    expect(approvalUrl(orderCreatedNoSource as any)).toBe(
      'https://www.paypal.com/checkoutnow?token=5O190127TN364715T',
    );
  });

  it('refuses to create without a request id, before any call', async () => {
    const mock = mockPayPal();
    await expect(
      testClient(mock).client.orders.create({ ...base, requestId: undefined as unknown as string }),
    ).rejects.toBeInstanceOf(PayPalValidationError);
    expect(mock.calls).toHaveLength(0);
  });

  it('captures and reads the capture and vault token from the order', async () => {
    const mock = mockPayPal().on('POST', '/v2/checkout/orders/5O190127TN364715T/capture', {
      status: 201,
      json: orderCapturedWithVault,
    });
    const order = await testClient(mock).client.orders.capture('5O190127TN364715T', {
      requestId: 'sl-cap-1',
    });
    expect(jsonOf(mock.api()[0]!)).toEqual({});
    expect(captureFromOrder(order)?.id).toBe('8MC585209K746392H');
    expect(vaultFromOrder(order)).toEqual({ id: 'nkq2y9g', status: 'VAULTED', customerId: 'ROaPMoZUaV' });
  });

  it('authorize then capture the authorization (item checked out)', async () => {
    const mock = mockPayPal()
      .on('POST', '/v2/checkout/orders/5O190127TN364715T/authorize', { status: 201, json: orderAuthorized })
      .on('POST', '/v2/payments/authorizations/3C679366HH908993F/capture', {
        status: 201,
        json: authorizationCaptured,
      });
    const { client } = testClient(mock);
    const order = await client.orders.authorize('5O190127TN364715T', { requestId: 'sl-auth-1' });
    const auth = authorizationFromOrder(order)!;
    expect(auth.id).toBe('3C679366HH908993F');
    const cap = await client.payments.captureAuthorization(auth.id, {
      requestId: 'sl-acap-1',
      invoiceId: 'ord_01JC8Z',
    });
    expect(cap.status).toBe('COMPLETED');
    const [a, c] = mock.api();
    expect(a!.headers['paypal-request-id']).toBe('sl-auth-1');
    expect(c!.headers['paypal-request-id']).toBe('sl-acap-1');
    expect(c!.headers['prefer']).toBe('return=representation');
    expect(jsonOf(c!)).toEqual({ final_capture: true, invoice_id: 'ord_01JC8Z' });
  });

  it('authorize then void (item failed the check)', async () => {
    const mock = mockPayPal().on('POST', '/v2/payments/authorizations/3C679366HH908993F/void', {
      status: 200,
      json: authorizationVoided,
    });
    const voided = await testClient(mock).client.payments.voidAuthorization('3C679366HH908993F', {
      requestId: 'sl-void-1',
    });
    expect(voided?.status).toBe('VOIDED');
    const call = mock.api()[0]!;
    expect(call.headers['paypal-request-id']).toBe('sl-void-1');
    expect(call.text).toBe('');
  });

  it('accepts a 204 void with no body', async () => {
    const mock = mockPayPal().on('POST', '/v2/payments/authorizations/3C679366HH908993F/void', {
      status: 204,
    });
    expect(
      await testClient(mock).client.payments.voidAuthorization('3C679366HH908993F', {
        requestId: 'sl-void-2',
      }),
    ).toBeUndefined();
  });

  it('captures a partial amount and reauthorizes', async () => {
    const mock = mockPayPal()
      .on('POST', '/v2/payments/authorizations/3C679366HH908993F/capture', {
        status: 201,
        json: authorizationCaptured,
      })
      .on('POST', '/v2/payments/authorizations/3C679366HH908993F/reauthorize', {
        status: 201,
        json: reauthorized,
      });
    const { client } = testClient(mock);
    await client.payments.captureAuthorization('3C679366HH908993F', {
      requestId: 'p1',
      amount: usd(1099),
      finalCapture: false,
    });
    const re = await client.payments.reauthorize('3C679366HH908993F', { requestId: 'p2', amount: usd(1099) });
    expect(jsonOf(mock.api()[0]!)).toEqual({
      final_capture: false,
      amount: { currency_code: 'USD', value: '10.99' },
    });
    expect(jsonOf(mock.api()[1]!)).toEqual({ amount: { currency_code: 'USD', value: '10.99' } });
    expect(re.id).toBe('8AA831015G517922L');
  });

  it('captures part of an authorization as the final capture, so PayPal releases the rest', async () => {
    const mock = mockPayPal().on('POST', '/v2/payments/authorizations/3C679366HH908993F/capture', {
      status: 201,
      json: authorizationCaptured,
    });
    const { client } = testClient(mock);
    await client.payments.captureAuthorization('3C679366HH908993F', {
      requestId: 'keep-for-less-1',
      amount: usd(2938),
      finalCapture: true,
      invoiceId: 'ord_01JC8Z',
    });
    expect(jsonOf(mock.api()[0]!)).toEqual({
      final_capture: true,
      amount: { currency_code: 'USD', value: '29.38' },
      invoice_id: 'ord_01JC8Z',
    });
    await expect(client.payments.captureAuthorization('3C679366HH908993F', { requestId: 'x', amount: usd(0) })).rejects.toThrow(/positive integer cents/);
  });

  it('refunds with amount, note to payer and invoice id', async () => {
    const mock = mockPayPal().on('POST', '/v2/payments/captures/2GG279541U471931P/refund', {
      status: 201,
      json: refunded,
    });
    const r = await testClient(mock).client.payments.refundCapture('2GG279541U471931P', {
      requestId: 'sl-ref-1',
      amount: usd(1099),
      noteToPayer: 'Wrong colour delivered. Refund issued.',
      invoiceId: 'ord_01JC8Z',
    });
    expect(r.status).toBe('COMPLETED');
    const call = mock.api()[0]!;
    expect(call.headers['paypal-request-id']).toBe('sl-ref-1');
    expect(jsonOf(call)).toEqual({
      amount: { currency_code: 'USD', value: '10.99' },
      note_to_payer: 'Wrong colour delivered. Refund issued.',
      invoice_id: 'ord_01JC8Z',
    });
  });

  it('sends an empty body for a full refund and rejects a long note', async () => {
    const mock = mockPayPal().on('POST', '/v2/payments/captures/2GG279541U471931P/refund', {
      status: 201,
      json: refunded,
    });
    const { client } = testClient(mock);
    await client.payments.refundCapture('2GG279541U471931P', { requestId: 'sl-ref-2' });
    expect(jsonOf(mock.api()[0]!)).toEqual({});
    await expect(
      client.payments.refundCapture('2GG279541U471931P', {
        requestId: 'sl-ref-3',
        noteToPayer: 'x'.repeat(256),
      }),
    ).rejects.toBeInstanceOf(PayPalValidationError);
  });
});

describe('item image links PayPal accepts', () => {
  it('keeps an https .jpg/.jpeg/.gif/.png link and drops anything PayPal would reject', async () => {
    const { paypalImageUrl } = await import('../src/orders');
    expect(paypalImageUrl('https://example.com/a/b-1.jpg')).toBe('https://example.com/a/b-1.jpg');
    expect(paypalImageUrl('https://example.com/x.PNG')).toBe('https://example.com/x.PNG');
    // A product-feed CDN link with no extension and a query string (the live sandbox rejected it).
    expect(paypalImageUrl('https://cdn.trychannel3.com/0b18c0ec-7215?aid=01M6&mid=WDzU')).toBeUndefined();
    expect(paypalImageUrl('https://example.com/a.jpg?w=200')).toBeUndefined();
    expect(paypalImageUrl('http://example.com/a.jpg')).toBeUndefined();
    expect(paypalImageUrl('/demo-store/sweater.png')).toBeUndefined();
    expect(paypalImageUrl(undefined)).toBeUndefined();
  });
});
