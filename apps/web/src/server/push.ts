import 'server-only';
import { sendNotification, setVapidDetails } from 'web-push';
import { eq } from 'drizzle-orm';
import { tables } from '@sightline/db';
import { PRODUCT_NAME } from '@sightline/core';
import { db, ENV, INTEGRATIONS, appUrl } from './runtime';

let configured = false;
function setup(): boolean {
  if (!INTEGRATIONS.webPush) return false;
  if (!configured) {
    setVapidDetails(appUrl().startsWith('https') ? appUrl() : 'mailto:noreply@sightline.invalid', ENV.WEB_PUSH_VAPID_PUBLIC!, ENV.WEB_PUSH_VAPID_PRIVATE!);
    configured = true;
  }
  return true;
}

export function vapidPublicKey(): string | null {
  return INTEGRATIONS.webPush ? ENV.WEB_PUSH_VAPID_PUBLIC! : null;
}

/** Best effort: send to every device this person opted in; drop subscriptions the browser revoked. */
export async function sendPush(userId: string, body: string, link?: string): Promise<void> {
  if (!setup()) return;
  const subs = await db().select().from(tables.pushSubscriptions).where(eq(tables.pushSubscriptions.userId, userId));
  for (const s of subs) {
    try {
      await sendNotification(
        { endpoint: s.endpoint, keys: s.keys as { p256dh: string; auth: string } },
        JSON.stringify({ title: PRODUCT_NAME, body, url: link ?? '/app' }),
        { TTL: 3600 },
      );
    } catch (e) {
      const status = (e as { statusCode?: number }).statusCode;
      if (status === 404 || status === 410) await db().delete(tables.pushSubscriptions).where(eq(tables.pushSubscriptions.endpoint, s.endpoint));
    }
  }
}
