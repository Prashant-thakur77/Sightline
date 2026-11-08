import { voiceOverTest as test } from '@guidepup/playwright';
import { expect } from '@playwright/test';
import { writeFile } from 'node:fs/promises';

/** Real VoiceOver: walk each core screen and keep what was spoken, for review next to the virtual transcripts. */
async function walk(voiceOver: { next: () => Promise<void>; lastSpokenPhrase: () => Promise<string>; spokenPhraseLog: () => Promise<string[]> }, steps: number) {
  for (let i = 0; i < steps; i++) await voiceOver.next();
  return voiceOver.spokenPhraseLog();
}

test.use({ voiceOverStartOptions: { capture: true } });

test('landing page with VoiceOver', async ({ page, voiceOver }) => {
  await page.goto('/', { waitUntil: 'load' });
  await page.getByRole('heading', { level: 1 }).waitFor();
  await voiceOver.navigateToWebContent();
  const log = await walk(voiceOver, 40);
  await writeFile('logs/landing.voiceover.txt', log.join('\n'));
  expect(log.join(' ')).toContain('Is this the one');
});

test('shopping to the readback with VoiceOver', async ({ page, voiceOver }) => {
  await page.request.post('/api/demo/start', { data: { persona: 'maya' } });
  await page.goto('/app', { waitUntil: 'load' });
  await page.getByLabel('Or type what you need').waitFor();
  await voiceOver.navigateToWebContent();
  await page.getByLabel('Or type what you need').fill('I need a navy crew-neck sweater, medium, under forty dollars');
  await page.keyboard.press('Enter');
  await page.getByRole('list', { name: /options/ }).waitFor();
  await page.waitForTimeout(4000);
  await page.getByRole('button', { name: 'Buy this', exact: true }).first().click();
  await page.getByRole('group', { name: 'Readback' }).waitFor();
  await page.waitForTimeout(8000);
  const log = await voiceOver.spokenPhraseLog();
  await writeFile('logs/conversation.voiceover.txt', log.join('\n'));
  expect(log.join(' ')).toContain('Here’s what you’re buying'.replace('’', "'"));
});
