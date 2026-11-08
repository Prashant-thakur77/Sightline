import { describe, expect, it } from 'vitest';
import {
  PayPalValidationError,
  SUBSCRIBED_WEBHOOK_EVENTS,
  WEBHOOK_EVENTS,
  buildVerifySignatureBody,
  isSubscribedEvent,
  parseWebhookEvent,
} from '../src';
import { disputeInquiry, eventTypes, rawCaptureEvent, webhookCreated } from './fixtures';
import { jsonOf, mockPayPal, testClient } from './helpers';

const deliveryHeaders = {
  'PAYPAL-AUTH-ALGO': 'SHA256withRSA',
  'PAYPAL-CERT-URL': 'https://api.sandbox.paypal.com/v1/notifications/certs/CERT-360caa42-fca2a594-a5cafa77',
  'PAYPAL-TRANSMISSION-ID': '103e3700-8b0c-11e6-8695-6b62a8a99ac4',
  'PAYPAL-TRANSMISSION-SIG': 'sig/with+base64==',
  'PAYPAL-TRANSMISSION-TIME': '2026-11-09T21:50:08Z',
  'content-type': 'application/json',
};

describe('webhook event names', () => {
  it('subscribes to the plan events plus capture outcomes, all spelled as PayPal lists them', () => {
    expect(SUBSCRIBED_WEBHOOK_EVENTS).toEqual([
      'CHECKOUT.ORDER.APPROVED',
      'CHECKOUT.ORDER.COMPLETED',
      'PAYMENT.CAPTURE.COMPLETED',
      'PAYMENT.CAPTURE.PENDING',
      'PAYMENT.CAPTURE.DENIED',
      'PAYMENT.CAPTURE.DECLINED',
      'PAYMENT.CAPTURE.REFUNDED',
      'PAYMENT.CAPTURE.REVERSED',
      'PAYMENT.AUTHORIZATION.CREATED',
      'PAYMENT.AUTHORIZATION.VOIDED',
      'CUSTOMER.DISPUTE.CREATED',
      'CUSTOMER.DISPUTE.UPDATED',
      'CUSTOMER.DISPUTE.RESOLVED',
      'VAULT.PAYMENT-TOKEN.CREATED',
      'VAULT.PAYMENT-TOKEN.DELETED',
    ]);
    expect(isSubscribedEvent('PAYMENT.CAPTURE.DENIED')).toBe(true);
    expect(isSubscribedEvent('BILLING.SUBSCRIPTION.CREATED')).toBe(false);
    expect(isSubscribedEvent(WEBHOOK_EVENTS.CUSTOMER_DISPUTE_RESOLVED)).toBe(true);
  });
});

