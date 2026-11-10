import Link from 'next/link';
import { ScrollRegion } from '@/components/a11y/scroll-region';
import type { Schedule } from '@/server/schedule';
import { TONE_GLYPH } from './schedule-glyphs';

/**
 * The schedule as a table, rendered on the server from the same rows the timeline draws: one row
 * group per order (its reference, item, amount and state, and the way to its case), then each hold,
 * deadline and thing that happened, in time order. This is where a screen reader reads the schedule.
 */
export function ScheduleTable({ schedule, id }: { schedule: Schedule; id: string }) {
  const { rows } = schedule;
  if (!rows.length)
    return (
      <p className="mx-sched-empty">Nothing on hold and no case open, so there is nothing to schedule.</p>
    );
  const events = rows.reduce((n, r) => n + r.events.length, 0);
  return (
    <ScrollRegion label="Holds and deadlines by order" className="mx-sched-scroll">
      <table className="mx-sched-table" id={id}>
        <caption>
          Holds and deadlines by order: {rows.length} {rows.length === 1 ? 'order' : 'orders'}, {events}{' '}
          {events === 1 ? 'entry' : 'entries'}. Soonest deadline first. Times are in UTC.
        </caption>
        <thead>
          <tr>
            <th scope="col">What</th>
            <th scope="col">When</th>
            <th scope="col">Kind</th>
            <th scope="col">Status</th>
          </tr>
        </thead>
        {rows.map((r) => (
          <tbody key={r.orderId}>
            <tr className="mx-sched-group">
              <th scope="rowgroup" colSpan={4}>
                <div className="mx-sched-group-in">
                  <span className="mx-sched-group-h">
                    Order {r.orderRef}: {r.title}
                  </span>
                  <span className="mx-sched-group-meta">
                    {r.amount} · {r.buyer} · {r.stateWords}
                  </span>
                  <Link href={r.href} className="mx-sched-group-link">
                    {r.linkWords}
                  </Link>
                </div>
              </th>
            </tr>
            {r.events.map((e) => (
              <tr key={e.id} data-tone={e.tone}>
                <th scope="row">
                  <span className="mx-sched-label">{e.label}</span>
                  <span className="mx-sched-detail">{e.detail}</span>
                </th>
                <td>{e.when}</td>
                <td>
                  <span className="mx-sched-glyph" aria-hidden="true">
                    {TONE_GLYPH[e.tone]}
                  </span>{' '}
                  {e.toneWords}
                </td>
                <td>{e.statusWords}</td>
              </tr>
            ))}
          </tbody>
        ))}
      </table>
    </ScrollRegion>
  );
}
