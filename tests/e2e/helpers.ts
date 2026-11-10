import { expect, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

export async function expectNoAxeViolations(page: Page) {
  // Let client chunks finish loading first; the dev server can still be compiling them.
  await page.waitForLoadState('networkidle').catch(() => {});
  const r = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa', 'best-practice']).analyze();
  expect(r.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(' | ')}`)).toEqual([]);
}

export async function startAs(page: Page, persona: 'maya' | 'raj' = 'maya') {
  const res = await page.request.post('/api/demo/start', { data: { persona } });
  expect(res.ok()).toBeTruthy();
}

/** Everything announced through the app's announcer since the page loaded, in order. */
export async function announcements(page: Page): Promise<string[]> {
  return page.evaluate(() => (window as unknown as { __announcements?: string[] }).__announcements ?? []);
}

export async function say(page: Page, text: string) {
  const input = page.getByLabel('Or type what you need');
  await input.fill(text);
  await input.press('Enter');
}
