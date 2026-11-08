import { after, NextResponse } from 'next/server';
import { ENV } from '@/server/runtime';
import { paypal } from '@/server/paypal';
import { PayPalValidationError } from '@sightline/paypal';
import { processWebhookEvent, recordWebhook, retryFailedWebhooks } from '@/server/webhooks';

export const runtime = 'nodejs';

/**
 * PayPal webhooks. The raw body is verified exactly as received, stored once per PayPal event id
 * (replays are no-ops), acknowledged immediately, and processed after the response.
 */
export async function POST(req: Request) {
  const raw = await req.text();
  if (!ENV.PAYPAL_WEBHOOK_ID) return NextResponse.json({ error: 'webhook not configured' }, { status: 503 });
  let verified: boolean;
  try {
    verified = (await paypal().webhooks.verifySignature({ rawBody: raw, headers: req.headers, webhookId: ENV.PAYPAL_WEBHOOK_ID })).verified;
  } catch (e) {
    // Missing signature headers can never verify: refuse. Anything else (PayPal unreachable, 5xx)
    // is our failure to check, so answer 503 and PayPal will deliver the event again.
    if (e instanceof PayPalValidationError) return NextResponse.json({ error: 'signature headers missing' }, { status: 400 });
    return NextResponse.json({ error: 'could not verify yet' }, { status: 503 });
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
        console.error('[webhook] processing failed; it will be retried with backoff', e);
      }
      await retryFailedWebhooks().catch(() => undefined);
    });
  return NextResponse.json({ ok: true, duplicate: rec.duplicate });
}
