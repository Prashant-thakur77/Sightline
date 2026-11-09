'use client';

import { useEffect } from 'react';

/**
 * When this page is opened at a section (for example from the verdict's "Get my money back"),
 * move focus to the control the person came for, so they don't have to find the same button
 * again. A section marks that control with `data-focus-target`; otherwise its heading is used.
 */
export function FocusFromHash() {
  useEffect(() => {
    const go = () => {
      const id = decodeURIComponent(window.location.hash.slice(1));
      if (!id) return;
      const section = document.getElementById(id);
      // Only the order's own sections; the skip link (#main) and anything else keep their usual behaviour.
      if (!section || !section.matches('.case-folder, #helper')) return;
      const target =
        section.querySelector<HTMLElement>('[data-focus-target]:not([aria-disabled="true"])') ?? section.querySelector<HTMLElement>('h2, h3');
      if (!target) return;
      if (!target.matches('a, button, input, select, textarea, [tabindex]')) target.tabIndex = -1;
      target.focus();
    };
    go();
    window.addEventListener('hashchange', go);
    return () => window.removeEventListener('hashchange', go);
  }, []);
  return null;
}
