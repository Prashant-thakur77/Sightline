// Functions that run inside the store page. They only read the page; the only writes are a marker attribute and a
// constructed stylesheet that switches off CSS transitions in this local browser so focus styles settle at once.
// Each export is passed to page.evaluate or CDP Runtime.callFunctionOn, so it must be self-contained.

/** Every same-site link on the page with enough context to tell product links from navigation. */
export function harvestLinks() {
  const out = [];
  const seen = new Set();
  for (const a of document.querySelectorAll('a[href]')) {
    let href;
    try {
      const u = new URL(a.getAttribute('href'), location.href);
      if (!/^https?:$/.test(u.protocol)) continue;
      u.hash = '';
      href = u.href;
    } catch {
      continue;
    }
    if (seen.has(href)) continue;
    seen.add(href);
    const r = a.getBoundingClientRect();
    const ctx = [];
    let el = a;
    for (let i = 0; i < 7 && el; i++) {
      const cls = typeof el.className === 'string' ? el.className : '';
      const data = [...el.attributes]
        .filter((x) => x.name.startsWith('data-'))
        .map((x) => `${x.name}=${String(x.value).slice(0, 24)}`)
        .join(' ');
      ctx.push(`${cls} ${el.id || ''} ${data}`);
      el = el.parentElement;
    }
    out.push({
      href,
      text: (a.innerText || a.getAttribute('aria-label') || '').trim().slice(0, 80),
      ctx: ctx.join(' | ').slice(0, 900),
      inHeader: !!a.closest('header,nav,[role=banner],[role=navigation]'),
      inFooter: !!a.closest('footer,[role=contentinfo]'),
      visible: r.width > 0 && r.height > 0,
    });
    if (out.length > 1500) break;
  }
  return out;
}

/** JS globals that confirm a platform. */
export function platformGlobals() {
  const w = window;
  let magento = false;
  try {
    magento = !!document.querySelector('script[type="text/x-magento-init"]') || JSON.stringify(w.require?.s?.contexts?._?.config?.paths ?? {}).includes('Magento_');
  } catch {}
  return {
    shopify: !!(w.Shopify && (w.Shopify.shop || w.Shopify.theme)),
    woocommerce: !!(w.wc_add_to_cart_params || w.woocommerce_params || w.wc_cart_fragments_params || (w.wc && w.wc.wcSettings)),
    magento,
    bigcommerce: !!w.BCData,
  };
}

