import { NextResponse } from 'next/server';
import { receiptKeyPair } from '@/server/keys';

/** Public key for checking receipt and evidence signatures offline. */
export function GET() {
  const k = receiptKeyPair();
  return NextResponse.json({ alg: 'Ed25519', use: 'receipts and evidence packs', publicKey: k.publicKeyHex, fingerprint: k.fingerprint });
}
