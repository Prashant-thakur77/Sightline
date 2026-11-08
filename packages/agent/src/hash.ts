/**
 * The one place the agent package reaches into @sightline/evidence for hashing, so the readback
 * hash always matches what the payment gate recomputes.
 *
 * textHash covers exactly what was spoken: hashReadbackText(text) = hashDomain(READBACK, text).
 * Binding the readback to its cart is the gate's job (hashReadbackBinding over id, cartId,
 * cartHash and textHash), and the cart hash itself comes from hashCart.
 */
export { hashCart, hashReadbackBinding, hashReadbackText } from '@sightline/evidence';
