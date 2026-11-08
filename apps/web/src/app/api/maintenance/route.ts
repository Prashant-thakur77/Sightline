import { NextResponse } from 'next/server';
import { timingSafeEqual } from 'node:crypto';
import { ENV } from '@/server/runtime';
import { sweepHolds } from '@/server/holds';
import { purgeExpiredPhotos } from '@/server/privacy';
import { retryFailedWebhooks } from '@/server/webhooks';

export const runtime = 'nodejs';

function authorized(req: Request): boolean {
  const token = ENV.MAINTENANCE_TOKEN;
  if (!token) return false;
  const got = Buffer.from(req.headers.get('authorization') ?? '');
  const want = Buffer.from(`Bearer ${token}`);
  return got.length === want.length && timingSafeEqual(got, want);
}

/**
 * Scheduled upkeep (render.yaml cron, every 15 minutes): payment-hold deadlines, photo retention
 * and webhook retries. Each step is idempotent; the response lists what each one did.
 */
export async function POST(req: Request) {
  if (!ENV.MAINTENANCE_TOKEN) return NextResponse.json({ error: 'maintenance is not configured' }, { status: 503 });
  if (!authorized(req)) return NextResponse.json({ error: 'not allowed' }, { status: 401 });
  const now = new Date();
  const holds = await sweepHolds(now).catch((e: Error) => ({ error: e.message }));
  const photos = await purgeExpiredPhotos(now).catch((e: Error) => ({ error: e.message }));
  const webhooks = await retryFailedWebhooks()
    .then(() => 'ok')
    .catch((e: Error) => ({ error: e.message }));
  return NextResponse.json({ at: now.toISOString(), holds, photosDeleted: photos, webhooks });
}
