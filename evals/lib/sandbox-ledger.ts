/**
 * Sandbox-ledger mode: the real payment path against the PayPal sandbox, counted from PayPal's
 * own records.
 *
 *   NetworkEdge  wraps fetch for the PayPal client: paces requests (at most 2 a second), backs off
 *                and re-sends on 429, records every call (never headers or tokens) and the order
 *                and authorization ids in PayPal's answers, and can drop an order-create response
 *                after PayPal received and answered the request (a lost response).
 *   readLedger   GETs each PayPal order and each of its authorizations.
 *   ledgerBreaches  compares a PayPal order with the terms the buyer confirmed in the readback.
 *   voidAll      voids every authorization still open, so the sandbox buyer is never charged.
 *   transactionSearchCheck  secondary cross-check with /v1/reporting/transactions, which can lag by hours.
 */
import path from 'node:path';
import { existsSync } from 'node:fs';
import { assertSandbox } from '@sightline/core/env';
import { parseMoney } from '@sightline/core';
import { paypalRequestId } from '@sightline/evidence';
import type { ConfirmedReadback, GateOptions } from '@sightline/gate';
import type { Cart } from '@sightline/core';
import { hashReadbackBinding } from '@sightline/evidence';
import {
  PayPalApiError,
  authorizationFromOrder,
  completeOrder,
  createPayPalClient,
  createVaultOrder,
  orderInputFromCart,
  type FetchLike,
  type Order,
  type PayPalClient,
} from '@sightline/paypal';
import { SIM_SIGNING_KEY } from './commerce';
import { REPO_ROOT } from './results';

export interface EdgeCall {
  scenario: string;
  at: string;
  method: string;
  /** Path with PayPal ids replaced by ":id"; no query string. */
  route: string;
  path: string;
  status?: number;
  paypalRequestId?: string;
  debugId?: string;
  /** The response reached the edge and was thrown away before the client saw it. */
  dropped: boolean;
  orderId?: string;
  authorizationIds?: string[];
  captureIds?: string[];
  error?: string;
}

export interface EdgeOptions {
  fetch?: FetchLike;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  /** Minimum gap between request starts. 500 ms = at most 2 requests a second. */
  minIntervalMs?: number;
  /** Re-sends after a 429 before the 429 is handed to the client. */
  max429Retries?: number;
}

const ORDERS = '/v2/checkout/orders';

function routeOf(p: string): string {
  return p.replace(/\/(orders|authorizations|captures|refunds)\/[A-Za-z0-9_-]+/g, '/$1/:id');
}

function headerOf(init: RequestInit, name: string): string | undefined {
  const h = init.headers as Record<string, string> | undefined;
  if (!h) return undefined;
  const k = Object.keys(h).find((x) => x.toLowerCase() === name.toLowerCase());
  return k ? h[k] : undefined;
}

/** Order, authorization and capture ids in an Orders v2 or Payments v2 answer. */
function idsIn(p: string, body: unknown): Pick<EdgeCall, 'orderId' | 'authorizationIds' | 'captureIds'> {
  if (!body || typeof body !== 'object') return {};
  const b = body as { id?: string; purchase_units?: Array<{ payments?: { authorizations?: Array<{ id?: string }>; captures?: Array<{ id?: string }> } }> };
  const out: Pick<EdgeCall, 'orderId' | 'authorizationIds' | 'captureIds'> = {};
  if (p.startsWith(ORDERS) && b.id) out.orderId = b.id;
  const auths = (b.purchase_units ?? []).flatMap((u) => u.payments?.authorizations ?? []).map((a) => a.id).filter((x): x is string => !!x);
  const caps = (b.purchase_units ?? []).flatMap((u) => u.payments?.captures ?? []).map((a) => a.id).filter((x): x is string => !!x);
  if (p.startsWith('/v2/payments/authorizations/') && b.id && !p.endsWith('/capture')) auths.push(b.id);
  if (p.endsWith('/capture') && p.startsWith('/v2/payments/') && b.id) caps.push(b.id);
  if (auths.length) out.authorizationIds = [...new Set(auths)];
  if (caps.length) out.captureIds = [...new Set(caps)];
  return out;
}

