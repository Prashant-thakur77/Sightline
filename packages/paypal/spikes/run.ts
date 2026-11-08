/**
 * PayPal sandbox spikes. Run from the repo root:
 *   packages/db/node_modules/.bin/tsx packages/paypal/spikes/run.ts <token|s2-vault|s3-tracking|s1-dispute|voidauth> [--headed] [--order=ID --capture=ID] [--wait=SECONDS]
 *
 * Sandbox only. Each spike writes a redacted JSON log to docs/spikes/raw/<spike>.json, and s1/s2/s3 fill the
 * Result and proposed Decision sections of docs/spikes/S1.md, S2.md, S3.md.
 */
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadEnv, SandboxOnlyError, type Env } from '@sightline/core/env';
import {
  PayPalApiError,
  PayPalError,
  SUBSCRIBED_WEBHOOK_EVENTS,
  approvalUrl,
  authorizationFromOrder,
  captureFromOrder,
  createPayPalClient,
  vaultFromOrder,
  type Order,
  type PayPalClient,
} from '../src/index';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const RAW_DIR = join(ROOT, 'docs/spikes/raw');
const SHOT_DIR =
  process.env.SPIKE_SHOT_DIR ??
  '/tmp/claude-1000/-home-prashant-projects-Sightline/7633199f-8d06-4de6-b59d-314713283d0b/scratchpad/spikes';
const PLAYWRIGHT = join(ROOT, 'tests/node_modules/@playwright/test');
const RETURN_HOST = 'example.com';
const RETURN_URL = `https://${RETURN_HOST}/spike/return`;
const CANCEL_URL = `https://${RETURN_HOST}/spike/cancel`;
const SPIKES = ['token', 's2-vault', 's3-tracking', 's1-dispute', 'voidauth'] as const;
type SpikeName = (typeof SPIKES)[number];

const args = process.argv.slice(3);
const flag = (name: string) => args.includes(`--${name}`);
const opt = (name: string) => args.find((a) => a.startsWith(`--${name}=`))?.split('=')[1];
const HEADED = flag('headed');
const usd = (cents: number) => ({ cents, currency: 'USD' });
const rid = (tag: string) => `spike-${tag}-${randomUUID()}`;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------- logging and redaction

const SENSITIVE_KEYS = new Set([
  'access_token',
  'id_token',
  'client_token',
  'refresh_token',
  'nonce',
  'password',
  'secret',
  'client_secret',
  'authorization',
  'paypal-auth-assertion',
  'authassertion',
  'auth_assertion',
  'email',
  'email_address',
  'login_email',
]);

function redactString(s: string, secrets: string[]): string {
  let out = s;
  for (const secret of secrets) if (secret.length >= 4) out = out.split(secret).join('[redacted]');
  return out
    .replace(/eyJ[\w-]+\.[\w-]*\.[\w-]*/g, '[jwt]')
    .replace(/A21AA[\w-]{20,}/g, '[token]')
    .replace(/[\w.+-]+@[\w-]+(\.[\w-]+)+/g, '[email]');
}

function redact(value: unknown, secrets: string[]): unknown {
  if (typeof value === 'string') return redactString(value, secrets);
  if (Array.isArray(value)) return value.map((v) => redact(v, secrets));
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value))
      out[k] = SENSITIVE_KEYS.has(k.toLowerCase()) ? '[redacted]' : redact(v, secrets);
    return out;
  }
  return value;
}

function describeError(err: unknown): Record<string, unknown> {
  if (err instanceof PayPalApiError)
    return {
      type: 'PayPalApiError',
      status: err.status,
      name: err.name,
      issue: err.issue,
      message: err.message,
      debugId: err.debugId,
      details: err.details,
      path: err.path,
    };
  if (err instanceof PayPalError) return { type: err.constructor.name, message: err.message };
  if (err instanceof Error) return { type: err.name, message: err.message };
  return { type: 'unknown', message: String(err) };
}

function shortError(err: Record<string, unknown> | undefined): string {
  if (!err) return '';
  const bits = [err.status, err.name, err.issue, err.message].filter((x) => x !== undefined && x !== '');
  return bits.join(' ').slice(0, 300) + (err.debugId ? ` (debug_id ${err.debugId})` : '');
}

interface Step {
  name: string;
  ok: boolean | 'skipped';
  at: string;
  data?: unknown;
  error?: Record<string, unknown>;
}

class SpikeLog {
  readonly steps: Step[] = [];
  outputs: Record<string, unknown> = {};

  constructor(
    readonly spike: SpikeName,
    private readonly secrets: string[],
  ) {}

  async step<T>(name: string, fn: () => Promise<T>, summarize?: (v: T) => unknown): Promise<T | undefined> {
    const at = new Date().toISOString();
    try {
      const v = await fn();
      this.steps.push({ name, ok: true, at, data: summarize ? summarize(v) : v });
      console.log(`  ok    ${name}`);
      return v;
    } catch (err) {
      const error = describeError(err);
      this.steps.push({ name, ok: false, at, error });
      console.log(`  FAIL  ${name}: ${redactString(shortError(error), this.secrets)}`);
      return undefined;
    }
  }

  skip(name: string, reason: string): void {
    this.steps.push({ name, ok: 'skipped', at: new Date().toISOString(), data: { reason } });
    console.log(`  skip  ${name}: ${reason}`);
  }

  note(name: string, data: unknown): void {
    this.steps.push({ name, ok: true, at: new Date().toISOString(), data });
  }

  get(name: string): Step | undefined {
    return this.steps.find((s) => s.name === name);
  }

