import { desc } from 'drizzle-orm';
import { tables } from '@sightline/db';
import { db } from './runtime';

/** One PayPal webhook as the judge page shows it: what PayPal said and whether its signature checked out. Never the payload. */
export type WebhookRow = { type: string; words: string; signatureOk: boolean; processed: boolean; at: string };

const WORDS: Record<string, string> = {
  'PAYMENT.AUTHORIZATION.CREATED': 'PayPal put the money on hold',
  'PAYMENT.AUTHORIZATION.VOIDED': 'PayPal released the hold',
  'PAYMENT.CAPTURE.COMPLETED': 'PayPal paid the store',
  'PAYMENT.CAPTURE.PENDING': 'PayPal is still processing a payment',
  'PAYMENT.CAPTURE.DENIED': 'PayPal declined a payment',
  'PAYMENT.CAPTURE.DECLINED': 'PayPal declined a payment',
  'PAYMENT.CAPTURE.REFUNDED': 'PayPal refunded the buyer',
  'PAYMENT.CAPTURE.REVERSED': 'PayPal reversed a payment',
  'CHECKOUT.ORDER.APPROVED': 'The buyer approved the order in PayPal',
  'CHECKOUT.ORDER.COMPLETED': 'PayPal completed the order',
  'CUSTOMER.DISPUTE.CREATED': 'A PayPal dispute was opened',
  'CUSTOMER.DISPUTE.UPDATED': 'A PayPal dispute changed',
  'CUSTOMER.DISPUTE.RESOLVED': 'A PayPal dispute was resolved',
  'VAULT.PAYMENT-TOKEN.CREATED': 'PayPal saved the buyer’s payment method',
  'VAULT.PAYMENT-TOKEN.DELETED': 'PayPal removed a saved payment method',
};

/** Plain words for a PayPal event type; unknown types are shown as PayPal names them. */
export function webhookWords(type: string): string {
  return WORDS[type] ?? type;
}

/** The newest webhooks this server received, newest first, sanitised: type, words, signature result, time. */
export async function recentWebhooks(limit = 10): Promise<WebhookRow[]> {
  const rows = await db()
    .select({ type: tables.webhookEvents.type, signatureOk: tables.webhookEvents.signatureOk, processedAt: tables.webhookEvents.processedAt, receivedAt: tables.webhookEvents.receivedAt })
    .from(tables.webhookEvents)
    .orderBy(desc(tables.webhookEvents.receivedAt))
    .limit(limit);
  return rows.map((r) => ({
    type: r.type,
    words: webhookWords(r.type),
    signatureOk: r.signatureOk,
    processed: r.processedAt != null,
    at: new Date(r.receivedAt as unknown as string).toISOString(),
  }));
}
