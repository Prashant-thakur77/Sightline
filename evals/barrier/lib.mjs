// Shared helpers for the Checkout Barrier Index: identity, robots.txt, politeness, hashing, platform signals.
// Plain Node ESM so the crawler runs without a build step.
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
export const RAW_DIR = path.join(ROOT, 'evals/data/raw/barrier');
export const STORE_DIR = path.join(RAW_DIR, 'stores');
export const RESULT_FILE = path.join(ROOT, 'evals/results/barrier.json');

/** The tool identifies itself honestly. No email, no disguise of the headless browser. */
export const TOOL_TOKEN = 'SightlineBarrierIndex';
export const TOOL_UA = `${TOOL_TOKEN}/0.1 (accessibility research; read-only)`;

/** Minimum gap between page requests to the same site, in milliseconds. */
export const MIN_GAP_MS = 5000;
const MAX_CRAWL_DELAY_MS = 60000;

/** Playwright and axe come from the repo's tests package so nothing new is installed. */
export function loadTooling() {
  const req = createRequire(path.join(ROOT, 'tests/package.json'));
  const { chromium } = req('@playwright/test');
  const axeMod = req('@axe-core/playwright');
  const AxeBuilder = axeMod.default ?? axeMod.AxeBuilder ?? axeMod;
  const axeReq = createRequire(req.resolve('@axe-core/playwright'));
  const axeSourcePath = axeReq.resolve('axe-core/axe.min.js');
  const axeVersion = axeReq('axe-core/package.json').version;
  return { chromium, AxeBuilder, axeSourcePath, axeVersion };
}

/** Published identifier for a store: first 12 hex of sha256 of the bare domain. */
export function domainHash(domain) {
  return createHash('sha256').update(bareDomain(domain)).digest('hex').slice(0, 12);
}

export function bareDomain(d) {
  return String(d)
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, '')
    .replace(/\/.*$/, '')
    .replace(/^www\./, '');
}

const MULTI_TLDS = new Set(['co.uk', 'org.uk', 'com.au', 'net.au', 'co.nz', 'co.in', 'com.br', 'co.za', 'com.mx', 'co.jp', 'com.sg', 'com.tr']);

