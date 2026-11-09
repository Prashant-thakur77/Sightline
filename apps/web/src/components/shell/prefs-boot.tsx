'use client';

import { useLayoutEffect } from 'react';
import { useAnnouncer } from '@/components/a11y/announcer';

/**
 * Applies a shopper's saved low-vision and voice preferences once per browser, unless they changed
 * them here since. It runs on every route into the app, including a client-side redirect from
 * /start, where an inline script would never run, and it tells the announcer directly, so the
 * app's own voice is on straight away rather than after a reload.
 */
export function PrefsBoot({
  userId,
  lowVision,
  voice,
}: {
  userId: string;
  lowVision: { enabled: boolean; textScale: number } | null;
  voice: { enabled: boolean; rate: number };
}) {
  const { setOwnVoice } = useAnnouncer();
  useLayoutEffect(() => {
    try {
      if (localStorage.getItem('sl-prefs-applied') === userId) return;
      const root = document.documentElement;
      if (lowVision?.enabled) {
        localStorage.setItem('sl-theme', 'contrast');
        root.dataset.theme = 'contrast';
        localStorage.setItem('sl-text-scale', String(lowVision.textScale));
        root.style.setProperty('--text-scale', String(lowVision.textScale));
      }
      setOwnVoice(voice);
      localStorage.setItem('sl-prefs-applied', userId);
    } catch {
      /* storage blocked: settings still apply from the Settings page */
    }
  }, [userId, lowVision, voice, setOwnVoice]);
  return null;
}
