import { NextResponse } from 'next/server';
import { ENV } from '@/server/runtime';
import { currentUser } from '@/server/session';

export const dynamic = 'force-dynamic';

/**
 * Speech-to-text for the browser. With a Deepgram key, mints a short-lived token so the key
 * never reaches the browser; otherwise tells the client to use the browser's own recognition.
 */
export async function POST() {
  if (!ENV.DEEPGRAM_API_KEY) return NextResponse.json({ engine: 'browser' });
  const user = await currentUser();
  if (!user) return NextResponse.json({ engine: 'browser' });
  try {
    const res = await fetch('https://api.deepgram.com/v1/auth/grant', {
      method: 'POST',
      headers: { Authorization: `Token ${ENV.DEEPGRAM_API_KEY}`, 'content-type': 'application/json' },
      body: JSON.stringify({ ttl_seconds: 60 }),
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) return NextResponse.json({ engine: 'browser' });
    const j = (await res.json()) as { access_token?: string };
    if (!j.access_token) return NextResponse.json({ engine: 'browser' });
    const params = new URLSearchParams({ model: 'nova-3', language: 'en-US', smart_format: 'true', interim_results: 'true', endpointing: '300', punctuate: 'true' });
    return NextResponse.json({ engine: 'deepgram', token: j.access_token, url: `wss://api.deepgram.com/v1/listen?${params}` });
  } catch {
    return NextResponse.json({ engine: 'browser' });
  }
}
