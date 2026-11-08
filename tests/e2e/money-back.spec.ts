import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { announcements, expectNoAxeViolations } from './helpers';

/**
 * The payoff path: a wrong-size parcel is checked with the demo photos, and the verdict's
 * "Get my money back" lands on the order page with focus on that button. Builds the evidence,
 * backs out with "Not now", starts again, sends, and the page shows the new state without a
 * reload. Needs the local database (seed script) and the vision service; skipped without them.
 */
const REPO = path.resolve(import.meta.dirname, '../..');
const VISION = process.env.VISION_SERVICE_URL ?? 'http://127.0.0.1:8011';

test.describe('money back after a wrong item', () => {
  test.beforeAll(async () => {
    const up = await fetch(`${VISION}/health`).then((r) => r.ok).catch(() => false);
    test.skip(!up, 'needs the vision service');
  });

  /** A fresh demo shopper with one delivered wrong-size order; returns the order id. */
  async function seededOrder(page: import('@playwright/test').Page): Promise<string> {
    const base = test.info().project.use.baseURL ?? 'http://localhost:3100';
    const res = await page.request.post('/api/demo/start', { data: { persona: 'maya' }, headers: { origin: new URL(base).origin } });
    const { userId } = (await res.json()) as { userId: string };
    const out = execFileSync('pnpm', ['--silent', '--filter', '@sightline/db', 'exec', 'tsx', '../../apps/web/scripts/dev-seed-order.ts', 'delivered', 'wrong_size', userId], {
      cwd: REPO,
      encoding: 'utf8',
    });
    return (JSON.parse(out.trim().split('\n').at(-1)!) as { orderId: string }).orderId;
  }

  test('a blocked camera says so and offers to try again, with photos as the other way', async ({ page }) => {
    const orderId = await seededOrder(page);
    await page.goto(`/app/check/${orderId}`);
    await page.getByRole('button', { name: 'Start the camera' }).click();
    await expect(page.locator('#main .card-refusal')).toContainText('I couldn’t use the camera.');
    await expect(page.getByRole('button', { name: 'Try the camera again' })).toBeVisible();
    await expect(page.getByLabel(/Or take or choose a photo/)).toBeVisible();
    await expect.poll(async () => (await announcements(page)).some((a) => a.startsWith('I couldn’t use the camera'))).toBe(true);
    await expectNoAxeViolations(page);
  });

  test('check, then money back with focus on each step and one deadline', async ({ page }) => {
    const orderId = await seededOrder(page);

    await page.goto(`/app/check/${orderId}`);
    await page.getByRole('button', { name: 'Use the demo parcel photos' }).click();
    await page.getByRole('button', { name: 'Check it now' }).click();
    const moneyLink = page.getByRole('link', { name: 'Get my money back' });
    await expect(moneyLink).toBeVisible({ timeout: 45_000 });

    await moneyLink.click();
    await expect(page).toHaveURL(new RegExp(`/app/orders/${orderId}#money-back$`));
    const start = page.getByRole('button', { name: 'Get my money back' });
    await expect(start).toBeFocused();

    await start.click();
    await expect(page.getByRole('heading', { name: 'Before I send it' })).toBeFocused({ timeout: 30_000 });
    await page.getByRole('button', { name: 'Not now' }).click();
    await expect(start).toBeFocused();

    // Starting again after "Not now" rebuilds the summary; it is not an already-open case.
    await start.click();
    await expect(page.getByRole('heading', { name: 'Before I send it' })).toBeFocused({ timeout: 30_000 });
    expect((await announcements(page)).some((a) => a.includes('already open'))).toBe(false);

    await page.getByRole('button', { name: /^Send it/ }).click();
    const result = page.locator('.mb-result').filter({ hasText: /^(Done|I sent your case)/ });
    await expect(result).toBeFocused({ timeout: 30_000 });
    // The page refreshed underneath: the Money back folder no longer offers to start.
    await expect(page.getByRole('heading', { name: 'Get your money back' })).toHaveCount(0);
    const said = await result.textContent();
    const day = said?.match(/until (\w+ \d+ \w+)/)?.[1];
    if (day) await expect(page.locator('#money-back')).toContainText(`until ${day}`);
    await expectNoAxeViolations(page);
  });
});
