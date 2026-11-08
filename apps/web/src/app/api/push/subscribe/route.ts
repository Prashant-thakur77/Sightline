import { NextResponse } from 'next/server';
import { z } from 'zod';
import { eq } from 'drizzle-orm';
import { tables } from '@sightline/db';
import { db } from '@/server/runtime';
import { HttpError, requireUser } from '@/server/session';

const Sub = z.object({ endpoint: z.string().url().max(1000), keys: z.object({ p256dh: z.string().max(200), auth: z.string().max(100) }) });

export async function POST(req: Request) {
  try {
    const user = await requireUser();
    const sub = Sub.safeParse(await req.json());
    if (!sub.success || !sub.data.endpoint.startsWith('https://')) return NextResponse.json({ error: 'Bad subscription' }, { status: 400 });
    await db()
      .insert(tables.pushSubscriptions)
      .values({ endpoint: sub.data.endpoint, userId: user.id, keys: sub.data.keys })
      .onConflictDoUpdate({ target: tables.pushSubscriptions.endpoint, set: { userId: user.id, keys: sub.data.keys } });
    return NextResponse.json({ ok: true });
  } catch (e) {
    if (e instanceof HttpError) return NextResponse.json({ error: e.message }, { status: e.status });
    return NextResponse.json({ error: 'Could not save' }, { status: 500 });
  }
}

export async function DELETE(req: Request) {
  try {
    const user = await requireUser();
    const { endpoint } = (await req.json()) as { endpoint?: string };
    if (endpoint) await db().delete(tables.pushSubscriptions).where(eq(tables.pushSubscriptions.endpoint, endpoint));
    void user;
    return NextResponse.json({ ok: true });
  } catch (e) {
    if (e instanceof HttpError) return NextResponse.json({ error: e.message }, { status: e.status });
    return NextResponse.json({ error: 'Could not remove' }, { status: 500 });
  }
}
