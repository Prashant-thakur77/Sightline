'use client';

import { useLayoutEffect } from 'react';

/**
 * Applies the saved theme and text size. The inline script in the root layout does this before
 * first paint; this repeats it for pages React draws entirely in the browser (for example a
 * not-found page), where that script never runs. Doing it twice is harmless.
 */
export function ThemeBoot() {
  useLayoutEffect(() => {
    try {
      const root = document.documentElement;
      const t = localStorage.getItem('sl-theme');
      if (t) root.dataset.theme = t;
      else if (window.matchMedia?.('(prefers-contrast: more)').matches) root.dataset.theme = 'contrast';
      const s = parseFloat(localStorage.getItem('sl-text-scale') || '1');
      if (s > 1) root.style.setProperty('--text-scale', String(s));
    } catch {
      /* storage blocked: defaults stay */
    }
  }, []);
  return null;
}