  write(apiBase: string): string {
    mkdirSync(RAW_DIR, { recursive: true });
    const file = join(RAW_DIR, `${this.spike}.json`);
    const doc = {
      spike: this.spike,
      ranAt: new Date().toISOString(),
      apiBase,
      outputs: this.outputs,
      steps: this.steps,
    };
    writeFileSync(file, JSON.stringify(redact(doc, this.secrets), null, 2) + '\n');
    return file;
  }

  resultMarkdown(): string {
    const lines = [
      `Run ${new Date().toISOString()} with \`spikes/run.ts ${this.spike}\`. Raw log: \`docs/spikes/raw/${this.spike}.json\`.`,
      '',
    ];
    for (const s of this.steps) {
      const mark = s.ok === true ? 'ok' : s.ok === 'skipped' ? 'skipped' : 'FAILED';
      const why =
        s.ok === false
          ? `: ${shortError(s.error)}`
          : s.ok === 'skipped'
            ? `: ${(s.data as { reason: string }).reason}`
            : '';
      lines.push(`- ${s.name}: ${mark}${why}`);
    }
    const outs = Object.entries(this.outputs).filter(([, v]) => v !== undefined);
    if (outs.length) {
      lines.push('', 'Outputs:', '');
      for (const [k, v] of outs) lines.push(`- ${k}: \`${typeof v === 'string' ? v : JSON.stringify(v)}\``);
    }
    return redactString(lines.join('\n'), this.secrets);
  }
}

/** Replaces the text between <!-- name:start --> and <!-- name:end --> in a spike decision doc. */
function fillDoc(file: string, sections: Record<string, string>): void {
  const path = join(ROOT, 'docs/spikes', file);
  if (!existsSync(path)) return;
  let md = readFileSync(path, 'utf8');
  for (const [name, body] of Object.entries(sections)) {
    const re = new RegExp(`(<!-- ${name}:start -->)[\\s\\S]*?(<!-- ${name}:end -->)`);
    md = md.replace(re, `$1\n${body.trim()}\n$2`);
  }
  writeFileSync(path, md);
}

// ---------------------------------------------------------------- headless buyer approval (sandbox only)

interface PwLocator {
  first(): PwLocator;
  isVisible(): Promise<boolean>;
  click(o?: { timeout?: number }): Promise<void>;
  fill(v: string): Promise<void>;
}
interface PwPage {
  goto(url: string, o?: { waitUntil?: string; timeout?: number }): Promise<unknown>;
  url(): string;
  screenshot(o: { path: string; fullPage?: boolean }): Promise<unknown>;
  locator(selector: string): PwLocator;
  getByRole(role: string, o: { name: RegExp }): PwLocator;
  getByLabel(text: RegExp): PwLocator;
  route(
    url: RegExp,
    handler: (route: {
      fulfill(o: { status: number; contentType: string; body: string }): Promise<void>;
    }) => unknown,
  ): Promise<void>;
  waitForURL(url: (u: URL) => boolean, o?: { timeout?: number }): Promise<void>;
}
interface PwBrowser {
  newContext(o?: {
    locale?: string;
    viewport?: { width: number; height: number };
  }): Promise<{ newPage(): Promise<PwPage> }>;
  close(): Promise<void>;
}
interface Playwright {
  chromium: { launch(o: { headless: boolean }): Promise<PwBrowser> };
}

function loadPlaywright(): Playwright {
  return createRequire(import.meta.url)(PLAYWRIGHT) as Playwright;
}

function assertSandboxPayPalUrl(raw: string): URL {
  const u = new URL(raw);
  const ok =
    u.protocol === 'https:' &&
    (u.hostname === 'sandbox.paypal.com' || u.hostname.endsWith('.sandbox.paypal.com'));
  if (!ok)
    throw new Error(`Refusing to open ${u.hostname}: headless approval only runs on sandbox.paypal.com.`);
  return u;
}

async function firstVisible(candidates: PwLocator[], timeoutMs: number): Promise<PwLocator | undefined> {
  const end = Date.now() + timeoutMs;
  do {
    for (const c of candidates) {
      const l = c.first();
      if (await l.isVisible().catch(() => false)) return l;
    }
    await sleep(250);
  } while (Date.now() < end);
  return undefined;
}

interface BuyerCreds {
  email: string;
  password: string;
}

