import 'server-only';
import { keyPairFromSeed, signHash, type Ed25519KeyPair } from '@sightline/evidence';
import { ENV } from './runtime';

let receiptKeys: Ed25519KeyPair | undefined;

export function signingSecret(): string {
  if (!ENV.RECEIPT_SIGNING_KEY) throw new Error('RECEIPT_SIGNING_KEY is not set');
  return ENV.RECEIPT_SIGNING_KEY;
}

/** Ed25519 key pair for receipts and evidence, derived from RECEIPT_SIGNING_KEY. */
export function receiptKeyPair(): Ed25519KeyPair {
  if (!receiptKeys) receiptKeys = keyPairFromSeed(signingSecret(), 'receipts');
  return receiptKeys;
}

export function ed25519(hash: string): string {
  return signHash(hash, receiptKeyPair());
}
