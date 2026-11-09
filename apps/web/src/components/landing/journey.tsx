'use client';

import { useEffect, useRef, useState } from 'react';
import { AskArt, CheckArt, HoldArt, ReadbackArt, RefundArt } from '@/components/art/illustrations';

export interface JourneyStep {
  key: string;
  label: string;
  title: string;
  body: string;
  said: string;
}

const ART = [AskArt, ReadbackArt, HoldArt, CheckArt, RefundArt];

/**
 * The five moments, as you scroll. On a wide screen the drawing stays beside the words and changes
 * with the step you are reading (plain scrolling, nothing hijacked); on a phone each step shows its
 * own drawing. For a screen reader it is an ordered list of five steps; the drawings are decorative.
 */
export function Journey({ steps }: { steps: JourneyStep[] }) {
  const [active, setActive] = useState(0);
  const refs = useRef<(HTMLLIElement | null)[]>([]);

  useEffect(() => {
    if (!('IntersectionObserver' in window)) return;
    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (e.isIntersecting) setActive(Number((e.target as HTMLElement).dataset.step));
        }
      },
      { rootMargin: '-45% 0px -45% 0px' },
    );
    for (const el of refs.current) if (el) io.observe(el);
    return () => io.disconnect();
  }, []);

  return (
    <div className="jr">
      <div className="jr-stage" aria-hidden="true">
        <div className="jr-stage-card">
          {ART.map((A, n) => (
            <div key={n} className="jr-stage-art" data-on={n === active || undefined}>
              <A />
            </div>
          ))}
          <ol className="jr-dots">
            {steps.map((s, n) => (
              <li key={s.key} data-on={n <= active || undefined} data-current={n === active || undefined} />
            ))}
          </ol>
        </div>
      </div>
      <ol className="jr-steps">
        {steps.map((s, n) => {
          const A = ART[n]!;
          return (
            <li
              key={s.key}
              ref={(el) => {
                refs.current[n] = el;
              }}
              data-step={n}
              data-current={n === active || undefined}
              className="jr-step"
            >
              <div className="jr-inline-art" aria-hidden="true">
                <A />
              </div>
              <p className="jr-label">
                <span className="jr-n" aria-hidden="true">
                  {n + 1}
                </span>
                <span className="sr-only">Step {n + 1}: </span>
                {s.label}
              </p>
              <h3 className="jr-title">{s.title}</h3>
              <p className="jr-body">{s.body}</p>
              <p className="jr-said">
                <span className="sr-only">For example: </span>
                {s.said}
              </p>
            </li>
          );
        })}
      </ol>
    </div>
  );
}
