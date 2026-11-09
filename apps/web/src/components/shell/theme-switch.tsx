'use client';

import { useEffect, useState } from 'react';
import { useAnnouncer } from '@/components/a11y/announcer';

type Theme = 'system' | 'light' | 'dark' | 'contrast';
const LABEL: Record<Theme, string> = { system: 'Match device', light: 'Light', dark: 'Dark', contrast: 'High contrast' };

/** "Match device" follows the device's contrast setting too: more contrast gets the high-contrast theme. */
const deviceWantsContrast = () => typeof window.matchMedia === 'function' && window.matchMedia('(prefers-contrast: more)').matches;

export function ThemeSwitch() {
  const [theme, setTheme] = useState<Theme>('system');
  const { announce } = useAnnouncer();
  useEffect(() => {
    try {
      const t = localStorage.getItem('sl-theme') as Theme | null;
      if (t) setTheme(t);
    } catch {
      /* ignore */
    }
  }, []);
  const apply = (t: Theme) => {
    setTheme(t);
    try {
      if (t === 'system') {
        localStorage.removeItem('sl-theme');
        if (deviceWantsContrast()) document.documentElement.dataset.theme = 'contrast';
        else delete document.documentElement.dataset.theme;
      } else {
        localStorage.setItem('sl-theme', t);
        document.documentElement.dataset.theme = t;
      }
    } catch {
      /* ignore */
    }
    announce(`Theme: ${LABEL[t]}.`, { source: 'settings' });
  };
  return (
    <label className="theme-switch">
      <span>Theme</span>
      <select value={theme} onChange={(e) => apply(e.target.value as Theme)}>
        {(Object.keys(LABEL) as Theme[]).map((t) => (
          <option key={t} value={t}>
            {LABEL[t]}
          </option>
        ))}
      </select>
    </label>
  );
}
