import { redirect } from 'next/navigation';
import { AppHeader } from '@/components/shell/app-header';
import { SpeechViewer } from '@/components/a11y/speech-viewer';
import { currentUser } from '@/server/session';

export const dynamic = 'force-dynamic';

export default async function BuyerLayout({ children }: { children: React.ReactNode }) {
  const user = await currentUser();
  if (!user) redirect('/start');
  return (
    <div id="app-root" className="min-h-dvh grid grid-rows-[auto_1fr]">
      <AppHeader userName={user.displayName} />
      <main id="main" tabIndex={-1} className="w-full max-w-[1200px] mx-auto px-[clamp(1rem,3vw,2.5rem)] py-[var(--space-6)]">
        {children}
      </main>
      <SpeechViewer />
    </div>
  );
}
