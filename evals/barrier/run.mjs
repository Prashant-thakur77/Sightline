// Checkout Barrier Index crawler.
//
//   node evals/barrier/run.mjs [--only=<domain>[,<domain>...]] [--limit=N] [--retry=timeout,error,no-product] [--force]
//
// Reads evals/data/raw/barrier/stores.json (git-ignored) and writes one raw JSON file per store to
// evals/data/raw/barrier/stores/<domainHash>.json. Resumable: stores with a file are skipped.
//
// Read-only by construction: pages are opened by URL only. Nothing is clicked, no form is submitted, no account is
// used, no personal data is typed. The only keys pressed are Tab (and Escape once if focus is trapped); Enter and
// Space are never sent. robots.txt is honoured for user-agent "*" and for this tool, every page waits at least
// 5 seconds after the previous request to the same site, and the user agent names the tool.
import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { loadTooling, RAW_DIR, STORE_DIR, TOOL_UA, Pacer, RobotsBook, domainHash, siteKey, detectPlatform, sleep, bareDomain } from './lib.mjs';
import { harvestLinks, platformGlobals, challengeSignals, inspectProduct, describeFocused, finishFocus } from './inpage.mjs';

export const AXE_TAGS = ['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa'];
export const ATC_RE = /add to (cart|bag|basket)|buy now/i;
const MAX_TABS = 150;
const STORE_BUDGET_MS = 9 * 60 * 1000;
const CURRENCY = /(?:[$£€₹¥]|\bUSD|\bEUR|\bGBP|\bINR|\bAUD|\bCAD|\bNZD|\bRs\.?|\bA\$|\bC\$|\bkr)\s?\d|\d(?:[.,]\d{2})?\s?(?:USD|EUR|GBP|INR|AUD|CAD|NZD|€|kr|zł|£)(?![a-z])/i;

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const [k, v] = a.replace(/^--/, '').split('=');
    return [k, v ?? true];
  }),
);

function withTimeout(p, ms, label) {
  let timer;
  const t = new Promise((_, rej) => {
    timer = setTimeout(() => rej(new Error(`timeout: ${label}`)), ms);
  });
  return Promise.race([p, t]).finally(() => clearTimeout(timer));
}

// ---------------------------------------------------------------- page helpers

async function visit(page, url, book, pacer) {
  const ok = await book.allows(url);
  if (!ok.allowed) return { url, skipped: 'robots', rule: ok.rule };
  await pacer.wait(new URL(url).host);
  const hosts = new Set();
  const onReq = (r) => {
    try {
      hosts.add(new URL(r.url()).host);
    } catch {}
  };
  page.on('request', onReq);
  // header names that give a platform away even on headless storefronts
  const platformHeaders = {};
  const onResp = (r) => {
    try {
      for (const k of Object.keys(r.headers())) if (/^x-(magento|shopify|shopid|bc-|dw-|sfdc)/i.test(k)) platformHeaders[k] = '1';
    } catch {}
  };
  page.on('response', onResp);
  const t0 = Date.now();
  let resp = null;
  let error = null;
  try {
    resp = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
  } catch (e) {
    error = String(e?.message ?? e).split('\n')[0].slice(0, 200);
  }
  if (!error) {
    await page.waitForLoadState('load', { timeout: 20000 }).catch(() => {});
    await page.waitForLoadState('networkidle', { timeout: 6000 }).catch(() => {});
    await sleep(1500);
  }
  page.off('request', onReq);
  page.off('response', onResp);
  const finalUrl = page.url();
  const out = { url, finalUrl, ms: Date.now() - t0, status: resp?.status() ?? null, hosts: [...hosts] };
  if (error) return { ...out, blocked: true, reason: /timeout/i.test(error) ? 'timeout' : `error: ${error}` };
  // The browser follows redirects on its own; if one landed on a path robots.txt disallows, drop the page unread.
  if (finalUrl !== url && /^https?:/.test(finalUrl)) {
    const ok2 = await book.allows(finalUrl);
    if (!ok2.allowed) return { ...out, skipped: 'robots-after-redirect', rule: ok2.rule };
  }
  out.headers = { ...platformHeaders, ...(resp ? await resp.allHeaders().catch(() => ({})) : {}) };
  out.title = await page.title().catch(() => '');
  const ch = await page.evaluate(challengeSignals).catch(() => null);
  out.challenge = ch;
  const st = out.status ?? 0;
  if (st === 403 || st === 429 || st === 503 || st === 401) out.blocked = true;
  const challenge = !!ch && (ch.strong || ch.titleHit || ((ch.words || ch.captcha) && ch.thin));
  if (challenge) out.blocked = true;
  if (st >= 400 && ch?.thin) out.blocked = true;
  if (out.blocked) out.reason = challenge ? 'challenge' : `http ${st}`;
  return out;
}

