import { hashCart, hashReadbackText } from '@sightline/evidence';
import { fail, pass, timeOf } from '../guard';
import type { Guard, GuardContext, GuardResult } from '../types';

/**
 * The user heard this exact cart and said yes to it, with both confirmation keys, in time.
 *
 * Hashes are recomputed rather than trusted: the cart hash from the cart's contents and the
 * readback text hash from the text, so editing either after the readback breaks the binding.
 * The window is measured from the readback to the recorded confirmation; when the user said
 * "wait" (`holdOpen`) there is no limit on that stretch. The confirmation must also be recent
 * at decision time, so an old "yes" cannot be replayed later.
 */
export class ReadbackBindingGuard implements Guard {
  readonly name = 'ReadbackBindingGuard';

  async run({ intent, opts }: GuardContext): Promise<GuardResult> {
    const { cart, readback: rb } = intent;
    if (!rb) return fail(this.name, 'READBACK_MISSING', 'No readback for this payment');

    if (typeof rb.text !== 'string' || hashReadbackText(rb.text) !== rb.textHash) {
      return fail(this.name, 'READBACK_TAMPERED', 'Readback text does not match its hash', { readbackId: rb.id });
    }

    let recomputed: string;
    try {
      recomputed = hashCart(cart);
    } catch {
      return fail(this.name, 'CART_TAMPERED', 'Cart cannot be hashed', { cartId: cart?.id ?? null });
    }
    if (recomputed !== cart.hash) {
      return fail(this.name, 'CART_TAMPERED', 'Cart contents do not match the cart hash', { cartId: cart.id });
    }
    if (cart.userId !== intent.userId) {
      return fail(this.name, 'USER_MISMATCH', 'Cart belongs to another user', { cartId: cart.id });
    }
    if (rb.cartId !== cart.id || rb.cartHash !== cart.hash) {
      return fail(this.name, 'READBACK_CART_MISMATCH', 'The readback was for a different cart', {
        readbackId: rb.id,
        readbackCartHash: rb.cartHash,
        cartHash: cart.hash,
      });
    }

    const c = rb.confirmation;
    if (!c || !rb.confirmedAt || (c.phraseMatched !== true && c.classifierAgreed !== true)) {
      return fail(this.name, 'NOT_CONFIRMED', 'The readback has not been confirmed', { readbackId: rb.id });
    }
    if (c.phraseMatched !== true || c.classifierAgreed !== true) {
      return fail(this.name, 'SINGLE_KEY_CONFIRMATION', 'Only one confirmation key agreed', {
        phraseMatched: c.phraseMatched === true,
        classifierAgreed: c.classifierAgreed === true,
      });
    }

    const readAt = timeOf(rb.createdAt);
    const heardAt = timeOf(c.at);
    const confirmedAt = timeOf(rb.confirmedAt);
    const now = intent.now.getTime();
    if (
      readAt === null ||
      heardAt === null ||
      confirmedAt === null ||
      !(readAt <= heardAt && heardAt <= confirmedAt && confirmedAt <= now)
    ) {
      return fail(this.name, 'CONFIRMATION_OUT_OF_ORDER', 'Confirmation times are not after the readback', {
        readbackAt: rb.createdAt ?? null,
        heardAt: c.at ?? null,
        confirmedAt: rb.confirmedAt,
      });
    }

    const holdOpen = rb.holdOpen === true;
    const thinkingMs = confirmedAt - readAt;
    if (!holdOpen && thinkingMs > opts.confirmWindowMs) {
      return fail(this.name, 'CONFIRMATION_EXPIRED', 'Confirmed too long after the readback', {
        elapsedMs: thinkingMs,
        windowMs: opts.confirmWindowMs,
      });
    }
    const sinceConfirmMs = now - confirmedAt;
    if (sinceConfirmMs > opts.confirmWindowMs) {
      return fail(this.name, 'CONFIRMATION_EXPIRED', 'The confirmation is too old to act on', {
        elapsedMs: sinceConfirmMs,
        windowMs: opts.confirmWindowMs,
      });
    }

    return pass(this.name, 'Readback bound to this cart and confirmed with both keys', {
      readbackId: rb.id,
      cartHash: cart.hash,
      holdOpen,
    });
  }
}