/** Logs in as the sandbox buyer and approves the order, stopping when PayPal redirects to the return URL. */
async function approveAsBuyer(
  link: string,
  creds: BuyerCreds,
  label: string,
): Promise<{ returnedTo: string; screenshots: string }> {
  assertSandboxPayPalUrl(link);
  mkdirSync(SHOT_DIR, { recursive: true });
  const browser = await loadPlaywright().chromium.launch({ headless: !HEADED });
  try {
    const context = await browser.newContext({ locale: 'en-US', viewport: { width: 1280, height: 900 } });
    const page = await context.newPage();
    // Never load the real return site; answer it locally.
    await page.route(/^https:\/\/example\.com\//, (r) =>
      r.fulfill({ status: 200, contentType: 'text/html', body: '<title>returned</title>' }),
    );
    let n = 0;
    const shot = async (name: string) => {
      n += 1;
      const path = join(SHOT_DIR, `${label}-${String(n).padStart(2, '0')}-${name}.png`);
      await page.screenshot({ path, fullPage: true }).catch(() => undefined);
    };
    const returned = () => {
      try {
        return new URL(page.url()).hostname === RETURN_HOST;
      } catch {
        return false;
      }
    };

    await page.goto(link, { waitUntil: 'domcontentloaded', timeout: 60_000 });
    await shot('opened');
    const cookies = await firstVisible(
      [page.locator('#acceptAllButton'), page.getByRole('button', { name: /accept all|accept cookies/i })],
      3000,
    );
    if (cookies) await cookies.click().catch(() => undefined);

    const email = await firstVisible(
      [
        page.locator('#email'),
        page.locator('input[name="login_email"]'),
        page.getByRole('textbox', { name: /email|mobile/i }),
      ],
      30_000,
    );
    if (email) {
      await email.fill(creds.email);
      await shot('email');
      const next = await firstVisible(
        [page.locator('#btnNext'), page.getByRole('button', { name: /^next$/i })],
        3000,
      );
      if (next) await next.click();
    }
    const usePassword = await firstVisible(
      [
        page.getByRole('link', { name: /password instead|use (your )?password/i }),
        page.getByRole('button', { name: /password instead|use (your )?password/i }),
      ],
      3000,
    );
    if (usePassword) await usePassword.click();
    const password = await firstVisible(
      [page.locator('#password'), page.locator('input[name="login_password"]'), page.getByLabel(/password/i)],
      30_000,
    );
    if (!password) {
      await shot('no-password-field');
      throw new Error('Password field not found on the sandbox login page.');
    }
    await password.fill(creds.password);
    await shot('password');
    const login = await firstVisible(
      [page.locator('#btnLogin'), page.getByRole('button', { name: /^log ?in$/i })],
      5000,
    );
    if (!login) throw new Error('Log in button not found.');
    await login.click();

    for (let i = 0; i < 5 && !returned(); i += 1) {
      const button = await firstVisible(
        [
          page.locator('[data-testid="submit-button-initial"]'),
          page.locator('#payment-submit-btn'),
          page.getByRole('button', {
            name: /pay now|complete purchase|agree (and|&) (pay|continue)|save and continue|continue to review|^continue$/i,
          }),
        ],
        30_000,
      );
      await shot(`review-${i + 1}`);
      if (!button) break;
      await button.click();
      await page.waitForURL((u) => u.hostname === RETURN_HOST, { timeout: 20_000 }).catch(() => undefined);
    }
    await shot('final');
    if (!returned())
      throw new Error(
        `Approval did not reach the return URL (stopped at ${new URL(page.url()).pathname}). Screenshots: ${SHOT_DIR}`,
      );
    return { returnedTo: new URL(page.url()).pathname, screenshots: SHOT_DIR };
  } finally {
    await browser.close();
  }
}

// ---------------------------------------------------------------- shared order helpers

interface Ctx {
  env: Env;
  client: PayPalClient;
  log: SpikeLog;
  buyer: BuyerCreds | undefined;
}

function orderSummary(o: Order) {
  const cap = captureFromOrder(o);
  const auth = authorizationFromOrder(o);
  return {
    id: o.id,
    status: o.status,
    captureId: cap?.id,
    captureStatus: cap?.status,
    authorizationId: auth?.id,
    authorizationStatus: auth?.status,
    vault: vaultFromOrder(o),
    payerId: o.payer?.payer_id,
    payeeMerchantId: (o.purchase_units?.[0] as { payee?: { merchant_id?: string } } | undefined)?.payee
      ?.merchant_id,
  };
}

/** Creates a PayPal-wallet order, approves it headlessly as the sandbox buyer, and returns the approved order id. */
async function createAndApprove(
  ctx: Ctx,
  label: string,
  intent: 'CAPTURE' | 'AUTHORIZE',
  storeInVault: boolean,
): Promise<string | undefined> {
  const created = await ctx.log.step(
    `${label}: create ${intent} order${storeInVault ? ' with store_in_vault ON_SUCCESS' : ''}`,
    () =>
      ctx.client.orders.create({
        requestId: rid(label),
        intent,
        items: [{ name: 'Spike test item', quantity: 1, unitAmount: usd(1000), sku: 'SPIKE-1' }],
        shipping: usd(250),
        expectedTotal: usd(1250),
        customId: `spike-${label}`,
        invoiceId: `spike-${randomUUID()}`,
        paymentSource: {
          type: 'paypal',
          storeInVault,
          experienceContext: {
            returnUrl: RETURN_URL,
            cancelUrl: CANCEL_URL,
            shippingPreference: 'GET_FROM_FILE',
            userAction: 'PAY_NOW',
            brandName: 'Spike Store',
          },
        },
      }),
    (o) => ({
      ...orderSummary(o),
      approvalHost: approvalUrl(o) ? new URL(approvalUrl(o)!).hostname : undefined,
    }),
  );
  if (!created) return undefined;
  const link = approvalUrl(created);
  if (!link) {
    ctx.log.skip(`${label}: buyer approval`, 'order has no approve or payer-action link');
    return undefined;
  }
  if (!ctx.buyer) {
    ctx.log.skip(
      `${label}: buyer approval`,
      'PAYPAL_SANDBOX_BUYER_EMAIL / PAYPAL_SANDBOX_BUYER_PASSWORD not set in .env.local',
    );
    return undefined;
  }
  const approved = await ctx.log.step(`${label}: approve headlessly as sandbox buyer`, () =>
    approveAsBuyer(link, ctx.buyer!, label),
  );
  if (!approved) return undefined;
  await ctx.log.step(
    `${label}: order status after approval`,
    () => ctx.client.orders.get(created.id),
    orderSummary,
  );
  return created.id;
}

interface CapturedRef {
  orderId: string;
  captureId: string;
  amountCents: number;
  merchantId?: string;
  payerId?: string;
}

function readS2Outputs(): Record<string, unknown> | undefined {
  const file = join(RAW_DIR, 's2-vault.json');
  if (!existsSync(file)) return undefined;
  return (JSON.parse(readFileSync(file, 'utf8')) as { outputs?: Record<string, unknown> }).outputs;
}

