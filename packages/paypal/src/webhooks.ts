import { PayPalApiError, PayPalValidationError } from './errors';
import { parseWith, pathId, type HttpCore } from './http';
import {
  AuthorizationSchema,
  CaptureSchema,
  DisputeSchema,
  EventTypeListSchema,
  OrderSchema,
  PaymentTokenSchema,
  RefundSchema,
  VerifySignatureResponseSchema,
  WebhookEventSchema,
  WebhookListSchema,
  WebhookSchema,
  type Authorization,
  type Capture,
  type Dispute,
  type EventTypeList,
  type Order,
  type PaymentToken,
  type Refund,
  type Webhook,
  type WebhookEvent,
} from './schemas';

/** Event names confirmed against PayPal's live webhook event list. */
export const WEBHOOK_EVENTS = {
  CHECKOUT_ORDER_APPROVED: 'CHECKOUT.ORDER.APPROVED',
  /** Live docs mark this one "for use by marketplaces and platforms only". */
  CHECKOUT_ORDER_COMPLETED: 'CHECKOUT.ORDER.COMPLETED',
  PAYMENT_CAPTURE_COMPLETED: 'PAYMENT.CAPTURE.COMPLETED',
  PAYMENT_CAPTURE_PENDING: 'PAYMENT.CAPTURE.PENDING',
  PAYMENT_CAPTURE_DENIED: 'PAYMENT.CAPTURE.DENIED',
  PAYMENT_CAPTURE_DECLINED: 'PAYMENT.CAPTURE.DECLINED',
  PAYMENT_CAPTURE_REFUNDED: 'PAYMENT.CAPTURE.REFUNDED',
  PAYMENT_CAPTURE_REVERSED: 'PAYMENT.CAPTURE.REVERSED',
  PAYMENT_AUTHORIZATION_CREATED: 'PAYMENT.AUTHORIZATION.CREATED',
  PAYMENT_AUTHORIZATION_VOIDED: 'PAYMENT.AUTHORIZATION.VOIDED',
  CUSTOMER_DISPUTE_CREATED: 'CUSTOMER.DISPUTE.CREATED',
  CUSTOMER_DISPUTE_UPDATED: 'CUSTOMER.DISPUTE.UPDATED',
  CUSTOMER_DISPUTE_RESOLVED: 'CUSTOMER.DISPUTE.RESOLVED',
  VAULT_PAYMENT_TOKEN_CREATED: 'VAULT.PAYMENT-TOKEN.CREATED',
  VAULT_PAYMENT_TOKEN_DELETED: 'VAULT.PAYMENT-TOKEN.DELETED',
} as const;
export type WebhookEventName = (typeof WEBHOOK_EVENTS)[keyof typeof WEBHOOK_EVENTS];

/** The events Sightline subscribes to (plan 7.4). */
export const SUBSCRIBED_WEBHOOK_EVENTS: readonly WebhookEventName[] = [
  WEBHOOK_EVENTS.CHECKOUT_ORDER_APPROVED,
  WEBHOOK_EVENTS.CHECKOUT_ORDER_COMPLETED,
  WEBHOOK_EVENTS.PAYMENT_CAPTURE_COMPLETED,
  WEBHOOK_EVENTS.PAYMENT_CAPTURE_REFUNDED,
  WEBHOOK_EVENTS.PAYMENT_CAPTURE_REVERSED,
  WEBHOOK_EVENTS.PAYMENT_AUTHORIZATION_CREATED,
  WEBHOOK_EVENTS.PAYMENT_AUTHORIZATION_VOIDED,
  WEBHOOK_EVENTS.CUSTOMER_DISPUTE_CREATED,
  WEBHOOK_EVENTS.CUSTOMER_DISPUTE_UPDATED,
  WEBHOOK_EVENTS.CUSTOMER_DISPUTE_RESOLVED,
  WEBHOOK_EVENTS.VAULT_PAYMENT_TOKEN_CREATED,
  WEBHOOK_EVENTS.VAULT_PAYMENT_TOKEN_DELETED,
];

export const SIGNATURE_HEADERS = [
  'paypal-auth-algo',
  'paypal-cert-url',
  'paypal-transmission-id',
  'paypal-transmission-sig',
  'paypal-transmission-time',
] as const;

export type IncomingHeaders = Headers | Record<string, string | string[] | undefined>;

