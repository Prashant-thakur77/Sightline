import { redirect } from 'next/navigation';
import { eq } from 'drizzle-orm';
import { tables } from '@sightline/db';
import { db } from '@/server/runtime';
import { AppHeader } from '@/components/shell/app-header';
import { SpeechViewer } from '@/components/a11y/speech-viewer';
import { currentUser } from '@/server/session';

export const dynamic = 'force-dynamic';

export default async function BuyerLayout({ children }: { children: React.ReactNode }) {
  const user = await currentUser();
  if (!user) redirect('/start');
  const [prefs] = await db().select({ lowVision: tables.preferences.lowVision, voiceMode: tables.preferences.voiceMode, speechRate: tables.preferences.speechRate }).from(tables.preferences).where(eq(tables.preferences.userId, user.id)).limit(1);
  // Apply saved low-vision and voice preferences once per browser, unless the person changed them here.
  const lv = prefs?.lowVision;
  const prefScript = `(function(){try{if(localStorage.getItem('sl-prefs-applied')==='${user.id}')return;${
    lv?.enabled ? `localStorage.setItem('sl-theme','contrast');document.documentElement.dataset.theme='contrast';localStorage.setItem('sl-text-scale','${lv.textScale}');document.documentElement.style.setProperty('--text-scale','${lv.textScale}');` : ''
  }localStorage.setItem('sl-own-voice',JSON.stringify({enabled:${prefs?.voiceMode !== 'screen-reader'},rate:${(prefs?.speechRate ?? 100) / 100}}));localStorage.setItem('sl-prefs-applied','${user.id}');}catch(e){}})();`;
  return (
    <div id="app-root" className="min-h-dvh grid grid-rows-[auto_1fr]">
      <script dangerouslySetInnerHTML={{ __html: prefScript }} />
      <AppHeader userName={user.displayName} />
      <main id="main" tabIndex={-1} className="w-full max-w-[1200px] mx-auto px-[clamp(1rem,3vw,2.5rem)] py-[var(--space-6)]">
        {children}
      </main>
      <SpeechViewer />
    </div>
  );
}