export class NetworkEdge {
  scenario = '';
  /** The next N order-create responses are dropped after PayPal answered them. */
  dropCreates = 0;
  readonly calls: EdgeCall[] = [];
  private last = Number.NEGATIVE_INFINITY;
  private readonly o: Required<EdgeOptions>;

  constructor(o: EdgeOptions = {}) {
    this.o = {
      fetch: o.fetch ?? ((input, init) => globalThis.fetch(input, init)),
      now: o.now ?? Date.now,
      sleep: o.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms))),
      minIntervalMs: o.minIntervalMs ?? 500,
      max429Retries: o.max429Retries ?? 6,
    };
  }

  private async pace(): Promise<void> {
    const wait = this.last + this.o.minIntervalMs - this.o.now();
    if (wait > 0) await this.o.sleep(wait);
    this.last = this.o.now();
  }

  fetch: FetchLike = async (url, init) => {
    const u = new URL(url);
    const p = u.pathname;
    const method = init.method ?? 'GET';
    const isToken = p === '/v1/oauth2/token';
    for (let attempt = 0; ; attempt++) {
      await this.pace();
      const call: EdgeCall = {
        scenario: this.scenario,
        at: new Date(this.o.now()).toISOString(),
        method,
        route: routeOf(p),
        path: p,
        dropped: false,
        ...(headerOf(init, 'PayPal-Request-Id') ? { paypalRequestId: headerOf(init, 'PayPal-Request-Id') } : {}),
      };
      this.calls.push(call);
      let res: Response;
      try {
        res = await this.o.fetch(url, init);
      } catch (e) {
        call.error = (e as Error).message;
        throw e;
      }
      call.status = res.status;
      const debugId = res.headers.get('paypal-debug-id');
      if (debugId) call.debugId = debugId;
      if (res.status === 429 && attempt < this.o.max429Retries) {
        const after = Number(res.headers.get('retry-after'));
        const backoff = Number.isFinite(after) && after > 0 ? after * 1000 : Math.min(30_000, 1000 * 2 ** attempt);
        // Slow the whole run down too, not just this request.
        this.o.minIntervalMs = Math.min(4000, this.o.minIntervalMs * 2);
        await this.o.sleep(backoff);
        continue;
      }
      // Token answers carry the access token: never read or kept.
      if (isToken) return res;
      const text = await res.clone().text();
      let body: unknown;
      try {
        body = text ? JSON.parse(text) : undefined;
      } catch {
        body = undefined;
      }
      if (res.ok) Object.assign(call, idsIn(p, body));
      if (method === 'POST' && p === ORDERS && this.dropCreates > 0) {
        this.dropCreates--;
        call.dropped = true;
        // PayPal received the request and answered; the answer is lost on the way back.
        throw new TypeError('fetch failed: response dropped at the network edge (sandbox-ledger eval)');
      }
      return res;
    }
  };

  private where(scenario?: string) {
    return this.calls.filter((c) => scenario === undefined || c.scenario === scenario);
  }

  /** Distinct PayPal order ids that order-create answers carried, including dropped answers. */
  ordersCreated(scenario?: string): string[] {
    return [...new Set(this.where(scenario).filter((c) => c.method === 'POST' && c.path === ORDERS && c.orderId).map((c) => c.orderId!))];
  }

  authorizationsSeen(scenario?: string): string[] {
    return [...new Set(this.where(scenario).flatMap((c) => c.authorizationIds ?? []))];
  }

  /** Calls per method and route, e.g. "POST /v2/checkout/orders". */
  summary(scenario?: string): Record<string, number> {
    const out: Record<string, number> = {};
    for (const c of this.where(scenario)) out[`${c.method} ${c.route}`] = (out[`${c.method} ${c.route}`] ?? 0) + 1;
    return out;
  }
}