/** Is this a bot wall or challenge page rather than the store? */
export function challengeSignals() {
  const text = (document.body?.innerText || '').slice(0, 3000);
  // ids used only by bot-wall pages; a reCAPTCHA widget in a review or newsletter form does not count
  const strong = !!document.querySelector('#challenge-form,#cf-challenge-running,.cf-browser-verification,#challenge-stage,#cf-wrapper,#px-captcha,#sec-if-container,#sec-text-if,#distil_ident_block,[id^="incapsula"],#main-iframe[src*="_Incapsula_"]');
  const captcha = !!document.querySelector('iframe[src*="captcha"],iframe[src*="challenge"],.g-recaptcha,.h-captcha');
  const titleHit = /^(access denied|just a moment|attention required|pardon our interruption|robot or human|are you a robot|security check|403 forbidden|vercel security checkpoint)/i.test(document.title.trim());
  const words = /(access denied|pardon our interruption|are you a robot|robot or human|verify you are (a )?human|press (&|and) hold|checking your browser|request unsuccessful|access to this page has been denied|you have been blocked|unusual traffic|incident id|reference #\d)/i.test(text + ' ' + document.title);
  const thin = text.length < 1500 && document.querySelectorAll('a[href]').length < 8;
  return { strong, captcha, titleHit, words, thin, textLength: text.length, links: document.querySelectorAll('a[href]').length };
}

/**
 * Product page facts: structured product signals and price, add-to-cart inventory, variant selectors, product images,
 * and a marker on the region that holds the title and price. Sets window.__sbi for the keyboard traversal.
 */
export function inspectProduct() {
  const ATC = /add to (cart|bag|basket)|buy now/i;
  const SECONDARY = /(related|recommend|upsell|up-sell|cross-?sell|recent|you-?may|also-?like|complete-the-look|product-?card|card-product|card-wrapper|product-?tile|quick-?(add|shop|view)|mini-?cart|cart-?drawer|side-?cart|grid-item|product-grid|productgrid|bundle|wishlist)/i;
  const CURRENCY = /(?:[$£€₹¥]|\bUSD|\bEUR|\bGBP|\bINR|\bAUD|\bCAD|\bNZD|\bRs\.?|\bA\$|\bC\$|\bkr)\s?\d|\d(?:[.,]\d{2})?\s?(?:USD|EUR|GBP|INR|AUD|CAD|NZD|€|kr|zł|£)(?![a-z])/i;

  const attrText = (el) => {
    if (!el || el.nodeType !== 1) return '';
    const cls = typeof el.className === 'string' ? el.className : el.getAttribute('class') || '';
    const data = [...el.attributes].filter((x) => x.name.startsWith('data-')).map((x) => `${x.name}=${String(x.value).slice(0, 40)}`).join(' ');
    return `${cls} ${el.id || ''} ${el.getAttribute('name') || ''} ${el.getAttribute('aria-label') || ''} ${data}`;
  };
  const approxName = (el) => {
    const lb = el.getAttribute('aria-labelledby');
    if (lb) {
      const t = lb.split(/\s+/).map((id) => document.getElementById(id)?.textContent || '').join(' ').trim();
      if (t) return t;
    }
    const al = el.getAttribute('aria-label');
    if (al && al.trim()) return al.trim();
    if (el.tagName === 'INPUT') return (el.value || el.getAttribute('title') || '').trim();
    const t = (el.innerText || el.textContent || '').trim();
    if (t) return t;
    const img = el.querySelector('img[alt]');
    if (img && img.alt.trim()) return img.alt.trim();
    return (el.getAttribute('title') || '').trim();
  };
  // The visible page title marks the main product region: walking up from a control, reaching an ancestor that holds
  // the title means the control belongs to the main product, so layout wrappers above it are never examined.
  const shownH1 = [...document.querySelectorAll('h1')].filter((h) => {
    const r = h.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  });
  const titleH1 = shownH1.find((h) => !h.closest('header,[role=banner],nav')) ?? shownH1[0];
  const secondaryWhy = (el) => {
    let e = el;
    for (let i = 0; i < 12 && e && e !== document.body; i++) {
      if (titleH1 && e.contains(titleH1)) return null;
      const m = `${typeof e.className === 'string' ? e.className : ''} ${e.id || ''}`.match(SECONDARY);
      if (m) return m[0];
      e = e.parentElement;
    }
    return null;
  };
  const isSecondary = (el) => secondaryWhy(el) !== null;
  const visibleBox = (el) => {
    const r = el.getBoundingClientRect();
    const cs = getComputedStyle(el);
    return r.width >= 2 && r.height >= 2 && cs.visibility !== 'hidden' && cs.display !== 'none' && Number(cs.opacity) > 0.05;
  };

  // ---- structured signals and price
  const sig = [];
  let price = null;
  let currency = null;
  const walk = (o, depth = 0) => {
    if (!o || typeof o !== 'object' || depth > 6) return;
    if (Array.isArray(o)) return o.forEach((x) => walk(x, depth + 1));
    const t = [].concat(o['@type'] || []).join(',');
    if (/Product/.test(t)) {
      if (!sig.includes('jsonld-product')) sig.push('jsonld-product');
      for (const of of [].concat(o.offers || [])) {
        const pp = of?.price ?? of?.lowPrice ?? of?.priceSpecification?.price ?? [].concat(of?.offers || [])[0]?.price;
        if (pp != null && price == null) {
          price = String(pp);
          currency = of.priceCurrency || null;
        }
      }
      if (o.hasVariant) walk(o.hasVariant, depth + 1);
    }
    if (o['@graph']) walk(o['@graph'], depth + 1);
  };
  for (const s of document.querySelectorAll('script[type="application/ld+json"]')) {
    try {
      walk(JSON.parse(s.textContent));
    } catch {}
  }
  if (/product/i.test(document.querySelector('meta[property="og:type"]')?.content || '')) sig.push('og-product');
  const mp = document.querySelector('meta[property="product:price:amount"],meta[property="og:price:amount"]')?.content;
  if (mp) {
    sig.push('meta-price');
    if (price == null) {
      price = mp;
      currency = document.querySelector('meta[property="product:price:currency"],meta[property="og:price:currency"]')?.content || null;
    }
  }
  if (document.querySelector('[itemtype*="schema.org/Product" i]')) sig.push('microdata-product');
  const ip = document.querySelector('[itemprop="price"]');
  if (ip && price == null) price = (ip.getAttribute('content') || ip.textContent || '').trim() || null;
  try {
    if (window.ShopifyAnalytics?.meta?.page?.pageType === 'product') sig.push('shopify-product');
  } catch {}
  if (document.querySelector('form[action*="/cart/add"],form.cart,form#product_addtocart_form,form[data-cart-item-add]')) sig.push('cart-add-form');
  if (/single-product|catalog-product-view|page-type-product|template-product|product-template|\bpdp\b/i.test(document.body.className)) sig.push('body-class');

  // ---- add-to-cart inventory
  const ctrls = [...document.querySelectorAll('button,[role=button],input[type=submit],input[type=button],a[href]')];
  let mainEnabled = 0;
  let mainDisabled = 0;
  let secondary = 0;
  let textOnly = 0;
  let mainVisible = 0;
  let mainEnabledVisible = 0;
  const secondaryWhyList = [];
  for (const el of ctrls) {
    const name = approxName(el);
    const text = (el.innerText || el.value || '').trim();
    const match = ATC.test(name);
    if (!match) {
      if (ATC.test(text) && name) textOnly++;
      continue;
    }
    const why = secondaryWhy(el);
    if (why) {
      secondary++;
      if (secondaryWhyList.length < 5) secondaryWhyList.push(why);
      continue;
    }
    const disabled = el.disabled || el.getAttribute('aria-disabled') === 'true';
    if (disabled) mainDisabled++;
    else mainEnabled++;
    if (visibleBox(el)) {
      mainVisible++;
      if (!disabled) mainEnabledVisible++;
    }
  }

  // ---- product region: walk up from the h1 until it holds a large image
  const h1 = titleH1 || document.querySelector('h1');
  let root = null;
  if (h1) {
    let e = h1.parentElement;
    for (let i = 0; i < 9 && e && e !== document.body; i++) {
      const big = [...e.querySelectorAll('img')].some((im) => {
        const r = im.getBoundingClientRect();
        return r.width >= 150 && r.height >= 150;
      });
      if (big) {
        root = e;
        break;
      }
      e = e.parentElement;
    }
  }

  // ---- product images
  const GALLERY = /(product|gallery|media|pdp|zoom|carousel|slider|swiper|slick|splide|flickity|thumbnail|image|photo)/i;
  const NOT = /(related|recommend|upsell|cross-?sell|recent|you-?may|also-?like|review|ugc|instagram|logo|icon|badge|payment|trust|swatch|klarna|afterpay)/i;
  const inGallery = (img) => {
    let e = img.parentElement;
    let g = false;
    for (let i = 0; i < 9 && e && e !== document.body; i++) {
      const s = `${typeof e.className === 'string' ? e.className : ''} ${e.id || ''}`;
      if (NOT.test(s)) return false;
      if (GALLERY.test(s)) g = true;
      e = e.parentElement;
    }
    return g;
  };
  const imgPool = root ? [...root.querySelectorAll('img')] : [...document.querySelectorAll('main img, [role=main] img')];
  const productImgs = imgPool.filter((img) => {
    if (img.closest('header,footer,nav,[role=banner],[role=contentinfo]')) return false;
    const r = img.getBoundingClientRect();
    const shown = r.width > 0 && r.height > 0;
    if (shown && (r.width < 80 || r.height < 80)) return false;
    if (!shown && !(img.getAttribute('src') || img.getAttribute('data-src') || img.getAttribute('srcset'))) return false;
    if (!shown && !inGallery(img)) return false;
    if (shown && !root && !inGallery(img)) return false;
    return !NOT.test(`${typeof img.className === 'string' ? img.className : ''} ${img.getAttribute('src') || ''}`.slice(0, 300));
  });
  let noAlt = 0;
  let emptyAlt = 0;
  for (const img of productImgs) {
    if (!img.hasAttribute('alt')) {
      const named = img.getAttribute('aria-label') || img.getAttribute('aria-labelledby') || img.getAttribute('title');
      if (!named && img.getAttribute('role') !== 'presentation' && img.getAttribute('aria-hidden') !== 'true') noAlt++;
    } else if (!img.alt.trim()) emptyAlt++;
  }

  // ---- price region near the title
  let priceRegion = null;
  if (h1) {
    let e = h1;
    for (let i = 0; i < 7 && e && e !== document.body; i++) {
      if (CURRENCY.test((e.innerText || '').slice(0, 4000))) {
        priceRegion = e;
        break;
      }
      e = e.parentElement;
    }
  }
  if (!priceRegion) {
    const scope = document.querySelector('main,[role=main]') || document.body;
    const tw = document.createTreeWalker(scope, NodeFilter.SHOW_TEXT);
    let n;
    while ((n = tw.nextNode())) {
      const p = n.parentElement;
      if (!p || p.closest('header,footer,nav,[role=banner],[role=navigation],[role=contentinfo]')) continue;
      if (CURRENCY.test(n.textContent) && visibleBox(p)) {
        priceRegion = p.parentElement?.parentElement || p;
        break;
      }
    }
  }
  if (priceRegion) priceRegion.setAttribute('data-sbi-pinfo', '1');
  const priceVisibleText = priceRegion ? ((priceRegion.innerText || '').match(CURRENCY) || [null])[0] : null;

  // ---- variant selectors (size, colour, ...)
  const VAR = /(size|colou?r|swatch|variant|width|length|fit\b|style)/i;
  const NOTVAR = /(country|currency|language|locale|region|sort|filter|quantity|qty|rating|review|newsletter|search|shipping|zip|postcode)/i;
  const varSet = new WeakSet();
  const varList = [];
  const haystack = (el) => {
    let s = attrText(el);
    let e = el.parentElement;
    for (let i = 0; i < 4 && e && e !== document.body; i++) {
      s += ' ' + attrText(e);
      e = e.parentElement;
    }
    const fs = el.closest('fieldset');
    if (fs) s += ' ' + (fs.querySelector('legend')?.textContent || '');
    if (el.labels?.[0]) s += ' ' + el.labels[0].textContent;
    return s.slice(0, 1500);
  };
  const consider = (el, strict) => {
    if (varSet.has(el)) return;
    if (el.closest('header,footer,nav,[role=banner],[role=navigation],[role=contentinfo],dialog,[role=dialog]')) return;
    if (isSecondary(el)) return;
    const h = haystack(el);
    if (NOTVAR.test(h) && !/(size|colou?r|swatch)/i.test(attrText(el))) return;
    if (strict ? /(swatch|size|colou?r|variant)/i.test(h) : VAR.test(h)) {
      varSet.add(el);
      varList.push(el);
    }
  };
  for (const el of document.querySelectorAll('select,input[type=radio],[role=radio],[role=option],[role=listbox],[role=combobox],[role=radiogroup]')) consider(el, false);
  for (const el of document.querySelectorAll('button,[role=button],a[href]')) {
    const r = el.getBoundingClientRect();
    if (r.width > 0 && r.width < 220 && r.height < 120) consider(el, true);
  }
  // swatches built from plain divs or list items that keyboard users cannot reach at all
  let nonFocusableSwatches = 0;
  for (const el of document.querySelectorAll('[class*="swatch" i],[class*="size-option" i],[class*="color-option" i],[class*="colour-option" i],[class*="variant-option" i]')) {
    if (['BUTTON', 'A', 'INPUT', 'SELECT', 'LABEL'].includes(el.tagName)) continue;
    if (el.querySelector('button,a[href],input,select,[tabindex]') || el.closest('button,a[href],label')) continue;
    if (el.hasAttribute('tabindex') || el.getAttribute('role')) continue;
    const r = el.getBoundingClientRect();
    if (r.width < 8 || r.width > 200 || r.height < 8 || r.height > 120) continue;
    if (el.closest('header,footer,nav') || isSecondary(el)) continue;
    if (el.children.length > 3) continue;
    nonFocusableSwatches++;
    varSet.add(el);
    varList.push(el);
  }

  // ---- tabbable count, for telling a focus trap from a page that simply wraps around
  const FOCUSABLE = 'a[href],button,input:not([type=hidden]),select,textarea,iframe,[tabindex],[contenteditable=""],[contenteditable=true],summary,audio[controls],video[controls]';
  let tabbable = 0;
  for (const el of document.querySelectorAll(FOCUSABLE)) {
    if (el.disabled || el.closest('[inert]')) continue;
    const ti = el.getAttribute('tabindex');
    if (ti !== null && Number(ti) < 0) continue;
    const r = el.getBoundingClientRect();
    if (r.width === 0 && r.height === 0) continue;
    if (getComputedStyle(el).visibility === 'hidden') continue;
    tabbable++;
  }

  // ---- state for the keyboard traversal
  const PROPS = ['outlineStyle', 'outlineWidth', 'outlineColor', 'outlineOffset', 'boxShadow', 'borderTopColor', 'borderBottomColor', 'borderLeftColor', 'borderTopWidth', 'borderBottomWidth', 'backgroundColor', 'color', 'textDecorationLine', 'textDecorationColor', 'opacity', 'transform', 'filter'];
  const PSEUDO = ['outlineStyle', 'boxShadow', 'backgroundColor', 'borderBottomColor', 'borderTopColor', 'opacity', 'transform', 'content', 'width'];
  const snapOne = (el, props, pseudo) => {
    if (!el || el.nodeType !== 1) return '';
    const cs = getComputedStyle(el, pseudo);
    return props.map((p) => cs[p]).join('|');
  };
  window.__sbi = {
    n: 0,
    ids: new WeakMap(),
    variant: varSet,
    prev: null,
    prevSnap: null,
    // Style snapshot of the element and the places a focus indicator is commonly drawn: its label, parent, next
    // sibling, first child and pseudo-elements. Returned as [element, style] pairs so a comparison can ignore any
    // part that holds the newly focused element (its own focus style is not the previous element's indicator).
    snap(el) {
      const parts = [
        [el, snapOne(el, PROPS) + '#' + snapOne(el, PSEUDO, '::before') + '#' + snapOne(el, PSEUDO, '::after')],
      ];
      const lab = el.labels?.[0];
      if (lab) parts.push([lab, snapOne(lab, PROPS) + '#' + snapOne(lab, PSEUDO, '::before') + '#' + snapOne(lab, PSEUDO, '::after')]);
      for (const other of [el.parentElement, el.nextElementSibling, el.firstElementChild]) if (other) parts.push([other, snapOne(other, PROPS)]);
      return parts;
    },
    changed(before, after, current) {
      for (let k = 0; k < before.length && k < after.length; k++) {
        const node = before[k][0];
        if (current && (node === current || node.contains(current))) continue;
        if (before[k][1] !== after[k][1]) return true;
      }
      return false;
    },
    isSecondary,
  };
  try {
    const sheet = new CSSStyleSheet();
    sheet.replaceSync('*,*::before,*::after{transition-duration:0s!important;transition-delay:0s!important;animation-duration:0s!important;animation-delay:0s!important}');
    document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet];
  } catch {}

  return {
    signals: sig,
    structuredPrice: price,
    structuredCurrency: currency,
    h1: !!h1,
    atc: { mainEnabled, mainDisabled, mainVisible, mainEnabledVisible, secondary, secondaryWhy: secondaryWhyList, textOnly },
    images: { productImages: productImgs.length, noAlt, emptyAlt, rootFound: !!root },
    price: { regionFound: !!priceRegion, visibleText: priceVisibleText },
    variants: { present: varList.length, nonFocusableSwatches },
    tabbable,
  };
}

