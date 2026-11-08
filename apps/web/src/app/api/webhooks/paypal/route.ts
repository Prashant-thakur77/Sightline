import { after, NextResponse } from 'next/server';
import { ENV } from '@/server/runtime';
import { paypal } from '@/server/paypal';
import { processWebhookEvent, recordWebhook } from '@/server/webhooks';

export const runtime = 'nodejs';

/**
 * PayPal webhooks. The raw body is verified exactly as received, stored once per PayPal event id
 * (replays are no-ops), acknowledged immediately, and processed after the response.
 */
export async function POST(req: Request) {
  const raw = await req.text();
  if (!ENV.PAYPAL_WEBHOOK_ID) return NextResponse.json({ error: 'webhook not configured' }, { status: 503 });
  let verified = false;
  try {
    const result = await paypal().webhooks.verifySignature({ rawBody: raw, headers: req.headers, webhookId: ENV.PAYPAL_WEBHOOK_ID });
    verified = result.verified;
  } catch {
    verified = false;
  }
  if (!verified) return NextResponse.json({ error: 'signature not verified' }, { status: 400 });
  let rec;
  try {
    rec = await recordWebhook(raw, true);
  } catch {
    return NextResponse.json({ error: 'malformed event' }, { status: 400 });
  }
  if (!rec.duplicate)
    after(async () => {
      try {
        await processWebhookEvent(rec.id);
      } catch (e) {
        console.error('[webhook] processing failed; will retry from the replay tool', e);
      }
    });
  return NextResponse.json({ ok: true, duplicate: rec.duplicate });
}
