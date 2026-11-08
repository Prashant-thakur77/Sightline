import { createHash } from 'node:crypto';
import { canonicalJson } from './canonical';

/**
 * Domain separation: a snapshot hash must never equal a receipt hash, even when the two happen
 * to serialise to identical bytes. Every hash Sightline stores is produced here.
 */
export const DOMAIN = {
  SNAPSHOT: 'snapshot',
  CART: 'cart',
  READBACK: 'readback',
  READBACK_BINDING: 'readback-binding',
  RECEIPT: 'receipt',
  AUDIT: 'audit',
  EVIDENCE_MANIFEST: 'evidence-manifest',
  EVIDENCE_FILE: 'evidence-file',
  PHOTO: 'photo',
  WEBHOOK: 'webhook',
} as const;

export const {
  SNAPSHOT,
  CART,
  READBACK,
  READBACK_BINDING,
  RECEIPT,
  AUDIT,
  EVIDENCE_MANIFEST,
  EVIDENCE_FILE,
  PHOTO,
  WEBHOOK,
} = DOMAIN;

export type HashDomain = (typeof DOMAIN)[keyof typeof DOMAIN];

export const DOMAIN_PREFIX = 'SIGHTLINE/v1/';

const DOMAIN_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const encoder = new TextEncoder();

export function utf8(s: string): Uint8Array {
  return encoder.encode(s);
}

/**
 * The bytes that precede the payload: a 4-byte big-endian length, the tag
 * `SIGHTLINE/v1/<domain>`, then 0x00. The length prefix makes the tag unambiguous on its own;
 * the 0x00 keeps the boundary visible in hex dumps.
 */
export function domainPrefix(domain: string): Uint8Array {
  if (!DOMAIN_PATTERN.test(domain)) throw new Error(`Invalid hash domain: "${domain}"`);
  const tag = utf8(`${DOMAIN_PREFIX}${domain}`);
  const out = new Uint8Array(4 + tag.length + 1);
  new DataView(out.buffer).setUint32(0, tag.length, false);
  out.set(tag, 4);
  out[4 + tag.length] = 0x00;
  return out;
}

/** Domain-separated SHA-256, lowercase hex. Strings are hashed as UTF-8. */
export function hashDomain(domain: string, data: string | Uint8Array): string {
  const bytes = typeof data === 'string' ? utf8(data) : data;
  return createHash('sha256').update(domainPrefix(domain)).update(bytes).digest('hex');
}

/** Canonicalise (RFC 8785 subset) then domain-separated hash. */
export function hashObject(domain: string, obj: unknown): string {
  return hashDomain(domain, canonicalJson(obj));
}

/** Plain SHA-256 bytes. Exposed for derived identifiers that are not stored hashes. */
export function sha256Bytes(...chunks: Uint8Array[]): Uint8Array {
  const h = createHash('sha256');
  for (const c of chunks) h.update(c);
  return new Uint8Array(h.digest());
}

export const HEX_HASH = /^[0-9a-f]{64}$/;

export function isHexHash(v: unknown): v is string {
  return typeof v === 'string' && HEX_HASH.test(v);
}