// ---------------------------------------------------------------------------------------------
// PayPal's record of an order

export interface LedgerPayment {
  id: string;
  status: string;
  amountCents: number;
  currency: string;
}

export interface LedgerOrder {
  id: string;
  status: string;
  amountCents: number;
  currency: string;
  payeeMerchantId?: string;
  quantity: number;
  invoiceId?: string;
  customId?: string;
  itemDescriptions: string[];
  authorizations: LedgerPayment[];
  captures: LedgerPayment[];
}

type Loose = Record<string, any>;

function payment(p: Loose): LedgerPayment {
  const m = parseMoney(String(p.amount?.value ?? '0'), p.amount?.currency_code ?? 'USD');
  return { id: String(p.id), status: String(p.status ?? ''), amountCents: m.cents, currency: m.currency };
}

/** The fields this suite compares, read from an Orders v2 GET answer. */
export function orderRecord(order: Order): LedgerOrder {
  const units = (order.purchase_units ?? []) as Loose[];
  const u = units[0] ?? {};
  const total = parseMoney(String(u.amount?.value ?? '0'), u.amount?.currency_code ?? 'USD');
  const items = units.flatMap((x) => (x.items ?? []) as Loose[]);
  return {
    id: order.id,
    status: String(order.status ?? ''),
    amountCents: units.reduce((a, x) => a + parseMoney(String(x.amount?.value ?? '0')).cents, 0),
    currency: total.currency,
    ...(u.payee?.merchant_id ? { payeeMerchantId: String(u.payee.merchant_id) } : {}),
    quantity: items.reduce((a, it) => a + Number(it.quantity ?? 0), 0),
    ...(u.invoice_id ? { invoiceId: String(u.invoice_id) } : {}),
    ...(u.custom_id ? { customId: String(u.custom_id) } : {}),
    itemDescriptions: items.map((it) => String(it.description ?? '')),
    authorizations: units.flatMap((x) => (x.payments?.authorizations ?? []) as Loose[]).map(payment),
    captures: units.flatMap((x) => (x.payments?.captures ?? []) as Loose[]).map(payment),
  };
}

export interface ConfirmedTerms {
  amountCents: number;
  currency: string;
  payeeMerchantId: string;
  quantity: number;
}

/** What the buyer heard and confirmed: the readback's total and line quantities; the payee is the store merchant it names. */
export function termsFromReadback(rb: Pick<ConfirmedReadback, 'fields'>, storeMerchantId: string): ConfirmedTerms {
  const total = rb.fields.find((f) => f.key === 'total')?.value;
  if (!total) throw new Error('Readback has no total field');
  const m = parseMoney(total.replace(/[^0-9.]/g, ''));
  const quantity = rb.fields.filter((f) => /^line\d+\.quantity$/.test(f.key)).reduce((a, f) => a + Number(f.value), 0);
  return { amountCents: m.cents, currency: m.currency, payeeMerchantId: storeMerchantId, quantity };
}

export type LedgerBreach = 'wrong_amount' | 'wrong_payee' | 'wrong_quantity' | 'authorization_amount' | 'captured';

export function ledgerBreaches(o: LedgerOrder, t: ConfirmedTerms): LedgerBreach[] {
  const out: LedgerBreach[] = [];
  if (o.amountCents !== t.amountCents || o.currency !== t.currency) out.push('wrong_amount');
  if (o.payeeMerchantId !== t.payeeMerchantId) out.push('wrong_payee');
  if (o.quantity !== t.quantity) out.push('wrong_quantity');
  if (o.authorizations.some((a) => a.amountCents !== t.amountCents || a.currency !== t.currency)) out.push('authorization_amount');
  if (o.captures.length > 0) out.push('captured');
  return out;
}

