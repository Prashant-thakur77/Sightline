import { SANDBOX_API_BASE, SandboxOnlyError } from '@sightline/core/env';
import { describe, expect, it } from 'vitest';
import {
  PayPalApiError,
  PayPalInstrumentDeclinedError,
  PayPalNetworkError,
  PayPalResponseShapeError,
  PayPalValidationError,
  assertRequestId,
  createPayPalClient,
  isInstrumentDeclined,
  parseRetryAfter,
} from '../src';
import { orderAuthorized, orderCreated } from './fixtures';
import { mockPayPal, testClient } from './helpers';

const getOrder = '/v2/checkout/orders/5O190127TN364715T';

describe('sandbox guard', () => {
  it('refuses a live API base at construction', () => {
    expect(() =>
      createPayPalClient({
        clientId: 'a',
        clientSecret: 'b',
        apiBase: 'https://api-m.paypal.com',
        fetch: mockPayPal().fetch,
      }),
    ).toThrow(SandboxOnlyError);
  });
  it('refuses when the PayPal env is not sandbox', () => {
    expect(() =>
      createPayPalClient({ clientId: 'a', clientSecret: 'b', apiBase: SANDBOX_API_BASE, paypalEnv: 'live' }),
    ).toThrow(SandboxOnlyError);
  });
  it('accepts the sandbox base with a trailing slash and only ever calls it', async () => {
    const mock = mockPayPal().on('GET', getOrder, { status: 200, json: orderCreated });
    const { client } = testClient(mock, { apiBase: `${SANDBOX_API_BASE}/` });
    await client.orders.get('5O190127TN364715T');
    expect(mock.calls.every((c) => c.url.startsWith(`${SANDBOX_API_BASE}/`))).toBe(true);
  });
  it('refuses absolute URLs through the low-level request', async () => {
    const { client } = testClient(mockPayPal());
    await expect(
      client.request({ method: 'GET', path: 'https://api-m.paypal.com/v1/x' }),
    ).rejects.toBeInstanceOf(PayPalValidationError);
    await expect(client.request({ method: 'GET', path: '//evil.example.com/x' })).rejects.toBeInstanceOf(
      PayPalValidationError,
    );
  });
  it('validates ids before putting them in a path', async () => {
    const mock = mockPayPal();
    const { client } = testClient(mock);
    await expect(client.orders.get('../../v1/oauth2/token')).rejects.toBeInstanceOf(PayPalValidationError);
    expect(mock.calls).toHaveLength(0);
  });
});

