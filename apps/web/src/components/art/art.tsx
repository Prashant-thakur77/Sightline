'use client';

import { useEffect, useRef, useState } from 'react';

/**
 * A drawing that draws its lines once, the first time it comes into view. The drawing is complete
 * in the HTML, so with no script, reduced motion or a screen reader nothing waits on the motion.
 * Decorative by default (hidden from screen readers); pass `label` when the picture carries
 * meaning that the text around it does not already say.
 */
export function Art({
  children,
  viewBox,
  label,
  className,
  delay = 0,
}: {
  children: React.ReactNode;
  viewBox: string;
  label?: string;
  className?: string;
  /** Milliseconds before the lines start drawing. */
  delay?: number;
}) {
  const ref = useRef<SVGSVGElement>(null);
  const [state, setState] = useState<'idle' | 'ready' | 'drawn'>('idle');

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches || !('IntersectionObserver' in window)) return;
    setState('ready');
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          setState('drawn');
          io.disconnect();
        }
      },
      { threshold: 0.25 },
    );
    io.observe(el);
    // Never blank on paper: printing shows every drawing complete.
    const print = () => {
      io.disconnect();
      setState('idle');
    };
    window.addEventListener('beforeprint', print);
    return () => {
      io.disconnect();
      window.removeEventListener('beforeprint', print);
    };
  }, []);

  return (
    <svg
      ref={ref}
      viewBox={viewBox}
      className={['art', className].filter(Boolean).join(' ')}
      data-state={state}
      style={{ ['--art-delay' as string]: `${delay}ms` }}
      role={label ? 'img' : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
      focusable="false"
    >
      {children}
    </svg>
  );
}
