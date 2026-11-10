import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { announcements, expectNoAxeViolations } from './helpers';

/**
 * When the check is not sure, it asks for one specific extra photo and checks again with both.
 * Needs the local database (seed script) and the vision service; skipped without them.
 */
const REPO = path.resolve(import.meta.dirname, '../..');
const VISION = process.env.VISION_SERVICE_URL ?? 'http://127.0.0.1:8011';

test.describe('one more photo when the check is not sure', () => {
  test.beforeAll(async () => {
    const up = await fetch(`${VISION}/health`).then((r) => r.ok).catch(() => false);
    test.skip(!up, 'needs the vision service');
  });

  test('a not-sure verdict offers one named extra photo, keyboard first, with no axe violations', async ({ page }) => {
    test.setTimeout(120_000);
    const base = test.info().project.use.baseURL ?? 'http://localhost:3100';
    const res = await page.request.post('/api/demo/start', { data: { persona: 'maya' }, headers: { origin: new URL(base).origin } });
    const { userId } = (await res.json()) as { userId: string };
    const out = execFileSync('pnpm', ['--silent', '--filter', '@sightline/db', 'exec', 'tsx', '../../apps/web/scripts/dev-seed-order.ts', 'delivered', 'correct', userId], {
      cwd: REPO,
      encoding: 'utf8',
    });
    const { orderId } = JSON.parse(out.trim().split('\n').at(-1)!) as { orderId: string };

    await page.goto(`/app/check/${orderId}`);
    // Only the whole item, no size tag: the size cannot be read, so the check cannot be sure.
    await page.getByLabel(/photo of the whole item/).setInputFiles(path.join(REPO, 'apps/web/public/demo-parcel', 'right-item.jpg'));
    await page.getByRole('button', { name: 'Skip this shot' }).click();
    await page.getByRole('button', { name: 'Skip this shot' }).click();
    await page.getByRole('button', { name: 'Check it now' }).click();

    const more = page.getByRole('button', { name: 'Take one more photo' });
    await expect(more).toBeVisible({ timeout: 60_000 });
    await expectNoAxeViolations(page);

    await more.focus();
    await more.press('Enter');
    // The extra photo is named, and focus moves to it.
    await expect(page.locator(':focus')).toBeVisible();
    await expect.poll(async () => (await announcements(page)).length).toBeGreaterThan(0);
    await expectNoAxeViolations(page);
    await expect(page.getByRole('button', { name: 'Keep my first answer' })).toBeVisible();
  });
});
