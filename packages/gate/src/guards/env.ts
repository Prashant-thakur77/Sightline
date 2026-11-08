import { assertSandbox } from '@sightline/core/env';
import { fail, isValidDate, pass } from '../guard';
import type { Guard, GuardContext, GuardResult } from '../types';

const SOURCES = ['vault', 'paypal-popup'];
const INTENTS = ['CAPTURE', 'AUTHORIZE'];

/** The payment would run against the PayPal sandbox, with a real clock and a supported mode. */
export class EnvGuard implements Guard {
  readonly name = 'EnvGuard';

  async run({ intent, opts }: GuardContext): Promise<GuardResult> {
    const env = opts.env ?? {};
    try {
      assertSandbox({ PAYPAL_ENV: env.PAYPAL_ENV ?? '', PAYPAL_API_BASE: env.PAYPAL_API_BASE ?? '' });
    } catch {
      return fail(this.name, 'ENV_NOT_SANDBOX', 'PayPal is not configured for the sandbox', {
        paypalEnv: env.PAYPAL_ENV ?? null,
        apiBase: env.PAYPAL_API_BASE ?? null,
      });
    }
    if (!isValidDate(intent.now)) return fail(this.name, 'INVALID_CLOCK', 'The decision time is not a valid date');
    if (!SOURCES.includes(intent.paymentSource) || !INTENTS.includes(intent.intent)) {
      return fail(this.name, 'UNSUPPORTED_MODE', 'Unsupported payment source or intent', {
        paymentSource: String(intent.paymentSource),
        intent: String(intent.intent),
      });
    }
    return pass(this.name, 'Sandbox environment', { paypalEnv: env.PAYPAL_ENV ?? null });
  }
}