async function runAxe(page, AxeBuilder) {
  const t0 = Date.now();
  const shape = (res, framesExcluded) => ({
    ms: Date.now() - t0,
    framesExcluded,
    violations: res.violations.map((v) => ({ id: v.id, impact: v.impact, nodes: v.nodes.length, help: v.help, tags: v.tags.filter((t) => /^wcag\d|^best/.test(t)) })),
    passes: res.passes.length,
    incomplete: res.incomplete.length,
    version: res.testEngine?.version,
  });
  try {
    const res = await withTimeout(new AxeBuilder({ page }).withTags(AXE_TAGS).analyze(), 120000, 'axe');
    return shape(res, false);
  } catch (e) {
    try {
      const res = await withTimeout(new AxeBuilder({ page }).withTags(AXE_TAGS).exclude('iframe').analyze(), 120000, 'axe-noframes');
      return { ...shape(res, true), firstError: String(e?.message ?? e).slice(0, 200) };
    } catch (e2) {
      return { error: String(e2?.message ?? e2).slice(0, 200) };
    }
  }
}

function scoreProductLink(link, key) {
  let u;
  try {
    u = new URL(link.href);
  } catch {
    return -99;
  }
  if (siteKey(u.host) !== key) return -99;
  const p = u.pathname.toLowerCase();
  if (p === '/' || p.length < 3) return -99;
  if (/\/(cart|basket|bag|checkout|account|login|log-in|signin|sign-in|register|search|wishlist|blogs?|news|journal|pages\/|policies|policy|help|faq|contact|about|stores?\b|store-locator|gift-?cards?|returns|track|careers|sitemap|privacy|terms)/.test(p)) return -99;
  let s = 0;
  if (/\/products\/[^/]+\/?$/.test(p)) s += 10;
  if (/\/product\/[^/]+\/?$/.test(p)) s += 10;
  if (/\/(p|dp|ip|pd|prod)\/[^/]+/.test(p)) s += 8;
  if (/[-_/](p|prod|pd|sku|style|item)?[-_]?\d{5,}(\.html?)?\/?$/.test(p)) s += 6;
  if (/\.html?$/.test(p)) s += 2;
  if (/\/[^/]*\d{3,}[^/]*\.html?$/.test(p)) s += 4;
  const ctx = link.ctx.toLowerCase();
  if (/product[-_]{0,2}(tile|card|item|grid|link|image|img|name|title|block|thumb)|card[-_]product|productgrid|product-item|data-product-id|data-pid|data-entity-id|data-product|data-item-id|data-sku|grid-product|productcard|loopproduct|loop-product|type-product/.test(ctx)) s += 5;
  if (link.inHeader) s -= 3;
  if (link.inFooter) s -= 6;
  if (!link.visible) s -= 1;
  if (/\/(collections|category|categories|product-category|catalog|c)\/[^/]*\/?$/.test(p) && !/\/products?\//.test(p)) s -= 4;
  if (/card[-_](title|figure|img|image|body)|product-click|productclick/.test(ctx)) s += 3;
  if (/gift|card|sample|swatch|bundle|subscription|giftcard|e-gift/.test(p)) s -= 4;
  return s;
}

/** Second pass for flat product URLs (e.g. /blue-linen-shirt/): hyphenated slugs in the page body, verified on visit. */
function scoreSlugLink(link, key) {
  const base = scoreProductLink(link, key);
  if (base <= -99 || link.inHeader || link.inFooter || !link.visible) return -99;
  const p = new URL(link.href).pathname.toLowerCase().replace(/\/$/, '');
  const parts = p.split('/').filter(Boolean);
  if (parts.length < 1 || parts.length > 3) return -99;
  const last = parts[parts.length - 1];
  return base + (last.split('-').length >= 3 ? 3 : 0);
}

function pickCandidates(links, key) {
  let c = links.map((l) => ({ href: l.href, s: scoreProductLink(l, key) })).filter((x) => x.s >= 5);
  if (!c.length) c = links.map((l) => ({ href: l.href, s: scoreSlugLink(l, key) })).filter((x) => x.s >= 3);
  return c.sort((a, b) => b.s - a.s);
}

function scoreCategoryLink(link, key) {
  let u;
  try {
    u = new URL(link.href);
  } catch {
    return -99;
  }
  if (siteKey(u.host) !== key) return -99;
  const p = u.pathname.toLowerCase();
  if (/\/(cart|checkout|account|login|search|blogs?|pages\/|help|faq|contact|about|gift)/.test(p)) return -99;
  let s = 0;
  if (/\/collections\/all\/?$/.test(p)) s += 6;
  if (/\/(collections|category|categories|product-category|shop|shop-all|catalog|c)(\/|$)/.test(p)) s += 4;
  if (/(women|men|new|sale|best|all|clothing|shoes|home|accessories|bags|tops|shirts|bedding|furniture)/.test(p)) s += 2;
  if (link.inHeader) s += 1;
  if (link.inFooter) s -= 2;
  return s;
}

const CART_PATH = /^\/(cart|basket|bag|shopping-bag|shoppingbag|shopping-cart|checkout\/cart|cart\.php)\/?$/i;
const CART_DEFAULT = { shopify: '/cart', woocommerce: '/cart/', magento: '/checkout/cart/', bigcommerce: '/cart.php', sfcc: '/cart' };

// ---------------------------------------------------------------- keyboard traversal

const DEEP_ACTIVE = `(() => { let el = document.activeElement; while (el && el.shadowRoot && el.shadowRoot.activeElement) el = el.shadowRoot.activeElement; return el; })()`;

async function keyboardTraversal(page, cdp, tabbable) {
  await cdp.send('Accessibility.enable').catch(() => {});
  const steps = [];
  const seen = new Map();
  let stuck = 0;
  let iframeRun = 0;
  let escapes = 0;
  let trap = null;
  let wrapped = false;
  let firstAtc = null;
  let firstAtcSecondary = null;
  const variantSteps = [];
  let lastId = null;
  let i = 0;
  for (i = 1; i <= MAX_TABS; i++) {
    await page.keyboard.press('Tab');
    await sleep(70);
    let step = { i };
    try {
      const { result } = await cdp.send('Runtime.evaluate', { expression: DEEP_ACTIVE, objectGroup: 'kb' });
      if (!result?.objectId) {
        step.document = true;
      } else {
        const det = await cdp.send('Runtime.callFunctionOn', { objectId: result.objectId, functionDeclaration: describeFocused.toString(), returnByValue: true, objectGroup: 'kb' });
        const d = det.result?.value ?? {};
        if (d.lost) {
          step.lost = true;
        } else {
          Object.assign(step, d);
          if (!d.document) {
            const ax = await cdp.send('Accessibility.getPartialAXTree', { objectId: result.objectId, fetchRelatives: false }).catch(() => null);
            const node = ax?.nodes?.find((n) => !n.ignored) ?? ax?.nodes?.[0];
            step.role = node?.role?.value ?? null;
            step.name = String(node?.name?.value ?? '').replace(/\s+/g, ' ').trim().slice(0, 100);
            step.axIgnored = !!(ax?.nodes?.length && ax.nodes.every((n) => n.ignored));
          }
        }
      }
      await cdp.send('Runtime.releaseObjectGroup', { objectGroup: 'kb' }).catch(() => {});
    } catch (e) {
      step.error = String(e?.message ?? e).slice(0, 120);
    }
    // the visible-focus verdict for the previous step arrives with this one
    if (steps.length && 'prevVisibleFocus' in step) steps[steps.length - 1].visibleFocus = step.prevVisibleFocus;
    delete step.prevVisibleFocus;
    steps.push(step);
    if (step.lost || step.error) {
      if (steps.filter((s) => s.lost || s.error).length >= 5) break;
      continue;
    }

    if (!step.document && step.name && ATC_RE.test(step.name) && !step.disabled) {
      if (!step.secondary && !firstAtc) firstAtc = { tabs: i, role: step.role, name: step.name, overlay: step.overlay };
      if (step.secondary && !firstAtcSecondary) firstAtcSecondary = { tabs: i };
    }
    if (step.variant) variantSteps.push({ tabs: i, role: step.role, named: !!step.name, tag: step.tag });

    // Focus fell back to the document. After a pass through most of the page that is a normal wrap-around; a short
    // loop is decided below, when an element comes round again.
    if (step.document) {
      if (seen.size >= Math.max(4, tabbable * 0.5)) {
        wrapped = true;
        break;
      }
      lastId = null;
      continue;
    }
    // stuck on one element (iframes swallow Tabs while focus moves inside them, so give them longer)
    if (step.id === lastId) {
      if (step.iframe) iframeRun++;
      else stuck++;
    } else {
      stuck = 0;
      iframeRun = 0;
    }
    let trapped = null;
    if (stuck >= 3) trapped = { kind: 'stuck', cycle: 1 };
    if (iframeRun >= 25) trapped = { kind: 'stuck-iframe', cycle: 1 };
    // An element came round again: a short loop is a trap (with or without a stop on the document), a long one is
    // the page wrapping around.
    if (!trapped && seen.has(step.id) && step.id !== lastId) {
      const from = seen.get(step.id);
      const cycleSteps = steps.slice(from - 1, i - 1).filter((s) => !s.lost && !s.error && !s.document);
      const distinct = new Set(cycleSteps.map((s) => s.id)).size;
      const passedDocument = steps.slice(from - 1, i - 1).some((s) => s.document);
      if (distinct < Math.max(4, tabbable * 0.5)) {
        trapped = { kind: passedDocument ? 'loop-via-document' : 'cycle', cycle: distinct, inDialog: cycleSteps.some((s) => s.dialog), inOverlay: cycleSteps.some((s) => s.overlay) };
      } else {
        wrapped = true;
        break;
      }
    }
    if (trapped) {
      trapped.atTab = i;
      trapped.names = steps.slice(-Math.min(6, trapped.cycle + 1)).map((s) => s.name ?? s.tag);
      if (escapes === 0) {
        escapes++;
        trap = { ...trapped, escaped: null };
        await page.keyboard.press('Escape');
        await sleep(300);
        seen.clear();
        stuck = 0;
        iframeRun = 0;
        lastId = null;
        continue;
      }
      trap = { ...trap, second: trapped, escaped: false };
      break;
    }
    if (!seen.has(step.id)) seen.set(step.id, i);
    lastId = step.id;
  }
  if (trap && trap.escaped === null) trap.escaped = true;
  // settle the last element's focus style
  const lastVisible = await page.evaluate(finishFocus).catch(() => null);
  if (steps.length && steps[steps.length - 1].visibleFocus === undefined && !steps[steps.length - 1].document) steps[steps.length - 1].visibleFocus = lastVisible;

  const elementSteps = steps.filter((s) => !s.document && !s.lost && !s.error && !s.iframe);
  const withVerdict = elementSteps.filter((s) => s.visibleFocus === true || s.visibleFocus === false);
  const namedRoles = new Set(['button', 'link', 'checkbox', 'radio', 'combobox', 'textbox', 'menuitem', 'tab', 'option', 'switch', 'searchbox', 'listbox', 'slider', 'spinbutton', 'menuitemradio', 'menuitemcheckbox', 'PopUpButton']);
  return {
    tabsPressed: Math.min(i, MAX_TABS),
    wrapped,
    distinctElements: new Set(elementSteps.map((s) => s.id)).size,
    atcReached: !!firstAtc,
    atcTabs: firstAtc?.tabs ?? null,
    atcViaOverlay: firstAtc?.overlay ?? null,
    secondaryAtcReachedFirstAt: firstAtcSecondary?.tabs ?? null,
    variantReached: variantSteps.length > 0,
    variantFirstTabs: variantSteps[0]?.tabs ?? null,
    variantReachedCount: variantSteps.length,
    variantUnnamedCount: variantSteps.filter((v) => !v.named).length,
    trap,
    trapped: !!trap && trap.escaped === false,
    escapes,
    focusInvisibleSteps: elementSteps.filter((s) => s.visible === false).length,
    visibleFocusChecked: withVerdict.length,
    noVisibleFocus: withVerdict.filter((s) => s.visibleFocus === false).length,
    unnamedFocusable: elementSteps.filter((s) => !s.name && namedRoles.has(s.role)).length,
    unnamedFocusedButtons: elementSteps.filter((s) => !s.name && s.role === 'button').length,
    ariaHiddenFocusable: elementSteps.filter((s) => s.axIgnored).length,
    log: steps.map((s) => ({ i: s.i, id: s.id, role: s.role, name: s.name, tag: s.tag, vf: s.visibleFocus, vis: s.visible, v: s.variant || undefined, sec: s.secondary || undefined, dlg: s.dialog || undefined, doc: s.document || undefined, err: s.error || s.lost || undefined })),
  };
}

// ---------------------------------------------------------------- price exposure

function priceCheck(snapshot, structuredPrice) {
  const text = String(snapshot ?? '');
  const anyCurrency = CURRENCY.test(text);
  let structuredMatch = null;
  if (structuredPrice != null) {
    const num = Number(String(structuredPrice).replace(/[^\d.]/g, ''));
    if (Number.isFinite(num) && num > 0) {
      const intPart = String(Math.floor(num));
      const flat = text.replace(/(\d)[,.\s  ](?=\d{3}(?!\d))/g, '$1');
      structuredMatch = new RegExp(`(^|[^\\d])${intPart}([.,]\\d{1,2})?([^\\d]|$)`).test(flat);
    }
  }
  return { anyCurrency, structuredMatch };
}

// ---------------------------------------------------------------- one store

async function crawlStore(browser, AxeBuilder, ua, store) {
  const domain = bareDomain(store.domain);
  const rec = { domain, domainHash: domainHash(domain), startedAt: new Date().toISOString(), status: 'ok', notes: [], pages: {} };
  const pacer = new Pacer();
  const book = new RobotsBook(pacer);
  const ctx = await browser.newContext({
    userAgent: ua,
    viewport: { width: 1280, height: 900 },
    locale: 'en-US',
    reducedMotion: 'reduce',
    serviceWorkers: 'block',
    acceptDownloads: false,
    extraHTTPHeaders: { 'accept-language': 'en-US,en;q=0.9' },
  });
  await ctx.route('**/*', (route) => (route.request().resourceType() === 'media' ? route.abort() : route.continue()));
  const page = await ctx.newPage();
  page.on('dialog', (d) => d.dismiss().catch(() => {}));
  page.on('popup', (p) => p.close().catch(() => {}));
  try {
    // ---- home
    const startUrl = store.startUrl || `https://www.${domain}/`;
    const robotsInfo = await book.get(new URL(startUrl).origin);
    rec.robotsStatus = robotsInfo.status;
    const home = await visit(page, startUrl, book, pacer);
    rec.pages.home = { status: home.status, ms: home.ms, blocked: !!home.blocked, reason: home.reason, skipped: home.skipped, finalUrl: home.finalUrl };
    if (home.skipped) {
      rec.status = 'robots';
      return rec;
    }
    if (home.blocked) {
      rec.status = 'blocked';
      rec.blockedAt = 'home';
      rec.blockedReason = home.reason;
      return rec;
    }
    const key = siteKey(new URL(page.url()).host);
    const html = await page.content().catch(() => '');
    const globals = await page.evaluate(platformGlobals).catch(() => ({}));
    let plat = detectPlatform({ html, hosts: home.hosts, headers: home.headers, globals });
    rec.platform = plat.platform;
    rec.platformSignals = plat.signals;
    rec.pages.home.axe = await runAxe(page, AxeBuilder);
    const links = await page.evaluate(harvestLinks).catch(() => []);
    rec.homeLinks = links.length;

    // ---- cart link (read from the page, never clicked)
    const cartLink = links.find((l) => {
      try {
        const u = new URL(l.href);
        return siteKey(u.host) === key && CART_PATH.test(u.pathname);
      } catch {
        return false;
      }
    });

    // ---- product page: candidates from the home page, else from one category page
    let blockedProduct = 0;
    let candidates = links.map((l) => ({ href: l.href, s: scoreProductLink(l, key) })).filter((c) => c.s >= 5);
    if (candidates.length === 0) {
      const cats = links
        .map((l) => ({ href: l.href, s: scoreCategoryLink(l, key) }))
        .filter((c) => c.s >= 3)
        .sort((a, b) => b.s - a.s);
      // up to two category pages, stopping at the first that lists products
      for (const catLink of cats.slice(0, 2)) {
        const cat = await visit(page, catLink.href, book, pacer);
        rec.pages.category = { url: catLink.href, status: cat.status, blocked: !!cat.blocked, skipped: cat.skipped, reason: cat.reason };
        if (cat.blocked) {
          blockedProduct++;
          break;
        }
        if (!cat.skipped) {
          const clinks = await page.evaluate(harvestLinks).catch(() => []);
          candidates = pickCandidates(clinks, key);
          if (candidates.length) break;
        }
      }
      if (!candidates.length) candidates = pickCandidates(links, key);
    }
    candidates.sort((a, b) => b.s - a.s);
    // spread picks across the page instead of three neighbours from one carousel
    const seenPaths = new Set();
    candidates = candidates.filter((c) => {
      const p = new URL(c.href).pathname.replace(/\/$/, '');
      if (seenPaths.has(p)) return false;
      seenPaths.add(p);
      return true;
    });
    rec.productCandidates = candidates.length;
    rec.productCandidateSample = candidates.slice(0, 5).map((c) => `${c.s} ${c.href}`);
    let product = null;
    let fallback = null;
    for (const c of candidates.slice(0, 3)) {
      const v = await visit(page, c.href, book, pacer);
      if (v.skipped) {
        rec.notes.push(`product candidate skipped: ${v.skipped}`);
        continue;
      }
      if (v.blocked) {
        blockedProduct++;
        rec.notes.push(`product candidate blocked: ${v.reason}`);
        if (v.reason === 'challenge' || v.reason === 'timeout') break;
        continue;
      }
      const info = await page.evaluate(inspectProduct).catch((e) => ({ error: String(e?.message ?? e).slice(0, 200) }));
      const isProduct = info.signals?.length > 0 || info.atc?.mainEnabled > 0 || info.atc?.mainDisabled > 0;
      if (!isProduct) {
        rec.notes.push('candidate was not a product page');
        continue;
      }
      if (info.atc.mainEnabled > 0 || info.atc.mainDisabled > 0) {
        product = { visit: v, info };
        break;
      }
      if (!fallback) fallback = { visit: v, info, href: c.href };
      rec.notes.push('product page had no add-to-cart control (sold out or other wording)');
    }
    if (!product && fallback) {
      // return to the first real product page we saw so the measurements match it
      const v = await visit(page, fallback.href, book, pacer);
      if (!v.blocked && !v.skipped) {
        const info = await page.evaluate(inspectProduct).catch(() => fallback.info);
        product = { visit: v, info };
      }
    }
    if (!product) {
      rec.status = blockedProduct > 0 ? 'blocked' : 'no-product';
      if (blockedProduct > 0) {
        rec.blockedAt = 'product';
        rec.blockedReason = 'product page refused';
      }
    } else {
      const v = product.visit;
      const info = product.info;
      rec.pages.product = { status: v.status, ms: v.ms, finalUrl: v.finalUrl };
      const html2 = await page.content().catch(() => '');
      const g2 = await page.evaluate(platformGlobals).catch(() => ({}));
      const plat2 = detectPlatform({ html: html2, hosts: [...home.hosts, ...v.hosts], headers: { ...home.headers, ...v.headers }, globals: { ...globals, ...g2 } });
      if (plat2.platform !== 'custom' && plat.platform === 'custom') {
        plat = plat2;
        rec.platform = plat2.platform;
        rec.platformSignals = plat2.signals;
      }
      rec.pages.product.axe = await runAxe(page, AxeBuilder);
      let snapshot = null;
      if (info.price?.regionFound) {
        snapshot = await page.locator('[data-sbi-pinfo="1"]').first().ariaSnapshot({ timeout: 20000 }).catch(() => null);
      }
      const pc = priceCheck(snapshot, info.structuredPrice);
      rec.product = {
        signals: info.signals,
        h1: info.h1,
        atc: info.atc,
        images: info.images,
        variants: info.variants,
        tabbable: info.tabbable,
        price: {
          structured: info.structuredPrice != null,
          regionFound: !!info.price?.regionFound,
          visible: !!info.price?.visibleText,
          a11ySnapshot: snapshot != null,
          exposedAsText: snapshot != null ? pc.anyCurrency || pc.structuredMatch === true : null,
          structuredMatch: pc.structuredMatch,
        },
      };
      const cdp = await ctx.newCDPSession(page);
      try {
        rec.keyboard = await withTimeout(keyboardTraversal(page, cdp, info.tabbable ?? 0), 180000, 'keyboard');
      } catch (e) {
        rec.keyboard = { error: String(e?.message ?? e).slice(0, 200) };
      }
      await cdp.detach().catch(() => {});
    }

    // ---- cart, by direct URL, only if robots.txt allows it
    const cartUrl = cartLink?.href ?? (CART_DEFAULT[rec.platform] ? new URL(CART_DEFAULT[rec.platform], page.url()).href : null);
    if (cartUrl) {
      const c = await visit(page, cartUrl, book, pacer);
      rec.pages.cart = { status: c.status, skipped: c.skipped, blocked: !!c.blocked, reason: c.reason, source: cartLink ? 'home-link' : 'platform-default' };
      if (!c.skipped && !c.blocked && (c.status ?? 0) < 400) rec.pages.cart.axe = await runAxe(page, AxeBuilder);
    } else {
      rec.pages.cart = { skipped: 'no-cart-url' };
    }
  } catch (e) {
    rec.status = rec.status === 'ok' ? 'error' : rec.status;
    rec.error = String(e?.message ?? e).slice(0, 300);
  } finally {
    rec.finishedAt = new Date().toISOString();
    await ctx.close().catch(() => {});
  }
  return rec;
}

// ---------------------------------------------------------------- main

async function main() {
  const { chromium, AxeBuilder, axeVersion } = loadTooling();
  await fs.mkdir(STORE_DIR, { recursive: true });
  let stores = JSON.parse(await fs.readFile(path.join(RAW_DIR, 'stores.json'), 'utf8'));
  if (args.only) {
    const only = new Set(String(args.only).split(',').map(bareDomain));
    stores = stores.filter((s) => only.has(bareDomain(s.domain)));
  }
  const browser = await chromium.launch({ headless: true, args: ['--disable-dev-shm-usage'] });
  const ua = `Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/${browser.version()} Safari/537.36 ${TOOL_UA}`;
  let n = 0;
  for (const store of stores) {
    const hash = domainHash(store.domain);
    const file = path.join(STORE_DIR, `${hash}.json`);
    let prev = null;
    try {
      prev = JSON.parse(await fs.readFile(file, 'utf8'));
    } catch {}
    const retry = new Set(String(args.retry ?? (args['retry-blocked'] ? 'blocked,error' : '')).split(',').filter(Boolean));
    const timedOut = prev?.status === 'blocked' && /timeout/.test(`${prev.blockedReason ?? ''} ${prev.pages?.home?.reason ?? ''} ${(prev.notes ?? []).join(' ')}`);
    if (prev && !args.force && !retry.has(prev.status) && !(retry.has('timeout') && timedOut)) continue;
    if (args.limit && n >= Number(args.limit)) break;
    n++;
    let rec;
    try {
      rec = await withTimeout(crawlStore(browser, AxeBuilder, ua, store), STORE_BUDGET_MS, 'store');
    } catch (e) {
      rec = { domain: bareDomain(store.domain), domainHash: hash, status: 'error', error: String(e?.message ?? e).slice(0, 200), finishedAt: new Date().toISOString() };
    }
    rec.axeVersion = axeVersion;
    rec.userAgent = ua;
    await fs.writeFile(file, JSON.stringify(rec, null, 1));
    const kb = rec.keyboard;
    console.log(
      [
        new Date().toISOString().slice(11, 19),
        hash,
        (rec.platform ?? '-').padEnd(11),
        rec.status.padEnd(10),
        `home=${rec.pages?.home?.axe?.violations?.length ?? '-'}`,
        `prod=${rec.pages?.product?.axe?.violations?.length ?? '-'}`,
        `cart=${rec.pages?.cart?.axe?.violations?.length ?? rec.pages?.cart?.skipped ?? '-'}`,
        `atc=${kb ? (kb.atcReached ? `tab${kb.atcTabs}` : 'no') : '-'}`,
        `trap=${kb?.trap ? kb.trap.kind + (kb.trap.escaped ? '/esc' : '') : '-'}`,
      ].join(' '),
    );
  }
  await browser.close();
  console.log('done');
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) await main();

export { keyboardTraversal, priceCheck, scoreProductLink };