/** GET each order, then GET each of its authorizations (their status and amount as PayPal holds them now). */
export async function readLedger(pp: PayPalClient, orderIds: string[]): Promise<LedgerOrder[]> {
  const out: LedgerOrder[] = [];
  for (const id of orderIds) {
    const rec = orderRecord(await pp.orders.get(id));
    rec.authorizations = await Promise.all(
      rec.authorizations.map(async (a) => {
        const got = await pp.payments.getAuthorization(a.id);
        return payment(got as Loose);
      }),
    );
    out.push(rec);
  }
  return out;
}

export interface VoidResult {
  authorizationId: string;
  before: string;
  after?: string;
  error?: string;
}

/** Voids every authorization that is still open. The request id is derived as the app derives it. */
export async function voidAll(pp: PayPalClient, auths: LedgerPayment[]): Promise<VoidResult[]> {
  const out: VoidResult[] = [];
  for (const a of auths) {
    if (!['CREATED', 'PENDING', 'PARTIALLY_CAPTURED'].includes(a.status)) {
      out.push({ authorizationId: a.id, before: a.status, after: a.status });
      continue;
    }
    try {
      const v = await pp.payments.voidAuthorization(a.id, { requestId: paypalRequestId('void', a.id) });
      out.push({ authorizationId: a.id, before: a.status, after: v?.status ?? 'VOIDED (204)' });
    } catch (e) {
      out.push({ authorizationId: a.id, before: a.status, error: e instanceof PayPalApiError ? `${e.status} ${e.name ?? ''} ${e.issue ?? ''}`.trim() : (e as Error).message });
    }
  }
  return out;
}

export interface TransactionSearchCheck {
  enabled: boolean;
  window: { start: string; end: string };
  checkedAt: string;
  status?: number;
  error?: string;
  /** Transactions PayPal listed in the window. */
  listed: number;
  /** Of our authorization ids, how many appear as a transaction id. */
  authorizationsFound: number;
  authorizationsExpected: number;
  /** Listed transactions whose invoice id is one of ours. */
  byInvoice: Record<string, number>;
  note: string;
}

/** Secondary check: Transaction Search can lag by hours, so a missing id here is not evidence of anything. */
export async function transactionSearchCheck(pp: PayPalClient, a: { start: Date; end: Date; authorizationIds: string[]; invoiceIds: string[] }): Promise<TransactionSearchCheck> {
  const base = {
    window: { start: a.start.toISOString(), end: a.end.toISOString() },
    checkedAt: new Date().toISOString(),
    authorizationsExpected: a.authorizationIds.length,
    note: 'Secondary check only. PayPal says transactions can take up to three hours to appear in Transaction Search, so it is read once at the end of the run and a shortfall is expected lag, not a missing payment. The primary count is from Orders v2 and Payments v2 GETs.',
  };
  try {
    const seen: Array<{ transaction_id?: string; invoice_id?: string }> = [];
    for (let page = 1; page <= 20; page++) {
      const r = await pp.transactions.search({ startDate: a.start, endDate: a.end, pageSize: 500, page });
      seen.push(...r.transaction_details.map((d) => d.transaction_info));
      if (!r.total_pages || page >= r.total_pages) break;
    }
    const ids = new Set(seen.map((s) => s.transaction_id));
    const mine = new Set(a.invoiceIds);
    const byInvoice: Record<string, number> = {};
    for (const s of seen) if (s.invoice_id && mine.has(s.invoice_id)) byInvoice[s.invoice_id] = (byInvoice[s.invoice_id] ?? 0) + 1;
    return { ...base, enabled: true, status: 200, listed: seen.length, authorizationsFound: a.authorizationIds.filter((x) => ids.has(x)).length, byInvoice };
  } catch (e) {
    const status = e instanceof PayPalApiError ? e.status : undefined;
    const error = e instanceof PayPalApiError ? `${e.status} ${e.name ?? ''} ${e.issue ?? ''}: ${e.message}`.replace(/\s+/g, ' ').trim() : (e as Error).message;
    return { ...base, enabled: false, ...(status ? { status } : {}), error, listed: 0, authorizationsFound: 0, byInvoice: {} };
  }
}

