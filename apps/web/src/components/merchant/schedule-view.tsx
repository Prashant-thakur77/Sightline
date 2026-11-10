'use client';

import dynamic from 'next/dynamic';
import type { Schedule } from '@/server/schedule';
import { TONE_GLYPH } from './schedule-glyphs';

/* Bryntum touches the DOM as it loads, so the timeline is only ever loaded in the browser. */
const ScheduleWidget = dynamic(() => import('./schedule-widget'), {
  ssr: false,
  loading: () => <p className="mx-sched-loading">Loading the schedule…</p>,
});

const KEY = [
  { tone: 'hold', words: 'Hold: money PayPal is holding, and each honour period' },
  { tone: 'deadline', words: 'Deadline: a renewal, reminder, auto-capture, reply or offer that is due' },
  { tone: 'done', words: 'Done: what actually happened, with its time' },
] as const;

/**
 * The timeline, for sighted staff, in a labelled region with a way past it. The table after it
 * holds the same schedule and is what a screen reader uses.
 */
export function ScheduleView({ schedule, skipTo }: { schedule: Schedule; skipTo: string }) {
  return (
    <section className="mx-sched" aria-labelledby="sched-h">
      <div className="mx-sched-head">
        <h2 id="sched-h" className="mx-h2">
          Schedule
        </h2>
        <p className="mx-hint">
          One row per order. Each bar and diamond says what it is in words. Choose one, or press Enter on it,
          to open its case. The line marked Now is the current time. The same schedule is in the table after
          it.
        </p>
        <ul className="mx-sched-key" aria-label="Key">
          {KEY.map((k) => (
            <li key={k.tone} data-tone={k.tone}>
              <span className="mx-sched-swatch" aria-hidden="true">
                {TONE_GLYPH[k.tone]}
              </span>
              {k.words}
            </li>
          ))}
        </ul>
        <a className="mx-sched-skip" href={`#${skipTo}`}>
          Skip past the schedule
        </a>
      </div>
      <div className="mx-sched-box">
        <ScheduleWidget schedule={schedule} label="Holds and deadlines schedule" />
      </div>
    </section>
  );
}
