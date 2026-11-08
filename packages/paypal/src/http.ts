import { randomUUID } from 'node:crypto';
import type { z } from 'zod';
import {
  PayPalApiError,
  PayPalInstrumentDeclinedError,
  PayPalNetworkError,
  PayPalResponseShapeError,
  PayPalValidationError,
  type PayPalErrorDetail,
  type PayPalErrorLink,
} from './errors';

export type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

/** Every method is optional so a plain `console` or a partial logger both fit. Tokens and secrets are never logged. */
export interface PayPalLogger {
  debug?(message: string, meta?: Record<string, unknown>): void;
  info?(message: string, meta?: Record<string, unknown>): void;
  warn?(message: string, meta?: Record<string, unknown>): void;
  error?(message: string, meta?: Record<string, unknown>): void;
}

export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

export interface RequestSpec {
  method: HttpMethod;
  /** Path below the API base, starting with "/". Absolute URLs are refused. */
  path: string;
  query?: Record<string, string | number | boolean | undefined>;
  /** JSON body; serialised with JSON.stringify. */
  json?: unknown;
  /** Pre-serialised body (multipart, form-encoded, or a JSON string that must keep its exact bytes). */
  raw?: { body: string | Uint8Array<ArrayBuffer>; contentType: string };
  /** PayPal-Request-Id. POSTs without one get a fresh UUID, reused on every retry of that call. */
  requestId?: string;
  /** Sends `Prefer: return=representation` when true. */
  representation?: boolean;
  headers?: Record<string, string>;
  /** Defaults to the cached bearer token. "basic" is only used by the OAuth token call. */
  auth?: 'bearer' | 'basic';
}

export interface HttpResult {
  status: number;
  body: unknown;
  headers: Headers;
  debugId: string | undefined;
  requestId: string | undefined;
}

export interface RetryPolicy {
  /** Retries after the first attempt for 429, 5xx and network errors. */
  maxRetries: number;
  baseDelayMs: number;
  maxDelayMs: number;
  /** Upper bound for a server-supplied Retry-After. */
  maxRetryAfterMs: number;
}

export const DEFAULT_RETRY: RetryPolicy = {
  maxRetries: 3,
  baseDelayMs: 300,
  maxDelayMs: 5_000,
  maxRetryAfterMs: 30_000,
};

/** The strictest PayPal-Request-Id limit in the APIs used here (Payment Method Tokens v3: 108). */
export const REQUEST_ID_MAX_LENGTH = 108;

export function assertRequestId(requestId: unknown, field = 'requestId'): string {
  if (typeof requestId !== 'string' || requestId.length === 0)
    throw new PayPalValidationError(field, 'a PayPal-Request-Id is required for calls that move money.');
  if (requestId.length > REQUEST_ID_MAX_LENGTH)
    throw new PayPalValidationError(field, `must be at most ${REQUEST_ID_MAX_LENGTH} characters.`);
  if (!/^[\x21-\x7e]+$/.test(requestId))
    throw new PayPalValidationError(field, 'must be printable ASCII without spaces.');
  return requestId;
}

/** Validates an id before it is placed in a URL path. */
export function pathId(value: unknown, field: string): string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{1,255}$/.test(value))
    throw new PayPalValidationError(field, 'must be a PayPal id (letters, digits, "-" or "_").');
  return value;
}

export interface HttpCoreOptions {
  apiBase: string;
  fetch: FetchLike;
  logger: PayPalLogger;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  random: () => number;
  retry: RetryPolicy;
  basicAuth: string;
  bearer: { get(): Promise<string>; invalidate(): void };
}

export class HttpCore {
  constructor(private readonly o: HttpCoreOptions) {}

  /** The injected clock, shared with date-window validation. */
  now(): number {
    return this.o.now();
  }

