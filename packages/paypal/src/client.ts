import { assertSandbox } from '@sightline/core/env';
import {
  fetchClientToken,
  fetchUserIdToken,
  TokenCache,
  type ClientTokenOptions,
  type UserIdTokenOptions,
} from './auth';
import { buyerApi, buildAuthAssertion, type AuthAssertionSubject } from './buyer';
import { merchantDisputesApi, sandboxDisputesApi } from './disputes';
import {
  DEFAULT_RETRY,
  HttpCore,
  type FetchLike,
  type HttpResult,
  type PayPalLogger,
  type RequestSpec,
  type RetryPolicy,
} from './http';
import { ordersApi } from './orders';
import { paymentsApi } from './payments';
import { trackingApi } from './tracking';
import { searchTransactions, type TransactionSearchInput } from './transactions';
import { vaultApi } from './vault';
import { webhooksApi } from './webhooks';

export interface PayPalClientOptions {
  clientId: string;
  clientSecret: string;
  /** Must be https://api-m.sandbox.paypal.com; anything else is refused at construction. */
  apiBase: string;
  /** Defaults to "sandbox"; pass env().PAYPAL_ENV so a misconfigured process fails here too. */
  paypalEnv?: string;
  fetch?: FetchLike;
  logger?: PayPalLogger;
  /** Clock in ms, for token expiry and date windows. */
  now?: () => number;
  /** Injected in tests to skip real waits between retries. */
  sleep?: (ms: number) => Promise<void>;
  /** Jitter source in [0, 1). */
  random?: () => number;
  retry?: Partial<RetryPolicy>;
}

export function createPayPalClient(opts: PayPalClientOptions) {
  assertSandbox({ PAYPAL_ENV: opts.paypalEnv ?? 'sandbox', PAYPAL_API_BASE: opts.apiBase });
  if (!opts.clientId || !opts.clientSecret) throw new Error('PayPal clientId and clientSecret are required.');
  const apiBase = opts.apiBase.replace(/\/+$/, '');
  const now = opts.now ?? Date.now;
  const tokens = new TokenCache(now);
  const http = new HttpCore({
    apiBase,
    fetch: opts.fetch ?? ((input, init) => globalThis.fetch(input, init)),
    logger: opts.logger ?? {},
    now,
    sleep: opts.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms))),
    random: opts.random ?? Math.random,
    retry: { ...DEFAULT_RETRY, ...opts.retry },
    basicAuth: `Basic ${Buffer.from(`${opts.clientId}:${opts.clientSecret}`).toString('base64')}`,
    bearer: tokens,
  });
  tokens.attach(http);

  return {
    apiBase,
    auth: {
      /** Cached client-credentials access token (server side only). */
      accessToken: () => tokens.get(),
      /** Browser-safe client token for JS SDK v6 `clientToken` mode. */
      clientToken: (o?: ClientTokenOptions) => fetchClientToken(http, o),
      /** User id token for a returning payer's vaulted PayPal. */
      userIdToken: (o?: UserIdTokenOptions) => fetchUserIdToken(http, o),
      /** PayPal-Auth-Assertion JWT for this app acting for a sandbox buyer. */
      buildAuthAssertion: (subject: AuthAssertionSubject) => buildAuthAssertion(opts.clientId, subject),
    },
    orders: ordersApi(http),
    payments: paymentsApi(http),
    vault: vaultApi(http),
    tracking: trackingApi(http),
    disputes: merchantDisputesApi(http),
    sandbox: sandboxDisputesApi(http),
    /** Buyer-side dispute calls, each carrying the buyer's PayPal-Auth-Assertion. */
    buyer: (who: AuthAssertionSubject | { assertion: string }) =>
      buyerApi(
        http,
        'assertion' in who && who.assertion
          ? who.assertion
          : buildAuthAssertion(opts.clientId, who as AuthAssertionSubject),
      ),
    webhooks: webhooksApi(http),
    transactions: { search: (input: TransactionSearchInput) => searchTransactions(http, input) },
    /** Low-level escape hatch with the same auth, retries and sandbox guard. */
    request: (spec: RequestSpec): Promise<HttpResult> => http.request(spec),
  };
}

export type PayPalClient = ReturnType<typeof createPayPalClient>;
