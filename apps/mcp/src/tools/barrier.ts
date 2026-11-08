import { readFile } from 'node:fs/promises';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { ServerConfig } from '../config';
import { fail, ok } from '../shared';

export const barrierInput = {
  platform: z
    .string()
    .trim()
    .max(60)
    .optional()
    .describe(
      'Store platform to focus on, e.g. "shopify", "woocommerce", "magento", "bigcommerce" or "custom".',
    ),
};

const row = z.record(z.string(), z.unknown());

export const barrierOutput = {
  available: z.boolean(),
  message: z.string(),
  run_at: z.string().nullable(),
  n: z.number().nullable().describe('Number of stores audited.'),
  platform: z.string().nullable(),
  platforms_available: z.array(z.string()),
  by_platform: z.array(row),
  top_failing_rules: z.array(row),
};

type Json = Record<string, unknown>;
const isObj = (v: unknown): v is Json => !!v && typeof v === 'object' && !Array.isArray(v);

function pick(o: Json, keys: string[]): unknown {
  for (const k of keys) if (o[k] !== undefined && o[k] !== null) return o[k];
  return undefined;
}

/** Platform rows from either { shopify: {...} } or [{ platform: 'shopify', ... }]. */
function platformRows(v: unknown): Json[] {
  if (Array.isArray(v))
    return v
      .filter(isObj)
      .map((r) => ({ ...r, platform: String(pick(r, ['platform', 'name', 'id']) ?? 'unknown') }));
  if (isObj(v))
    return Object.entries(v).map(([platform, r]) => (isObj(r) ? { platform, ...r } : { platform, value: r }));
  return [];
}

function ruleRows(v: unknown): Json[] {
  if (Array.isArray(v)) return v.map((r) => (isObj(r) ? r : { rule: String(r) })).slice(0, 10);
  if (isObj(v))
    return Object.entries(v)
      .map(([rule, r]) => (isObj(r) ? { rule, ...r } : { rule, count: r }))
      .slice(0, 10);
  return [];
}

const RULE_KEYS = ['top_failing_rules', 'topFailingRules', 'top_rules', 'topRules', 'rules'];

export async function barrierIndex(
  platform: string | undefined,
  config: Pick<ServerConfig, 'barrierResultsPath'>,
) {
  let raw: string;
  try {
    raw = await readFile(config.barrierResultsPath, 'utf8');
  } catch {
    return {
      available: false,
      message:
        'The Checkout Barrier Index has not been run yet, so there are no results to report. Do not quote numbers for it. Results will appear in evals/results/barrier.json once the audit runs.',
      run_at: null,
      n: null,
      platform: platform ?? null,
      platforms_available: [],
      by_platform: [],
      top_failing_rules: [],
    };
  }
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    throw new Error('The Barrier Index results file is not valid JSON, so I could not read it.');
  }
  if (!isObj(data)) throw new Error('The Barrier Index results file is not in a shape I can read.');

  const runAt = pick(data, [
    'run_at',
    'runAt',
    'run_date',
    'runDate',
    'generated_at',
    'generatedAt',
    'date',
    'created_at',
  ]);
  const stores = pick(data, ['n', 'N', 'store_count', 'storeCount', 'stores_count', 'sample_size', 'stores']);
  const n = typeof stores === 'number' ? stores : Array.isArray(stores) ? stores.length : null;
  const rows = platformRows(pick(data, ['by_platform', 'byPlatform', 'platforms']));
  const platformsAvailable = rows.map((r) => String(r.platform));

  let byPlatform = rows;
  let topRules = ruleRows(pick(data, RULE_KEYS));
  let message = `Checkout Barrier Index${typeof runAt === 'string' ? ` from ${runAt}` : ''}${n !== null ? `, ${n} stores` : ''}. Stores are reported by platform only, never by name.`;
  if (platform) {
    const match = rows.find((r) => String(r.platform).toLowerCase() === platform.toLowerCase());
    if (!match) {
      message = `There are no Barrier Index results for "${platform}". Platforms with results: ${platformsAvailable.join(', ') || 'none'}.`;
      byPlatform = [];
    } else {
      byPlatform = [match];
      const own = ruleRows(pick(match, RULE_KEYS));
      if (own.length > 0) topRules = own;
    }
  }
  return {
    available: true,
    message,
    run_at: typeof runAt === 'string' ? runAt : null,
    n,
    platform: platform ?? null,
    platforms_available: platformsAvailable,
    by_platform: byPlatform,
    top_failing_rules: topRules,
  };
}

export function registerBarrier(server: McpServer, config: ServerConfig): void {
  server.registerTool(
    'barrier_index',
    {
      title: 'Checkout Barrier Index',
      description: [
        'Returns the aggregated Checkout Barrier Index: how inaccessible real store checkouts are for screen-reader and keyboard users, from automated accessibility audits of product, cart and checkout-start pages.',
        'Gives results by store platform, the most common failing accessibility rules, the number of stores (n) and the run date. Stores are never named.',
        'Pass platform to focus on one. If the audit has not been run, available is false: do not quote any numbers then.',
      ].join(' '),
      inputSchema: barrierInput,
      outputSchema: barrierOutput,
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    },
    async ({ platform }) => {
      try {
        const out = await barrierIndex(platform, config);
        return ok(out, out.message);
      } catch (e) {
        return fail((e as Error).message);
      }
    },
  );
}