function header(h: IncomingHeaders, name: string): string | undefined {
  if (typeof (h as Headers).get === 'function') return (h as Headers).get(name) ?? undefined;
  const rec = h as Record<string, string | string[] | undefined>;
  const key = Object.keys(rec).find((k) => k.toLowerCase() === name);
  const v = key === undefined ? undefined : rec[key];
  return Array.isArray(v) ? v[0] : v;
}

/**
 * Builds the verify-webhook-signature request body by string concatenation, so the event bytes PayPal signed are
 * passed through exactly as received. Re-serialising the event (even whitespace) would break verification.
 * The raw body must be one JSON object; that check keeps the concatenation well-formed.
 */
export function buildVerifySignatureBody(
  rawBody: string,
  headers: IncomingHeaders,
  webhookId: string,
): string {
  if (!webhookId) throw new PayPalValidationError('webhookId', 'is required.');
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody);
  } catch {
    throw new PayPalValidationError('rawBody', 'is not JSON.');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
    throw new PayPalValidationError('rawBody', 'must be one JSON object.');
  const v: Record<string, string> = {};
  for (const name of SIGNATURE_HEADERS) {
    const value = header(headers, name);
    if (!value) throw new PayPalValidationError(name, 'header is missing.');
    v[name] = value;
  }
  return (
    '{"auth_algo":' +
    JSON.stringify(v['paypal-auth-algo']) +
    ',"cert_url":' +
    JSON.stringify(v['paypal-cert-url']) +
    ',"transmission_id":' +
    JSON.stringify(v['paypal-transmission-id']) +
    ',"transmission_sig":' +
    JSON.stringify(v['paypal-transmission-sig']) +
    ',"transmission_time":' +
    JSON.stringify(v['paypal-transmission-time']) +
    ',"webhook_id":' +
    JSON.stringify(webhookId) +
    ',"webhook_event":' +
    rawBody +
    '}'
  );
}

export type ParsedWebhookEvent =
  | { kind: 'order'; event: WebhookEvent; resource: Order }
  | { kind: 'capture'; event: WebhookEvent; resource: Capture }
  | { kind: 'refund'; event: WebhookEvent; resource: Refund }
  | { kind: 'authorization'; event: WebhookEvent; resource: Authorization }
  | { kind: 'dispute'; event: WebhookEvent; resource: Dispute }
  | { kind: 'payment-token'; event: WebhookEvent; resource: PaymentToken }
  | { kind: 'other'; event: WebhookEvent; resource: Record<string, unknown> };

/**
 * Parses a webhook event (raw string or already-parsed JSON) and types its resource by event family.
 * Pure: it does not verify the signature. Verify first, then parse.
 */
export function parseWebhookEvent(raw: unknown): ParsedWebhookEvent {
  let value = raw;
  if (typeof raw === 'string') {
    try {
      value = JSON.parse(raw);
    } catch {
      throw new PayPalValidationError('event', 'is not JSON.');
    }
  }
  const r = WebhookEventSchema.safeParse(value);
  if (!r.success)
    throw new PayPalValidationError(
      'event',
      r.error.issues.map((i) => `${i.path.join('.')} ${i.message}`).join('; '),
    );
  const event = r.data;
  const t = event.event_type;
  const typed = <S extends { safeParse(v: unknown): { success: boolean; data?: unknown } }>(schema: S) => {
    const p = schema.safeParse(event.resource);
    if (!p.success)
      throw new PayPalValidationError('event.resource', `does not look like the resource of ${t}.`);
    return p.data;
  };
  if (t.startsWith('CHECKOUT.ORDER.')) return { kind: 'order', event, resource: typed(OrderSchema) as Order };
  if (
    t === WEBHOOK_EVENTS.PAYMENT_CAPTURE_REFUNDED ||
    (t.startsWith('PAYMENT.CAPTURE.') && event.resource_type === 'refund')
  )
    return { kind: 'refund', event, resource: typed(RefundSchema) as Refund };
  if (t.startsWith('PAYMENT.CAPTURE.'))
    return { kind: 'capture', event, resource: typed(CaptureSchema) as Capture };
  if (t.startsWith('PAYMENT.AUTHORIZATION.'))
    return { kind: 'authorization', event, resource: typed(AuthorizationSchema) as Authorization };
  if (t.startsWith('CUSTOMER.DISPUTE.'))
    return { kind: 'dispute', event, resource: typed(DisputeSchema) as Dispute };
  if (t.startsWith('VAULT.PAYMENT-TOKEN.'))
    return { kind: 'payment-token', event, resource: typed(PaymentTokenSchema) as PaymentToken };
  return { kind: 'other', event, resource: event.resource };
}

