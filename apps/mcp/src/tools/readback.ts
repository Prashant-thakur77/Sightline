import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { ReadbackError, composeReadback } from '@sightline/agent';
import { computeTotals } from '@sightline/catalog';
import {
  DEMO_MERCHANT_NAME,
  PRODUCT_NAME,
  addMoney,
  multiplyMoney,
  newId,
  type Cart,
  type CartLine,
} from '@sightline/core';
import { hashCart } from '@sightline/evidence';
import { z } from 'zod';
import type { ServerConfig } from '../config';
import {
  callerSnapshot,
  currencyCode,
  dollars,
  fail,
  isoDate,
  moneyOut,
  moneyView,
  ok,
  toMoney,
} from '../shared';

const item = z.strictObject({
  title: z.string().trim().min(1).max(300).describe('Product title exactly as the listing gives it.'),
  colour: z
    .string()
    .trim()
    .max(80)
    .optional()
    .describe('Colour exactly as the listing names it. Leave out if the listing does not say.'),
  size: z
    .string()
    .trim()
    .max(40)
    .optional()
    .describe('Size exactly as the listing gives it. Leave out if the listing does not say.'),
  brand: z.string().trim().max(120).optional().describe('Brand, read only at detailed verbosity.'),
  material: z.string().trim().max(200).optional().describe('Material, read only at detailed verbosity.'),
  unit_price: dollars.describe('Price of one unit in dollars as a string, e.g. "34.00".'),
  quantity: z.number().int().min(1).max(99),
});

export const readbackInput = {
  items: z.array(item).min(1).max(20).describe('Every line in the cart, as the listing states it.'),
  seller: z
    .string()
    .trim()
    .min(1)
    .max(200)
    .describe(`Name of the seller who receives the money, e.g. "${DEMO_MERCHANT_NAME}".`),
  payment_label: z
    .string()
    .trim()
    .min(1)
    .max(120)
    .describe('How the payment method is said aloud, e.g. "your saved PayPal".'),
  delivery_date: isoDate
    .optional()
    .describe('Latest delivery date the seller commits to, ISO 8601. Leave out when unknown.'),
  return_policy: z
    .strictObject({
      window_days: z.number().int().min(0).max(3650).optional(),
      free: z.boolean().optional(),
    })
    .optional()
    .describe(
      'Return policy as the listing states it. Leave out parts the listing does not give; they are read as unknown.',
    ),
  verbosity: z
    .enum(['brief', 'standard', 'detailed'])
    .default('standard')
    .describe(
      'brief: total only. standard: items, shipping, tax and total. detailed: adds brand, material and how to cancel.',
    ),
  currency: currencyCode,
  shipping: dollars
    .optional()
    .describe('Shipping in dollars, only if the store has quoted it. Otherwise the Demo Store rule is used.'),
  tax: dollars
    .optional()
    .describe('Tax in dollars, only if the store has quoted it. Otherwise the Demo Store rule is used.'),
};

export const readbackOutput = {
  text: z.string().describe('Speak this verbatim before asking for confirmation.'),
  text_hash: z
    .string()
    .describe('Domain-separated SHA-256 of exactly `text`. Any change to the cart or the words changes it.'),
  fields: z.array(z.object({ key: z.string(), label: z.string(), value: z.string() })),
  totals: z.object({ items: moneyOut, shipping: moneyOut, tax: moneyOut, total: moneyOut }),
  totals_source: z.object({
    shipping: z.enum(['demo_store_rule', 'caller']),
    tax: z.enum(['demo_store_rule', 'caller']),
  }),
  instructions: z.string(),
};

const INSTRUCTIONS =
  'Speak `text` to the user word for word, before asking them to confirm. Do not shorten, paraphrase, reorder or add to it. Then pass what they say to check_confirmation_phrase. If anything in the cart changes, build a new readback and read it again in full.';

type ReadbackArgs = z.infer<z.ZodObject<typeof readbackInput>>;

