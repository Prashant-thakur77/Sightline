import 'server-only';
import { eq } from 'drizzle-orm';
import { tables } from '@sightline/db';
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