/** A captured PayPal-wallet order: from --order/--capture, from the last s2 run, or a fresh approved purchase. */
async function capturedOrder(ctx: Ctx): Promise<CapturedRef | undefined> {
  const orderId = opt('order') ?? (readS2Outputs()?.captureOrderId as string | undefined);
  if (orderId) {
    const order = await ctx.log.step(
      'load captured order',
      () => ctx.client.orders.get(orderId),
      orderSummary,
    );
    const cap = order && captureFromOrder(order);
    const captureId = opt('capture') ?? cap?.id;
    if (order && captureId) {
      const s = orderSummary(order);
      return {
        orderId,
        captureId,
        amountCents: Math.round(Number(cap?.amount?.value ?? '12.50') * 100),
        merchantId: s.payeeMerchantId,
        payerId: s.payerId,
      };
    }
  }
  const approvedId = await createAndApprove(ctx, 'fresh-capture', 'CAPTURE', false);
  if (!approvedId) return undefined;
  const captured = await ctx.log.step(
    'fresh-capture: capture',
    () => ctx.client.orders.capture(approvedId, { requestId: rid('cap') }),
    orderSummary,
  );
  const cap = captured && captureFromOrder(captured);
  if (!captured || !cap) return undefined;
  const s = orderSummary(captured);
  return {
    orderId: approvedId,
    captureId: cap.id,
    amountCents: 1250,
    merchantId: s.payeeMerchantId,
    payerId: s.payerId,
  };
}

// ---------------------------------------------------------------- spikes

async function spikeToken(ctx: Ctx): Promise<void> {
  const KEY_SCOPES: Record<string, string> = {
    'disputes read (seller)': 'https://uri.paypal.com/services/disputes/read-seller',
    'disputes update (seller)': 'https://uri.paypal.com/services/disputes/update-seller',
    'disputes create (buyer, limited)': 'https://uri.paypal.com/services/disputes/create',
    'disputes update (buyer, limited)': 'https://uri.paypal.com/services/disputes/update-buyer',
    'vault payment tokens': 'https://uri.paypal.com/services/vault/payment-tokens/readwrite',
    'shipping trackers': 'https://uri.paypal.com/services/shipping/trackers/readwrite',
    'transaction search': 'https://uri.paypal.com/services/reporting/search/read',
    webhooks: 'https://uri.paypal.com/services/applications/webhooks',
    refunds: 'https://uri.paypal.com/services/payments/refund',
    'auth and capture': 'https://uri.paypal.com/services/payments/payment/authcapture',
  };
  await ctx.log.step(
    'mint access token and summarise scopes',
    () =>
      ctx.client.request({
        method: 'POST',
        path: '/v1/oauth2/token',
        auth: 'basic',
        raw: { body: 'grant_type=client_credentials', contentType: 'application/x-www-form-urlencoded' },
      }),
    (res) => {
      const body = res.body as { scope?: string; expires_in?: number; app_id?: string };
      const scopes = (body.scope ?? '').split(/\s+/).filter(Boolean);
      const present = Object.fromEntries(
        Object.entries(KEY_SCOPES).map(([label, s]) => [label, scopes.includes(s)]),
      );
      ctx.log.outputs = {
        scopeStringLength: (body.scope ?? '').length,
        scopeCount: scopes.length,
        keyScopes: present,
      };
      for (const [label, has] of Object.entries(present))
        console.log(`        ${has ? 'yes' : 'NO '}  ${label}`);
      return {
        expiresIn: body.expires_in,
        appId: body.app_id,
        scopeCount: scopes.length,
        keyScopes: present,
        allScopes: scopes,
      };
    },
  );
  await ctx.log.step(
    'list webhook event types and check the 12 subscribed names',
    () => ctx.client.webhooks.listEventTypes(),
    (types) => {
      const names = new Set(types.map((t) => t.name));
      const missing = SUBSCRIBED_WEBHOOK_EVENTS.filter((e) => !names.has(e));
      const trackingRelated = types.map((t) => t.name).filter((n) => /TRACK|SHIP|DELIVER/i.test(n));
      ctx.log.outputs.eventTypesTotal = types.length;
      ctx.log.outputs.subscribedMissing = missing;
      ctx.log.outputs.trackingRelatedEvents = trackingRelated;
      console.log(
        `        ${types.length} event types; missing of our 12: ${missing.length ? missing.join(', ') : 'none'}`,
      );
      if (missing.length) throw new Error(`Missing event types: ${missing.join(', ')}`);
      return { total: types.length, missing, trackingRelated };
    },
  );
}

async function spikeVoidAuth(ctx: Ctx): Promise<void> {
  let authorizationId: string | undefined;
  if (ctx.buyer) {
    const orderId = await createAndApprove(ctx, 'voidauth', 'AUTHORIZE', false);
    if (orderId) {
      const o = await ctx.log.step(
        'authorize approved order',
        () => ctx.client.orders.authorize(orderId, { requestId: rid('auth') }),
        orderSummary,
      );
      authorizationId = o && authorizationFromOrder(o)?.id;
    }
  } else {
    ctx.log.skip('wallet approval', 'no sandbox buyer credentials; using a sandbox test card instead');
    const res = await ctx.log.step(
      'create AUTHORIZE order with sandbox test card',
      () =>
        ctx.client.request({
          method: 'POST',
          path: '/v2/checkout/orders',
          requestId: rid('card'),
          representation: true,
          json: {
            intent: 'AUTHORIZE',
            purchase_units: [
              { amount: { currency_code: 'USD', value: '5.00' }, invoice_id: `spike-${randomUUID()}` },
            ],
            payment_source: {
              card: {
                number: '4111111111111111',
                expiry: `${new Date().getUTCFullYear() + 2}-12`,
                name: 'Spike Tester',
                security_code: '123',
              },
            },
          },
        }),
      (r) => orderSummary(r.body as Order),
    );
    authorizationId = res && authorizationFromOrder(res.body as Order)?.id;
  }
  if (!authorizationId) {
    ctx.log.skip('void authorization', 'no authorization was created');
    return;
  }
  ctx.log.outputs.authorizationId = authorizationId;
  await ctx.log.step(
    'void authorization',
    () => ctx.client.payments.voidAuthorization(authorizationId!, { requestId: rid('void') }),
    (a) => ({
      status: a?.status,
    }),
  );
  await ctx.log.step(
    'authorization status is VOIDED',
    () => ctx.client.payments.getAuthorization(authorizationId!),
    (a) => {
      ctx.log.outputs.finalStatus = a.status;
      if (a.status !== 'VOIDED') throw new Error(`status is ${a.status}`);
      return { status: a.status };
    },
  );
}

