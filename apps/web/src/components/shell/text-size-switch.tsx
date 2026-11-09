'use client';

import { useEffect, useState } from 'react';
import { useAnnouncer } from '@/components/a11y/announcer';

const SIZES: [string, string][] = [
  ['1', 'Normal'],
  ['1.25', 'Large'],
  ['1.5', 'Larger'],
  ['2', 'Largest'],
];

/**
 * Text size for pages outside the app, where there is no Settings page (a helper's link). Same
 * sizes and the same saved value as Settings, kept in this browser only.
 */
export function TextSizeSwitch() {
  const [scale, setScale] = useState('1');
  const { announce } = useAnnouncer();
  useEffect(() => {
    try {
      const s = localStorage.getItem('sl-text-scale');
      if (s && SIZES.some(([v]) => v === s)) setScale(s);
    } catch {
      /* ignore */
    }
  }, []);
  const apply = (v: string) => {
    setScale(v);
    try {
      localStorage.setItem('sl-text-scale', v);
    } catch {
      /* ignore */
    }
    document.documentElement.style.setProperty('--text-scale', v);
    announce(`Text size: ${SIZES.find(([k]) => k === v)?.[1] ?? 'Normal'}.`, { source: 'settings' });
  };
  return (
    <label className="theme-switch">
      <span>Text size</span>
      <select value={scale} onChange={(e) => apply(e.target.value)}>
        {SIZES.map(([v, name]) => (
          <option key={v} value={v}>
            {name}
          </option>
        ))}
      </select>
    </label>
  );
}
