import { NextResponse } from 'next/server';
import { eq } from 'drizzle-orm';
import { tables } from '@sightline/db';
import { newId, type Verdict } from '@sightline/core';
import { requireUser, HttpError } from '@/server/session';
import { orderForUser } from '@/server/orders-read';
import { PHOTO_TOO_LARGE_SAY, PhotoTooLargeError, putBlob, sanitisePhoto, UNREADABLE_PHOTO_SAY, UnreadablePhotoError } from '@/server/blobs';
import { recheckDelivery, VisionRefusedError, VisionUnavailableError } from '@/server/vision';
import { db } from '@/server/runtime';
import { audit } from '@/server/audit';
import { afterVerdict } from '@/server/after-check';
import { retakeAllowed } from '@/server/retake';

export const runtime = 'nodejs';
export const maxDuration = 60;

const SOURCES = new Set(['camera', 'upload', 'demo']);

/**
 * The ONE extra photo a "not sure" check asked for. Which photo it is, and the first check's
 * module outputs, come from the stored check on this server; the browser sends only the photo.
 */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const user = await requireUser();
    const { id } = await ctx.params;
    const found = await orderForUser(id, user.id);
    if (!found || !found.snapshot) return NextResponse.json({ error: 'Order not found.' }, { status: 404 });
    const ver = found.verification;
    const allowed = retakeAllowed(ver);
    if (!allowed.ok) return NextResponse.json({ error: allowed.say }, { status: 409 });
    const form = await req.formData();
    const file = form.get('retake');
    if (!(file instanceof File) || file.size === 0)
      return NextResponse.json({ error: 'I didn’t get the extra photo. Take it again, then send it.' }, { status: 400 });
    let bytes: Buffer;
    try {
      bytes = await sanitisePhoto(Buffer.from(await file.arrayBuffer()));
    } catch (e) {
      if (e instanceof UnreadablePhotoError) return NextResponse.json({ error: UNREADABLE_PHOTO_SAY }, { status: 422 });
      if (e instanceof PhotoTooLargeError) return NextResponse.json({ error: PHOTO_TOO_LARGE_SAY }, { status: 413 });
      throw e;
    }
    const blob = await putBlob(bytes, 'image/jpeg', user.id);
    const source = String(form.get('retake-source') ?? '');
    const retakePhoto = { kind: 'retake', retakeKind: allowed.retake.kind, blobId: blob.id, sha256: blob.sha256, ...(SOURCES.has(source) ? { source } : {}) };
    const verificationId = newId('ver');
    await db()
      .insert(tables.verifications)
      .values({ id: verificationId, orderId: id, status: 'analysing', photos: [...allowed.photos, retakePhoto] });
    await audit({
      userId: user.id,
      actor: 'user',
      action: 'check.retake_sent',
      subjectId: id,
      payload: { verificationId, after: allowed.verificationId, kind: allowed.retake.kind, sha256: blob.sha256 },
    });

    let result;
    try {
      result = await recheckDelivery({ snapshot: found.snapshot, previousModules: allowed.modules, kind: allowed.retake.kind, photo: bytes });
    } catch (e) {
      await db().update(tables.verifications).set({ status: 'failed', moduleOutputs: { error: (e as Error).message } }).where(eq(tables.verifications.id, verificationId));
      if (e instanceof VisionRefusedError)
        return NextResponse.json({ error: 'The checker couldn’t use this photo. Take it again. Nothing about your payment changed.' }, { status: 422 });
      const msg =
        e instanceof VisionUnavailableError
          ? 'The checker is not reachable right now. Your photo is saved. Nothing about your payment changed. Try again in a minute.'
          : 'Something went wrong while checking. Nothing about your payment changed.';
      return NextResponse.json({ error: msg }, { status: 503 });
    }
    await db()
      .update(tables.verifications)
      .set({ status: result.verdict.kind, verdict: result.verdict, moduleOutputs: { modules: result.modules, timings_ms: result.timings_ms }, updatedAt: new Date().toISOString() })
      .where(eq(tables.verifications.id, verificationId));
    await audit({
      userId: user.id,
      actor: 'agent',
      action: 'check.verdict',
      subjectId: id,
      payload: { verificationId, looks: 2, kind: result.verdict.kind, reasons: result.verdict.reasons.map((r) => [r.module, r.finding, r.confidence]) },
    });
    const next = await afterVerdict({ userId: user.id, orderId: id, verificationId, verdict: result.verdict as Verdict });
    const item = allowed.photos.find((p) => p.kind === 'item');
    return NextResponse.json({ verificationId, verdict: result.verdict, next, itemPhoto: item ? `/api/blobs/${item.blobId}` : undefined });
  } catch (e) {
    if (e instanceof HttpError) return NextResponse.json({ error: e.message }, { status: e.status });
    return NextResponse.json({ error: 'Something went wrong. Nothing about your payment changed.' }, { status: 500 });
  }
}