  async request(spec: RequestSpec): Promise<HttpResult> {
    if (!spec.path.startsWith('/') || spec.path.includes('://') || spec.path.startsWith('//'))
      throw new PayPalValidationError('path', 'must be a path below the sandbox API base.');
    const url = this.o.apiBase + spec.path + queryString(spec.query);
    const mode = spec.auth ?? 'bearer';
    // The OAuth token call is not idempotency-keyed; every other POST is.
    const requestId =
      spec.method === 'POST' && mode === 'bearer' ? (spec.requestId ?? randomUUID()) : spec.requestId;
    const body = spec.raw ? spec.raw.body : spec.json === undefined ? undefined : JSON.stringify(spec.json);
    const contentType = spec.raw
      ? spec.raw.contentType
      : spec.json === undefined
        ? undefined
        : 'application/json';

    let attempt = 0;
    let refreshedAfter401 = false;
    for (;;) {
      const headers: Record<string, string> = { Accept: 'application/json', ...spec.headers };
      if (contentType) headers['Content-Type'] = contentType;
      if (requestId) headers['PayPal-Request-Id'] = requestId;
      if (spec.representation) headers['Prefer'] = 'return=representation';
      headers['Authorization'] = mode === 'basic' ? this.o.basicAuth : `Bearer ${await this.o.bearer.get()}`;

      let res: Response;
      try {
        res = await this.o.fetch(url, { method: spec.method, headers, body: body as BodyInit | undefined });
      } catch (cause) {
        if (attempt < this.o.retry.maxRetries) {
          attempt++;
          const delay = this.backoff(attempt);
          this.o.logger.warn?.('paypal network error, retrying', {
            path: spec.path,
            attempt,
            delayMs: delay,
          });
          await this.o.sleep(delay);
          continue;
        }
        throw new PayPalNetworkError(spec.path, attempt + 1, { cause });
      }

      const parsed = await readBody(res);
      const debugId = res.headers.get('paypal-debug-id') ?? stringField(parsed, 'debug_id');

      if (res.ok) {
        this.o.logger.debug?.('paypal ok', {
          method: spec.method,
          path: spec.path,
          status: res.status,
          debugId,
        });
        return { status: res.status, body: parsed, headers: res.headers, debugId, requestId };
      }

      if (res.status === 401 && mode === 'bearer' && !refreshedAfter401) {
        refreshedAfter401 = true;
        this.o.bearer.invalidate();
        this.o.logger.warn?.('paypal 401, refreshing token once', { path: spec.path, debugId });
        continue;
      }

      if ((res.status === 429 || res.status >= 500) && attempt < this.o.retry.maxRetries) {
        attempt++;
        const retryAfter =
          res.status === 429 ? parseRetryAfter(res.headers.get('retry-after'), this.o.now()) : undefined;
        const delay =
          retryAfter !== undefined
            ? Math.min(retryAfter, this.o.retry.maxRetryAfterMs)
            : this.backoff(attempt);
        this.o.logger.warn?.('paypal retryable status, retrying', {
          path: spec.path,
          status: res.status,
          attempt,
          delayMs: delay,
          debugId,
        });
        await this.o.sleep(delay);
        continue;
      }

      const err = toApiError(res.status, parsed, {
        debugId,
        method: spec.method,
        path: spec.path,
        requestId,
      });
      this.o.logger.error?.('paypal error', {
        method: spec.method,
        path: spec.path,
        status: err.status,
        name: err.name,
        issue: err.issue,
        debugId: err.debugId,
      });
      throw err;
    }
  }

  /** Jittered exponential backoff: base * 2^(attempt-1), capped, scaled by a factor in [0.5, 1). */
  backoff(attempt: number): number {
    const exp = Math.min(this.o.retry.maxDelayMs, this.o.retry.baseDelayMs * 2 ** (attempt - 1));
    return Math.round(exp * (0.5 + this.o.random() * 0.5));
  }
}

export function queryString(query: RequestSpec['query']): string {
  if (!query) return '';
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(query)) if (v !== undefined) params.append(k, String(v));
  const s = params.toString();
  return s ? `?${s}` : '';
}

/** Retry-After is either delta-seconds or an HTTP date. Returns milliseconds, or undefined when absent or unreadable. */
export function parseRetryAfter(value: string | null, nowMs: number): number | undefined {
  if (!value) return undefined;
  const trimmed = value.trim();
  if (/^\d+(\.\d+)?$/.test(trimmed)) return Math.round(Number(trimmed) * 1000);
  const at = Date.parse(trimmed);
  if (Number.isNaN(at)) return undefined;
  return Math.max(0, at - nowMs);
}

async function readBody(res: Response): Promise<unknown> {
  if (res.status === 204) return undefined;
  const text = await res.text();
  if (text.length === 0) return undefined;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

function stringField(body: unknown, key: string): string | undefined {
  if (body && typeof body === 'object' && key in body) {
    const v = (body as Record<string, unknown>)[key];
    return typeof v === 'string' ? v : undefined;
  }
  return undefined;
}

export function toApiError(
  status: number,
  body: unknown,
  ctx: { debugId?: string; method?: string; path?: string; requestId?: string },
): PayPalApiError {
  const b = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>;
  // REST errors use name/message/details; OAuth errors use error/error_description.
  const name =
    (typeof b.name === 'string' && b.name) || (typeof b.error === 'string' && b.error) || `HTTP_${status}`;
  const message =
    (typeof b.message === 'string' && b.message) ||
    (typeof b.error_description === 'string' && b.error_description) ||
    (typeof body === 'string' && body.slice(0, 200)) ||
    `PayPal returned HTTP ${status}.`;
  const details = Array.isArray(b.details)
    ? (b.details.filter((d) => d && typeof d === 'object') as PayPalErrorDetail[])
    : [];
  const links = Array.isArray(b.links) ? (b.links as PayPalErrorLink[]) : [];
  const init = {
    status,
    name,
    message,
    debugId: ctx.debugId ?? stringField(body, 'debug_id'),
    details,
    links,
    method: ctx.method,
    path: ctx.path,
    requestId: ctx.requestId,
  };
  if (status === 422 && details.some((d) => d.issue === 'INSTRUMENT_DECLINED'))
    return new PayPalInstrumentDeclinedError(init);
  return new PayPalApiError(init);
}

/** Parses a 2xx body with a zod schema; unknown fields pass through untouched. */
export function parseWith<S extends z.ZodType>(schema: S, result: HttpResult, path: string): z.infer<S> {
  const r = schema.safeParse(result.body);
  if (!r.success)
    throw new PayPalResponseShapeError(
      path,
      r.error.issues.map((i) => `${i.path.join('.') || '(root)'} ${i.message}`),
      result.debugId,
    );
  return r.data;
}
