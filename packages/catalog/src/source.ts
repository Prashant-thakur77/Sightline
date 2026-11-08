import type { CatalogSource } from './types';
import { createChannel3 } from './channel3';
import { createDemoStore } from './demo-store';

/** Channel3 when a key is configured, otherwise the Demo Store's own catalog. */
export function catalogFromEnv(env: { CHANNEL3_API_KEY?: string }, userId?: string): CatalogSource {
  if (env.CHANNEL3_API_KEY) return createChannel3({ apiKey: env.CHANNEL3_API_KEY, userId });
  return createDemoStore();
}
