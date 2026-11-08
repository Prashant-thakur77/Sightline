import { expect, test } from '@playwright/test';
import { announcements, expectNoAxeViolations, say, startAs } from './helpers';

test.describe('landing and start', () => {
  test('landing has one h1, a skip link and no axe violations', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByRole('heading', { level: 1 })).toHaveCount(1);
    await page.keyboard.press('Tab');
    await expect(page.getByRole('link', { name: 'Skip to main content' })).toBeFocused();
    await expectNoAxeViolations(page);
  });

  test('start page signs in as Maya without sign-up', async ({ page }) => {
    await page.goto('/start');
    await page.getByRole('button', { name: 'Shop as Maya' }).click();
    await expect(page).toHaveURL(/\/app$/);
    await expect(page.getByRole('heading', { level: 1 })).toContainText('Maya');
  });
});

test.describe('shopping conversation', () => {
  test.beforeEach(async ({ page }) => {
    await startAs(page, 'maya');
    await page.goto('/app');
    await expect.poll(async () => (await announcements(page)).join(' ')).toContain('What do you need today');
  });

  test('a spoken request gives at most three options and announces them once', async ({ page }) => {
    await say(page, 'I need a navy crew-neck sweater, medium, under forty dollars');
    const options = page.getByRole('list', { name: /options/ });
    await expect(options).toBeVisible();
    expect(await options.getByRole('listitem').count()).toBeLessThanOrEqual(3);
    const said = await announcements(page);
    expect(said.filter((s) => s.startsWith('I found')).length).toBe(1);
    await expectNoAxeViolations(page);
  });

  test('the readback is template text with the exact total, and nothing is paid without confirmation', async ({ page }) => {
    await say(page, 'I need a navy crew-neck sweater, medium, under forty dollars');
    await page.getByRole('button', { name: 'Buy this', exact: true }).first().click();
    const readback = page.getByRole('group', { name: 'Readback' });
    await expect(readback).toContainText('$36.72');
    await expect(readback).toContainText('navy');
    await expect.poll(async () => (await announcements(page)).join(' ')).toContain("Here's what you're buying. Harbor knit crew-neck sweater. Colour: navy. Size: M.");
    await say(page, 'wait');
    await expect.poll(async () => (await announcements(page)).join(' ')).toContain('Nothing is paid');
    await expect(page.getByText(/Holding\. Take your time/)).toBeVisible();
    await expectNoAxeViolations(page);
  });

  test('shortcuts need Alt by default (WCAG 2.1.4), and single keys can be switched on', async ({ page }) => {
    await say(page, 'navy crew-neck sweater');
    await expect(page.getByRole('list', { name: /options/ })).toBeVisible();
    await page.locator('body').click({ position: { x: 5, y: 5 } });
    await page.keyboard.press('1');
    await expect(page.getByRole('heading', { level: 2, name: /^Option 1/ })).toHaveCount(0);
    await page.keyboard.press('Alt+Shift+Digit1');
    await expect(page.getByRole('heading', { level: 2, name: /^Option 1/ })).toBeVisible();
    await page.getByRole('button', { name: 'Keyboard shortcuts' }).click();
    await expect(page.getByRole('table', { name: 'Keyboard shortcuts' })).toContainText('Alt + Shift + 1, 2, 3');
    await page.getByLabel('Use single-key shortcuts').check();
    await expect(page.getByRole('table', { name: 'Keyboard shortcuts' })).not.toContainText('Alt +');
  });

  test('a reply is announced once and focus stays in the text box', async ({ page }) => {
    await say(page, 'navy crew-neck sweater');
    await expect(page.getByRole('list', { name: /options/ })).toBeVisible();
    await expect(page.getByLabel('Or type what you need')).toBeFocused();
    const said = await announcements(page);
    expect(said.filter((s) => s.startsWith('I found')).length).toBe(1);
  });
});

test.describe('other pages', () => {
  test.beforeEach(async ({ page }) => startAs(page, 'maya'));
  for (const path of ['/app/orders', '/app/settings', '/judge']) {
    test(`${path} has no axe violations`, async ({ page }) => {
      await page.goto(path);
      await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
      await expectNoAxeViolations(page);
    });
  }

  test('settings save is announced and focus moves to the result', async ({ page }) => {
    await page.goto('/app/settings');
    await page.getByLabel('Most for one order').fill('120');
    await page.getByRole('button', { name: 'Save settings' }).click();
    await expect(page.locator('#settings-status')).toBeFocused();
    await expect(page.locator('#settings-status')).toContainText('Saved');
  });

  test('delete everything asks first, can be cancelled, and announces what was kept', async ({ page }) => {
    await page.goto('/app/settings');
    const open = page.getByRole('button', { name: 'Delete everything' });
    await open.click();
    const question = page.getByRole('group', { name: /Delete your conversations/ });
    await expect(question.locator('p').first()).toBeFocused();
    await page.getByRole('button', { name: 'Keep them' }).last().click();
    await expect(open).toBeFocused();
    await expect.poll(() => announcements(page)).toContain('Nothing was deleted.');

    await open.click();
    await page.getByRole('button', { name: 'Yes, delete everything' }).click();
    const result = page.locator('#main').getByText(/^Done\. I deleted your conversations/);
    await expect(result).toBeFocused();
    await expect(result).toContainText('Your orders, payments and receipts are kept');
    await expect.poll(async () => (await announcements(page)).some((a) => a.startsWith('Done. I deleted your conversations'))).toBe(true);
    await expectNoAxeViolations(page);
  });
});