describe('verify-webhook-signature', () => {
  it('embeds the raw body bytes exactly, never re-serialised', () => {
    const body = buildVerifySignatureBody(rawCaptureEvent, deliveryHeaders, '0EH40505U7160970P');
    expect(body.endsWith(`,"webhook_event":${rawCaptureEvent}}`)).toBe(true);
    // The odd double space in the raw event survives; JSON.stringify(JSON.parse(raw)) would drop it.
    expect(body).toContain('USD",  "resource"');
    expect(body).not.toContain(JSON.stringify(JSON.parse(rawCaptureEvent)));
    const parsed = JSON.parse(body);
    expect(parsed).toMatchObject({
      auth_algo: 'SHA256withRSA',
      cert_url: deliveryHeaders['PAYPAL-CERT-URL'],
      transmission_id: '103e3700-8b0c-11e6-8695-6b62a8a99ac4',
      transmission_sig: 'sig/with+base64==',
      transmission_time: '2026-11-09T21:50:08Z',
      webhook_id: '0EH40505U7160970P',
    });
    expect(parsed.webhook_event.id).toBe('WH-58D329510W468432D-8HN650336L201105X');
  });

  it('keeps non-ASCII and escaped characters as received', () => {
    const raw =
      '{"id":"WH-1","event_type":"CUSTOMER.DISPUTE.UPDATED","resource":{"note":"caf\\u00e9 — café"}}';
    const body = buildVerifySignatureBody(raw, deliveryHeaders, 'WH');
    expect(body).toContain('"note":"caf\\u00e9 — café"');
  });

  it('reads headers from a Headers object too', () => {
    const h = new Headers(deliveryHeaders);
    expect(() => buildVerifySignatureBody(rawCaptureEvent, h, 'WH')).not.toThrow();
  });

  it('refuses bodies that would break the concatenation', () => {
    expect(() => buildVerifySignatureBody('{"id":1},"webhook_id":"evil"', deliveryHeaders, 'WH')).toThrow(
      PayPalValidationError,
    );
    expect(() => buildVerifySignatureBody('[1,2]', deliveryHeaders, 'WH')).toThrow(PayPalValidationError);
  });

  it('sends the concatenated string as the request body and reports SUCCESS', async () => {
    const mock = mockPayPal().on('POST', '/v1/notifications/verify-webhook-signature', {
      status: 200,
      json: { verification_status: 'SUCCESS' },
    });
    const res = await testClient(mock).client.webhooks.verifySignature({
      rawBody: rawCaptureEvent,
      headers: deliveryHeaders,
      webhookId: '0EH40505U7160970P',
    });
    expect(res).toEqual({ verified: true, status: 'SUCCESS' });
    const call = mock.api()[0]!;
    expect(call.text).toBe(buildVerifySignatureBody(rawCaptureEvent, deliveryHeaders, '0EH40505U7160970P'));
    expect(call.headers['content-type']).toBe('application/json');
  });

  it('reports FAILURE as not verified', async () => {
    const mock = mockPayPal().on('POST', '/v1/notifications/verify-webhook-signature', {
      status: 200,
      json: { verification_status: 'FAILURE' },
    });
    const res = await testClient(mock).client.webhooks.verifySignature({
      rawBody: rawCaptureEvent,
      headers: deliveryHeaders,
      webhookId: 'WH',
    });
    expect(res.verified).toBe(false);
  });

  it('rejects locally, without calling PayPal, when a signature header is missing', async () => {
    const mock = mockPayPal();
    const { 'PAYPAL-TRANSMISSION-SIG': _, ...missing } = deliveryHeaders;
    const res = await testClient(mock).client.webhooks.verifySignature({
      rawBody: rawCaptureEvent,
      headers: missing,
      webhookId: 'WH',
    });
    expect(res.verified).toBe(false);
    expect(res.status).toBe('LOCAL_REJECT');
    expect(res.reason).toMatch(/paypal-transmission-sig/);
    expect(mock.calls).toHaveLength(0);
  });
});

describe('parseWebhookEvent', () => {
  it('types a capture event from the raw string', () => {
    const e = parseWebhookEvent(rawCaptureEvent);
    expect(e.kind).toBe('capture');
    if (e.kind === 'capture') {
      expect(e.resource.id).toBe('8MC585209K746392H');
      expect(e.resource.custom_id).toBe('rb_9f2c');
    }
    expect(e.event.event_type).toBe('PAYMENT.CAPTURE.COMPLETED');
  });

  it('types dispute, refund, authorization, vault and order events', () => {
    const ev = (event_type: string, resource: unknown, resource_type?: string) =>
      parseWebhookEvent({ id: 'WH-1', event_type, resource, ...(resource_type ? { resource_type } : {}) });
    expect(ev('CUSTOMER.DISPUTE.CREATED', disputeInquiry).kind).toBe('dispute');
    expect(ev('PAYMENT.CAPTURE.REFUNDED', { id: '1JU08902781691411', status: 'COMPLETED' }).kind).toBe(
      'refund',
    );
    expect(ev('PAYMENT.CAPTURE.REVERSED', { id: '1JU08902781691411' }, 'refund').kind).toBe('refund');
    expect(ev('PAYMENT.AUTHORIZATION.VOIDED', { id: '3C679366HH908993F', status: 'VOIDED' }).kind).toBe(
      'authorization',
    );
    expect(ev('VAULT.PAYMENT-TOKEN.CREATED', { id: 'nkq2y9g', customer: { id: 'ROaPMoZUaV' } }).kind).toBe(
      'payment-token',
    );
    expect(ev('CHECKOUT.ORDER.APPROVED', { id: '5O190127TN364715T', status: 'APPROVED' }).kind).toBe('order');
    expect(ev('BILLING.PLAN.CREATED', { id: 'P-1' }).kind).toBe('other');
  });

  it('rejects malformed events', () => {
    expect(() => parseWebhookEvent('not json')).toThrow(PayPalValidationError);
    expect(() => parseWebhookEvent({ event_type: 'PAYMENT.CAPTURE.COMPLETED', resource: {} })).toThrow(
      PayPalValidationError,
    );
    expect(() =>
      parseWebhookEvent({ id: 'WH-1', event_type: 'CUSTOMER.DISPUTE.CREATED', resource: { status: 'OPEN' } }),
    ).toThrow(/does not look like/);
  });
});

