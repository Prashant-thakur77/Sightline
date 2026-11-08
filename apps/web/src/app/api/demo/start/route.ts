import { after, NextResponse } from 'next/server';
import { ensurePersona, type PersonaKey } from '@/server/personas';
import { createSession } from '@/server/session';
import { maybePurgeExpiredPhotos } from '@/server/privacy';

/** Starts a demo session as a seeded persona. Demo personas only; no real accounts. */
export async function POST(req: Request) {
  const body = (await req.json().catch(() => ({}))) as { persona?: string };
  const key = (body.persona ?? 'maya') as PersonaKey;
  if (key !== 'maya' && key !== 'raj') return NextResponse.json({ error: 'Unknown persona' }, { status: 400 });
  const userId = await ensurePersona(key);
  await createSession(userId);
  // Photo retention runs here at most once an hour, after the response is sent.
  after(() => maybePurgeExpiredPhotos().catch(() => undefined));
  return NextResponse.json({ ok: true, userId });
}