async function spikeS2(ctx: Ctx): Promise<void> {
  const out = ctx.log.outputs;
  // AUTHORIZE variant (pay after check).
  const authOrderId = await createAndApprove(ctx, 's2-authorize', 'AUTHORIZE', true);
  if (authOrderId) {
    const o = await ctx.log.step(
      's2-authorize: authorize',
      () => ctx.client.orders.authorize(authOrderId, { requestId: rid('auth') }),
      orderSummary,
    );
    const v = o && vaultFromOrder(o);
    const after = await ctx.log.step(
      's2-authorize: order after authorize (vault attributes)',
      () => ctx.client.orders.get(authOrderId),
      orderSummary,
    );
    out.authorizeOrderId = authOrderId;
    out.authorizeVault = v ?? (after ? vaultFromOrder(after) : undefined);
    const authId = o && authorizationFromOrder(o)?.id;
    if (authId)
      await ctx.log.step(
        's2-authorize: void the authorization (cleanup)',
        () => ctx.client.payments.voidAuthorization(authId, { requestId: rid('void') }),
        (a) => ({ status: a?.status }),
      );
  }
  // CAPTURE variant.
  const capOrderId = await createAndApprove(ctx, 's2-capture', 'CAPTURE', true);
  if (capOrderId) {
    const o = await ctx.log.step(
      's2-capture: capture',
      () => ctx.client.orders.capture(capOrderId, { requestId: rid('cap') }),
      orderSummary,
    );
    if (o) {
      const s = orderSummary(o);
      out.captureOrderId = capOrderId;
      out.captureId = s.captureId;
      out.captureVault = s.vault;
      out.payerId = s.payerId;
      out.payeeMerchantId = s.payeeMerchantId;
    }
  }
  const vault = (out.captureVault ?? out.authorizeVault) as
    { id?: string; customerId?: string; status?: string } | undefined;
  out.vaultId = vault?.id;
  out.customerId = vault?.customerId;
  if (!vault?.id) {
    ctx.log.skip('reuse vault_id with buyer not present', 'no vault id was returned');
    return;
  }
  await ctx.log.step(
    'read payment token',
    () => ctx.client.vault.getPaymentToken(vault.id!),
    (t) => ({ id: t.id, customer: t.customer, sources: Object.keys(t.payment_source ?? {}) }),
  );
  if (vault.customerId)
    await ctx.log.step(
      'list payment tokens for customer',
      () => ctx.client.vault.listPaymentTokens({ customerId: vault.customerId! }),
      (l) => ({
        count: l.payment_tokens.length,
        ids: l.payment_tokens.map((t) => t.id),
      }),
    );
  const reuse = await ctx.log.step(
    'reuse: create CAPTURE order with payment_source.paypal.vault_id (buyer not present)',
    () =>
      ctx.client.orders.create({
        requestId: rid('reuse'),
        intent: 'CAPTURE',
        items: [{ name: 'Spike repeat item', quantity: 1, unitAmount: usd(700) }],
        expectedTotal: usd(700),
        invoiceId: `spike-${randomUUID()}`,
        paymentSource: { type: 'vault', vaultId: vault.id! },
      }),
    orderSummary,
  );
  if (reuse) {
    let final = reuse;
    if (reuse.status !== 'COMPLETED') {
      const c = await ctx.log.step(
        'reuse: capture (order was not completed on create)',
        () => ctx.client.orders.capture(reuse.id, { requestId: rid('reuse-cap') }),
        orderSummary,
      );
      if (c) final = c;
    }
    out.reuseOrderId = reuse.id;
    out.reuseStatus = final.status;
    out.reuseCaptureId = captureFromOrder(final)?.id;
    out.reuseNeededApproval = Boolean(approvalUrl(reuse)) && final.status !== 'COMPLETED';
  }
}