describe('webhook management', () => {
  it('creates a webhook with the subscribed events by default', async () => {
    const mock = mockPayPal().on('POST', '/v1/notifications/webhooks', { status: 201, json: webhookCreated });
    const hook = await testClient(mock).client.webhooks.create({
      url: 'https://sightline.example.com/api/webhooks/paypal',
    });
    expect(hook.id).toBe('0EH40505U7160970P');
    const body = jsonOf(mock.api()[0]!);
    expect(body.url).toBe('https://sightline.example.com/api/webhooks/paypal');
    expect(body.event_types.map((e: { name: string }) => e.name)).toEqual([...SUBSCRIBED_WEBHOOK_EVENTS]);
  });

  it('refuses non-HTTPS and local URLs', async () => {
    const { client } = testClient(mockPayPal());
    await expect(client.webhooks.create({ url: 'http://sightline.example.com/hook' })).rejects.toThrow(
      /HTTPS/,
    );
    await expect(client.webhooks.create({ url: 'https://localhost:3100/hook' })).rejects.toThrow(/public/);
  });

  it('lists event types and webhooks', async () => {
    const mock = mockPayPal()
      .on('GET', '/v1/notifications/webhooks-event-types', { status: 200, json: eventTypes })
      .on('GET', '/v1/notifications/webhooks', { status: 200, json: { webhooks: [webhookCreated] } });
    const { client } = testClient(mock);
    expect((await client.webhooks.listEventTypes()).map((e) => e.name)).toContain('CUSTOMER.DISPUTE.CREATED');
    expect((await client.webhooks.list())[0]!.url).toBe(webhookCreated.url);
  });

  it('treats deleting an already-deleted sandbox webhook as done', async () => {
    const mock = mockPayPal().on(
      'DELETE',
      '/v1/notifications/webhooks/0EH40505U7160970P',
      { status: 204 },
      {
        status: 404,
        json: { name: 'INVALID_RESOURCE_ID', message: 'Resource id is invalid.', debug_id: 'x' },
      },
    );
    const { client } = testClient(mock);
    expect(await client.webhooks.delete('0EH40505U7160970P')).toBe('deleted');
    expect(await client.webhooks.delete('0EH40505U7160970P')).toBe('already-gone');
  });

  it('simulates an event for a webhook id', async () => {
    const mock = mockPayPal().on('POST', '/v1/notifications/simulate-event', {
      status: 202,
      json: {
        id: 'WH-SIM-1',
        event_type: 'PAYMENT.CAPTURE.COMPLETED',
        resource_type: 'capture',
        resource: { id: '42311647XV020574X' },
      },
    });
    const e = await testClient(mock).client.webhooks.simulateEvent({
      eventType: 'PAYMENT.CAPTURE.COMPLETED',
      webhookId: '0EH40505U7160970P',
    });
    expect(e.id).toBe('WH-SIM-1');
    expect(jsonOf(mock.api()[0]!)).toEqual({
      event_type: 'PAYMENT.CAPTURE.COMPLETED',
      webhook_id: '0EH40505U7160970P',
    });
  });
});
