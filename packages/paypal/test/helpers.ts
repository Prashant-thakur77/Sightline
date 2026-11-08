import { SANDBOX_API_BASE } from '@sightline/core/env';
import { createPayPalClient, type FetchLike, type PayPalClientOptions } from '../src';

export interface Call {
  method: string;
  url: string;
  path: string;
  query: URLSearchParams;
  headers: Record<string, string>;
  /** Body as sent: a string or bytes. */
  rawBody: string | Uint8Array | undefined;
  /** Body decoded as UTF-8 text. */
  text: string;
}

export type Reply =
  | { status: number; json?: unknown; text?: string; headers?: Record<string, string> }
  | ((call: Call) => Reply)
  | Error;

interface Route {
  method: string;
  path: string | RegExp;
  replies: Reply[];
}

export const TOKEN_PATH = '/v1/oauth2/token';

/** Route-based fetch double. A route's replies are used in order; the last one repeats. */
export function mockPayPal() {
  const calls: Call[] = [];
  const routes: Route[] = [];
  let tokens = 0;

  const fetch: FetchLike = async (url, init) => {
    const u = new URL(url);
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries((init.headers ?? {}) as Record<string, string>))
      headers[k.toLowerCase()] = v;
    const rawBody = init.body as string | Uint8Array | undefined;
    const text =
      rawBody === undefined ? '' : typeof rawBody === 'string' ? rawBody : new TextDecoder().decode(rawBody);
    const call: Call = {
      method: init.method ?? 'GET',
      url,
      path: u.pathname,
      query: u.searchParams,
      headers,
      rawBody,
      text,
    };
    calls.push(call);

    const route = routes.find(
      (r) =>
        r.method === call.method &&
        (typeof r.path === 'string' ? r.path === call.path : r.path.test(call.path)),
    );
    let reply: Reply;
    if (route) reply = route.replies.length > 1 ? route.replies.shift()! : route.replies[0]!;
    else if (call.path === TOKEN_PATH)
      reply = {
        status: 200,
        json: {
          access_token: `A21-token-${++tokens}`,
          token_type: 'Bearer',
          expires_in: 32400,
          app_id: 'APP-80W284485P519543T',
        },
      };
    else throw new Error(`unmocked ${call.method} ${call.path}`);

    while (typeof reply === 'function') reply = reply(call);
    if (reply instanceof Error) throw reply;
    const body = reply.json !== undefined ? JSON.stringify(reply.json) : (reply.text ?? '');
    return new Response(reply.status === 204 ? null : body, {
      status: reply.status,
      headers: { 'content-type': 'application/json', ...reply.headers },
    });
  };

  return {
    fetch,
    calls,
    on(method: string, path: string | RegExp, ...replies: Reply[]) {
      routes.push({ method, path, replies });
      return this;
    },
    /** Calls other than the OAuth token call. */
    api(): Call[] {
      return calls.filter((c) => c.path !== TOKEN_PATH);
    },
    tokenCalls(): Call[] {
      return calls.filter((c) => c.path === TOKEN_PATH);
    },
  };
}

export type Mock = ReturnType<typeof mockPayPal>;

export function testClient(mock: Mock, extra: Partial<PayPalClientOptions> = {}) {
  const clock = { t: Date.parse('2026-11-09T12:00:00Z') };
  const sleeps: number[] = [];
  const logs: { level: string; message: string; meta?: Record<string, unknown> }[] = [];
  const log = (level: string) => (message: string, meta?: Record<string, unknown>) =>
    logs.push({ level, message, meta });
  const client = createPayPalClient({
    clientId: 'AZgbuClientId',
    clientSecret: 'shh-secret',
    apiBase: SANDBOX_API_BASE,
    fetch: mock.fetch,
    now: () => clock.t,
    sleep: async (ms) => {
      sleeps.push(ms);
    },
    random: () => 0.5,
    logger: { debug: log('debug'), warn: log('warn'), error: log('error') },
    ...extra,
  });
  return { client, clock, sleeps, logs };
}

export interface ParsedPart {
  name: string | undefined;
  filename: string | undefined;
  contentType: string | undefined;
  bytes: Uint8Array;
  text: string;
}

/** Splits a multipart/form-data body into parts, byte-exact. */
export function parseMultipart(body: Uint8Array | string, contentType: string): ParsedPart[] {
  const boundary = /boundary=(.+)$/.exec(contentType)?.[1];
  if (!boundary) throw new Error('no boundary');
  const bytes = typeof body === 'string' ? new TextEncoder().encode(body) : body;
  const latin = Array.from(bytes, (b) => String.fromCharCode(b)).join('');
  const segments = latin.split(`--${boundary}`);
  if (segments.at(-1)?.trim() !== '--') throw new Error('missing closing boundary');
  return segments.slice(1, -1).map((seg) => {
    const s = seg.replace(/^\r\n/, '').replace(/\r\n$/, '');
    const split = s.indexOf('\r\n\r\n');
    const head = s.slice(0, split);
    const content = s.slice(split + 4);
    const partBytes = Uint8Array.from(content, (c) => c.charCodeAt(0));
    const disp = /Content-Disposition: form-data; name="([^"]*)"(?:; filename="([^"]*)")?/.exec(head);
    return {
      name: disp?.[1],
      filename: disp?.[2],
      contentType: /Content-Type: (.+)/.exec(head)?.[1]?.trim(),
      bytes: partBytes,
      text: new TextDecoder().decode(partBytes),
    };
  });
}

export function jsonOf(call: Call): any {
  return JSON.parse(call.text);
}

export const usd = (cents: number) => ({ cents, currency: 'USD' });

export const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
export const PDF = new TextEncoder().encode('%PDF-1.7\n%test\n');
export const JPEG = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46]);
