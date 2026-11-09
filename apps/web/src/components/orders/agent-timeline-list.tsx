'use client';

import { useEffect, useId, useRef, useState } from 'react';
import { useAnnouncer } from '@/components/a11y/announcer';
import type { TimelineStep } from '@/server/timeline';

/** How many of the latest steps show before the rest are opened. */
const SHOW_LATEST = 6;

const DECIDED: Record<NonNullable<TimelineStep['decided']>, string> = {
  model: 'Decided by Claude, a model, and checked by code',
  rules: 'Decided by fixed rules',
  person: 'Decided by a person',
};

const SOURCE: Record<NonNullable<TimelineStep['paypal']>['source'], string> = {
  answer: 'as PayPal answered',
  webhook: 'from a verified PayPal webhook',
};

/** "PAYER_ACTION_REQUIRED" read as words, not letters. */
const statusWords = (s: string) => s.replace(/_/g, ' ').toLowerCase();

/**
 * The steps as one ordered list, oldest first. Each item says who did it, what happened, when,
 * the tool used, who decided, and PayPal's id and status for PayPal steps, all in words. A long
 * list shows its latest steps first; opening the rest moves focus to the first step.
 */
export function AgentTimelineList({ steps, labelledBy }: { steps: TimelineStep[]; labelledBy: string }) {
  const { announce } = useAnnouncer();
  const listId = useId();
  const [all, setAll] = useState(false);
  const firstRef = useRef<HTMLLIElement>(null);
  const opened = useRef(false);
  const long = steps.length > SHOW_LATEST + 2;
  const hidden = long && !all ? steps.length - SHOW_LATEST : 0;
  const shown = steps.slice(hidden);

  useEffect(() => {
    if (!opened.current) return;
    opened.current = false;
    firstRef.current?.focus();
  }, [all]);

  return (
    <div className="agent-timeline-wrap">
      <p className="muted">
        {hidden ? `Showing the latest ${SHOW_LATEST} of ${steps.length} steps.` : `${steps.length} ${steps.length === 1 ? 'step' : 'steps'}, oldest first.`}
      </p>
      {long && (
        <p>
          <button
            type="button"
            className="btn"
            aria-expanded={all}
            aria-controls={listId}
            onClick={() => {
              const next = !all;
              opened.current = next;
              setAll(next);
              // Focus moves to the first step, which is read from there; this reaches the Speech Viewer only.
              if (next) announce(`Showing all ${steps.length} steps, from the first.`, { source: 'timeline', live: false });
            }}
          >
            {all ? `Show only the latest ${SHOW_LATEST} steps` : `Show all ${steps.length} steps`}
          </button>
        </p>
      )}
      <ol id={listId} className="history agent-timeline" aria-labelledby={labelledBy} start={hidden + 1}>
        {shown.map((s, i) => (
          <li key={s.key} ref={i === 0 ? firstRef : undefined} tabIndex={i === 0 && all ? -1 : undefined} className="agent-step" data-who={s.who}>
            <p className="agent-step-what">
              <strong>{s.whoWords}</strong>: {s.what}
            </p>
            <p className="agent-step-meta muted">
              {s.when}.{s.tool ? ` Used ${s.tool}.` : ''}
              {s.decided ? ` ${DECIDED[s.decided]}.` : ''}
            </p>
            {s.paypal && (
              <p className="agent-step-paypal muted">
                {s.paypal.label} <span className="mono">{s.paypal.id}</span>:{' '}
                {s.paypal.status ? `${statusWords(s.paypal.status)}, ${SOURCE[s.paypal.source]}` : 'status not recorded'}.
              </p>
            )}
          </li>
        ))}
      </ol>
    </div>
  );
}
