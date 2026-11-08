import { AUDIT, hashObject, isHexHash } from './hash';

/** One link of the append-only audit log. `hash` covers both the entry and the previous hash. */
export interface ChainLink<T = unknown> {
  hash: string;
  prevHash: string | null;
  entry: T;
}

export type ChainVerification =
  | { ok: true; head: string | null; length: number }
  | { ok: false; brokenAt: number; reason: 'malformed' | 'prev_hash_mismatch' | 'hash_mismatch' };

export function chainLinkHash(prevHash: string | null, entry: unknown): string {
  return hashObject(AUDIT, { prevHash, entry });
}

/** Append an entry after `prevHash` (null for the first entry). */
export function appendChain<T>(prevHash: string | null, entry: T): ChainLink<T> {
  if (prevHash !== null && !isHexHash(prevHash)) throw new Error('prevHash must be a hex SHA-256 or null');
  return { hash: chainLinkHash(prevHash, entry), prevHash, entry };
}

/**
 * Walk the chain from the start and report the first link that does not hold.
 * `anchor` is the hash the first link must point back to (null for a chain from genesis);
 * pass the stored head of an earlier segment to verify a later one.
 */
export function verifyChain(
  links: readonly ChainLink[],
  opts: { anchor?: string | null } = {},
): ChainVerification {
  let expectedPrev: string | null = opts.anchor ?? null;
  for (let i = 0; i < links.length; i++) {
    const link = links[i];
    if (!link || typeof link !== 'object' || !isHexHash(link.hash) || !('entry' in link)) {
      return { ok: false, brokenAt: i, reason: 'malformed' };
    }
    if (link.prevHash !== expectedPrev) return { ok: false, brokenAt: i, reason: 'prev_hash_mismatch' };
    let recomputed: string;
    try {
      recomputed = chainLinkHash(link.prevHash, link.entry);
    } catch {
      return { ok: false, brokenAt: i, reason: 'malformed' };
    }
    if (recomputed !== link.hash) return { ok: false, brokenAt: i, reason: 'hash_mismatch' };
    expectedPrev = link.hash;
  }
  return { ok: true, head: expectedPrev, length: links.length };
}
