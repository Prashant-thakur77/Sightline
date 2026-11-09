import { defineConfig } from 'vitest/config';
import path from 'node:path';

export default defineConfig({
  resolve: {
    alias: {
      '@': path.resolve(import.meta.dirname, 'src'),
      'server-only': path.resolve(import.meta.dirname, 'test/stubs/server-only.ts'),
    },
  },
  test: {
    include: ['test/**/*.test.ts', 'test/**/*.test.tsx'],
    environment: 'node',
    // Tests are deterministic: they use the demo catalogue and no model, whatever keys .env.local
    // holds (process.loadEnvFile never overwrites a variable that is already set, even to '').
    env: { ANTHROPIC_API_KEY: '', CHANNEL3_API_KEY: '', KERNEL_API_KEY: '', DEEPGRAM_API_KEY: '', AG_STUDIO: '' },
  },
});
