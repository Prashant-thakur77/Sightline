'use client';

import { useCallback, useState, type ReactNode } from 'react';

/**
 * Whether a box is narrower than its content, so it scrolls sideways. Measured again whenever the
 * box or its content changes size, so a larger text size or a turned phone is picked up.
 */
export function useScrollsSideways(): [(el: HTMLDivElement | null) => (() => void) | undefined, boolean] {
  const [scrolls, setScrolls] = useState(false);
  const ref = useCallback((el: HTMLDivElement | null) => {
    if (!el) return;
    const measure = () => setScrolls(el.scrollWidth > el.clientWidth + 1);
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    for (const child of el.children) ro.observe(child);
    return () => ro.disconnect();
  }, []);
  return [ref, scrolls];
}

/**
 * A wide table's box. Only when the table is wider than the screen does the box become a named
 * region in the Tab order, so a keyboard can scroll it (WCAG 2.1.1) and its name says so: "Results
 * by store platform, table, scrolls sideways". When everything fits it is a plain box: no extra
 * landmark, no extra Tab stop, no claim that it scrolls.
 */
export function ScrollRegion({ label, className, children }: { label: string; className?: string; children: ReactNode }) {
  const [ref, scrolls] = useScrollsSideways();
  const region = scrolls ? ({ role: 'region', tabIndex: 0, 'aria-label': `${label}, table, scrolls sideways` } as const) : {};
  return (
    <div ref={ref} className={className} {...region}>
      {children}
    </div>
  );
}
