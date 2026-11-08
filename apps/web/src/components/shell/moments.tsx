const MOMENTS = ['Asked', 'Paid', 'Arrived', 'Checked', 'Money back'] as const;
export type Moment = (typeof MOMENTS)[number];

/** Where an order stands in its five moments. The current one is marked with aria-current. */
export function MomentsStrip({ done, current, label = 'Where this order is' }: { done: number; current?: Moment; label?: string }) {
  return (
    <nav aria-label={label} className="moments">
      <ol>
        {MOMENTS.map((m, i) => {
          const isDone = i < done;
          const isCurrent = current === m;
          return (
            <li key={m} data-done={isDone || undefined} aria-current={isCurrent ? 'step' : undefined}>
              <span className="moments-dot" aria-hidden="true">
                {isDone ? '✓' : i + 1}
              </span>
              <span>
                {m}
                <span className="sr-only">{isDone ? ', done' : isCurrent ? ', now' : ', not yet'}</span>
              </span>
            </li>
          );
        })}
      </ol>
    </nav>
  );
}
