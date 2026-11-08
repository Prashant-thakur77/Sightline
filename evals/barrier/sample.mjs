// Build the store sample for the Checkout Barrier Index.
//
//   node evals/barrier/sample.mjs check    one polite GET of robots.txt and the home page per candidate; detects platform
//   node evals/barrier/sample.mjs select   picks the crawl sample from the checked candidates
//
// Input:  evals/data/raw/barrier/candidates.json   [{ domain, expected }]   (git-ignored: domains are never committed)
// Output: evals/data/raw/barrier/candidates-checked.json, evals/data/raw/barrier/stores.json (both git-ignored)
import fs from 'node:fs/promises';
import path from 'node:path';
import { RAW_DIR, Pacer, RobotsBook, politeGet, detectPlatform, bareDomain } from './lib.mjs';

const CHALLENGE = /just a moment|attention required|access denied|pardon our interruption|are you a robot|robot or human|px-captcha|request unsuccessful|access to this page has been denied|verify you are human|captcha/i;

async function check() {
  const candidates = JSON.parse(await fs.readFile(path.join(RAW_DIR, 'candidates.json'), 'utf8'));
  const outFile = path.join(RAW_DIR, 'candidates-checked.json');
  let done = [];
  try {
    done = JSON.parse(await fs.readFile(outFile, 'utf8'));
  } catch {}
  const doneSet = new Set(done.map((d) => d.domain));
  const todo = candidates.filter((c) => !doneSet.has(bareDomain(c.domain)));
  const book = new RobotsBook(new Pacer());
  const results = [...done];
  let i = 0;
  async function worker() {
    while (i < todo.length) {
      const c = todo[i++];
      const r = await checkOne(c, book);
      results.push(r);
      console.log(`${r.domain.padEnd(28)} ${String(r.status).padEnd(4)} ${r.platform.padEnd(12)} ${r.note ?? ''}`);
      await fs.writeFile(outFile, JSON.stringify(results, null, 1));
    }
  }
  await Promise.all(Array.from({ length: 3 }, worker));
}

async function checkOne(c, book) {
  const domain = bareDomain(c.domain);
  const out = { domain, expected: c.expected, status: 0, platform: 'unknown', signals: [] };
  for (const origin of [`https://www.${domain}`, `https://${domain}`]) {
    try {
      const r = await politeGet(origin + '/', book);
      if (r.robotsBlocked) {
        out.note = `robots disallows ${new URL(r.url).pathname} (${r.rule})`;
        out.robotsBlocked = true;
        return out;
      }
      out.status = r.status;
      out.finalUrl = r.url;
      const html = r.text ?? '';
      const title = (html.match(/<title[^>]*>([^<]{0,200})/i)?.[1] ?? '').trim();
      out.title = title;
      if (r.status >= 400 || r.status === 0 || (html.length < 20000 && CHALLENGE.test(title + html.slice(0, 5000)))) out.note = 'blocked-or-challenge';
      const d = detectPlatform({ html, headers: r.headers ?? {} });
      out.platform = out.note ? 'unknown' : d.platform;
      out.signals = d.signals;
      out.htmlBytes = html.length;
      return out;
    } catch (e) {
      out.note = `error: ${String(e?.cause?.code ?? e?.message ?? e).slice(0, 120)}`;
    }
  }
  return out;
}

/**
 * Selection, deterministic from the checked list:
 *  - stores whose platform the precheck confirmed, up to 20 per platform, in listed order;
 *  - stores the precheck saw as custom, up to 30, those expected to be Magento first (headless Magento only shows
 *    itself to the browser) and then large retailers;
 *  - up to 6 large retailers that refused the plain precheck request, because blocking is itself a result;
 *  - stores that do not sell everyday goods are left out.
 */
const NOT_EVERYDAY = new Set(['berlinpackaging.com', 'ubiquiti.com']);
const CAPS = { shopify: 20, woocommerce: 20, magento: 20, bigcommerce: 20, sfcc: 20 };

async function select() {
  const checked = JSON.parse(await fs.readFile(path.join(RAW_DIR, 'candidates-checked.json'), 'utf8'));
  const order = JSON.parse(await fs.readFile(path.join(RAW_DIR, 'candidates.json'), 'utf8')).map((c) => bareDomain(c.domain));
  checked.sort((a, b) => order.indexOf(a.domain) - order.indexOf(b.domain));
  const eligible = checked.filter((c) => !c.robotsBlocked && !NOT_EVERYDAY.has(c.domain));
  const stores = [];
  for (const [platform, cap] of Object.entries(CAPS)) stores.push(...eligible.filter((c) => c.platform === platform).slice(0, cap));
  const rank = { magento: 0, sfcc_or_custom: 1 };
  const custom = eligible.filter((c) => c.platform === 'custom').sort((a, b) => (rank[a.expected] ?? 2) - (rank[b.expected] ?? 2));
  stores.push(...custom.slice(0, 30));
  stores.push(...eligible.filter((c) => c.platform === 'unknown' && c.expected === 'sfcc_or_custom').slice(0, 6));
  const out = stores.map((c) => ({
    domain: c.domain,
    startUrl: c.finalUrl && !c.note ? new URL(c.finalUrl).origin + '/' : `https://www.${c.domain}/`,
    precheckPlatform: c.platform,
  }));
  await fs.writeFile(path.join(RAW_DIR, 'stores.json'), JSON.stringify(out, null, 1));
  const by = {};
  for (const s of out) by[s.precheckPlatform] = (by[s.precheckPlatform] ?? 0) + 1;
  console.log(out.length, by);
}

const cmd = process.argv[2];
if (cmd === 'check') await check();
else if (cmd === 'select') await select();
else console.log('usage: node evals/barrier/sample.mjs check|select');
