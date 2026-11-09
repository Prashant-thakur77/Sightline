import 'server-only';
import { and, desc, eq, inArray, ne } from 'drizzle-orm';
import { tables } from '@sightline/db';
import type { ProductSnapshot } from '@sightline/core';
import { runShopper, searchListings, shopperWarmupRequest, type CreateMessage, type PastOrder, type ShopperInput, type ShopperResult } from '@sightline/agent';
import { aiAvailable, anthropic, MODELS } from './ai';
import { catalog, freeze } from './catalog';
import { db } from './runtime';

/**
 * The shopping agent with this server's dependencies: the Anthropic SDK client on the fast model
 * (voice turns need short waits), the merged catalog, and the buyer's order history. The loop
 * itself, its limits and its checks live in @sightline/agent.
 */

let testModel: CreateMessage | null = null;

/** Tests only: a scripted model instead of the API. */
export function setShopperModelForTests(create: CreateMessage | null): void {
  testModel = create;
}

/** The agent can run: there is a model to ask. Without a key, open requests use the grammar and templates. */
export function shopperAvailable(): boolean {
  return Boolean(testModel) || aiAvailable();
}

/** The prompt cache lives five minutes; warming a little more often than that keeps it hot. */
const WARM_EVERY_MS = 4 * 60 * 1000;
let lastWarm = 0;

/**
 * Warm the shopping agent's prompt cache when the conversation opens, so the buyer's first open
 * request doesn't wait for a cold prefix (measured: about 10 seconds cold against 1 to 4 warm).
 * `max_tokens: 0` returns at once and bills no output; at most once every four minutes per
 * server, only with a key, and never in the way of the turn (errors are ignored).
 */
export function prewarmShopper(now = Date.now()): void {
  if (testModel || !aiAvailable() || now - lastWarm < WARM_EVERY_MS) return;
  lastWarm = now;
  anthropic()
    .messages.create(shopperWarmupRequest(MODELS.fast()), { timeout: 15_000, maxRetries: 0 })
    .catch(() => {
      lastWarm = 0;
    });
}

export function runShopperTurn(userId: string, input: ShopperInput): Promise<ShopperResult> {
  const create: CreateMessage = testModel ?? ((body, options) => anthropic().messages.create(body, options));
  return runShopper(input, {
    create,
    model: MODELS.fast(),
    search: (query, text, prefs) => searchListings({ query, text, source: catalog(userId), freeze, ...prefs }),
    orderHistory: () => pastOrders(userId),
  });
}

/**
 * What the buyer has bought, grouped by item and variant: most often bought first, then most
 * recent. "My usual" is the first; failed orders (nothing charged) don't count.
 */
export async function pastOrders(userId: string): Promise<PastOrder[]> {
  const orders = await db()
    .select({ snapshotId: tables.orders.snapshotId, createdAt: tables.orders.createdAt, amountCents: tables.orders.amountCents })
    .from(tables.orders)
    .where(and(eq(tables.orders.userId, userId), ne(tables.orders.status, 'failed')))
    .orderBy(desc(tables.orders.createdAt))
    .limit(60);
  if (!orders.length) return [];
  const snaps = await db()
    .select()
    .from(tables.productSnapshots)
    .where(inArray(tables.productSnapshots.id, [...new Set(orders.map((o) => o.snapshotId))]));
  const byId = new Map(snaps.map((s) => [s.id, s.body as ProductSnapshot]));
  const groups = new Map<string, PastOrder>();
  for (const o of orders) {
    const s = byId.get(o.snapshotId);
    if (!s) continue;
    const key = `${s.productId}|${s.variantId}`;
    const g = groups.get(key);
    if (g) g.times++;
    else groups.set(key, { snapshot: s, times: 1, lastOrderedAt: o.createdAt, paidCents: o.amountCents });
  }
  return [...groups.values()].sort((a, b) => b.times - a.times || Date.parse(b.lastOrderedAt) - Date.parse(a.lastOrderedAt));
}
