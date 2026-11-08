import { sha256Bytes, utf8 } from './hash';

const BASE32_ALPHABET = 'abcdefghijklmnopqrstuvwxyz234567';

/** RFC 4648 base32, lowercase, no padding. */
export function base32Encode(bytes: Uint8Array): string {
  let out = '';
  let buffer = 0;
  let bits = 0;
  for (const byte of bytes) {
    buffer = (buffer << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += BASE32_ALPHABET[(buffer >>> (bits - 5)) & 31];
      bits -= 5;
    }
    buffer &= (1 << bits) - 1;
  }
  if (bits > 0) out += BASE32_ALPHABET[(buffer << (5 - bits)) & 31];
  return out;
}

export const PAYPAL_REQUEST_ID_KINDS = [
  'order',
  'capture',
  'authorize',
  'void',
  'reauthorize',
  'refund',
  'offer-accept',
  'dispute',
] as const;

export type PaypalRequestKind = (typeof PAYPAL_REQUEST_ID_KINDS)[number];

/** PayPal accepts up to 108 characters; 36 base32 characters carry 180 bits. */
export const PAYPAL_REQUEST_ID_LENGTH = 36;

const UNIT_SEPARATOR = 0x1f;

/**
 * Deterministic PayPal-Request-Id:
 *   base32(sha256("SIGHTLINE_<KIND>_V1" || parts joined with 0x1f)), first 36 characters.
 *
 * The same confirmation always yields the same id, so a retried or double-clicked request makes
 * PayPal return the original order instead of creating a second one. Parts may not contain
 * 0x1f, otherwise ["a\x1fb"] and ["a", "b"] would collide.
 */
export function paypalRequestId(kind: PaypalRequestKind, ...parts: string[]): string {
  if (!(PAYPAL_REQUEST_ID_KINDS as readonly string[]).includes(kind)) {
    throw new Error(`Unknown PayPal request kind: ${String(kind)}`);
  }
  if (parts.length === 0) throw new Error('paypalRequestId needs at least one part');
  for (const p of parts) {
    if (typeof p !== 'string') throw new Error('paypalRequestId parts must be strings');
    if (p.includes('\u001f')) throw new Error('paypalRequestId parts may not contain 0x1f');
  }
  const tag = utf8(`SIGHTLINE_${kind.toUpperCase().replace(/-/g, '_')}_V1`);
  const chunks: Uint8Array[] = [tag];
  parts.forEach((p, i) => {
    if (i > 0) chunks.push(Uint8Array.of(UNIT_SEPARATOR));
    chunks.push(utf8(p));
  });
  return base32Encode(sha256Bytes(...chunks)).slice(0, PAYPAL_REQUEST_ID_LENGTH);
}
