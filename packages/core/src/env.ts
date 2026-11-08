import { z } from 'zod';

export const SANDBOX_API_BASE = 'https://api-m.sandbox.paypal.com';

const optional = z
  .string()
  .optional()
  .transform((v) => (v && v.trim().length > 0 ? v.trim() : undefined));

const EnvSchema = z.object({
  PRODUCT_NAME: optional,
  APP_URL: z.string().default('http://localhost:3100'),
  NODE_ENV: z.string().default('development'),
  SESSION_SECRET: optional,
  RECEIPT_SIGNING_KEY: optional,
  /** Bearer token for POST /api/maintenance (hold deadlines, retention, webhook retries). */
  MAINTENANCE_TOKEN: optional,
  HELPER_LINK_SECRET: optional,

  PAYPAL_ENV: z.string().default('sandbox'),
  PAYPAL_API_BASE: z.string().default(SANDBOX_API_BASE),
  PAYPAL_CLIENT_ID: optional,
  PAYPAL_CLIENT_SECRET: optional,
  PAYPAL_WEBHOOK_ID: optional,
  PAYPAL_MERCHANT_ID: optional,
  PAYPAL_SANDBOX_BUYER_EMAIL: optional,
  PAYPAL_SANDBOX_BUYER_PASSWORD: optional,
  PAYPAL_SANDBOX_BUYER_PAYER_ID: optional,

  ANTHROPIC_API_KEY: optional,
  AGENT_MODEL: optional,
  VISION_MODEL: optional,
  FAST_MODEL: optional,
  GEMINI_API_KEY: optional,

  DEEPGRAM_API_KEY: optional,
  CHANNEL3_API_KEY: optional,
  KERNEL_API_KEY: optional,

  DATABASE_URL: optional,
  S3_ENDPOINT: optional,
  S3_REGION: optional,
  S3_BUCKET: optional,
  S3_ACCESS_KEY_ID: optional,
  S3_SECRET_ACCESS_KEY: optional,
  VISION_SERVICE_URL: optional,

  RESEND_API_KEY: optional,
  EMAIL_FROM: optional,
  WEB_PUSH_VAPID_PUBLIC: optional,
  WEB_PUSH_VAPID_PRIVATE: optional,

  AG_STUDIO: optional,
  RENDER_API_KEY: optional,
  TWILIO_ACCOUNT_SID: optional,
  TWILIO_AUTH_TOKEN: optional,
  TWILIO_PHONE_NUMBER: optional,
});

export type Env = z.infer<typeof EnvSchema> & { PAYPAL_API_BASE: string };

export class SandboxOnlyError extends Error {
  constructor(detail: string) {
    super(`Refusing to start: PayPal must be sandbox only. ${detail}`);
    this.name = 'SandboxOnlyError';
  }
}

/** Throws unless PayPal is configured for the sandbox. Called at boot by every process. */
export function assertSandbox(env: Pick<Env, 'PAYPAL_ENV' | 'PAYPAL_API_BASE'>): void {
  if (env.PAYPAL_ENV !== 'sandbox') throw new SandboxOnlyError(`PAYPAL_ENV is "${env.PAYPAL_ENV}".`);
  if (env.PAYPAL_API_BASE.replace(/\/+$/, '') !== SANDBOX_API_BASE)
    throw new SandboxOnlyError(`PAYPAL_API_BASE is "${env.PAYPAL_API_BASE}".`);
}

let cached: Env | undefined;

export function loadEnv(source: Record<string, string | undefined> = process.env): Env {
  const parsed = EnvSchema.parse(source) as Env;
  assertSandbox(parsed);
  return parsed;
}

export function env(): Env {
  if (!cached) cached = loadEnv();
  return cached;
}

/** Test helper. */
export function resetEnvCache(): void {
  cached = undefined;
}

export interface Integrations {
  paypal: boolean;
  anthropic: boolean;
  deepgram: boolean;
  channel3: boolean;
  kernel: boolean;
  s3: boolean;
  email: boolean;
  webPush: boolean;
  agStudio: boolean;
  gemini: boolean;
  vision: boolean;
}

/** Which sponsor and vendor integrations have keys. The UI shows this honestly. */
export function integrations(e: Env = env()): Integrations {
  return {
    paypal: Boolean(e.PAYPAL_CLIENT_ID && e.PAYPAL_CLIENT_SECRET),
    anthropic: Boolean(e.ANTHROPIC_API_KEY),
    deepgram: Boolean(e.DEEPGRAM_API_KEY),
    channel3: Boolean(e.CHANNEL3_API_KEY),
    kernel: Boolean(e.KERNEL_API_KEY),
    s3: Boolean(e.S3_ENDPOINT && e.S3_ACCESS_KEY_ID && e.S3_SECRET_ACCESS_KEY && e.S3_BUCKET),
    email: Boolean(e.RESEND_API_KEY && e.EMAIL_FROM),
    webPush: Boolean(e.WEB_PUSH_VAPID_PUBLIC && e.WEB_PUSH_VAPID_PRIVATE),
    agStudio: Boolean(e.AG_STUDIO),
    gemini: Boolean(e.GEMINI_API_KEY),
    vision: Boolean(e.VISION_SERVICE_URL),
  };
}
