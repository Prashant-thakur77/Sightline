import 'server-only';
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { and, desc, eq, isNull } from 'drizzle-orm';
import { tables } from '@sightline/db';
import { newId, type ProductSnapshot, type Verdict } from '@sightline/core';
import { db, ENV, appUrl } from './runtime';
import { audit } from './audit';
import { notify } from './cases';

const TTL_MS = 48 * 60 * 60 * 1000;

function secret(): string {
  if (!ENV.HELPER_LINK_SECRET) throw new Error('HELPER_LINK_SECRET is not set');
  return ENV.HELPER_LINK_SECRET;
}

function mac(id: string, nonce: string): string {
  return createHmac('sha256', secret()).update(`${id}.${nonce}`).digest('base64url').slice(0, 32);
}

/** Token = request id + nonce + MAC. Only a hash of the token is stored. */
function tokenFor(id: string): { token: string; hash: string } {
  const nonce = randomBytes(9).toString('base64url');
  const token = `${id}.${nonce}.${mac(id, nonce)}`;
  return { token, hash: createHmac('sha256', secret()).update(token).digest('hex') };
}

function parseToken(token: string): { id: string; hash: string } | null {
  const [id, nonce, sig] = token.split('.');
  if (!id || !nonce || !sig) return null;
  const expected = Buffer.from(mac(id, nonce));
  const got = Buffer.from(sig);
  if (expected.length !== got.length || !timingSafeEqual(expected, got)) return null;
  return { id, hash: createHmac('sha256', secret()).update(token).digest('hex') };
}

export async function createHelperRequest(userId: string, orderId: string): Promise<{ link: string; helperName: string }> {
  const [o] = await db().select().from(tables.orders).where(and(eq(tables.orders.id, orderId), eq(tables.orders.userId, userId))).limit(1);
  if (!o) throw new Error('Order not found');
  const [ver] = await db().select().from(tables.verifications).where(eq(tables.verifications.orderId, orderId)).orderBy(desc(tables.verifications.createdAt)).limit(1);
  if (!ver) throw new Error('Check the parcel first');
  const [helper] = await db().select().from(tables.helpers).where(eq(tables.helpers.userId, userId)).limit(1);
  if (!helper) throw new Error('No trusted helper is set up');
  const [snap] = await db().select().from(tables.productSnapshots).where(eq(tables.productSnapshots.id, o.snapshotId)).limit(1);
  const s = snap!.body as ProductSnapshot;
  const id = newId('hlq');
  const { token, hash } = tokenFor(id);
  const question = `Does this look like the ${s.title}${s.attributes.colour ? ` in ${s.attributes.colour}` : ''}, size ${s.attributes.size ?? 'as listed'}?`.replace(/\s+/g, ' ');
  await db().insert(tables.helperRequests).values({ id, verificationId: ver.id, helperId: helper.id, question, tokenHash: hash, expiresAt: new Date(Date.now() + TTL_MS).toISOString() });
  await audit({ userId, actor: 'user', action: 'helper.asked', subjectId: orderId, payload: { helperRequestId: id, helper: helper.name } });
  return { link: `${appUrl()}/helper/${token}`, helperName: helper.name };
}

export async function resolveHelperToken(token: string) {
  const parsed = parseToken(token);
  if (!parsed) return null;
  const [req] = await db().select().from(tables.helperRequests).where(eq(tables.helperRequests.id, parsed.id)).limit(1);
  if (!req || req.tokenHash !== parsed.hash || req.revokedAt || Date.parse(req.expiresAt) < Date.now()) return null;
  const [ver] = await db().select().from(tables.verifications).where(eq(tables.verifications.id, req.verificationId)).limit(1);
  const [o] = await db().select().from(tables.orders).where(eq(tables.orders.id, ver!.orderId)).limit(1);
  const [snap] = await db().select().from(tables.productSnapshots).where(eq(tables.productSnapshots.id, o!.snapshotId)).limit(1);
  const [buyer] = await db().select({ name: tables.users.displayName }).from(tables.users).where(eq(tables.users.id, o!.userId)).limit(1);
  // Deliberately no amounts, payee or payment ids: the helper sees only what is needed to answer.
  return {
    request: req,
    buyerName: buyer?.name ?? 'Your friend',
    snapshot: snap!.body as ProductSnapshot,
    verdict: ver!.verdict as Verdict | null,
    photos: ver!.photos,
    orderId: o!.id,
    userId: o!.userId,
  };
}

export async function answerHelper(token: string, answer: 'matches' | 'different' | 'cant_tell', note: string) {
  const r = await resolveHelperToken(token);
  if (!r) throw new Error('This link has expired or was cancelled.');
  if (r.request.answeredAt) return { already: true };
  const at = new Date().toISOString();
  await db().update(tables.helperRequests).set({ answer: { answer, note: note.slice(0, 500) }, answeredAt: at }).where(eq(tables.helperRequests.id, r.request.id));
  await db().update(tables.verifications).set({ helperAnswer: { answer, note: note.slice(0, 500), at }, updatedAt: at }).where(eq(tables.verifications.id, r.request.verificationId));
  const words = answer === 'matches' ? 'thinks it matches what you ordered' : answer === 'different' ? 'thinks it is not what you ordered' : "couldn't tell from the photos";
  const [h] = r.request.helperId
    ? await db().select({ name: tables.helpers.name }).from(tables.helpers).where(eq(tables.helpers.id, r.request.helperId)).limit(1)
    : [];
  // The note ends with exactly one full stop inside the quotes, whatever the helper typed.
  const said = note.trim() ? ` They said: “${note.trim().slice(0, 200).replace(/[.!?…]+$/, '')}.”` : '';
  await notify(
    r.userId,
    'helper',
    `${h?.name ?? 'Your helper'} ${words}.${said} Nothing about your payment has changed; you decide what happens next.`,
    `/app/orders/${r.orderId}`,
  );
  await audit({ userId: r.userId, actor: 'helper', action: 'helper.answered', subjectId: r.orderId, payload: { answer } });
  return { already: false };
}

/** Cancel every open helper link for this order. */
export async function revokeHelperLinks(userId: string, orderId: string): Promise<number> {
  const [o] = await db().select({ id: tables.orders.id }).from(tables.orders).where(and(eq(tables.orders.id, orderId), eq(tables.orders.userId, userId))).limit(1);
  if (!o) throw new Error('Order not found');
  const vers = await db().select({ id: tables.verifications.id }).from(tables.verifications).where(eq(tables.verifications.orderId, orderId));
  let n = 0;
  for (const v of vers) {
    const res = await db()
      .update(tables.helperRequests)
      .set({ revokedAt: new Date().toISOString() })
      .where(and(eq(tables.helperRequests.verificationId, v.id), isNull(tables.helperRequests.revokedAt)))
      .returning({ id: tables.helperRequests.id });
    n += res.length;
  }
  await audit({ userId, actor: 'user', action: 'helper.revoked', subjectId: orderId, payload: { links: n } });
  return n;
}
