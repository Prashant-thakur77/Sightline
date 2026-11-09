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
    await expect(page.getByRole('list', { name: 'Where this order is' })).toContainText('Paid, not yet, waiting for you to confirm');

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

  test('a reload keeps a waiting readback, at its first press', async ({ page }) => {
    await say(page, 'navy crew-neck sweater');
    await page.getByRole('button', { name: 'Buy this', exact: true }).first().click();
    const confirm = page.getByRole('button', { name: /^Confirm and pay \$/ });
    await confirm.click();
    await expect(page.getByRole('button', { name: /^Press again to pay \$/ })).toBeVisible();

    await page.reload();
    // Still there, with the conversation so far, and the reload did not count as a press.
    await expect(page.getByRole('group', { name: 'Readback' })).toBeVisible();
    await expect(page.getByRole('button', { name: /^Confirm and pay \$/ })).toBeVisible();
    await expect(page.locator('.transcript')).toContainText('navy crew-neck sweater');
    await expect.poll(async () => (await announcements(page)).join(' ')).toContain('Your readback is still here');
    expect((await announcements(page)).join(' ')).not.toContain('Welcome to');
    await expect(page.getByRole('button', { name: /^Press again to pay \$/ })).toHaveCount(0);
    await expectNoAxeViolations(page);

    // The next press is a first press again: nothing is paid.
    await page.getByRole('button', { name: /^Confirm and pay \$/ }).click();
    await expect(page.getByRole('button', { name: /^Press again to pay \$/ })).toBeFocused();
    await page.getByRole('button', { name: 'Cancel', exact: true }).click();
    await expect(page.getByRole('group', { name: 'Readback' })).toHaveCount(0);
  });

  test('typed words come back in the text box when the request fails, and the transcript does not keep them', async ({ page }) => {
    const input = page.getByLabel('Or type what you need');
    // The next request fails on the server's side; nothing reaches the conversation.
    await page.route('**/api/turn', (route) => route.fulfill({ status: 500, contentType: 'application/json', body: '{"error":"x"}' }), { times: 1 });
    await say(page, 'navy crew-neck sweater');
    await expect(input).toHaveValue('navy crew-neck sweater');
    await expect(page.locator('#convo-status')).toContainText('Your words are still in the text box.');
    await expect.poll(async () => (await announcements(page)).at(-1)).toContain('Your words are still in the text box.');
    await expect(page.locator('.transcript')).not.toContainText('navy crew-neck sweater');
    // Sending again works and clears the box.
    await input.press('Enter');
    await expect(page.getByRole('list', { name: /options/ })).toBeVisible();
    await expect(input).toHaveValue('');
  });

  test('the transcript keeps the newest message in view without moving focus', async ({ page }) => {
    const transcript = page.locator('.transcript');
    const input = page.getByLabel('Or type what you need');
    for (const t of ['navy crew-neck sweater', 'tell me more about one', 'compare them', 'why these', 'more']) {
      await say(page, t);
      await expect(page.locator('#convo-status')).not.toHaveAttribute('data-state', 'busy');
      await expect(transcript.locator('li').last()).not.toHaveText(t);
      if (await transcript.evaluate((el) => el.scrollHeight > el.clientHeight + 10)) break;
    }
    expect(await transcript.evaluate((el) => el.scrollHeight > el.clientHeight + 10)).toBe(true);
    await expect.poll(() => transcript.evaluate((el) => Math.abs(el.scrollHeight - el.clientHeight - el.scrollTop))).toBeLessThanOrEqual(2);
    await expect(input).toBeFocused();
  });

  test('Alt+Shift shortcuts work from the text box; Shift+Enter there never confirms', async ({ page }) => {
    const input = page.getByLabel('Or type what you need');
    await say(page, 'navy crew-neck sweater');
    await expect(page.getByRole('list', { name: /options/ })).toBeVisible();
    await expect(input).toBeFocused();
    await input.press('Alt+Shift+Digit1');
    await expect(page.getByRole('heading', { level: 2, name: /^Option 1/ })).toBeVisible();
    // A single key typed in the box is just text.
    await input.press('Digit2');
    await expect(input).toHaveValue('2');
    await input.fill('');

    await page.getByRole('button', { name: 'Buy this', exact: true }).first().click();
    await expect(page.getByRole('button', { name: /^Confirm and pay \$/ })).toBeVisible();
    await input.focus();
    await input.press('Shift+Enter');
    await expect(page.getByRole('button', { name: /^Press again to pay \$/ })).toHaveCount(0);
    await expect(page.getByRole('button', { name: /^Confirm and pay \$/ })).toBeVisible();
    await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  });

  test('another kind of thing is never offered: black jeans finds no cables, T-shirts or shoes', async ({ page }) => {
    await say(page, 'black jeans size 32');
    // With live store data there may be real jeans; with the Demo Store alone there are none. Either
    // way, nothing of another kind is ever offered.
    const notFound = "I couldn't find jeans in Demo Store. Want me to look for something else?";
    await expect.poll(async () => {
      const last = (await announcements(page)).at(-1) ?? '';
      return last === notFound || /^I found /.test(last);
    }).toBe(true);
    const options = page.getByRole('list', { name: /options/ });
    if (await options.count()) {
      const titles = await options.getByRole('heading').allTextContents();
      expect(titles.length).toBeGreaterThan(0);
      for (const t of titles) {
        expect(t).toMatch(/jean|denim/i);
        expect(t).not.toMatch(/cable|t-?shirt|\btee\b|shoe|sneaker/i);
      }
    } else {
      await say(page, 'yes');
      await expect.poll(async () => (await announcements(page)).at(-1)).toBe('Okay. What should I look for?');
    }
    await expectNoAxeViolations(page);
  });
});