export function isSubscribedEvent(eventType: string): eventType is WebhookEventName {
  return (SUBSCRIBED_WEBHOOK_EVENTS as readonly string[]).includes(eventType);
}

export interface VerifyResult {
  verified: boolean;
  /** PayPal's verification_status, or LOCAL_REJECT when the input failed local checks and nothing was sent. */
  status: string;
  reason?: string;
}

function checkWebhookUrl(url: string): void {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    throw new PayPalValidationError('url', 'is not a URL.');
  }
  if (u.protocol !== 'https:') throw new PayPalValidationError('url', 'must be HTTPS.');
  if (/^(localhost|127\.|0\.0\.0\.0|\[::1\])/.test(u.hostname))
    throw new PayPalValidationError('url', 'must be publicly reachable.');
  if (url.length > 2048) throw new PayPalValidationError('url', 'must be at most 2048 characters.');
}

export function webhooksApi(http: HttpCore) {
  const base = '/v1/notifications/webhooks';
  return {
    async create(input: {
      url: string;
      eventTypes?: readonly string[];
      requestId?: string;
    }): Promise<Webhook> {
      checkWebhookUrl(input.url);
      const names = [...new Set(input.eventTypes ?? SUBSCRIBED_WEBHOOK_EVENTS)];
      if (!names.length) throw new PayPalValidationError('eventTypes', 'at least one event is required.');
      const res = await http.request({
        method: 'POST',
        path: base,
        json: { url: input.url, event_types: names.map((name) => ({ name })) },
        requestId: input.requestId,
      });
      return parseWith(WebhookSchema, res, base);
    },

    async list(): Promise<Webhook[]> {
      return parseWith(WebhookListSchema, await http.request({ method: 'GET', path: base }), base).webhooks;
    },

    /** Deleting an already-deleted sandbox webhook answers 404 INVALID_RESOURCE_ID; that counts as done. */
    async delete(webhookId: string): Promise<'deleted' | 'already-gone'> {
      try {
        await http.request({ method: 'DELETE', path: `${base}/${pathId(webhookId, 'webhookId')}` });
        return 'deleted';
      } catch (err) {
        if (err instanceof PayPalApiError && err.status === 404 && err.name === 'INVALID_RESOURCE_ID')
          return 'already-gone';
        throw err;
      }
    },

    async listEventTypes(): Promise<EventTypeList['event_types']> {
      const path = '/v1/notifications/webhooks-event-types';
      return parseWith(EventTypeListSchema, await http.request({ method: 'GET', path }), path).event_types;
    },

    /**
     * Verifies a delivery with PayPal. Pass the body string exactly as received and the request headers.
     * Missing headers or a non-JSON body are rejected locally without a call.
     */
    async verifySignature(input: {
      rawBody: string;
      headers: IncomingHeaders;
      webhookId: string;
    }): Promise<VerifyResult> {
      let body: string;
      try {
        body = buildVerifySignatureBody(input.rawBody, input.headers, input.webhookId);
      } catch (err) {
        if (err instanceof PayPalValidationError)
          return { verified: false, status: 'LOCAL_REJECT', reason: err.message };
        throw err;
      }
      const path = '/v1/notifications/verify-webhook-signature';
      const res = await http.request({
        method: 'POST',
        path,
        raw: { body, contentType: 'application/json' },
      });
      const status = parseWith(VerifySignatureResponseSchema, res, path).verification_status;
      return { verified: status === 'SUCCESS', status };
    },

    /**
     * Sends a sample event. Simulated events carry webhook_id "WEBHOOK_ID" and never pass signature verification;
     * use them for listener plumbing only.
     */
    async simulateEvent(input: {
      eventType: string;
      webhookId?: string;
      url?: string;
      resourceVersion?: string;
    }): Promise<WebhookEvent> {
      if (!input.webhookId && !input.url)
        throw new PayPalValidationError('webhookId', 'give a webhook id or a url.');
      if (input.url) checkWebhookUrl(input.url);
      const json: Record<string, unknown> = { event_type: input.eventType };
      if (input.webhookId) json.webhook_id = input.webhookId;
      if (input.url) json.url = input.url;
      if (input.resourceVersion) json.resource_version = input.resourceVersion;
      const path = '/v1/notifications/simulate-event';
      return parseWith(WebhookEventSchema, await http.request({ method: 'POST', path, json }), path);
    },
  };
}

export type WebhooksApi = ReturnType<typeof webhooksApi>;
