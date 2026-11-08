// Walks a rendered page with the virtual screen reader and prints what would be spoken, in order.
// Usage (from apps/web): node scripts/sr-transcript.mjs <outDir> <route>[,<route>] [--persona=maya]
import { JSDOM } from 'jsdom';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { chromium } = require('../../../tests/node_modules/@playwright/test');
const [outDir, routesArg, ...rest] = process.argv.slice(2);
const opts = Object.fromEntries(rest.map((a) => a.replace(/^--/, '').split('=')));
const base = process.env.BASE_URL ?? 'http://localhost:3100';
await fs.mkdir(outDir, { recursive: true });

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, reducedMotion: 'reduce' });
const page = await ctx.newPage();
if (opts.persona) await page.request.post(`${base}/api/demo/start`, { data: { persona: opts.persona } });

for (const route of routesArg.split(',')) {
  await page.goto(`${base}${route}`, { waitUntil: 'load', timeout: 120000 });
  await page.waitForTimeout(2000);
  const html = await page.evaluate(() => {
    document.querySelectorAll('script, style, link, nextjs-portal').forEach((n) => n.remove());
    return document.documentElement.outerHTML;
  });
  const dom = new JSDOM(html, { pretendToBeVisual: true });
  const g = globalThis;
  for (const k of ['window', 'document', 'Node', 'Element', 'HTMLElement', 'MutationObserver', 'getComputedStyle', 'navigator']) {
    Object.defineProperty(g, k, { value: k === 'getComputedStyle' ? dom.window.getComputedStyle.bind(dom.window) : dom.window[k], configurable: true, writable: true });
  }
  const { Virtual } = await import('@guidepup/virtual-screen-reader');
  const virtual = new Virtual();
  await virtual.start({ container: dom.window.document.body, window: dom.window });
  for (let i = 0; i < 1500; i++) {
    await virtual.next();
    if ((await virtual.lastSpokenPhrase()) === 'end of document') break;
  }
  const log = await virtual.spokenPhraseLog();
  await virtual.stop();
  const name = `${route.replace(/\//g, '_') || '_root'}.txt`;
  await fs.writeFile(path.join(outDir, name), log.join('\n') + '\n');
  console.log(`${route}: ${log.length} phrases -> ${name}`);
}
await browser.close();
