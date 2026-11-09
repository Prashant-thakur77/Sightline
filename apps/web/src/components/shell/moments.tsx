const MOMENTS = ['Asked', 'Paid', 'Arrived', 'Checked', 'Money back'] as const;
export type Moment = (typeof MOMENTS)[number];

/**
 * Where an order stands in its five moments: a labelled list (it has no links, so it is not
 * navigation). The current one is marked with aria-current; its spoken state is "now" unless
 * `currentNote` says more (a readback is about paying, but nothing is paid until the buyer confirms).
 */
export function MomentsStrip({
  done,
  current,
  currentNote = 'now',
  label = 'Where this order is',
  notDone = {},
}: {
  done: number;
  current?: Moment;
  currentNote?: string;
  label?: string;
  /** Moments inside `done` that did not happen, with what to say instead (e.g. Paid: 'not paid'). */
  notDone?: Partial<Record<Moment, string>>;
}) {
  return (
    <ol aria-label={label} className="moments">
      {MOMENTS.map((m, i) => {
        const skipped = notDone[m];
        const isDone = i < done && !skipped;
        const isCurrent = current === m;
        return (
          <li key={m} data-done={isDone || undefined} aria-current={isCurrent ? 'step' : undefined}>
            <span className="moments-dot" aria-hidden="true">
              {isDone ? '✓' : skipped ? '–' : i + 1}
            </span>
            <span>
              {m}
              <span className="sr-only">{isDone ? ', done' : skipped ? `, ${skipped}` : isCurrent ? `, ${currentNote}` : ', not yet'}</span>
            </span>
          </li>
        );
      })}
    </ol>
  );
}
