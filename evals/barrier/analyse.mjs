// Aggregate the raw crawl into evals/results/barrier.json.
//
//   node evals/barrier/analyse.mjs
//
// Reads evals/data/raw/barrier/stores.json and evals/data/raw/barrier/stores/*.json (git-ignored). The output names no
// store: each one appears only as the first 12 hex characters of sha256(domain), and results are grouped by platform.
import fs from 'node:fs/promises';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { RAW_DIR, STORE_DIR, RESULT_FILE, ROOT, domainHash } from './lib.mjs';

const SCRIPT = 'evals/barrier/analyse.mjs';
const PLATFORMS = ['shopify', 'woocommerce', 'magento', 'bigcommerce', 'sfcc', 'custom'];
const UNNAMED_BUTTON_RULES = new Set(['button-name', 'input-button-name', 'aria-command-name']);

// ---------------------------------------------------------------- stats

export function quantile(xs, q) {
  const s = [...xs].sort((a, b) => a - b);
  if (!s.length) return null;
  const pos = (s.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return s[lo] + (s[hi] - s[lo]) * (pos - lo);
}
const median = (xs) => quantile(xs, 0.5);

/** Wilson score interval for k successes in n trials (95%). */
export function wilson(k, n, z = 1.96) {
  if (!n) return [null, null];
  const p = k / n;
  const d = 1 + (z * z) / n;
  const c = (p + (z * z) / (2 * n)) / d;
  const h = (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / d;
  return [Math.max(0, c - h), Math.min(1, c + h)];
}

const pct = (x) => (x == null ? 'n/a' : `${Math.round(x * 100)}%`);
const num = (x) => (x == null ? null : Math.round(x * 10) / 10);
const fmt = (x) => (x == null ? 'n/a' : Number.isInteger(x) ? String(x) : x.toFixed(1));
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
const rate = (k, n) => (n ? Math.round((k / n) * 1000) / 1000 : null);

// ---------------------------------------------------------------- per store

function violationsOf(page) {
  return page?.axe?.violations ?? null;
}

function keyboardOutcome(rec) {
  const kb = rec.keyboard;
  if (!kb || kb.error) return 'error';
  const atc = rec.product?.atc ?? {};
  if (kb.atcReached) return 'reached';
  const t = kb.trap;
  // focus held by a consent banner or dialog that Escape did not close; a person would press one of its buttons,
  // which this crawler never does, so the page is left out rather than counted as a failure
  if (t && t.escaped === false && (t.inOverlay || t.inDialog || t.second?.inOverlay || t.second?.inDialog)) return 'overlay-blocked';
  if ((atc.mainEnabledVisible ?? 0) > 0) return 'not-reached';
  // the visible button says "Select a size" or is disabled until a choice is made
  if ((atc.mainDisabled ?? 0) > 0 || (atc.mainEnabled ?? 0) > 0) return 'atc-needs-selection';
  return 'no-atc';
}

/** A category page that refused or timed out on the way to a product counts as the store blocking the crawl. */
function statusOf(rec) {
  if (rec.status === 'no-product' && rec.pages?.category?.blocked) return { status: 'blocked', blockedAt: 'product' };
  // sent away from the store (for example a "site closed in your country" page) to a path robots.txt disallows
  if (rec.status === 'robots' && rec.pages?.home?.skipped === 'robots-after-redirect') return { status: 'blocked', blockedAt: 'home' };
  return { status: rec.status, blockedAt: rec.blockedAt ?? null };
}

function storeMetrics(rec, platform) {
  const home = violationsOf(rec.pages?.home);
  const prod = violationsOf(rec.pages?.product);
  const cart = violationsOf(rec.pages?.cart);
  const nodes = (v) => (v ? v.reduce((a, x) => a + x.nodes, 0) : null);
  const unnamed = (v) => (v ? v.filter((x) => UNNAMED_BUTTON_RULES.has(x.id)).reduce((a, x) => a + x.nodes, 0) : null);
  const kb = rec.keyboard && !rec.keyboard.error ? rec.keyboard : null;
  const outcome = prod ? keyboardOutcome(rec) : null;
  const variants = rec.product?.variants;
  return {
    domainHash: rec.domainHash,
    platform,
    ...statusOf(rec),
    homeViolations: home ? home.length : null,
    homeFailingNodes: nodes(home),
    productViolations: prod ? prod.length : null,
    productFailingNodes: nodes(prod),
    productCriticalOrSerious: prod ? prod.filter((v) => v.impact === 'critical' || v.impact === 'serious').length : null,
    cartViolations: cart ? cart.length : null,
    cartAudit: rec.pages?.cart?.axe ? 'audited' : rec.pages?.cart?.skipped ?? (rec.pages?.cart?.blocked ? 'blocked' : rec.pages?.cart ? 'not-audited' : null),
    unnamedButtonsHome: unnamed(home),
    unnamedButtonsProduct: unnamed(prod),
    keyboardOutcome: outcome,
    tabsToAddToCart: kb?.atcReached ? kb.atcTabs : null,
    tabsPressed: kb?.tabsPressed ?? null,
    focusTrap: kb ? (kb.trap ? (kb.trap.escaped ? 'escaped-with-escape' : 'trapped') : 'none') : null,
    focusTrapInOverlay: kb?.trap ? !!(kb.trap.inOverlay || kb.trap.inDialog) : null,
    variantSelectorPresent: variants ? variants.present > 0 : null,
    variantSelectorReached: kb && variants?.present > 0 ? kb.variantReached : null,
    variantSelectorNamed: kb && kb.variantReached ? kb.variantUnnamedCount === 0 : null,
    nonFocusableSwatches: variants ? variants.nonFocusableSwatches : null,
    focusStepsChecked: kb?.visibleFocusChecked ?? null,
    focusStepsWithoutVisibleChange: kb?.noVisibleFocus ?? null,
    focusOnInvisibleElement: kb?.focusInvisibleSteps ?? null,
    ariaHiddenFocusable: kb?.ariaHiddenFocusable ?? null,
    productImages: rec.product?.images?.productImages ?? null,
    productImagesNoAlt: rec.product?.images?.noAlt ?? null,
    productImagesEmptyAlt: rec.product?.images?.emptyAlt ?? null,
    priceVisible: rec.product?.price ? rec.product.price.visible : null,
    priceExposedAsText: rec.product?.price?.exposedAsText ?? null,
  };
}

// ---------------------------------------------------------------- aggregate

function aggregate(rows) {
  const analysed = rows.filter((r) => r.productViolations != null);
  const kbRows = analysed.filter((r) => r.keyboardOutcome === 'reached' || r.keyboardOutcome === 'not-reached');
  const reached = kbRows.filter((r) => r.keyboardOutcome === 'reached').length;
  const withHome = rows.filter((r) => r.homeViolations != null);
  const unnamedRows = analysed.filter((r) => r.unnamedButtonsProduct != null);
  const unnamedK = unnamedRows.filter((r) => (r.unnamedButtonsProduct ?? 0) + (r.unnamedButtonsHome ?? 0) > 0).length;
  const imgRows = analysed.filter((r) => (r.productImages ?? 0) > 0);
  const priceRows = analysed.filter((r) => r.priceExposedAsText != null);
  const varRows = analysed.filter((r) => r.variantSelectorReached != null);
  const trapRows = analysed.filter((r) => r.focusTrap != null);
  const focusShares = analysed.filter((r) => (r.focusStepsChecked ?? 0) >= 5).map((r) => r.focusStepsWithoutVisibleChange / r.focusStepsChecked);
  return {
    stores: rows.length,
    crawled: analysed.length,
    blocked: rows.filter((r) => r.status === 'blocked').length,
    medianViolationsProduct: num(median(analysed.map((r) => r.productViolations))),
    iqrViolationsProduct: analysed.length ? [num(quantile(analysed.map((r) => r.productViolations), 0.25)), num(quantile(analysed.map((r) => r.productViolations), 0.75))] : null,
    medianFailingNodesProduct: num(median(analysed.map((r) => r.productFailingNodes))),
    medianViolationsHome: num(median(withHome.map((r) => r.homeViolations))),
    medianFailingNodesHome: num(median(withHome.map((r) => r.homeFailingNodes))),
    keyboardReachAddToCartRate: rate(reached, kbRows.length),
    keyboardReachDenominator: kbRows.length,
    keyboardOutcomes: analysed.reduce((m, r) => ({ ...m, [r.keyboardOutcome]: (m[r.keyboardOutcome] ?? 0) + 1 }), {}),
    medianTabsToAddToCart: num(median(analysed.filter((r) => r.tabsToAddToCart != null).map((r) => r.tabsToAddToCart))),
    unnamedButtonsRate: rate(unnamedK, unnamedRows.length),
    productImagesMissingAltRate: rate(imgRows.filter((r) => r.productImagesNoAlt > 0).length, imgRows.length),
    priceExposedAsTextRate: rate(priceRows.filter((r) => r.priceExposedAsText).length, priceRows.length),
    priceVisibleButNotExposed: priceRows.filter((r) => r.priceVisible && !r.priceExposedAsText).length,
    variantSelectorReachableRate: rate(varRows.filter((r) => r.variantSelectorReached).length, varRows.length),
    focusTrapRate: rate(trapRows.filter((r) => r.focusTrap === 'trapped').length, trapRows.length),
    medianShareOfFocusStopsWithoutVisibleChange: median(focusShares) == null ? null : Math.round(median(focusShares) * 1000) / 1000,
    cartAudited: rows.filter((r) => r.cartAudit === 'audited').length,
    cartSkippedByRobots: rows.filter((r) => r.cartAudit === 'robots' || r.cartAudit === 'robots-after-redirect').length,
  };
}

async function main() {
  const sample = JSON.parse(await fs.readFile(path.join(RAW_DIR, 'stores.json'), 'utf8'));
  const recs = [];
  for (const s of sample) {
    try {
      recs.push(JSON.parse(await fs.readFile(path.join(STORE_DIR, `${domainHash(s.domain)}.json`), 'utf8')));
    } catch {
      /* not crawled yet */
    }
  }
  if (!recs.length) throw new Error('no crawl data: run evals/barrier/run.mjs first');

  // Blocked stores never showed their page signals to the browser; group them by the plain-request precheck.
  const preByHash = new Map(sample.map((s) => [domainHash(s.domain), s.precheckPlatform]));
  const platformOf = (rec) => {
    if (rec.platform) return rec.platform;
    const pre = preByHash.get(rec.domainHash);
    return pre && pre !== 'unknown' ? pre : 'custom';
  };
  const rows = recs.map((r) => storeMetrics(r, platformOf(r))).sort((a, b) => a.platform.localeCompare(b.platform) || a.domainHash.localeCompare(b.domainHash));
  const all = aggregate(rows);
  const byPlatform = {};
  for (const p of PLATFORMS) {
    const sub = rows.filter((r) => r.platform === p);
    if (sub.length) byPlatform[p] = aggregate(sub);
  }

  // ---- rules across stores (any audited page counts once per store)
  const analysedRecs = recs.filter((r) => r.pages?.product?.axe?.violations);
  const ruleMap = new Map();
  for (const rec of analysedRecs) {
    const perStore = new Map();
    for (const kind of ['home', 'product', 'cart']) {
      for (const v of rec.pages?.[kind]?.axe?.violations ?? []) {
        const cur = perStore.get(v.id) ?? { nodes: 0, help: v.help };
        cur.nodes += v.nodes;
        perStore.set(v.id, cur);
      }
    }
    for (const [id, v] of perStore) {
      const cur = ruleMap.get(id) ?? { id, help: v.help, storesAffected: 0, totalNodes: 0 };
      cur.storesAffected++;
      cur.totalNodes += v.nodes;
      ruleMap.set(id, cur);
    }
  }
  const topRules = [...ruleMap.values()].sort((a, b) => b.storesAffected - a.storesAffected || b.totalNodes - a.totalNodes).slice(0, 10);

  // ---- headlines
  const N = all.crawled;
  const analysedRows = rows.filter((r) => r.productViolations != null);
  const kbRows = analysedRows.filter((r) => r.keyboardOutcome === 'reached' || r.keyboardOutcome === 'not-reached');
  const notReached = kbRows.filter((r) => r.keyboardOutcome === 'not-reached');
  const trappedAmongNot = notReached.filter((r) => r.focusTrap === 'trapped').length;
  const excludedDisabled = analysedRows.filter((r) => r.keyboardOutcome === 'atc-needs-selection').length;
  const excludedOverlay = analysedRows.filter((r) => r.keyboardOutcome === 'overlay-blocked').length;
  const excludedNoAtc = analysedRows.filter((r) => r.keyboardOutcome === 'no-atc').length;
  const excludedErr = analysedRows.filter((r) => r.keyboardOutcome === 'error').length;
  const [nrLo, nrHi] = wilson(notReached.length, kbRows.length);
  const unnamedRows = analysedRows.filter((r) => r.unnamedButtonsProduct != null);
  const unnamedK = unnamedRows.filter((r) => (r.unnamedButtonsProduct ?? 0) + (r.unnamedButtonsHome ?? 0) > 0).length;
  const [unLo, unHi] = wilson(unnamedK, unnamedRows.length);
  const top = topRules[0];
  const tied = top ? topRules.slice(1).filter((r) => r.storesAffected === top.storesAffected) : [];
  const [trLo, trHi] = top ? wilson(top.storesAffected, analysedRecs.length) : [null, null];
  const sampled = rows.length;
  const blocked = rows.filter((r) => r.status === 'blocked');
  const robotsOut = rows.filter((r) => r.status === 'robots').length;
  const noProduct = rows.filter((r) => r.status === 'no-product').length;
  const errors = rows.filter((r) => r.status === 'error').length;
  const [blLo, blHi] = wilson(blocked.length, sampled);
  const axeVersion = recs.find((r) => r.axeVersion)?.axeVersion ?? 'unknown';

  const headlines = [
    {
      id: 'barrier-median-violations-product',
      label: 'Median axe-core violations per product page (distinct WCAG A/AA rules failed)',
      value: fmt(all.medianViolationsProduct),
      interval: all.iqrViolationsProduct ? `IQR ${fmt(all.iqrViolationsProduct[0])}–${fmt(all.iqrViolationsProduct[1])}` : undefined,
      n: N,
      script: SCRIPT,
      note: `axe-core ${axeVersion}, tags wcag2a, wcag2aa, wcag21aa, wcag22aa, one product page per store. Median failing elements per product page: ${fmt(all.medianFailingNodesProduct)}. Home page median: ${fmt(all.medianViolationsHome)} rules.`,
    },
    {
      id: 'barrier-keyboard-atc-unreachable',
      label: 'Stores where keyboard-only traversal could not reach add to cart within 150 Tabs',
      value: kbRows.length ? `${pct(notReached.length / kbRows.length)} (${notReached.length} of ${kbRows.length})` : 'n/a',
      interval: kbRows.length ? `95% Wilson ${pct(nrLo)}–${pct(nrHi)}` : undefined,
      n: kbRows.length,
      script: SCRIPT,
      note: `Tab only from the top of the page, no Enter, Space or clicks; Escape pressed once if focus was trapped. Counted over product pages with an enabled add-to-cart control named "add to cart/bag/basket" or "buy now". Focus traps among the failures: ${trappedAmongNot}. Not in the denominator: ${plural(excludedOverlay, 'page')} where a cookie or sign-up dialog held focus and Escape did not close it, ${excludedDisabled} whose add-to-cart button is disabled or hidden until a size is chosen, ${excludedNoAtc} with no control using that wording, ${plural(excludedErr, 'traversal error')}.`,
    },
    {
      id: 'barrier-unnamed-buttons',
      label: 'Stores with at least one button that has no accessible name (home or product page)',
      value: unnamedRows.length ? `${pct(unnamedK / unnamedRows.length)} (${unnamedK} of ${unnamedRows.length})` : 'n/a',
      interval: unnamedRows.length ? `95% Wilson ${pct(unLo)}–${pct(unHi)}` : undefined,
      n: unnamedRows.length,
      script: SCRIPT,
      note: 'axe-core rules button-name, input-button-name and aria-command-name. A screen reader announces these as "button" with nothing else.',
    },
    top && {
      id: 'barrier-top-rule',
      label: `Most common failing rule: ${top.id}`,
      value: `${pct(top.storesAffected / analysedRecs.length)} of stores (${top.storesAffected} of ${analysedRecs.length})`,
      interval: `95% Wilson ${pct(trLo)}–${pct(trHi)}`,
      n: analysedRecs.length,
      script: SCRIPT,
      note: `${top.help}. Counted once per store if it fails on the home, product or cart page; ${top.totalNodes} failing elements in total.${
        tied.length ? ` Tied on store count with ${tied.map((r) => `${r.id} (${r.totalNodes} elements)`).join(', ')}; ranked first by failing elements.` : ''
      }`,
    },
    {
      id: 'barrier-blocked',
      label: 'Sampled stores that refused or timed out for an honest, rate-limited, read-only crawler',
      value: `${blocked.length} of ${sampled}`,
      interval: sampled ? `95% Wilson ${pct(blLo)}–${pct(blHi)}` : undefined,
      n: sampled,
      script: SCRIPT,
      note: `Blocked at the home page: ${blocked.filter((r) => r.blockedAt === 'home').length}; at the product page: ${blocked.filter((r) => r.blockedAt === 'product').length}. Also excluded: ${robotsOut} disallowed by robots.txt, ${noProduct} with no product page found from the home page, ${plural(errors, 'crawler error')}. Blocked stores are left out of every other number.`,
    },
    N > 0 && {
      id: 'barrier-sightline-path',
      label: `Sightline path: product facts, readback and payment reachable by voice and keyboard on all ${N} items; no store UI needed`,
      value: 'By design',
      n: N,
      script: SCRIPT,
      note: `A design property, not a measurement on these stores: Sightline reads product facts from catalog data, speaks the readback and pays through PayPal, so none of the store pages audited here sit on its path. ${N} is the number of stores whose product page was crawled.`,
    },
  ].filter(Boolean);

  const finished = recs.map((r) => r.finishedAt).filter(Boolean).sort();
  const started = recs.map((r) => r.startedAt).filter(Boolean).sort();
  // Same rule as evals/lib/results.ts gitSha(): a commit is named only when evals/ and packages/
  // match it; otherwise the result says "uncommitted", so it never points at code it didn't run.
  let gitSha = 'uncommitted';
  try {
    const head = execSync('git rev-parse --short HEAD', { cwd: ROOT }).toString().trim();
    const dirty = execSync('git status --porcelain -- evals packages', { cwd: ROOT }).toString().trim();
    if (head && !dirty) gitSha = head;
  } catch {}

  const limitations = [
    `Convenience sample: ${sampled} well-known stores selling everyday goods, picked from public knowledge and platform showcase pages, then grouped by the platform their pages actually showed. Not a random sample of all online stores, and platform groups are small, so per-platform numbers are indicative only.`,
    `Crawled between ${started[0]?.slice(0, 16).replace('T', ' ') ?? '?'} and ${finished[finished.length - 1]?.slice(0, 16).replace('T', ' ') ?? '?'} UTC from a single location in India with headless Chromium at 1280×900. Stores change their pages often, and geo redirects, currency conversion and consent banners differ by country: several large US retailers answered with a country selector or a global corporate page, which shows up here as no product page found.`,
    'Stores that timed out or gave no product page on the first pass were crawled once more after product-link discovery was widened (a second category page and flat product URLs). Stores already measured were not crawled again, so a fresh run of the current code can pick different product pages.',
    `${blocked.length} stores refused or timed out and are excluded, so the measured set leans toward stores without aggressive bot defences.`,
    'Automated rules catch only part of WCAG. Zero axe violations would not mean a page is accessible; these counts are a floor, not a full audit. No screen reader was run.',
    'One product page per store, found from links on the home page (or up to two category pages). It may not represent the rest of the catalogue.',
    'Keyboard traversal presses Tab only (plus Escape once when trapped). It never presses Enter, Space or arrow keys, so it does not open menus, choose a size or dismiss dialogs that need a button press. Pages where a consent or sign-up dialog held focus, and pages whose add-to-cart button is disabled or hidden until a size is chosen, are left out of the reachability rate rather than counted as failures.',
    'Add to cart is matched by its accessible name in English ("add to cart/bag/basket", "buy now"). Stores that use other wording are counted as having no matching control, not as failures.',
    'Visible focus is a heuristic: computed styles of the focused element, its label, parent, next sibling, first child and pseudo-elements are compared focused versus blurred. It misses indicators drawn elsewhere and can count unrelated style changes.',
    'Product images, the price region and size or colour selectors are found by heuristics on class names, the main heading and structured data, and can miss or misclassify elements.',
    `Cart pages are opened by direct URL only where robots.txt allows: ${all.cartAudited} stores had an (empty) cart page audited and ${all.cartSkippedByRobots} were skipped because robots.txt disallows it, so cart numbers are partial. Checkout pages are never opened.`,
    'The Sightline path line is a design property of the product, not a measurement on these stores.',
    'Stores appear only as unsalted 12-character sha256 prefixes of their domain. That keeps names out of the published data but does not stop someone who guesses a domain from confirming it; the per-store rows exist for reproducibility, not for naming stores.',
  ];

  const out = {
    suite: 'barrier',
    title: 'Checkout Barrier Index',
    ranAt: finished[finished.length - 1] ?? new Date().toISOString(),
    gitSha,
    headlines,
    limitations,
    details: { byPlatform, topRules, stores: rows },
  };
  await fs.mkdir(path.dirname(RESULT_FILE), { recursive: true });
  await fs.writeFile(RESULT_FILE, JSON.stringify(out, null, 2) + '\n');

  // A last guard: nothing that identifies a store may reach the committed file.
  const written = await fs.readFile(RESULT_FILE, 'utf8');
  const lower = written.toLowerCase();
  const leaks = sample.filter((s) => lower.includes(s.domain.toLowerCase()));
  if (leaks.length || /https?:\/\//.test(lower)) {
    await fs.rm(RESULT_FILE, { force: true });
    throw new Error(`result mentions ${leaks.length} store domains or a URL; refusing to keep it`);
  }

  console.log(JSON.stringify({ headlines: headlines.map((h) => `${h.label}: ${h.value} ${h.interval ?? ''} n=${h.n ?? ''}`), byPlatform: Object.fromEntries(Object.entries(byPlatform).map(([k, v]) => [k, { stores: v.stores, crawled: v.crawled, blocked: v.blocked }])), topRules: topRules.slice(0, 5).map((r) => `${r.id} ${r.storesAffected}`) }, null, 1));
}

await main();
