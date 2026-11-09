import { redirect } from 'next/navigation';
import { eq } from 'drizzle-orm';
import { tables } from '@sightline/db';
import { db } from '@/server/runtime';
import { AppHeader } from '@/components/shell/app-header';
import { SpeechViewer } from '@/components/a11y/speech-viewer';
import { currentUser } from '@/server/session';
import { PrefsBoot } from '@/components/shell/prefs-boot';

export const dynamic = 'force-dynamic';

export default async function BuyerLayout({ children }: { children: React.ReactNode }) {
  const user = await currentUser();
  if (!user) redirect('/start');
  const [prefs] = await db().select({ lowVision: tables.preferences.lowVision, voiceMode: tables.preferences.voiceMode, speechRate: tables.preferences.speechRate }).from(tables.preferences).where(eq(tables.preferences.userId, user.id)).limit(1);
  // Saved low-vision and voice preferences, applied once per browser by PrefsBoot.
  const lv = prefs?.lowVision;
  return (
    <div id="app-root" className="min-h-dvh grid grid-rows-[auto_1fr]">
      <PrefsBoot
        userId={user.id}
        lowVision={lv ? { enabled: lv.enabled, textScale: lv.textScale } : null}
        voice={{ enabled: prefs?.voiceMode !== 'screen-reader', rate: (prefs?.speechRate ?? 100) / 100 }}
      />
      <AppHeader userName={user.displayName} />
      {/* The side padding's floor is in px, not rem, so Largest text on a phone keeps the width for words. */}
      <main id="main" tabIndex={-1} className="w-full max-w-[1200px] mx-auto px-[clamp(16px,3vw,2.5rem)] py-[var(--space-6)]">
        {children}
      </main>
      <SpeechViewer />
    </div>
  );
}