/**
 * Called with `this` = the focused element. Records its identity and focus style, and decides whether the PREVIOUS
 * focused element showed a visible change when it had focus (its focused snapshot vs. its style now that it is blurred).
 */
export function describeFocused() {
  const S = window.__sbi;
  if (!S) return { lost: true };
  const el = this;
  const out = {};
  if (S.prev && S.prev !== el) {
    const current = el && el !== document.body && el !== document.documentElement ? el : null;
    out.prevVisibleFocus = S.prev.isConnected ? S.changed(S.prevSnap, S.snap(S.prev), current) : null;
  }
  if (!el || el === document.body || el === document.documentElement) {
    S.prev = null;
    S.prevSnap = null;
    return { ...out, document: true };
  }
  let id = S.ids.get(el);
  if (!id) {
    id = ++S.n;
    S.ids.set(el, id);
  }
  S.prev = el;
  S.prevSnap = S.snap(el);
  const r = el.getBoundingClientRect();
  const cs = getComputedStyle(el);
  const clipped = cs.clip === 'rect(0px, 0px, 0px, 0px)' || cs.clipPath === 'inset(50%)' || cs.clipPath === 'inset(100%)';
  const inView = r.bottom > 0 && r.right > 0 && r.top < innerHeight && r.left < innerWidth;
  const ownVisible = r.width >= 2 && r.height >= 2 && !clipped && inView && cs.visibility !== 'hidden' && Number(cs.opacity) > 0.05;
  let proxyVisible = false;
  for (const p of [el.labels?.[0], el.parentElement, el.nextElementSibling]) {
    if (!p) continue;
    const pr = p.getBoundingClientRect();
    if (pr.width >= 8 && pr.height >= 8 && pr.bottom > 0 && pr.top < innerHeight && pr.right > 0 && pr.left < innerWidth) {
      proxyVisible = true;
      break;
    }
  }
  let variant = S.variant.has(el);
  if (!variant) {
    let e = el.parentElement;
    for (let i = 0; i < 3 && e && !variant; i++) {
      if (S.variant.has(e)) variant = true;
      e = e.parentElement;
    }
  }
  const dialog = !!el.closest('[role=dialog],[role=alertdialog],dialog,[aria-modal=true]');
  const overlay =
    dialog ||
    !!el.closest('#onetrust-consent-sdk,#onetrust-banner-sdk,#CybotCookiebotDialog,#usercentrics-root,#truste-consent-track,[id*="cookie" i],[class*="cookie" i],[id*="consent" i],[class*="consent" i],[class*="klaviyo" i],[class*="popup" i],[id*="popup" i],[class*="modal" i]');
  return {
    ...out,
    id,
    tag: el.tagName.toLowerCase(),
    type: el.getAttribute('type') || undefined,
    iframe: el.tagName === 'IFRAME',
    visible: ownVisible || proxyVisible,
    variant,
    secondary: S.isSecondary(el),
    dialog,
    overlay,
    disabled: !!el.disabled || el.getAttribute('aria-disabled') === 'true',
  };
}

/** After the last Tab: blur and settle whether the last focused element showed focus. */
export function finishFocus() {
  const S = window.__sbi;
  if (!S || !S.prev) return null;
  const el = S.prev;
  try {
    el.blur();
  } catch {}
  return el.isConnected ? S.changed(S.prevSnap, S.snap(el), null) : null;
}
