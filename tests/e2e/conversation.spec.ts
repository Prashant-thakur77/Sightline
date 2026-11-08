import { expect, test } from '@playwright/test';
import { announcements, expectNoAxeViolations, say, startAs } from './helpers';

test.describe('conversation: focus, honesty and dead ends', () => {
  test.beforeEach(async ({ page }) => {
    await startAs(page, 'maya');
    await page.goto('/app');
    await expect.poll(async () => (await announcements(page)).join(' ')).toContain('What do you need today');
  });

  test('the first Confirm press keeps focus on the confirm control, and Wait keeps it on Wait', async ({ page }) => {
    await say(page, 'navy crew-neck sweater');
    await page.getByRole('button', { name: 'Buy this', exact: true }).first().click();
    const confirm = page.getByRole('button', { name: /^Confirm and pay \$/ });
    await expect(confirm).toBeVisible();
    // Exactly one Confirm control: the suggestion chips never repeat it.
    await expect(page.getByRole('button', { name: /confirm/i })).toHaveCount(1);
    // On a desktop screen the greeting is compact after the first request and the actions sit beside
    // the receipt, so the readback and its Confirm button are both above the fold.
    const viewport = page.viewportSize()!;
    if (viewport.width >= 1024) {
      const box = await confirm.boundingBox();
      expect(box!.y + box!.height).toBeLessThanOrEqual(viewport.height);
      const receipt = await page.getByRole('group', { name: 'Readback' }).boundingBox();
      expect(receipt!.y).toBeLessThan(viewport.height);
    }
    // Nothing is called paid while the readback waits.
    await expect(page.getByRole('navigation', { name: 'Where this order is' })).toContainText('Paid, not yet, waiting for you to confirm');

    await confirm.focus();
    await confirm.press('Enter');
    const again = page.getByRole('button', { name: /^Press again to pay \$/ });
    await expect(again).toBeVisible();
    await expect(again).toBeFocused();
    await expect.poll(async () => (await announcements(page)).join(' ')).toContain('Press confirm again to pay');

    const wait = page.getByRole('button', { name: 'Wait, hold on' });
    await wait.focus();
    await wait.press('Enter');
    await expect(page.getByText(/Holding\. Take your time/)).toBeVisible();
    await expect(wait).toBeFocused();
    await expectNoAxeViolations(page);

    // Questions during the readback are answered from it, then say how to pay.
    await say(page, "what's the total");
    await expect.poll(async () => (await announcements(page)).at(-1)).toMatch(/^The total is \$\d+\.\d\d, with shipping and tax\. To pay, say 'confirm purchase'\./);
    await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  });

  test('another kind of thing is never offered: black jeans finds no cables, T-shirts or shoes', async ({ page }) => {
    await say(page, 'black jeans size 32');
    await expect.poll(async () => (await announcements(page)).at(-1)).toBe("I couldn't find jeans in Demo Store. Want me to look for something else?");
    await expect(page.getByRole('list', { name: /options/ })).toHaveCount(0);
    await say(page, 'yes');
    await expect.poll(async () => (await announcements(page)).at(-1)).toBe('Okay. What should I look for?');
    await expectNoAxeViolations(page);
  });
});
