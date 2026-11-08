import { expect, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

export async function expectNoAxeViolations(page: Page) {
  const r = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa', 'best-practice']).analyze();
  expect(r.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(' | ')}`)).toEqual([]);
}

export async function startAs(page: Page, persona: 'maya' | 'raj' = 'maya') {
  const res = await page.request.post('/api/demo/start', { data: { persona } });
  expect(res.ok()).toBeTruthy();
}

/** Text announced through the app's live regions, in order. */
export async function announcements(page: Page): Promise<string[]> {
  return page.locator('[data-announcer] p').allTextContents();
}

export async function say(page: Page, text: string) {
  const input = page.getByLabel('Or type what you need');
  await input.fill(text);
  await input.press('Enter');
}
