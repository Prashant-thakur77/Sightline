import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
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

  /**
   * A seeded wrong-size order, checked with the demo photos, its case sent to Demo Store, and Demo
   * Store's replacement offer made from its desk (same demo session), all through the app's own
   * routes. Returns the order id.
   */
  async function offerWaiting(page: import('@playwright/test').Page): Promise<string> {
    const orderId = await seededOrder(page);
    const origin = new URL(test.info().project.use.baseURL ?? 'http://localhost:3100').origin;
    const photo = (name: string) => ({ name: `${name}.jpg`, mimeType: 'image/jpeg', buffer: readFileSync(path.join(REPO, 'apps/web/public/demo-parcel', `${name}.jpg`)) });
    const checked = await page.request.post(`/api/orders/${orderId}/check`, {
      multipart: { item: photo('wrong-item'), 'item-source': 'demo', label: photo('wrong-tag'), 'label-source': 'demo' },
      timeout: 60_000,
    });
    expect(checked.ok()).toBeTruthy();
    const draft = await page.request.post(`/api/orders/${orderId}/money-back`, { timeout: 60_000 });
    expect(draft.ok()).toBeTruthy();
    const { caseId } = (await draft.json()) as { caseId: string };
    expect((await page.request.post(`/api/cases/${caseId}/send`)).ok()).toBeTruthy();
    const offered = await page.request.post(`/api/merchant/cases/${caseId}/respond`, { data: { action: 'replacement', confirm: true }, headers: { origin } });
    expect(offered.ok()).toBeTruthy();
    return orderId;
  }

  test('accepting a store offer takes two presses on the offer card, with focus kept on Accept', async ({ page }) => {
    const orderId = await offerWaiting(page);
    await page.goto(`/app/orders/${orderId}`);
    await page.getByRole('link', { name: 'Hear Demo Store’s offer and answer it' }).click();
    await expect(page.getByRole('heading', { level: 2, name: 'Demo Store’s offer' })).toBeFocused();
    // Accept and Decline are on the card; the chips never repeat them.
    await expect(page.getByRole('button', { name: /accept/i })).toHaveCount(1);
    await expect(page.getByRole('button', { name: /decline/i })).toHaveCount(1);
    await expectNoAxeViolations(page);

    const accept = page.getByRole('button', { name: 'Accept the offer' });
    await accept.focus();
    await accept.press('Enter');
    const again = page.getByRole('button', { name: 'Press again to accept' });
    await expect(again).toBeFocused();
    await expect.poll(async () => (await announcements(page)).at(-1)).toBe(
      "Press Accept again to accept. You can't undo accepting. To leave the offer open, say 'not now'.",
    );
    // Nothing is answered by the first press.
    await expect(page.getByRole('heading', { name: 'Offer accepted' })).toHaveCount(0);

    await page.waitForTimeout(600);
    await again.press('Enter');
    await expect(page.getByRole('heading', { level: 2, name: 'Offer accepted' })).toBeFocused();
    await expect.poll(async () => (await announcements(page)).at(-1)).toMatch(/^Accepted\. Demo Store sends a new/);
  });

  test('once an offer is answered, the greeting does not read it again', async ({ page }) => {
    const orderId = await offerWaiting(page);
    // Answered by voice from the order page's link, without the greeting ever reading the notice.
    await page.goto(`/app/orders/${orderId}`);
    await page.getByRole('link', { name: 'Hear Demo Store’s offer and answer it' }).click();
    await expect(page.getByRole('heading', { level: 2, name: 'Demo Store’s offer' })).toBeVisible();
    const input = page.getByLabel('Or type what you need');
    await input.fill('accept the offer');
    await input.press('Enter');
    await expect(page.getByRole('heading', { level: 2, name: 'Offer accepted' })).toBeVisible();

    await page.goto('/app');
    await expect.poll(async () => (await announcements(page)).join(' ')).toMatch(/^Hi Maya\./);
    const hello = (await announcements(page)).join(' ');
    expect(hello).not.toMatch(/until you answer|offered to send/);
    // The order page says how it ended, not just "Resolved."
    await page.goto(`/app/orders/${orderId}`);
    await expect(page.locator('#money-back .folder-h')).toHaveText('Resolved: you accepted a replacement.');
  });

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

  test('adding photos without the camera says which photo is next, shows the ones added and can skip', async ({ page }) => {
    const orderId = await seededOrder(page);
    await page.goto(`/app/check/${orderId}`);
    const photo = (name: string) => path.join(REPO, 'apps/web/public/demo-parcel', name);
    await page.getByLabel(/photo of the whole item/).setInputFiles(photo('right-item.jpg'));
    await expect(page.getByRole('heading', { name: 'Photo 2 of 3: The size tag' })).toBeFocused();
    await expect(page.getByRole('list').filter({ hasText: 'The whole item' })).toBeVisible();
    await page.getByLabel(/photo of the size tag/).setInputFiles(photo('right-tag.jpg'));
    await expect(page.getByRole('heading', { name: 'Photo 3 of 3: Any damage' })).toBeFocused();
    await expect(page.getByRole('region', { name: 'Photo 3 of 3: Any damage' }).getByText('If not, press Skip this shot.')).toBeVisible();
    await page.getByRole('button', { name: 'Skip this shot' }).click();
    await expect(page.getByRole('heading', { name: 'Ready to check' })).toBeFocused();
    await expect(page.getByRole('list', { name: 'Photos to send' }).getByRole('listitem')).toHaveCount(2);
    await expectNoAxeViolations(page);
  });

  test('skipping every photo says there is nothing to check yet, instead of an empty check', async ({ page }) => {
    const orderId = await seededOrder(page);
    await page.goto(`/app/check/${orderId}`);
    await page.getByRole('button', { name: 'Start the camera' }).click();
    // No camera in the test browser: the photo field and Skip are the way on.
    await expect(page.getByRole('button', { name: 'Try the camera again' })).toBeVisible();
    for (const next of ['Photo 2 of 3: The size tag', 'Photo 3 of 3: Any damage']) {
      await page.getByRole('button', { name: 'Skip this shot' }).click();
      await expect(page.getByRole('heading', { name: next })).toBeFocused();
    }
    await page.getByRole('button', { name: 'Skip this shot' }).click();
    await expect(page.locator('#main .card-refusal').filter({ hasText: 'No photos yet' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Check your parcel' })).toBeFocused();
    await expect(page.getByRole('button', { name: 'Check it now' })).toHaveCount(0);
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
    // The result is focused and stays focused through the refresh; the page's own sent-state
    // paragraph is hidden while it shows, so there is one copy on screen and one reading.
    const result = page.locator('#money-back .mb-result');
    await expect(result).toBeFocused({ timeout: 30_000 });
    await expect(result).toContainText(/^(Done|I sent your case)/);
    await expect(page.getByRole('heading', { name: 'Get your money back' })).toHaveCount(0);
    await expect(result).toBeFocused();
    await expect(page.locator('#money-back .mb-server-sent')).toBeHidden();
    const said = (await result.textContent()) ?? '';
    const day = said.match(/until (\w+ \d+ \w+)/)?.[1];
    if (day) await expect(page.locator('#money-back')).toContainText(`until ${day}`);
    // "Not now" then starting again reuses the same signed pack.
    await expect(page.locator('.history li', { hasText: 'The evidence pack was signed.' })).toHaveCount(1);
    // The refresh after sending re-renders the page; let it settle (title included) before axe.
    await page.waitForLoadState('networkidle').catch(() => undefined);
    await expect(page).toHaveTitle(/\S/);
    await expectNoAxeViolations(page);
  });
});
