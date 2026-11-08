import 'server-only';
import { eq } from 'drizzle-orm';
import { tables } from '@sightline/db';
import { paymentStatus, type StatusWord } from '@sightline/core';
import { receiptHash, verifyHashSignature, verifyReceipt } from '@sightline/evidence';
import { db } from './runtime';
import { receiptKeyPair, signingSecret } from './keys';

export interface ReceiptCheck {
  hashMatches: boolean;
  hmacValid: boolean;
  ed25519Valid: boolean | null;
  publicKey: string;
  fingerprint: string;
}

/** One key of the two-key confirmation, as the readback record stores it. */
export interface ConfirmationKey {
  source: 'phrase' | 'button' | 'classifier' | 'second_press' | string;
  at: number;
  detail?: string;
}

/** What happened to the money after the gate decided, read from the order with the receipt's PayPal-Request-Id. */
export interface ReceiptOrder {
  /** A PayPal order was created, so PayPal was called. */
  paypalOrder: boolean;
  status: string;
  payment: StatusWord;
}

export async function loadReceipt(id: string) {
  const [r] = await db().select().from(tables.receipts).where(eq(tables.receipts.id, id)).limit(1);
  if (!r) return null;
  const keys = receiptKeyPair();
  const check: ReceiptCheck = {
    hashMatches: receiptHash(r.body) === r.hash,
    hmacValid: verifyReceipt({ body: r.body, hash: r.hash, signature: r.signature }, signingSecret()).ok,
    ed25519Valid: r.ed25519 ? verifyHashSignature(r.hash, r.ed25519, keys.publicKeyHex) : null,
    publicKey: keys.publicKeyHex,
    fingerprint: keys.fingerprint,
  };
  return { receipt: r, check };
}

/**
 * The records around a gate receipt, read-only: the two confirmation keys stored on the readback
 * (they are not part of the signed body), and the order the payment created, if any.
 */
export async function receiptContext(body: { requestId?: string; input?: { readbackId?: string | null } }) {
  const readbackId = body.input?.readbackId ?? null;
  const [rb] = readbackId
    ? await db().select({ confirmation: tables.readbacks.confirmation }).from(tables.readbacks).where(eq(tables.readbacks.id, readbackId)).limit(1)
    : [];
  const keys = ((rb?.confirmation as { keys?: ConfirmationKey[] } | null)?.keys ?? []).filter((k) => k && typeof k.source === 'string');
  const [o] = body.requestId ? await db().select().from(tables.orders).where(eq(tables.orders.paypalRequestId, body.requestId)).limit(1) : [];
  const order: ReceiptOrder | null = o ? { paypalOrder: Boolean(o.paypalOrderId), status: o.status, payment: paymentStatus(o) } : null;
  return { keys, order };
}