async function spikeS3(ctx: Ctx): Promise<void> {
  const ref = await capturedOrder(ctx);
  if (!ref) {
    ctx.log.skip('tracking', 'no captured order available (run s2-vault first, or pass --order=ID)');
    return;
  }
  const out = ctx.log.outputs;
  out.orderId = ref.orderId;
  out.captureId = ref.captureId;
  const tnA = `9400${Date.now()}`.slice(0, 22);
  const tnB = `1Z${Date.now()}`;
  const viaOrders = await ctx.log.step(
    'orders-track: POST /v2/checkout/orders/{id}/track',
    () =>
      ctx.client.tracking.addTracking({
        strategy: 'orders-track',
        orderId: ref.orderId,
        captureId: ref.captureId,
        trackingNumber: tnA,
        carrier: 'USPS',
        notifyPayer: false,
        items: [{ name: 'Spike test item', sku: 'SPIKE-1', quantity: 1 }],
      }),
    (r) => ({ trackerId: r.trackerId }),
  );
  const viaBatch = await ctx.log.step(
    'trackers-batch: POST /v1/shipping/trackers-batch',
    () =>
      ctx.client.tracking.addTracking({
        strategy: 'trackers-batch',
        captureId: ref.captureId,
        trackingNumber: tnB,
        carrier: 'UPS',
        notifyPayer: false,
      }),
    (r) => ({ trackerId: r.trackerId }),
  );
  out.ordersTrackWorks = Boolean(viaOrders);
  out.trackersBatchWorks = Boolean(viaBatch);
  await ctx.log.step(
    'read back: GET /v1/shipping/trackers?transaction_id=',
    () => ctx.client.tracking.getTrackers({ transactionId: ref.captureId }),
    (c) => ({
      trackers: c.trackers.map((t) => ({
        tracking_number: t.tracking_number,
        status: t.status,
        carrier: t.carrier,
      })),
    }),
  );
  await ctx.log.step(
    'read back: order shipping.trackers',
    () => ctx.client.orders.get(ref.orderId),
    (o) => ({
      trackers: o.purchase_units
        ?.flatMap((u) => u.shipping?.trackers ?? [])
        .map((t) => ({ id: t.id, status: t.status })),
    }),
  );
  const trackerId = viaBatch?.trackerId ?? `${ref.captureId}-${tnB}`;
  const delivered = await ctx.log.step(
    'mark DELIVERED: PUT /v1/shipping/trackers/{id}',
    () =>
      ctx.client.request({
        method: 'PUT',
        path: `/v1/shipping/trackers/${encodeURIComponent(trackerId)}`,
        json: { transaction_id: ref.captureId, tracking_number: tnB, status: 'DELIVERED', carrier: 'UPS' },
      }),
    (r) => ({ status: r.status }),
  );
  out.deliveredStatusSettable = Boolean(delivered);
  await ctx.log.step(
    'webhook event types related to tracking or delivery',
    () => ctx.client.webhooks.listEventTypes(),
    (types) => {
      const related = types.map((t) => t.name).filter((n) => /TRACK|SHIP|DELIVER/i.test(n));
      out.trackingWebhookEvents = related;
      return { related };
    },
  );
}