/** Registrable domain (approximate eTLD+1), used as the politeness key and same-site test. */
export function siteKey(host) {
  const parts = String(host).toLowerCase().replace(/\.$/, '').split('.');
  if (parts.length <= 2) return parts.join('.');
  const last2 = parts.slice(-2).join('.');
  if (MULTI_TLDS.has(last2)) return parts.slice(-3).join('.');
  return last2;
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Per-site pacing: at most one request every MIN_GAP_MS (or the site's Crawl-delay if longer). */
export class Pacer {
  constructor() {
    this.last = new Map();
    this.gap = new Map();
  }
  setCrawlDelay(host, seconds) {
    if (!Number.isFinite(seconds) || seconds <= 0) return;
    this.gap.set(siteKey(host), Math.min(MAX_CRAWL_DELAY_MS, Math.max(MIN_GAP_MS, seconds * 1000)));
  }
  async wait(host) {
    const key = siteKey(host);
    const gap = this.gap.get(key) ?? MIN_GAP_MS;
    const last = this.last.get(key) ?? 0;
    const due = last + gap - Date.now();
    if (due > 0) await sleep(due);
    this.last.set(key, Date.now());
  }
}

// ---------------------------------------------------------------- robots.txt

/**
 * Parse robots.txt into groups. Returns { groups: [{ agents: [...], rules: [{ allow, pattern }], crawlDelay }] }.
 */
export function parseRobots(text) {
  const groups = [];
  let cur = null;
  let lastWasAgent = false;
  for (const rawLine of String(text).split(/\r?\n/)) {
    const line = rawLine.replace(/#.*$/, '').trim();
    if (!line) continue;
    const m = line.match(/^([A-Za-z-]+)\s*:\s*(.*)$/);
    if (!m) continue;
    const key = m[1].toLowerCase();
    const val = m[2].trim();
    if (key === 'user-agent') {
      if (!cur || !lastWasAgent) {
        cur = { agents: [], rules: [], crawlDelay: undefined };
        groups.push(cur);
      }
      cur.agents.push(val.toLowerCase());
      lastWasAgent = true;
      continue;
    }
    lastWasAgent = false;
    if (!cur) continue;
    if (key === 'allow' || key === 'disallow') {
      if (key === 'disallow' && val === '') continue; // empty Disallow allows everything
      cur.rules.push({ allow: key === 'allow', pattern: val });
    } else if (key === 'crawl-delay') {
      const n = Number(val);
      if (Number.isFinite(n)) cur.crawlDelay = n;
    }
  }
  return { groups };
}

function patternToRegex(pattern) {
  let p = pattern;
  const anchored = p.endsWith('$');
  if (anchored) p = p.slice(0, -1);
  const esc = p.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
  return new RegExp(`^${esc}${anchored ? '$' : ''}`);
}

function decideForRules(rules, pathAndQuery) {
  // Longest matching pattern wins; on a tie, Allow wins.
  let best = null;
  for (const r of rules) {
    let ok = false;
    try {
      ok = patternToRegex(r.pattern).test(pathAndQuery);
    } catch {
      ok = pathAndQuery.startsWith(r.pattern);
    }
    if (!ok) continue;
    const len = r.pattern.length;
    if (!best || len > best.len || (len === best.len && r.allow && !best.allow)) best = { len, allow: r.allow, pattern: r.pattern };
  }
  return best ? { allowed: best.allow, rule: best.pattern } : { allowed: true, rule: null };
}

/** A robots group names this tool when its user-agent equals the product token (case-insensitive, version ignored). */
function namesThisTool(agent) {
  return agent.replace(/\/.*$/, '').trim() === TOOL_TOKEN.toLowerCase();
}

/**
 * Conservative check: the path must be allowed for user-agent "*" AND for any group that names this tool.
 * robots: parsed object, or { allowAll: true } / { disallowAll: true }.
 */
export function robotsAllows(robots, pathAndQuery) {
  if (!robots || robots.allowAll) return { allowed: true, rule: null };
  if (robots.disallowAll) return { allowed: false, rule: '(robots.txt unavailable: treated as disallow all)' };
  const star = robots.groups.filter((g) => g.agents.includes('*'));
  const ours = robots.groups.filter((g) => g.agents.some(namesThisTool));
  for (const set of [star, ours]) {
    if (!set.length) continue;
    const d = decideForRules(set.flatMap((g) => g.rules), pathAndQuery);
    if (!d.allowed) return d;
  }
  return { allowed: true, rule: null };
}

export function robotsCrawlDelay(robots) {
  if (!robots?.groups) return undefined;
  const vals = robots.groups
    .filter((g) => g.agents.includes('*') || g.agents.some(namesThisTool))
    .map((g) => g.crawlDelay)
    .filter((n) => Number.isFinite(n));
  return vals.length ? Math.max(...vals) : undefined;
}

/**
 * Fetch and parse robots.txt for an origin. 4xx: allow all (standard). 5xx or network error: disallow all (conservative).
 */
export async function fetchRobots(origin, pacer) {
  let r = await fetchRobotsOnce(origin, pacer);
  // one retry for a network error, after the usual gap
  if (r.status === 0) r = await fetchRobotsOnce(origin, pacer);
  return r;
}

async function fetchRobotsOnce(origin, pacer) {
  const url = new URL('/robots.txt', origin).href;
  if (pacer) await pacer.wait(new URL(origin).host);
  try {
    const res = await fetch(url, { headers: { 'user-agent': TOOL_UA, accept: 'text/plain,*/*;q=0.5' }, redirect: 'follow', signal: AbortSignal.timeout(30000) });
    if (res.status >= 400 && res.status < 500) return { status: res.status, robots: { allowAll: true } };
    if (res.status >= 500) return { status: res.status, robots: { disallowAll: true } };
    const text = (await res.text()).slice(0, 500000);
    // An HTML page served as robots.txt (soft 404) carries no rules.
    if (/^\s*<(!doctype|html)/i.test(text)) return { status: res.status, robots: { allowAll: true }, note: 'html-soft-404' };
    return { status: res.status, robots: parseRobots(text), finalUrl: res.url };
  } catch (e) {
    return { status: 0, robots: { disallowAll: true }, error: String(e?.message ?? e).slice(0, 200) };
  }
}

/** Robots cache per origin, shared by the sampler and the crawler. */
export class RobotsBook {
  constructor(pacer) {
    this.pacer = pacer;
    this.byOrigin = new Map();
  }
  async get(origin) {
    const o = new URL(origin).origin;
    if (!this.byOrigin.has(o)) {
      const r = await fetchRobots(o, this.pacer);
      const delay = robotsCrawlDelay(r.robots);
      if (delay) this.pacer.setCrawlDelay(new URL(o).host, delay);
      this.byOrigin.set(o, r);
    }
    return this.byOrigin.get(o);
  }
  async allows(url) {
    const u = new URL(url);
    const r = await this.get(u.origin);
    return { ...robotsAllows(r.robots, u.pathname + u.search), robotsStatus: r.status };
  }
}

/**
 * GET a page politely: robots.txt is checked for every origin before it is requested, including redirect targets,
 * and every request waits its turn with the pacer.
 */
export async function politeGet(url, book, { maxBytes = 3_000_000 } = {}) {
  let cur = url;
  for (let hop = 0; hop < 6; hop++) {
    const ok = await book.allows(cur);
    if (!ok.allowed) return { robotsBlocked: true, url: cur, rule: ok.rule };
    await book.pacer.wait(new URL(cur).host);
    const res = await fetch(cur, {
      headers: { 'user-agent': TOOL_UA, accept: 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.5', 'accept-language': 'en-US,en;q=0.8' },
      redirect: 'manual',
      signal: AbortSignal.timeout(30000),
    });
    if (res.status >= 300 && res.status < 400 && res.headers.get('location')) {
      cur = new URL(res.headers.get('location'), cur).href;
      continue;
    }
    const text = (await res.text()).slice(0, maxBytes);
    return { status: res.status, url: cur, headers: Object.fromEntries(res.headers.entries()), text };
  }
  return { status: 0, url: cur, error: 'too many redirects' };
}

// ---------------------------------------------------------------- platform

/**
 * Platform from page signals. `html` is page source, `hosts` is the set of request hostnames, `headers` the main
 * document's response headers, `globals` booleans read from window in the browser (optional).
 */
export function detectPlatform({ html = '', hosts = [], headers = {}, globals = {} }) {
  const h = html.slice(0, 3_000_000);
  const hostStr = hosts.join(' ');
  const hdr = Object.entries(headers)
    .map(([k, v]) => `${k.toLowerCase()}: ${String(v).toLowerCase()}`)
    .join('\n');
  const signals = [];
  const add = (platform, why) => signals.push({ platform, why });

  if (globals.shopify) add('shopify', 'window.Shopify');
  if (/cdn\.shopify\.com/.test(h) || /cdn\.shopify\.com/.test(hostStr)) add('shopify', 'cdn.shopify.com');
  if (/shopify-checkout-api-token|Shopify\.theme|ShopifyAnalytics/.test(h)) add('shopify', 'Shopify globals in source');
  if (/x-shopid|x-shopify-stage|powered-by: shopify/.test(hdr)) add('shopify', 'Shopify response header');
  if (/monorail-edge\.shopifysvc\.com|\.myshopify\.com/.test(hostStr)) add('shopify', 'Shopify service hosts');

  if (globals.woocommerce) add('woocommerce', 'wc globals');
  if (/wp-content\/plugins\/woocommerce|woocommerce-no-js|class="[^"]*\bwoocommerce\b|wc-block-|woocommerce_params|wc_add_to_cart_params/.test(h)) add('woocommerce', 'WooCommerce assets or classes');

  if (globals.magento) add('magento', 'Magento require config');
  if (/Magento_[A-Z][A-Za-z]+|data-mage-init|x-magento-init|mage\/cookies|requirejs-config\.js|\/static\/version\d+\/frontend\//.test(h)) add('magento', 'Magento modules or static path');
  if (/x-magento-/.test(hdr)) add('magento', 'Magento response header');

  if (globals.bigcommerce) add('bigcommerce', 'window.BCData');
  if (/cdn\d*\.bigcommerce\.com|stencil-utils|BCData/.test(h) || /bigcommerce\.com/.test(hostStr)) add('bigcommerce', 'BigCommerce CDN or Stencil');
  if (/^x-bc-/m.test(hdr)) add('bigcommerce', 'BigCommerce response header');

  if (/\/on\/demandware\.static\/|demandware\.store|\/dw\/image\/|dwanonymous_|Sites-[A-Za-z0-9_-]+-Site/.test(h) || /demandware\.net|commercecloud\.salesforce\.com/.test(hostStr)) add('sfcc', 'Salesforce Commerce Cloud (demandware) paths');
  if (/mobify|pwa-kit|__PRELOADED_STATE__[^<]{0,200}commerce/.test(h) && /salesforce|commercecloud/i.test(h)) add('sfcc', 'Salesforce PWA Kit');

  const counts = {};
  for (const s of signals) counts[s.platform] = (counts[s.platform] ?? 0) + 1;
  const ranked = Object.entries(counts).sort((a, b) => b[1] - a[1]);
  // A store can embed another platform's widget; the strongest family wins, Shopify/Magento/SFCC beat a stray WordPress blog.
  const platform = ranked.length ? ranked[0][0] : 'custom';
  return { platform, signals: signals.map((s) => `${s.platform}: ${s.why}`) };
}

export const PLATFORM_LABELS = {
  shopify: 'Shopify',
  woocommerce: 'WooCommerce',
  magento: 'Magento / Adobe Commerce',
  bigcommerce: 'BigCommerce',
  sfcc: 'Salesforce Commerce Cloud',
  custom: 'Custom or other',
};
