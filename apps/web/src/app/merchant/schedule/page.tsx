import Link from 'next/link';
import { currentUser } from '@/server/session';
import { loadSchedule } from '@/server/schedule-read';
import {
  AUTHORIZATION_DAYS,
  AUTO_CAPTURE_DAYS,
  CHECK_REMINDER_DAYS,
  HONOR_PERIOD_DAYS,
} from '@/server/hold-rules';
import type { Schedule } from '@/server/schedule';
import { ScheduleView } from '@/components/merchant/schedule-view';
import { ScheduleTable } from '@/components/merchant/schedule-table';
import { spokenWhen } from '@/lib/when';
import './schedule.css';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Holds and deadlines' };

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** What the page says first: how many orders need watching, and the very next thing due. */
function lede(s: Schedule): string {
  const active = s.rows.filter((r) => r.active);
  const settled = s.rows.length - active.length;
  if (!s.rows.length) return 'Nothing on hold and no case open.';
  const head = active.length
    ? `${plural(active.length, 'order has', 'orders have')} money on hold or a case open`
    : 'No money on hold and no case open now';
  const tail = settled
    ? `, and ${plural(settled, 'hold or case was', 'holds or cases were')} settled in the last ${AUTHORIZATION_DAYS} days.`
    : '.';
  const next = active
    .flatMap((r) =>
      r.events
        .filter((e) => e.tone === 'deadline' && (e.status === 'planned' || e.status === 'overdue'))
        .map((e) => ({ e, r })),
    )
    .sort((a, b) => Date.parse(a.e.start) - Date.parse(b.e.start))[0];
  return `${head}${tail}${next ? ` Next due: ${next.e.label}, order ${next.r.orderRef}, ${spokenWhen(next.e.start)}.` : ''}`;
}

export default async function MerchantSchedule() {
  // The layout asks for a demo session first; this page shows only that demo shopper's orders.
  const user = await currentUser();
  const schedule = await loadSchedule(user?.id ?? '__none__');

  return (
    <div className="mx-page">
      <header className="mx-page-head">
        <p className="eyebrow">Demo Store · Schedule</p>
        <h1 className="mx-h1">Holds and deadlines</h1>
        <p className="mx-lede">{lede(schedule)}</p>
        <p className="mx-hint">
          Read from your demo shopper&apos;s orders, cases and PayPal steps each time the page loads. PayPal
          honours a hold for {HONOR_PERIOD_DAYS} days at a time and allows renewals for {AUTHORIZATION_DAYS}{' '}
          days. After delivery, the buyer is reminded on day {CHECK_REMINDER_DAYS} and the store is paid on
          day {AUTO_CAPTURE_DAYS}, unless a case is open. Nothing on this page moves money.
        </p>
      </header>

      {schedule.rows.length === 0 ? (
        <div className="mx-sched-empty-card">
          <p className="mx-sched-empty-h">Your demo shopper has nothing on hold</p>
          <p>
            Order something with pay after check in the <Link href="/app">shopper app</Link>, then ship it
            from the <Link href="/merchant">Orders</Link> page. Its hold, renewals and deadlines appear here.
          </p>
        </div>
      ) : (
        <>
          <ScheduleView schedule={schedule} skipTo="sched-table-h" />
          <section className="mx-sched-data" aria-labelledby="sched-table-h">
            <h2 id="sched-table-h" className="mx-h2" tabIndex={-1}>
              The schedule as a table
            </h2>
            <ScheduleTable schedule={schedule} id="sched-table" />
          </section>
        </>
      )}
    </div>
  );
}