describe('access token', () => {
  it('fetches with client credentials and Basic auth, then caches', async () => {
    const mock = mockPayPal().on('GET', getOrder, { status: 200, json: orderCreated });
    const { client } = testClient(mock);
    await client.orders.get('5O190127TN364715T');
    await client.orders.get('5O190127TN364715T');
    const tokenCalls = mock.tokenCalls();
    expect(tokenCalls).toHaveLength(1);
    expect(tokenCalls[0]!.text).toBe('grant_type=client_credentials');
    expect(tokenCalls[0]!.headers['content-type']).toBe('application/x-www-form-urlencoded');
    expect(tokenCalls[0]!.headers['authorization']).toBe(
      `Basic ${Buffer.from('AZgbuClientId:shh-secret').toString('base64')}`,
    );
    expect(tokenCalls[0]!.headers['paypal-request-id']).toBeUndefined();
    expect(mock.api().map((c) => c.headers['authorization'])).toEqual([
      'Bearer A21-token-1',
      'Bearer A21-token-1',
    ]);
  });

  it('refreshes 60 s before expiry, not earlier', async () => {
    const mock = mockPayPal().on('GET', getOrder, { status: 200, json: orderCreated });
    const { client, clock } = testClient(mock);
    await client.orders.get('5O190127TN364715T');
    clock.t += (32400 - 61) * 1000;
    await client.orders.get('5O190127TN364715T');
    expect(mock.tokenCalls()).toHaveLength(1);
    clock.t += 2000;
    await client.orders.get('5O190127TN364715T');
    expect(mock.tokenCalls()).toHaveLength(2);
    expect(mock.api().at(-1)!.headers['authorization']).toBe('Bearer A21-token-2');
  });

  it('shares one token fetch between concurrent calls', async () => {
    const mock = mockPayPal().on('GET', getOrder, { status: 200, json: orderCreated });
    const { client } = testClient(mock);
    await Promise.all([1, 2, 3].map(() => client.orders.get('5O190127TN364715T')));
    expect(mock.tokenCalls()).toHaveLength(1);
  });

  it('retries once with a fresh token after a 401, keeping the request id', async () => {
    const mock = mockPayPal().on(
      'POST',
      `${getOrder}/capture`,
      {
        status: 401,
        json: {
          name: 'AUTHENTICATION_FAILURE',
          message:
            'Authentication failed due to invalid authentication credentials or a missing Authorization header.',
        },
      },
      { status: 201, json: orderAuthorized },
    );
    const { client } = testClient(mock);
    await client.orders.capture('5O190127TN364715T', { requestId: 'cap-1' });
    const api = mock.api();
    expect(api).toHaveLength(2);
    expect(api.map((c) => c.headers['authorization'])).toEqual(['Bearer A21-token-1', 'Bearer A21-token-2']);
    expect(api.map((c) => c.headers['paypal-request-id'])).toEqual(['cap-1', 'cap-1']);
  });

  it('gives up after a second 401', async () => {
    const mock = mockPayPal().on('GET', getOrder, {
      status: 401,
      json: { error: 'invalid_token', error_description: 'Token signature verification failed' },
    });
    const { client } = testClient(mock);
    const err = await client.orders.get('5O190127TN364715T').catch((e) => e);
    expect(err).toBeInstanceOf(PayPalApiError);
    expect(err.status).toBe(401);
    expect(err.name).toBe('invalid_token');
    expect(mock.api()).toHaveLength(2);
  });

  it('mints a JS SDK v6 client token with response_type=client_token', async () => {
    const mock = mockPayPal().on('POST', '/v1/oauth2/token', {
      status: 200,
      json: { access_token: 'eyJclient', expires_in: 900 },
    });
    const { client } = testClient(mock);
    const t = await client.auth.clientToken({ domains: ['sightline.example.com'] });
    expect(t).toEqual({ token: 'eyJclient', expiresIn: 900 });
    const params = new URLSearchParams(mock.calls[0]!.text);
    expect(params.get('grant_type')).toBe('client_credentials');
    expect(params.get('response_type')).toBe('client_token');
    expect(params.get('intent')).toBe('sdk_init');
    expect(params.getAll('domains[]')).toEqual(['sightline.example.com']);
  });

  it('omits domains[] by default (sandbox rejects localhost)', async () => {
    const mock = mockPayPal().on('POST', '/v1/oauth2/token', {
      status: 200,
      json: { access_token: 'eyJclient', expires_in: 900 },
    });
    await testClient(mock).client.auth.clientToken();
    expect(mock.calls[0]!.text).not.toContain('domains');
  });

  it('mints a user id token for a returning payer', async () => {
    const mock = mockPayPal().on('POST', '/v1/oauth2/token', {
      status: 200,
      json: { access_token: 'A21', expires_in: 32400, id_token: 'eyJid' },
    });
    const t = await testClient(mock).client.auth.userIdToken({ customerId: 'ROaPMoZUaV' });
    expect(t.token).toBe('eyJid');
    const params = new URLSearchParams(mock.calls[0]!.text);
    expect(params.get('response_type')).toBe('id_token');
    expect(params.get('target_customer_id')).toBe('ROaPMoZUaV');
  });
});

