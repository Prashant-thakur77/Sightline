import type { CatalogProduct, CatalogSource, SearchQuery } from './types';
import { createChannel3 } from './channel3';
import { createDemoStore } from './demo-store';

/** What a merged search could not reach, for the agent's step log and an honest reply. */
export interface MergedSearchReport {
  liveFailed: boolean;
  demoCount: number;
  liveCount: number;
}

export type MergedCatalog = CatalogSource & { lastReport: MergedSearchReport | null };

const key = (p: CatalogProduct) => `${(p.brand ?? '').toLowerCase()}|${p.title.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()}`;

/**
 * The Demo Store's own inventory (the sandbox merchant every order is placed with) together with
 * live Channel3 results. Demo Store items come first in the list and win de-duplication; every
 * item keeps its `source`. When Channel3 fails or times out the Demo Store's results still come
 * back, and `lastReport` says Channel3 didn't answer, so nothing is claimed about it.
 */
export function createMergedCatalog(demo: CatalogSource, live: CatalogSource): MergedCatalog {
  const merged: MergedCatalog = {
    name: 'merged',
    lastReport: null,
    async search(q: SearchQuery) {
      const [own, remote] = await Promise.allSettled([demo.search(q), live.search(q)]);
      const ownItems = own.status === 'fulfilled' ? own.value : [];
      if (remote.status === 'rejected') console.error('[catalog] Channel3 search failed', remote.reason);
      const liveItems = remote.status === 'fulfilled' ? remote.value : [];
      if (own.status === 'rejected' && remote.status === 'rejected') throw remote.reason;
      const seen = new Set(ownItems.map(key));
      const out = [...ownItems, ...liveItems.filter((p) => !seen.has(key(p)))];
      merged.lastReport = { liveFailed: remote.status === 'rejected', demoCount: ownItems.length, liveCount: liveItems.length };
      return out;
    },
    async get(id, selection) {
      return id.startsWith('demo:') ? demo.get(id, selection) : live.get(id, selection);
    },
  };
  return merged;
}

/**
 * The Demo Store's catalog and, when a key is configured, live Channel3 results with it. Without
 * a key, the Demo Store's catalog alone.
 */
export function catalogFromEnv(env: { CHANNEL3_API_KEY?: string }, userId?: string): CatalogSource {
  if (env.CHANNEL3_API_KEY) return createMergedCatalog(createDemoStore(), createChannel3({ apiKey: env.CHANNEL3_API_KEY, userId }));
  return createDemoStore();
}
