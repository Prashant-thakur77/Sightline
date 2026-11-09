import { eq } from 'drizzle-orm';
import { tables } from '@sightline/db';
import { requireUser } from '@/server/session';
import { db } from '@/server/runtime';
import { SettingsForm } from './settings-form';
import { PushOptIn } from '@/components/a11y/push-optin';
import { vapidPublicKey } from '@/server/push';
import { photoSummary, PHOTO_RETENTION_DAYS } from '@/server/privacy';
import { DataControls } from './data-controls';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Settings' };

export default async function Settings() {
  const user = await requireUser();
  const [p] = await db().select().from(tables.preferences).where(eq(tables.preferences.userId, user.id)).limit(1);
  const [helper] = await db().select().from(tables.helpers).where(eq(tables.helpers.userId, user.id)).limit(1);
  const photos = await photoSummary(user.id);
  return (
    <div className="grid gap-8 max-w-[760px]">
      <header className="grid gap-2">
        <h1 className="text-[length:var(--step-4)]">Settings</h1>
        <p className="text-[length:var(--step-1)]">
          Every setting is optional. Preferences are saved when you press Save settings. Notifications and Your data work on their own, straight away.
        </p>
      </header>
      <SettingsForm
        initial={{
          verbosity: p!.verbosity,
          voiceMode: p!.voiceMode,
          speechRate: p!.speechRate,
          sizes: p!.sizes as Record<string, string>,
          avoidColours: p!.avoidColours.join(', '),
          perOrderCap: p!.perOrderCapCents / 100,
          dailyCap: p!.dailyCapCents / 100,
          payAfterCheck: p!.payAfterCheck,
          lowVision: p!.lowVision,
        }}
        helperName={helper?.name ?? null}
      />
      {/* A named region with a heading, not also a fieldset with a legend, so its name is said once. */}
      <section aria-labelledby="notify-h" className="settings settings-box">
        <h2 id="notify-h" className="settings-h">
          Notifications
        </h2>
        <p className="hint">Parcel arrived, refund landed, helper answered. Short and plain. You can stop them any time.</p>
        <p className="hint">This button works on its own, straight away. Save settings doesn’t change it.</p>
        <PushOptIn vapidKey={vapidPublicKey()} />
      </section>
      <DataControls photoCount={photos.total} neededByCase={photos.needed} retentionDays={PHOTO_RETENTION_DAYS} />
    </div>
  );
}