async function spikeS1(ctx: Ctx): Promise<void> {
  const out = ctx.log.outputs;
  const ref = await capturedOrder(ctx);
  if (!ref) {
    ctx.log.skip('disputes', 'no captured order available (run s2-vault first, or pass --order=ID)');
    return;
  }
  out.orderId = ref.orderId;
  out.sellerTransactionId = ref.captureId;
  const now = Date.now();
  const window = { startDate: new Date(now - 2 * 86_400_000), endDate: new Date(now) };

  // 1. Where could the buyer-side id come from?
  const candidates = new Set<string>();
  await ctx.log.step(
    'transaction search as merchant (capture id)',
    () => ctx.client.transactions.search({ ...window, transactionId: ref.captureId }),
    (r) => {
      const rows = r.transaction_details.map((d) => d.transaction_info);
      return {
        count: rows.length,
        rows: rows.map((t) => ({
          id: t.transaction_id,
          ref: t.paypal_reference_id,
          refType: t.paypal_reference_id_type,
          code: t.transaction_event_code,
        })),
      };
    },
  );
  const buyerEmail = ctx.buyer?.email;
  const buyer = buyerEmail ? ctx.client.buyer({ email: buyerEmail }) : undefined;
  if (buyer) {
    await ctx.log.step(
      'transaction search as buyer (auth assertion, undocumented)',
      () => buyer.searchTransactions(window),
      (r) => {
        const rows = r.transaction_details.map((d) => d.transaction_info);
        for (const t of rows) if (t.transaction_id) candidates.add(t.transaction_id);
        return { count: rows.length, ids: rows.map((t) => t.transaction_id) };
      },
    );
    for (const [i, body] of [
      { transaction_id: ref.captureId },
      { seller_transaction_id: ref.captureId },
      { disputed_transactions: [{ seller_transaction_id: ref.captureId }] },
    ].entries()) {
      await ctx.log.step(
        `validate-eligibility attempt ${i + 1} (body shape guessed; schema unpublished)`,
        () =>
          ctx.client.request({
            method: 'POST',
            path: '/v1/customer/disputes/validate-eligibility',
            json: body,
            headers: { 'PayPal-Auth-Assertion': buyer.authAssertion },
          }),
        (r) => {
          const found = JSON.stringify(r.body).match(/"buyer_transaction_id"\s*:\s*"([A-Za-z0-9-]+)"/g) ?? [];
          for (const f of found) candidates.add(f.split('"')[3]!);
          return { body: r.body };
        },
      );
    }
  } else {
    ctx.log.skip('buyer-side calls', 'PAYPAL_SANDBOX_BUYER_EMAIL not set');
  }
  candidates.add(ref.captureId);
  out.buyerTransactionIdCandidates = [...candidates];

  // 2. Buyer-side create.
  if (buyer) {
    for (const id of candidates) {
      const created = await ctx.log.step(`buyer create dispute with buyer_transaction_id=${id}`, () =>
        buyer.create({
          buyerTransactionId: id,
          reason: 'MERCHANDISE_OR_SERVICE_NOT_AS_DESCRIBED',
          issueType: 'PRODUCT',
          disputeAmount: usd(ref.amountCents),
          merchantContacted: true,
          merchantContactedOutcome: 'NO_RESPONSE',
          notes: 'Spike: item colour does not match the listing.',
        }),
      );
      if (created) {
        out.buyerDisputeId = created.disputeId;
        out.buyerTransactionIdThatWorked = id;
        break;
      }
    }
    if (!out.buyerDisputeId && ctx.env.PAYPAL_SANDBOX_BUYER_PAYER_ID) {
      const viaPayer = ctx.client.buyer({ payerId: ctx.env.PAYPAL_SANDBOX_BUYER_PAYER_ID });
      const created = await ctx.log.step('buyer create dispute with payer_id assertion (capture id)', () =>
        viaPayer.create({
          buyerTransactionId: ref.captureId,
          reason: 'MERCHANDISE_OR_SERVICE_NOT_AS_DESCRIBED',
          issueType: 'PRODUCT',
          disputeAmount: usd(ref.amountCents),
          merchantContacted: true,
          merchantContactedOutcome: 'NO_RESPONSE',
        }),
      );
      if (created) out.buyerDisputeId = created.disputeId;
    }
  }

  // 3. Fallback: sandbox chargeback simulation, then look for a merchant-side dispute.
  const merchantId = ctx.env.PAYPAL_MERCHANT_ID ?? ref.merchantId;
  if (!merchantId) ctx.log.skip('process-chargeback', 'no merchant id (set PAYPAL_MERCHANT_ID)');
  else {
    const day = 86_400_000;
    const iso = (t: number) => new Date(t).toISOString();
    const value = (ref.amountCents / 100).toFixed(2);
    await ctx.log.step(
      'sandbox chargeback: POST /v2/customer-support/process-chargeback',
      () =>
        ctx.client.request({
          method: 'POST',
          path: '/v2/customer-support/process-chargeback',
          json: {
            adjacency: 'PAYPAL',
            file_layout: 'ATCK_CB',
            merchant_id: merchantId,
            financial_institution: { processor: 'FDMS' },
            transaction: { id_enc: ref.captureId, amount: { currency_code: 'USD', value } },
            instrument: {
              instrument_type: 'CARD',
              card_brand: 'VISA',
              credit_card_transaction_id: String(now).padEnd(16, '0').slice(0, 16),
              external: false,
            },
            dispute: {
              id: null,
              stage: 'CHARGEBACK',
              response_date: iso(now + 10 * day),
              status: '2',
              amount: { currency_code: 'USD', value },
              receive_date: iso(now),
              event_code: 'CHARGEBACK_INITIATED',
              money_movement_date: iso(now),
              event_type: 'DEBIT',
              chargeback_type: 'REPORTED_TO_PROCESSOR',
              processor_info: {
                reference_number: String(now) + '0000000000',
                reason_code: '1330',
                notes: 'TEST_MEMO',
              },
            },
          },
        }),
      (r) => {
        out.chargebackDisputeId = (r.body as { dispute_id?: string } | undefined)?.dispute_id;
        return { status: r.status, body: r.body };
      },
    );
  }
  const waitS = Number(opt('wait') ?? '45');
  for (let i = 0; i < 4; i += 1) {
    const list = await ctx.log.step(
      `merchant disputes for the capture (poll ${i + 1})`,
      () => ctx.client.disputes.list({ disputedTransactionId: ref.captureId }),
      (l) => ({
        ids: l.items.map((d) => ({
          id: d.dispute_id,
          reason: d.reason,
          status: d.status,
          stage: d.dispute_life_cycle_stage,
        })),
      }),
    );
    if (list?.items.length) {
      out.merchantVisibleDisputes = list.items.map((d) => d.dispute_id);
      break;
    }
    if (i < 3) await sleep((waitS * 1000) / 3);
  }

  // 4. Manual path, not automated.
  out.resolutionCenter = {
    note: 'Manual fallback (b): the sandbox buyer logs in and files from the transaction. Not automated.',
    buyerLogin: 'https://www.sandbox.paypal.com/signin',
    activity: 'https://www.sandbox.paypal.com/myaccount/activity',
    resolutionCenter: 'https://www.sandbox.paypal.com/resolutioncenter',
    sellerTransactionId: ref.captureId,
  };
  console.log(
    `  manual: buyer files at https://www.sandbox.paypal.com/resolutioncenter (activity: https://www.sandbox.paypal.com/myaccount/activity)`,
  );
}

// ---------------------------------------------------------------- decisions

/** A run that never reached the question it asks must not read as a decision. */
function inconclusive(log: SpikeLog): string | undefined {
  const authFail = log.steps.find((s) => s.ok === false && s.error?.status === 401);
  if (authFail)
    return `Inconclusive: PayPal rejected the app credentials (${shortError(authFail.error)}). Fix PAYPAL_CLIENT_ID / PAYPAL_CLIENT_SECRET and run again.`;
  const approval = log.steps.find((s) => /approv/i.test(s.name) && s.ok !== true);
  if (approval)
    return `Inconclusive: buyer approval did not complete (${approval.ok === 'skipped' ? (approval.data as { reason: string }).reason : shortError(approval.error)}). Check the screenshots, try --headed, and run again.`;
  return undefined;
}

function decideS2(o: Record<string, unknown>): string {
  if (o.vaultId && o.reuseStatus === 'COMPLETED')
    return `Proposed: vault works in sandbox. First purchase saves PayPal with store_in_vault ON_SUCCESS (vault id and customer id recorded); repeat purchases use payment_source.paypal.vault_id and completed without buyer approval. Make vault the default for returning buyers.`;
  if (o.vaultId)
    return `Proposed: vault id was issued but reuse did not complete (status ${String(o.reuseStatus ?? 'none')}). Use the popup every time until the reuse error is resolved.`;
  return 'Proposed: no vault id was returned. Fall back to the popup every time (still with readback and gate) and report it.';
}