describe('request ids', () => {
  it('requires a request id on money-moving calls and validates it', async () => {
    const mock = mockPayPal();
    const { client } = testClient(mock);
    await expect(client.orders.capture('5O190127TN364715T', { requestId: '' })).rejects.toBeInstanceOf(
      PayPalValidationError,
    );
    await expect(
      client.payments.voidAuthorization('3C679366HH908993F', { requestId: 'x'.repeat(109) }),
    ).rejects.toBeInstanceOf(PayPalValidationError);
    expect(() => assertRequestId('has space')).toThrow(PayPalValidationError);
    expect(assertRequestId('sl-ord-abc123')).toBe('sl-ord-abc123');
    expect(mock.calls).toHaveLength(0);
  });

  it('adds a generated request id to POSTs without one and keeps it across retries', async () => {
    const mock = mockPayPal().on(
      'POST',
      '/v1/customer/disputes/PP-R-AYP-10135034/escalate',
      { status: 503, json: { name: 'SERVICE_UNAVAILABLE', message: 'down' } },
      { status: 200, json: { links: [] } },
    );
    const { client } = testClient(mock);
    await client.request({
      method: 'POST',
      path: '/v1/customer/disputes/PP-R-AYP-10135034/escalate',
      json: { note: 'x' },
    });
    const ids = mock.api().map((c) => c.headers['paypal-request-id']);
    expect(ids[0]).toMatch(/^[0-9a-f-]{36}$/);
    expect(ids[1]).toBe(ids[0]);
  });

  it('sends no request id on GET', async () => {
    const mock = mockPayPal().on('GET', getOrder, { status: 200, json: orderCreated });
    await testClient(mock).client.orders.get('5O190127TN364715T');
    expect(mock.api()[0]!.headers['paypal-request-id']).toBeUndefined();
  });
});

