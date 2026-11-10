/**
 * DEV/TEST ONLY: inserts a demo order for Maya in a chosen lifecycle state so the post-purchase
 * screens can be exercised without PayPal credentials. Refuses to run in production. Real orders
 * always come from the PayPal sandbox.
 *   pnpm --filter @sightline/db exec tsx ../../apps/web/scripts/dev-seed-order.ts [delivered|authorized] [wrong_size|correct] [userId] [held]
 * With `held`, the order carries a placeholder authorization (SEED-AUTH-…) so hold views show it.
 * Never run the maintenance sweep on such an order: PayPal does not know that id.
 */
import path from 'node:path';
process.loadEnvFile(path.resolve(import.meta.dirname, '../../../.env.local'));
import { eq } from 'drizzle-orm';
import { getDb, closeDb, tables } from '@sightline/db';
import { newId } from '@sightline/core';
import { hashCart, hashReadbackText, paypalRequestId } from '@sightline/evidence';
import { computeTotals, createDemoStore, snapshotOf } from '@sightline/catalog';
import { composeReadback } from '@sightline/agent';

if (process.env.NODE_ENV === 'production') throw new Error('dev-seed-order refuses to run in production');
const [status = 'delivered', shipped = 'wrong_size', forUser, held] = process.argv.slice(2);
const db = getDb(process.env.DATABASE_URL);
const [maya] = forUser
  ? await db.select().from(tables.users).where(eq(tables.users.id, forUser)).limit(1)
  : await db.select().from(tables.users).where(eq(tables.users.email, 'maya@demo.sightline.app')).limit(1);
if (!maya) throw new Error('Start a Maya session once first (POST /api/demo/start)');
const product = (await createDemoStore().get('demo:harbor-knit-crew', { Colour: 'navy', Size: 'M' }))!;
const snap = snapshotOf(product, { name: 'Demo Store', merchantId: process.env.PAYPAL_MERCHANT_ID || 'DEMO-STORE-UNCONFIGURED' }, new Date(), process.env.APP_URL);
await db.insert(tables.productSnapshots).values({ id: snap.id, productId: snap.productId, variantId: snap.variantId, source: snap.source, body: snap, hash: snap.hash, capturedAt: snap.capturedAt });
const lines = [{ snapshot: snap, quantity: 1 }];
const totals = computeTotals([{ price: snap.price, quantity: 1 }]);
const cart = { id: newId('crt'), userId: maya.id, lines, totals, hash: hashCart({ userId: maya.id, lines, totals }), createdAt: new Date().toISOString() };
await db.insert(tables.carts).values({ id: cart.id, userId: maya.id, body: cart, hash: cart.hash });
const rb = composeReadback({ cart, paymentSource: { kind: 'vault', label: 'your saved PayPal' }, deliveryEstimate: null, locale: 'en-US', verbosity: 'standard', now: new Date() });
const readbackId = newId('rdb');
await db.insert(tables.readbacks).values({ id: readbackId, cartId: cart.id, cartHash: cart.hash, text: rb.text, fields: rb.fields, textHash: hashReadbackText(rb.text), confirmedAt: new Date().toISOString() });
const orderId = newId('ord');
await db.insert(tables.orders).values({
  id: orderId,
  userId: maya.id,
  cartId: cart.id,
  readbackId,
  snapshotId: snap.id,
  paypalOrderId: null,
  paypalRequestId: paypalRequestId('order', cart.hash, readbackId),
  intent: 'AUTHORIZE',
  paymentSource: 'vault',
  status,
  amountCents: totals.total.cents,
  currency: 'USD',
  merchantId: snap.seller.merchantId,
  title: snap.title,
  ...(held === 'held'
    ? { authorizationId: `SEED-AUTH-${orderId.slice(-10)}`, authorizationExpiresAt: new Date(Date.now() + 29 * 86_400_000).toISOString() }
    : {}),
});
await db.insert(tables.shipments).values({ orderId, carrier: 'USPS', trackingNumber: `9400${Date.now()}`.slice(0, 22), status: 'delivered', shippedVariant: shipped, shippedAt: new Date().toISOString(), deliveredAt: new Date().toISOString() });
console.log(JSON.stringify({ orderId, status, shipped }));
await closeDb();
