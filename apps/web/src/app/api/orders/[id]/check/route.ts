import { NextResponse } from 'next/server';
import { eq } from 'drizzle-orm';
import { tables } from '@sightline/db';
import { newId } from '@sightline/core';
import { requireUser, HttpError } from '@/server/session';
import { orderForUser } from '@/server/orders-read';
import { putBlob, sanitisePhoto } from '@/server/blobs';
import { verifyDelivery, VisionRefusedError, VisionUnavailableError } from '@/server/vision';
import { db } from '@/server/runtime';
import { audit } from '@/server/audit';
import { afterVerdict } from '@/server/after-check';

export const runtime = 'nodejs';
export const maxDuration = 60;

const KINDS = ['item', 'label', 'damage'] as const;
const SOURCES = new Set(['camera', 'upload', 'demo']);

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const user = await requireUser();
    const { id } = await ctx.params;
    const found = await orderForUser(id, user.id);
    if (!found || !found.snapshot) return NextResponse.json({ error: 'Order not found.' }, { status: 404 });
    const form = await req.formData();
    // The check compares what arrived against the listing, so the whole item is needed; the size
    // tag and damage photos are optional. Refused before anything is stored.
    const item = form.get('item');
    if (!(item instanceof File) || item.size === 0)
      return NextResponse.json({ error: 'I need a photo of the whole item to check it. Add one, then check again.' }, { status: 400 });
    const photos: { kind: (typeof KINDS)[number]; bytes: Buffer; blobId: string; sha256: string; source?: string }[] = [];
    for (const kind of KINDS) {
      const f = form.get(kind);
      if (!(f instanceof File) || f.size === 0) continue;
      const clean = await sanitisePhoto(Buffer.from(await f.arrayBuffer()), f.type || 'image/jpeg');
      const blob = await putBlob(clean, 'image/jpeg', user.id);
      // Where the page says the photo came from (camera, an added file, or the demo parcel photos),
      // so a demo photo is never presented as the buyer's or shown to a helper as theirs.
      const source = String(form.get(`${kind}-source`) ?? '');
      photos.push({ kind, bytes: clean, blobId: blob.id, sha256: blob.sha256, ...(SOURCES.has(source) ? { source } : {}) });
    }
    if (photos.length === 0) return NextResponse.json({ error: 'No photos were received.' }, { status: 400 });

    const verificationId = newId('ver');
    await db()
      .insert(tables.verifications)
      .values({
        id: verificationId,
        orderId: id,
        status: 'analysing',
        photos: photos.map((p) => ({ kind: p.kind, blobId: p.blobId, sha256: p.sha256, ...(p.source ? { source: p.source } : {}) })),
      });
    await audit({ userId: user.id, actor: 'user', action: 'check.photos_sent', subjectId: id, payload: { verificationId, photos: photos.map((p) => ({ kind: p.kind, sha256: p.sha256 })) } });

    let result;
    try {
      result = await verifyDelivery({ snapshot: found.snapshot, photos });
    } catch (e) {
      await db().update(tables.verifications).set({ status: 'failed', moduleOutputs: { error: (e as Error).message } }).where(eq(tables.verifications.id, verificationId));
      if (e instanceof VisionRefusedError)
        return NextResponse.json(
          { error: 'The checker couldn’t use these photos. Retake them, with the whole item in the first one. Nothing about your payment changed.' },
          { status: 422 },
        );
      const msg =
        e instanceof VisionUnavailableError
          ? 'The checker is not reachable right now. Your photos are saved. Nothing about your payment changed. Try again in a minute.'
          : 'Something went wrong while checking. Nothing about your payment changed.';
      return NextResponse.json({ error: msg }, { status: 503 });
    }
    await db()
      .update(tables.verifications)
      .set({ status: result.verdict.kind, verdict: result.verdict, moduleOutputs: { modules: result.modules, timings_ms: result.timings_ms }, updatedAt: new Date().toISOString() })
      .where(eq(tables.verifications.id, verificationId));
    await audit({ userId: user.id, actor: 'agent', action: 'check.verdict', subjectId: id, payload: { verificationId, kind: result.verdict.kind, reasons: result.verdict.reasons.map((r) => [r.module, r.finding, r.confidence]) } });
    const next = await afterVerdict({ userId: user.id, orderId: id, verificationId, verdict: result.verdict });
    return NextResponse.json({ verificationId, verdict: result.verdict, next, itemPhoto: `/api/blobs/${photos.find((p) => p.kind === 'item')?.blobId ?? photos[0]!.blobId}` });
  } catch (e) {
    if (e instanceof HttpError) return NextResponse.json({ error: e.message }, { status: e.status });
    return NextResponse.json({ error: 'Something went wrong. Nothing about your payment changed.' }, { status: 500 });
  }
}