function decideS3(o: Record<string, unknown>): string {
  const events = (o.trackingWebhookEvents as string[] | undefined) ?? [];
  const which = o.ordersTrackWorks
    ? 'Use orders-track (POST /v2/checkout/orders/{id}/track), the documented path for Orders v2.'
    : o.trackersBatchWorks
      ? 'Use trackers-batch (POST /v1/shipping/trackers-batch); orders-track failed.'
      : 'Neither endpoint accepted the tracker; keep tracking in Sightline only.';
  const hook = events.length
    ? `Tracking-related webhook events exist: ${events.join(', ')}.`
    : 'No tracking or delivery webhook event exists, so the worker polls GET /v1/shipping/trackers and raises an app event.';
  return `Proposed: ${which} ${hook} DELIVERED via PUT /v1/shipping/trackers/{id}: ${o.deliveredStatusSettable ? 'accepted' : 'not accepted'}.`;
}

function decideS1(o: Record<string, unknown>): string {
  if (o.buyerDisputeId)
    return `Proposed: (a) API path works. Buyer dispute ${String(o.buyerDisputeId)} created with buyer_transaction_id from ${o.buyerTransactionIdThatWorked === o.sellerTransactionId ? 'the capture id itself' : 'a buyer-side lookup'}.`;
  if ((o.merchantVisibleDisputes as string[] | undefined)?.length || o.chargebackDisputeId)
    return 'Proposed: buyer create is blocked (see errors), but the sandbox chargeback simulation produces a merchant-side dispute. Use (c): drive the merchant lifecycle with simulation endpoints, and use (b) the sandbox Resolution Center for the buyer step when a real buyer-filed case is needed.';
  return 'Proposed: neither buyer create nor chargeback simulation produced a dispute. Use (b) the sandbox Resolution Center for the buyer step, or (c) seller message plus refund, per the fallback ladder.';
}

// ---------------------------------------------------------------- main

async function main(): Promise<void> {
  const spike = process.argv[2] as SpikeName | undefined;
  if (!spike || !SPIKES.includes(spike)) {
    console.log(
      `Usage: tsx packages/paypal/spikes/run.ts <${SPIKES.join('|')}> [--headed] [--order=ID --capture=ID] [--wait=SECONDS]`,
    );
    process.exitCode = 1;
    return;
  }
  const envFile = join(ROOT, '.env.local');
  if (existsSync(envFile)) process.loadEnvFile(envFile);
  let env: Env;
  try {
    env = loadEnv(process.env);
  } catch (err) {
    if (err instanceof SandboxOnlyError) {
      console.log(err.message);
      process.exitCode = 1;
      return;
    }
    throw err;
  }
  if (!env.PAYPAL_CLIENT_ID || !env.PAYPAL_CLIENT_SECRET) {
    console.log(
      `Spike "${spike}" not run: PayPal sandbox keys are missing. Add PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET to .env.local, then run it again. Nothing was sent to PayPal and no files were written.`,
    );
    return;
  }
  const buyer =
    env.PAYPAL_SANDBOX_BUYER_EMAIL && env.PAYPAL_SANDBOX_BUYER_PASSWORD
      ? { email: env.PAYPAL_SANDBOX_BUYER_EMAIL, password: env.PAYPAL_SANDBOX_BUYER_PASSWORD }
      : undefined;
  const secrets = [
    env.PAYPAL_CLIENT_ID,
    env.PAYPAL_CLIENT_SECRET,
    env.PAYPAL_SANDBOX_BUYER_EMAIL,
    env.PAYPAL_SANDBOX_BUYER_PASSWORD,
  ].filter((s): s is string => Boolean(s));
  const client = createPayPalClient({
    clientId: env.PAYPAL_CLIENT_ID,
    clientSecret: env.PAYPAL_CLIENT_SECRET,
    apiBase: env.PAYPAL_API_BASE,
    paypalEnv: env.PAYPAL_ENV,
    logger: {
      warn: (m, meta) => console.log(`        retry: ${m} ${JSON.stringify(redact(meta ?? {}, secrets))}`),
    },
  });
  const log = new SpikeLog(spike, secrets);
  const ctx: Ctx = { env, client, log, buyer };
  console.log(
    `Spike ${spike} against ${env.PAYPAL_API_BASE}${buyer ? '' : ' (no sandbox buyer credentials: approval steps will be skipped)'}`,
  );

  const run: Record<SpikeName, () => Promise<void>> = {
    token: () => spikeToken(ctx),
    's2-vault': () => spikeS2(ctx),
    's3-tracking': () => spikeS3(ctx),
    's1-dispute': () => spikeS1(ctx),
    voidauth: () => spikeVoidAuth(ctx),
  };
  try {
    await run[spike]();
  } catch (err) {
    log.note('unexpected error', describeError(err));
    console.log(`  unexpected error: ${redactString(shortError(describeError(err)), secrets)}`);
    process.exitCode = 1;
  }
  const file = log.write(env.PAYPAL_API_BASE);
  const docs: Partial<Record<SpikeName, [string, (o: Record<string, unknown>) => string]>> = {
    's1-dispute': ['S1.md', decideS1],
    's2-vault': ['S2.md', decideS2],
    's3-tracking': ['S3.md', decideS3],
  };
  const doc = docs[spike];
  if (doc) {
    const decision = inconclusive(log) ?? doc[1](log.outputs);
    fillDoc(doc[0], { result: log.resultMarkdown(), decision: redactString(decision, secrets) });
  }
  console.log(`Wrote ${file.replace(ROOT + '/', '')}${doc ? ` and docs/spikes/${doc[0]}` : ''}.`);
}

await main();
