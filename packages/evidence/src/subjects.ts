import type { CartLine, ProductSnapshot, Readback, Totals } from '@sightline/core';
import { CART, READBACK, READBACK_BINDING, SNAPSHOT, hashDomain, hashObject } from './hash';

/**
 * The single definition of how the commerce objects in @sightline/core are hashed.
 * Builders (catalog, readback) and checkers (gate, evidence) both call these, so a hash written
 * at one end always recomputes at the other.
 */

/** Hash of the snapshot body: every field except `hash` itself. */
export function hashSnapshot(snapshot: ProductSnapshot): string {
  const { hash: _ignored, ...body } = snapshot;
  return hashObject(SNAPSHOT, body);
}

/**
 * Cart hash: who it is for, each line's recomputed snapshot hash and quantity, and the totals.
 * The cart id is left out on purpose, so the same goods for the same person hash the same
 * across carts and the duplicate check can see a repeat purchase.
 */
export function hashCart(cart: { userId: string; lines: readonly CartLine[]; totals: Totals }): string {
  return hashObject(CART, {
    userId: cart.userId,
    lines: cart.lines.map((l) => ({ snapshotHash: hashSnapshot(l.snapshot), quantity: l.quantity })),
    totals: cart.totals,
  });
}

/** Hash of exactly what was spoken. Stored as `Readback.textHash`. */
export function hashReadbackText(text: string): string {
  return hashDomain(READBACK, text);
}

/**
 * Binds a readback to the cart it describes. Small enough to travel as the PayPal order
 * `custom_id`, and recomputable from the readback row alone.
 */
export function hashReadbackBinding(readback: Pick<Readback, 'id' | 'cartId' | 'cartHash' | 'textHash'>): string {
  return hashObject(READBACK_BINDING, {
    readbackId: readback.id,
    cartId: readback.cartId,
    cartHash: readback.cartHash,
    textHash: readback.textHash,
  });
}
