// Screenshot + axe sweep for pages: node shots.mjs <outDir> <route>[,<route>...] [--persona=maya] [--themes=light,dark,contrast] [--widths=375,1280]
import { chromium } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import fs from 'node:fs/promises';
import path from 'node:path';

const [outDir, routesArg, ...rest] = process.argv.slice(2);
const opts = Object.fromEntries(rest.map((a) => a.replace(/^--/, '').split('=')));
const base = process.env.BASE_URL ?? 'http://localhost:3100';
const routes = routesArg.split(',');
const themes = (opts.themes ?? 'light,dark,contrast').split(',');
const widths = (opts.widths ?? '320,375,1280').split(',').map(Number);
await fs.mkdir(outDir, { recursive: true });
const browser = await chromium.launch();
const summary = [];
for (const width of widths) {
  const ctx = await browser.newContext({ viewport: { width, height: width < 600 ? 812 : 900 }, deviceScaleFactor: 1, reducedMotion: 'reduce' });
  if (opts.session) await ctx.addCookies([{ name: 'sl_session', value: opts.session, url: base }]);
  const page = await ctx.newPage();
  if (opts.persona && !opts.session) {
    await page.goto(`${base}/start`);
    await page.getByRole('button', { name: new RegExp(`Shop as ${opts.persona}`, 'i') }).click();
    await page.waitForURL(/\/app/);
  }
  for (const route of routes) {
    for (const theme of themes) {
      await page.goto(`${base}${route}`, { waitUntil: 'load', timeout: 120000 });
      await page.waitForTimeout(1500);
      await page.evaluate((t) => {
        if (t === 'light') document.documentElement.dataset.theme = 'light';
        else document.documentElement.dataset.theme = t;
      }, theme);
      await page.waitForTimeout(300);
      const name = `${route.replace(/\//g, '_') || '_root'}-${theme}-${width}.png`;
      await page.screenshot({ path: path.join(outDir, name), fullPage: true });
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      const axe = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa', 'best-practice']).analyze();
      summary.push({ route, width, theme, overflow, violations: axe.violations.map((v) => ({ id: v.id, impact: v.impact, nodes: v.nodes.length, sample: v.nodes[0]?.target })) });
    }
  }
  await ctx.close();
}
await browser.close();
await fs.writeFile(path.join(outDir, 'axe.json'), JSON.stringify(summary, null, 2));
for (const s of summary) console.log(`${s.route} @${s.width} ${s.theme}: ${s.violations.length} axe violations ${s.violations.map((v) => v.id).join(', ')}${s.overflow > 0 ? ` | OVERFLOW ${s.overflow}px` : ''}`);
