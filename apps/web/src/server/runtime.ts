import 'server-only';
import { PRODUCT_NAME, DEMO_MERCHANT_NAME, type Seller } from '@sightline/core';
import { env, integrations } from '@sightline/core/env';
import { getDb } from '@sightline/db';

/** Boot checks run on first import in every server process. Refuses non-sandbox PayPal config. */
export const ENV = env();
export const INTEGRATIONS = integrations(ENV);
export const db = () => getDb(ENV.DATABASE_URL);

export function demoSeller(): Seller {
  return { name: DEMO_MERCHANT_NAME, merchantId: ENV.PAYPAL_MERCHANT_ID ?? 'DEMO-STORE-UNCONFIGURED' };
}

export function appUrl(): string {
  return ENV.APP_URL.replace(/\/$/, '');
}

export { PRODUCT_NAME };
