import { devices } from '@playwright/test';
import { withGuidepup } from '@guidepup/playwright';

export default withGuidepup({
  testDir: '.',
  testMatch: /voiceover\.spec\.ts/,
  timeout: 180_000,
  use: { baseURL: process.env.BASE_URL },
  projects: [{ name: 'webkit', use: { ...devices['Desktop Safari'] } }],
});
