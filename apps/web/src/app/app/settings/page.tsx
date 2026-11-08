import { eq } from 'drizzle-orm';
import { tables } from '@sightline/db';
import { requireUser } from '@/server/session';
import { db } from '@/server/runtime';
import { SettingsForm } from './settings-form';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Settings' };

export default async function Settings() {
  const user = await requireUser();
  const [p] = await db().select().from(tables.preferences).where(eq(tables.preferences.userId, user.id)).limit(1);
  const [helper] = await db().select().from(tables.helpers).where(eq(tables.helpers.userId, user.id)).limit(1);
  return (
    <div className="grid gap-8 max-w-[760px]">
      <header className="grid gap-2">
        <h1 className="text-[length:var(--step-4)]">Settings</h1>
        <p className="text-[length:var(--step-1)]">Every setting is optional. Changes are saved when you press Save.</p>
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
    </div>
  );
}
