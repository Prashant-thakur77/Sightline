/* eslint-disable jsx-a11y/no-redundant-roles, jsx-a11y/no-interactive-element-to-noninteractive-role -- On
   narrow screens the table is laid out as cards, and some screen readers (VoiceOver on iOS) drop
   table semantics when a table's display changes. Stating each role (table, row, cell…) keeps it a
   table for them; the plugin reads td as a grid cell, so role="cell" looks like a change to it. */
import Link from 'next/link';
import { caseStatus, formatMoney, paymentStatus, verdictStatus } from '@sightline/core';
import { requireUser } from '@/server/session';
import { ordersPageData } from '@/server/orders-read';
import { isHeld } from '@/server/after-check';
import { buildMoneyTimeline } from '@/lib/money-timeline';
import { utcWhen } from '@/lib/when';
import { StatusChip } from '@/components/shell/status-chip';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Orders and money' };

/**
 * What tells one order's link from another's: when it was ordered, and the order number too when
 * the same item was ordered more than once in the same minute.
 */
function orderRefs(orders: { id: string; title: string; createdAt: string }[]): Map<string, string> {
  const when = (o: { createdAt: string }) => `ordered ${utcWhen(o.createdAt)}`;
  const seen = new Map<string, number>();
  for (const o of orders) seen.set(`${o.title}|${when(o)}`, (seen.get(`${o.title}|${when(o)}`) ?? 0) + 1);
  return new Map(orders.map((o) => [o.id, seen.get(`${o.title}|${when(o)}`)! > 1 ? `${when(o)}, order ${o.id.slice(-8).toUpperCase()}` : when(o)]));
}

export default async function Orders() {
  const user = await requireUser();
  const { orders, verdictOf, caseOf, cases, entries } = await ordersPageData(user.id);
  const held = orders.filter((o) => isHeld(o)).reduce((a, o) => a + o.amountCents, 0);
  const refs = orderRefs(orders);
  const titleOf = new Map(orders.map((o) => [o.id, o.title]));
  const timeline = buildMoneyTimeline({ orders, cases, entries, now: new Date() });
  return (
    <div className="grid gap-8">
      <header className="grid gap-3">
        <h1 className="text-[length:var(--step-4)]">Orders and money</h1>
        <p className="text-[length:var(--step-1)] max-w-[var(--measure)]">
          {orders.length === 0
            ? "You haven't bought anything yet."
            : `${orders.length} ${orders.length === 1 ? 'order' : 'orders'}, newest first.${held ? ` ${formatMoney({ cents: held, currency: 'USD' })} is on hold until you check the parcel.` : ''}`}
        </p>
      </header>
      {orders.length > 0 ? (
        <>
          <div className="orders-wrap">
            <table role="table" className="orders-table">
              <caption className="sr-only">Your orders, newest first, with where the money is</caption>
              <thead role="rowgroup">
                <tr role="row">
                  <th role="columnheader" scope="col">
                    Item
                  </th>
                  <th role="columnheader" scope="col">
                    Amount
                  </th>
                  <th role="columnheader" scope="col">
                    Where the money is
                  </th>
                  <th role="columnheader" scope="col">
                    Parcel check
                  </th>
                  <th role="columnheader" scope="col">
                    Money back
                  </th>
                  <th role="columnheader" scope="col">
                    Ordered
                  </th>
                </tr>
              </thead>
              <tbody role="rowgroup">
                {orders.map((o) => {
                  const pay = paymentStatus(o);
                  return (
                    <tr role="row" key={o.id}>
                      <th role="rowheader" scope="row">
                        <Link className="link-target" href={`/app/orders/${o.id}`}>
                          <span>
                            {o.title}
                            <span className="sr-only">
                              , {refs.get(o.id)}, {pay.word}
                            </span>
                          </span>
                        </Link>
                      </th>
                      {/* Each cell's label is shown on narrow screens only; screen readers get the column header instead. */}
                      <td role="cell">
                        <span className="cell-label" aria-hidden="true">
                          Amount
                        </span>
                        {formatMoney({ cents: o.amountCents, currency: o.currency })}
                      </td>
                      <td role="cell">
                        <span className="cell-label" aria-hidden="true">
                          Where the money is
                        </span>
                        <StatusChip s={pay} />
                      </td>
                      <td role="cell">
                        <span className="cell-label" aria-hidden="true">
                          Parcel check
                        </span>
                        <StatusChip s={verdictStatus(verdictOf.get(o.id))} />
                      </td>
                      <td role="cell">
                        <span className="cell-label" aria-hidden="true">
                          Money back
                        </span>
                        <StatusChip s={caseStatus(caseOf.get(o.id)?.stage)} />
                      </td>
                      <td role="cell">
                        <span className="cell-label" aria-hidden="true">
                          Ordered
                        </span>
                        <time dateTime={new Date(o.createdAt).toISOString()}>{utcWhen(o.createdAt)}</time>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          <section aria-labelledby="timeline-h" className="grid gap-4">
            <h2 id="timeline-h" className="text-[length:var(--step-2)]">
              Money timeline
            </h2>
            {timeline.length === 0 ? (
              <p className="max-w-[var(--measure)]">
                No money has moved yet. When PayPal holds, takes or gives back money for an order, it shows here, newest first, with any
                deadline.
              </p>
            ) : (
              <>
                <p className="max-w-[var(--measure)]">Every hold, payment, refund and deadline on record, newest first.</p>
                <ol className="money-timeline">
                  {timeline.map((e) => (
                    <li key={e.key} data-upcoming={e.upcoming ? '' : undefined}>
                      <p className="mt-head">
                        <StatusChip s={e.status} />
                        <time dateTime={e.at}>{utcWhen(e.at)}</time>
                      </p>
                      <p>{e.sentence}</p>
                      <p className="mt-order">
                        Order:{' '}
                        <Link href={`/app/orders/${e.orderId}`}>
                          {titleOf.get(e.orderId)}
                          <span className="sr-only">, {refs.get(e.orderId)}</span>
                        </Link>
                      </p>
                    </li>
                  ))}
                </ol>
              </>
            )}
          </section>
        </>
      ) : (
        <p>
          <Link className="btn btn-primary btn-xl" href="/app">
            Start shopping
          </Link>
        </p>
      )}
    </div>
  );
}
