import 'server-only';
import { createPayPalClient, type PayPalClient } from '@sightline/paypal';
import { ENV, INTEGRATIONS } from './runtime';

let client: PayPalClient | undefined;

export class PayPalNotConfiguredError extends Error {
  constructor() {
    super('PayPal sandbox credentials are not configured');
  }
}

export function paypal(): PayPalClient {
  if (!INTEGRATIONS.paypal) throw new PayPalNotConfiguredError();
  if (!client) {
    client = createPayPalClient({
      clientId: ENV.PAYPAL_CLIENT_ID!,
      clientSecret: ENV.PAYPAL_CLIENT_SECRET!,
      apiBase: ENV.PAYPAL_API_BASE,
      paypalEnv: ENV.PAYPAL_ENV,
      logger: {
        warn: (msg: string, meta?: unknown) => console.warn('[paypal]', msg, meta ?? ''),
        error: (msg: string, meta?: unknown) => console.error('[paypal]', msg, meta ?? ''),
      },
    } as Parameters<typeof createPayPalClient>[0]);
  }
  return client;
}