// ---------------------------------------------------------------------------------------------
// Setup

export interface SandboxContext {
  pp: PayPalClient;
  edge: NetworkEdge;
  merchantId: string;
  vaultId: string;
  gateOpts: GateOptions;
  /** Makes cart, readback and invoice ids unique to this run, so PayPal never replays an earlier run's order. */
  runId: string;
}

/**
 * Loads .env.local, refuses anything but the sandbox, and builds the PayPal client on the edge.
 * The HTTP client retries a lost answer twice (three tries), as the duplicate scenarios model.
 */
export function sandboxContext(): SandboxContext {
  const envFile = path.join(REPO_ROOT, '.env.local');
  if (existsSync(envFile)) process.loadEnvFile(envFile);
  const e = process.env;
  assertSandbox({ PAYPAL_ENV: e.PAYPAL_ENV ?? '', PAYPAL_API_BASE: e.PAYPAL_API_BASE ?? '' });
  const missing = ['PAYPAL_CLIENT_ID', 'PAYPAL_CLIENT_SECRET', 'PAYPAL_MERCHANT_ID', 'DEMO_VAULT_ID'].filter((k) => !e[k]?.trim());
  if (missing.length) throw new Error(`Sandbox-ledger run needs ${missing.join(', ')} in .env.local. Nothing was sent to PayPal.`);
  const edge = new NetworkEdge();
  const pp = createPayPalClient({
    clientId: e.PAYPAL_CLIENT_ID!,
    clientSecret: e.PAYPAL_CLIENT_SECRET!,
    apiBase: e.PAYPAL_API_BASE!,
    paypalEnv: e.PAYPAL_ENV,
    fetch: edge.fetch,
    retry: { maxRetries: 2 },
  });
  return {
    pp,
    edge,
    merchantId: e.PAYPAL_MERCHANT_ID!.trim(),
    vaultId: e.DEMO_VAULT_ID!.trim(),
    gateOpts: { env: { PAYPAL_ENV: e.PAYPAL_ENV!, PAYPAL_API_BASE: e.PAYPAL_API_BASE! }, signingKey: SIM_SIGNING_KEY },
    runId: new Date().toISOString().replace(/\D/g, '').slice(2, 14),
  };
}

/**
 * The PayPal half of payForReadback for a gate-approved readback: the order body from the cart rows
 * (orderInputFromCart), the vault create keyed by the gate's request id (createVaultOrder), then
 * authorize if PayPal did not complete it on create (completeOrder). The intent comes from the
 * readback, as in payForReadback; these runs refuse anything but an authorization.
 */
export async function payConfirmedReadback(
  ctx: SandboxContext,
  a: { cart: Cart; readback: ConfirmedReadback; requestId: string; orderId: string },
): Promise<{ order: Order; authorizationStatus?: string }> {
  const intent = a.readback.fields.some((f) => f.key === 'payAfterCheck') ? 'AUTHORIZE' : 'CAPTURE';
  if (intent !== 'AUTHORIZE') throw new Error('Sandbox-ledger runs authorize only; this readback would capture.');
  const input = orderInputFromCart(a.cart, { readbackBinding: hashReadbackBinding(a.readback), orderId: a.orderId, intent, payeeMerchantId: ctx.merchantId });
  const created = await createVaultOrder(ctx.pp.orders, input, { requestId: a.requestId, vaultId: ctx.vaultId });
  const order = await completeOrder(ctx.pp.orders, created, intent, (kind, id) => paypalRequestId(kind, id));
  return { order, authorizationStatus: authorizationFromOrder(order)?.status };
}
