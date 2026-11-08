import { PayPalResponseShapeError } from './errors';
import type { HttpCore } from './http';
import { parseWith } from './http';
import { TokenResponseSchema } from './schemas';

/** Refresh this long before PayPal's stated expiry. */
export const TOKEN_REFRESH_MARGIN_MS = 60_000;

const TOKEN_PATH = '/v1/oauth2/token';

/**
 * Client-credentials token cache. One in-flight fetch is shared by concurrent callers; the token is
 * reused until 60 s before `expires_in` runs out.
 */
export class TokenCache {
  private token: { value: string; expiresAt: number } | undefined;
  private inflight: Promise<string> | undefined;
  private http: HttpCore | undefined;

  constructor(private readonly now: () => number) {}

  attach(http: HttpCore): void {
    this.http = http;
  }

  async get(): Promise<string> {
    if (this.token && this.now() < this.token.expiresAt - TOKEN_REFRESH_MARGIN_MS) return this.token.value;
    if (!this.inflight) {
      this.inflight = this.fetchToken().finally(() => {
        this.inflight = undefined;
      });
    }
    return this.inflight;
  }

  invalidate(): void {
    this.token = undefined;
  }

  private async fetchToken(): Promise<string> {
    if (!this.http) throw new Error('TokenCache is not attached to an HTTP core.');
    const res = await this.http.request({
      method: 'POST',
      path: TOKEN_PATH,
      auth: 'basic',
      raw: { body: 'grant_type=client_credentials', contentType: 'application/x-www-form-urlencoded' },
    });
    const body = parseWith(TokenResponseSchema, res, TOKEN_PATH);
    this.token = { value: body.access_token, expiresAt: this.now() + body.expires_in * 1000 };
    return body.access_token;
  }
}

export interface ClientTokenOptions {
  /** Registered origins only. Omit in sandbox and local development: PayPal rejects "localhost". */
  domains?: string[];
  /** Defaults to "sdk_init", which the SDK needs for identity flows. */
  intent?: string;
}

export interface BrowserToken {
  token: string;
  expiresIn: number;
}

/**
 * Browser-safe client token for the JS SDK v6 `createInstance({ clientToken })` path.
 * PayPal returns it in `access_token` even though `response_type=client_token`.
 */
export async function fetchClientToken(http: HttpCore, opts: ClientTokenOptions = {}): Promise<BrowserToken> {
  const params = new URLSearchParams({
    grant_type: 'client_credentials',
    response_type: 'client_token',
    intent: opts.intent ?? 'sdk_init',
  });
  for (const d of opts.domains ?? []) params.append('domains[]', d);
  const res = await http.request({
    method: 'POST',
    path: TOKEN_PATH,
    auth: 'basic',
    raw: { body: params.toString(), contentType: 'application/x-www-form-urlencoded' },
  });
  const body = parseWith(TokenResponseSchema, res, TOKEN_PATH);
  return { token: body.access_token, expiresIn: body.expires_in };
}

export interface UserIdTokenOptions {
  /** PayPal-generated customer id of a returning payer (from the vault). Omit for a first-time payer. */
  customerId?: string;
}

/** User id token (`response_type=id_token`), the documented way to show a returning payer's vaulted PayPal. */
export async function fetchUserIdToken(http: HttpCore, opts: UserIdTokenOptions = {}): Promise<BrowserToken> {
  const params = new URLSearchParams({ grant_type: 'client_credentials', response_type: 'id_token' });
  if (opts.customerId) params.append('target_customer_id', opts.customerId);
  const res = await http.request({
    method: 'POST',
    path: TOKEN_PATH,
    auth: 'basic',
    raw: { body: params.toString(), contentType: 'application/x-www-form-urlencoded' },
  });
  const body = parseWith(TokenResponseSchema, res, TOKEN_PATH);
  if (!body.id_token) throw new PayPalResponseShapeError(TOKEN_PATH, ['id_token is missing'], res.debugId);
  return { token: body.id_token, expiresIn: body.expires_in };
}
