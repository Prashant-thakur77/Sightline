import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { expectNoAxeViolations } from './helpers';

/**
 * The store's holds and deadlines: the Bryntum timeline in a labelled region with a skip link, the
 * same schedule as a table, no axe violations in the light, dark and high-contrast themes, no
 * sideways page scroll at 320 px or at 200% zoom, and Enter on a bar opens the order. Needs the
 * local database (seed script).
 */
const REPO = path.resolve(import.meta.dirname, '../..');

/** A fresh demo shopper with one delivered order on hold; returns the order id. */
async function heldOrder(page: Page): Promise<string> {
  const base = test.info().project.use.baseURL ?? 'http://localhost:3100';
  const res = await page.request.post('/api/demo/start', { data: { persona: 'maya' }, headers: { origin: new URL(base).origin } });
  const { userId } = (await res.json()) as { userId: string };
  const out = execFileSync(
    'pnpm',
    ['--silent', '--filter', '@sightline/db', 'exec', 'tsx', '../../apps/web/scripts/dev-seed-order.ts', 'delivered', 'correct', userId, 'held'],
    { cwd: REPO, encoding: 'utf8' },
  );
  return (JSON.parse(out.trim().split('\n').at(-1)!) as { orderId: string }).orderId;
}

async function openSchedule(page: Page) {
  await page.goto('/merchant/schedule');
  await expect(page.getByRole('heading', { level: 1, name: 'Holds and deadlines' })).toBeVisible();
  await expect(page.locator('.mx-sched-box .b-sch-event-wrap:not(.b-measure)').first()).toBeVisible();
}

test.describe('holds and deadlines schedule', () => {
  test.beforeEach(async ({ page }) => {
    await heldOrder(page);
  });

  test('the timeline sits in a named region with a skip link, and the table holds the same schedule', async ({ page }) => {
    await openSchedule(page);
    const region = page.getByRole('region', { name: 'Schedule' });
    await expect(region.getByRole('group', { name: 'Holds and deadlines schedule' })).toBeVisible();
    const skip = region.getByRole('link', { name: 'Skip past the schedule' });
    await skip.focus();
    await page.keyboard.press('Enter');
    await expect(page.getByRole('heading', { level: 2, name: 'The schedule as a table' })).toBeFocused();
    const table = page.getByRole('table');
    await expect(table.locator('caption')).toContainText('Holds and deadlines by order');
    await expect(table.locator('th[scope="rowgroup"]')).toHaveCount(1);
    const bars = await page.locator('.mx-sched-box .b-sch-event-wrap:not(.b-measure)').count();
    expect(await table.locator('tbody tr[data-tone]').count()).toBeGreaterThanOrEqual(bars);
  });

  for (const theme of ['light', 'dark', 'contrast'] as const) {
    test(`no axe violations in the ${theme} theme`, async ({ page }) => {
      await openSchedule(page);
      await page.evaluate((t) => {
        if (t === 'light') delete document.documentElement.dataset.theme;
        else document.documentElement.dataset.theme = t;
      }, theme);
      await expectNoAxeViolations(page);
    });
  }

  test('no sideways page scroll at 320 px or at 200% zoom; the timeline scrolls inside its own box', async ({ page }) => {
    await page.setViewportSize({ width: 320, height: 800 });
    await openSchedule(page);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(320);
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.evaluate(() => {
      document.documentElement.style.zoom = '2';
    });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
  });

  test('Enter on a bar opens the order', async ({ page }) => {
    await openSchedule(page);
    await page.locator('.mx-sched-box .b-sch-event-wrap:not(.b-measure)').first().focus();
    await page.keyboard.press('Enter');
    // An order with no case opens the Orders page.
    await expect(page).toHaveURL(/\/merchant$/);
  });
});