describe('retries', () => {
  it('waits for Retry-After seconds on 429, then succeeds with the same request id', async () => {
    const mock = mockPayPal().on(
      'POST',
      `${getOrder}/capture`,
      {
        status: 429,
        json: { name: 'RATE_LIMIT_REACHED', message: 'Too many requests.' },
        headers: { 'retry-after': '2' },
      },
      { status: 201, json: orderAuthorized },
    );
    const { client, sleeps } = testClient(mock);
    await client.orders.capture('5O190127TN364715T', { requestId: 'cap-429' });
    expect(sleeps).toEqual([2000]);
    expect(mock.api().map((c) => c.headers['paypal-request-id'])).toEqual(['cap-429', 'cap-429']);
  });

  it('reads an HTTP-date Retry-After and caps very long waits', () => {
    const now = Date.parse('2026-11-09T12:00:00Z');
    expect(parseRetryAfter('Mon, 09 Nov 2026 12:00:05 GMT', now)).toBe(5000);
    expect(parseRetryAfter('1.5', now)).toBe(1500);
    expect(parseRetryAfter('soon', now)).toBeUndefined();
    expect(parseRetryAfter(null, now)).toBeUndefined();
  });

  it('caps Retry-After at the configured maximum', async () => {
    const mock = mockPayPal().on(
      'GET',
      getOrder,
      { status: 429, json: { name: 'RATE_LIMIT_REACHED' }, headers: { 'retry-after': '3600' } },
      { status: 200, json: orderCreated },
    );
    const { client, sleeps } = testClient(mock);
    await client.orders.get('5O190127TN364715T');
    expect(sleeps).toEqual([30_000]);
  });

  it('retries 5xx with jittered exponential backoff, at most 3 times, same request id', async () => {
    const mock = mockPayPal().on('POST', '/v2/payments/captures/2GG279541U471931P/refund', {
      status: 500,
      json: {
        name: 'INTERNAL_SERVER_ERROR',
        message: 'An internal server error occurred.',
        debug_id: '90957fca61718',
      },
    });
    const { client, sleeps, logs } = testClient(mock);
    const err = await client.payments
      .refundCapture('2GG279541U471931P', { requestId: 'rf-1' })
      .catch((e) => e);
    expect(err).toBeInstanceOf(PayPalApiError);
    expect(err.retryable).toBe(true);
    expect(err.debugId).toBe('90957fca61718');
    expect(mock.api()).toHaveLength(4);
    expect(new Set(mock.api().map((c) => c.headers['paypal-request-id']))).toEqual(new Set(['rf-1']));
    // random() = 0.5 gives a factor of 0.75 on 300, 600, 1200 ms.
    expect(sleeps).toEqual([225, 450, 900]);
    expect(logs.some((l) => l.level === 'error' && l.meta?.debugId === '90957fca61718')).toBe(true);
  });

  it('jitter stays within half to full of the exponential step', async () => {
    const mock = mockPayPal().on(
      'GET',
      getOrder,
      { status: 502, text: 'bad gateway' },
      { status: 502, text: 'bad gateway' },
      { status: 200, json: orderCreated },
    );
    const { client, sleeps } = testClient(mock, { random: () => 0.999 });
    await client.orders.get('5O190127TN364715T');
    expect(sleeps[0]).toBeGreaterThanOrEqual(150);
    expect(sleeps[0]).toBeLessThanOrEqual(300);
    expect(sleeps[1]).toBeGreaterThanOrEqual(300);
    expect(sleeps[1]).toBeLessThanOrEqual(600);
  });

  it('surfaces 422 INSTRUMENT_DECLINED distinctly and never retries it', async () => {
    const mock = mockPayPal().on('POST', `${getOrder}/capture`, {
      status: 422,
      headers: { 'paypal-debug-id': 'b1c2d3e4f5' },
      json: {
        name: 'UNPROCESSABLE_ENTITY',
        details: [
          {
            issue: 'INSTRUMENT_DECLINED',
            description:
              "The instrument presented was either declined by the processor or bank, or it can't be used for this payment.",
          },
        ],
        message:
          'The requested action could not be performed, semantically incorrect, or failed business validation.',
        debug_id: 'b1c2d3e4f5',
        links: [
          {
            href: 'https://www.sandbox.paypal.com/checkoutnow?token=5O190127TN364715T',
            rel: 'redirect',
            method: 'GET',
          },
        ],
      },
    });
    const { client, sleeps } = testClient(mock);
    const err = await client.orders.capture('5O190127TN364715T', { requestId: 'cap-d' }).catch((e) => e);
    expect(err).toBeInstanceOf(PayPalInstrumentDeclinedError);
    expect(isInstrumentDeclined(err)).toBe(true);
    expect(err.issue).toBe('INSTRUMENT_DECLINED');
    expect(err.status).toBe(422);
    expect(err.retryable).toBe(false);
    expect(err.debugId).toBe('b1c2d3e4f5');
    expect(mock.api()).toHaveLength(1);
    expect(sleeps).toEqual([]);
  });

  it('does not retry other 4xx', async () => {
    const mock = mockPayPal().on('POST', `${getOrder}/capture`, {
      status: 422,
      json: {
        name: 'UNPROCESSABLE_ENTITY',
        details: [{ issue: 'ORDER_NOT_APPROVED' }],
        message: 'Payer has not yet approved the Order for payment.',
        debug_id: 'abc',
      },
    });
    const { client } = testClient(mock);
    const err = await client.orders.capture('5O190127TN364715T', { requestId: 'cap-n' }).catch((e) => e);
    expect(err).toBeInstanceOf(PayPalApiError);
    expect(err).not.toBeInstanceOf(PayPalInstrumentDeclinedError);
    expect(err.issue).toBe('ORDER_NOT_APPROVED');
    expect(mock.api()).toHaveLength(1);
  });

  it('retries network failures and then reports a typed network error', async () => {
    const mock = mockPayPal().on('GET', getOrder, new TypeError('fetch failed'));
    const { client, sleeps } = testClient(mock);
    const err = await client.orders.get('5O190127TN364715T').catch((e) => e);
    expect(err).toBeInstanceOf(PayPalNetworkError);
    expect(err.attempts).toBe(4);
    expect(sleeps).toHaveLength(3);
  });

  it('rejects a 2xx body that lacks fields this package relies on', async () => {
    const mock = mockPayPal().on('GET', getOrder, { status: 200, json: { status: 'CREATED' } });
    const err = await testClient(mock)
      .client.orders.get('5O190127TN364715T')
      .catch((e) => e);
    expect(err).toBeInstanceOf(PayPalResponseShapeError);
  });

  it('keeps unknown response fields', async () => {
    const mock = mockPayPal().on('GET', getOrder, {
      status: 200,
      json: { ...orderCreated, brand_new_field: { x: 1 } },
    });
    const order = await testClient(mock).client.orders.get('5O190127TN364715T');
    expect((order as Record<string, unknown>).brand_new_field).toEqual({ x: 1 });
  });

  it('never logs tokens or secrets', async () => {
    const mock = mockPayPal().on('GET', getOrder, { status: 200, json: orderCreated });
    const { client, logs } = testClient(mock);
    await client.orders.get('5O190127TN364715T');
    const text = JSON.stringify(logs);
    expect(text).not.toContain('A21-token');
    expect(text).not.toContain('shh-secret');
  });
});
