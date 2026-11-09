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
import { spokenWhen } from '@/lib/when';
import { StatusChip } from '@/components/shell/status-chip';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Orders and money' };

/**
 * What tells one order's link from another's: when it was ordered, and the order number too when
 * the same item was ordered more than once in the same minute.
 */
function orderRefs(orders: { id: string; title: string; createdAt: string }[]): Map<string, string> {
  const when = (o: { createdAt: string }) => `ordered ${spokenWhen(o.createdAt)}`;
  const seen = new Map<string, number>();
  for (const o of orders) seen.set(`${o.title}|${when(o)}`, (seen.get(`${o.title}|${when(o)}`) ?? 0) + 1);
  return new Map(orders.map((o) => [o.id, seen.get(`${o.title}|${when(o)}`)! > 1 ? `${when(o)}, order ${o.id.slice(-8).toUpperCase()}` : when(o)]));
}

/** Titles that more than one order shares; only those links need more than the title to tell them apart. */
function sharedTitles(orders: { title: string }[]): Set<string> {
  const n = new Map<string, number>();
  for (const o of orders) n.set(o.title, (n.get(o.title) ?? 0) + 1);
  return new Set([...n].filter(([, k]) => k > 1).map(([t]) => t));
}

export default async function Orders() {
  const user = await requireUser();
  const { orders, verdictOf, caseOf, cases, entries } = await ordersPageData(user.id);
  const held = orders.filter((o) => isHeld(o)).reduce((a, o) => a + o.amountCents, 0);
  const refs = orderRefs(orders);
  const shared = sharedTitles(orders);
  const titleOf = new Map(orders.map((o) => [o.id, o.title]));
  const timeline = buildMoneyTimeline({ orders, cases, entries, now: new Date() });
  // One link per order in the timeline, on its newest line; its older lines name the order in plain text.
  const linked = new Set<string>();
  const linkHere = new Set(timeline.filter((e) => !linked.has(e.orderId) && linked.add(e.orderId)).map((e) => e.key));
  return (
    <div className="grid gap-8">
      <header className="grid gap-3">
        <h1 className="text-[length:var(--step-4)]">Orders and money</h1>
        <p className="text-[length:var(--step-1)] max-w-[var(--measure)]">
          {orders.length === 0
            ? "You haven't bought anything yet. Orders you buy appear here, with where the money is."
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
                        {/* The row's cells already say the amount, status and date, so the link is just the item,
                            plus when it was ordered if another order has the same item. */}
                        <Link className="link-target" href={`/app/orders/${o.id}`}>
                          <span>
                            {o.title}
                            {shared.has(o.title) && <span className="sr-only">, {refs.get(o.id)}</span>}
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
                        <time dateTime={new Date(o.createdAt).toISOString()}>{spokenWhen(o.createdAt)}</time>
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
                <p className="max-w-[var(--measure)]">Every hold, payment, refund, offer and deadline on record, newest first.</p>
                <ol className="money-timeline">
                  {timeline.map((e) => (
                    <li key={e.key} data-upcoming={e.upcoming ? '' : undefined}>
                      <p className="mt-head">
                        <StatusChip s={e.status} />
                        <time dateTime={e.at}>{spokenWhen(e.at)}</time>
                      </p>
                      <p>{e.sentence}</p>
                      <p className="mt-order">
                        Order:{' '}
                        {linkHere.has(e.key) ? (
                          <Link href={`/app/orders/${e.orderId}`}>
                            {titleOf.get(e.orderId)}
                            {shared.has(titleOf.get(e.orderId) ?? '') && <span className="sr-only">, {refs.get(e.orderId)}</span>}
                          </Link>
                        ) : (
                          titleOf.get(e.orderId)
                        )}
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