export function accessibleReadback(args: ReadbackArgs, config: Pick<ServerConfig, 'now'>) {
  const now = config.now();
  const currency = args.currency;
  const returnPolicy =
    args.return_policy &&
    (args.return_policy.window_days !== undefined || args.return_policy.free !== undefined)
      ? { windowDays: args.return_policy.window_days, free: args.return_policy.free }
      : null;

  const lines: CartLine[] = args.items.map((it, i) => ({
    quantity: it.quantity,
    snapshot: callerSnapshot(
      {
        title: it.title,
        colour: it.colour || undefined,
        size: it.size || undefined,
        brand: it.brand || undefined,
        material: it.material || undefined,
        price: toMoney(it.unit_price, currency),
        returnPolicy,
        sellerName: args.seller,
      },
      now,
      `snap_line${i + 1}`,
    ),
  }));

  // Items are always recomputed here. Shipping and tax follow the Demo Store rules unless the
  // caller passes the amounts the store quoted.
  const rule = computeTotals(lines.map((l) => ({ price: l.snapshot.price, quantity: l.quantity })));
  const items = addMoney(...lines.map((l) => multiplyMoney(l.snapshot.price, l.quantity)));
  const shipping = args.shipping !== undefined ? toMoney(args.shipping, currency) : rule.shipping;
  const tax = args.tax !== undefined ? toMoney(args.tax, currency) : rule.tax;
  const totals = { items, shipping, tax, total: addMoney(items, shipping, tax) };

  const userId = 'mcp';
  const cart: Cart = {
    id: newId('cart'),
    userId,
    lines,
    totals,
    hash: hashCart({ userId, lines, totals }),
    createdAt: now.toISOString(),
  };
  const deliveryEstimate = args.delivery_date ? new Date(args.delivery_date) : null;
  const composed = composeReadback({
    cart,
    paymentSource: { kind: 'paypal-popup', label: args.payment_label },
    deliveryEstimate,
    locale: 'en-US',
    verbosity: args.verbosity,
    now,
  });

  return {
    text: composed.text,
    text_hash: composed.textHash,
    fields: composed.fields,
    totals: {
      items: moneyView(items),
      shipping: moneyView(shipping),
      tax: moneyView(tax),
      total: moneyView(totals.total),
    },
    totals_source: {
      shipping: args.shipping !== undefined ? ('caller' as const) : ('demo_store_rule' as const),
      tax: args.tax !== undefined ? ('caller' as const) : ('demo_store_rule' as const),
    },
    instructions: INSTRUCTIONS,
  };
}

export function registerReadback(server: McpServer, config: ServerConfig): void {
  server.registerTool(
    'accessible_readback',
    {
      title: 'Accessible pre-payment readback',
      description: [
        `Builds the exact sentence-by-sentence readback a blind or low-vision shopper must hear before paying, using ${PRODUCT_NAME}'s template.`,
        'Call this after the cart is final and before asking the user to confirm. The text is built from a fixed template and the listing facts you pass, never from model wording, and totals are recomputed here (Demo Store tax and shipping rules unless you pass the store-quoted shipping and tax).',
        'You MUST speak the returned `text` to the user verbatim, in full, before asking for confirmation: do not summarise, paraphrase, reorder or add to it. Anything the listing does not give is read as "the listing doesn\'t say"; never fill gaps yourself.',
        'Keep `text_hash`: it identifies exactly what was spoken. If the item, variant, quantity, price, shipping, tax or seller changes, the readback is void and you must call this again and read the new one.',
        'Then pass the reply to check_confirmation_phrase. See the resource sightline://readback-rules.',
      ].join(' '),
      inputSchema: readbackInput,
      outputSchema: readbackOutput,
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    },
    async (args) => {
      try {
        const out = accessibleReadback(args, config);
        return ok(
          out,
          `Speak this to the user word for word, then wait for their answer:\n\n${out.text}\n\nTotal ${out.totals.total.spoken}. text_hash ${out.text_hash}.`,
        );
      } catch (e) {
        if (e instanceof ReadbackError)
          return fail(`I could not build a truthful readback: ${e.message}. Nothing should be paid.`);
        throw e;
      }
    },
  );
}
