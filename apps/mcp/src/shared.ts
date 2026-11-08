import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import {
  formatMoney,
  parseMoney,
  toDecimalString,
  type Money,
  type ProductSnapshot,
  type ReturnPolicy,
} from '@sightline/core';
import { hashSnapshot } from '@sightline/evidence';
import { z } from 'zod';

/** "34.00", "34" or "$34.00". Parsed to integer cents, never a float. */
export const dollars = z
  .string()
  .trim()
  .regex(/^\$?\d{1,7}(\.\d{1,2})?$/, 'Use a plain amount in dollars, such as "34.00".');

export const currencyCode = z
  .string()
  .regex(/^[A-Z]{3}$/, 'Use a three-letter currency code, such as "USD".')
  .default('USD');

export function toMoney(amount: string, currency: string): Money {
  return parseMoney(amount.replace(/^\$/, ''), currency);
}

export const moneyOut = z.object({
  amount: z.string().describe('Decimal string, e.g. "36.72".'),
  currency: z.string(),
  spoken: z.string().describe('How the readback says it, e.g. "$36.72".'),
});

export function moneyView(m: Money): z.infer<typeof moneyOut> {
  return { amount: toDecimalString(m), currency: m.currency, spoken: formatMoney(m) };
}

export const isoDate = z
  .string()
  .refine((s) => !Number.isNaN(Date.parse(s)), 'Use an ISO 8601 date, such as "2026-11-17".');

/** A successful tool result: structured data for programs, a short text for the model. */
export function ok<T extends Record<string, unknown>>(structured: T, text: string): CallToolResult {
  return { content: [{ type: 'text', text }], structuredContent: structured };
}

/** A tool error the caller can read out or act on. Never a fake result. */
export function fail(text: string): CallToolResult {
  return { content: [{ type: 'text', text }], isError: true };
}

export interface ListingFacts {
  title: string;
  colour?: string;
  size?: string;
  brand?: string;
  material?: string;
  price: Money;
  returnPolicy: ReturnPolicy | null;
  sellerName: string;
  merchantId?: string;
  imageUrls?: string[];
}

/**
 * Freeze listing facts supplied by the calling agent into a snapshot, hashed the same way catalog
 * snapshots are. The source says the facts came from the caller, not from a catalog this server
 * read itself.
 */
export function callerSnapshot(f: ListingFacts, now: Date, id: string): ProductSnapshot {
  const body = {
    id,
    productId: 'caller',
    variantId:
      [f.colour && `colour=${f.colour}`, f.size && `size=${f.size}`].filter(Boolean).join(';') || 'default',
    source: 'caller' as unknown as ProductSnapshot['source'],
    title: f.title,
    brand: f.brand,
    attributes: { colour: f.colour, size: f.size, material: f.material },
    price: f.price,
    images: (f.imageUrls ?? []).map((url) => ({ url })),
    returnPolicy: f.returnPolicy,
    seller: { name: f.sellerName, merchantId: f.merchantId ?? '' },
    capturedAt: now.toISOString(),
  };
  // Drop undefined keys so the canonical body is stable.
  const clean = JSON.parse(JSON.stringify(body)) as Omit<ProductSnapshot, 'hash'>;
  return { ...clean, hash: hashSnapshot({ ...clean, hash: '' }) };
}
