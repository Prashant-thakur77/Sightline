import Link from 'next/link';
import { formatMoney } from '@sightline/core';
import { requireUser } from '@/server/session';
import { ordersForUser } from '@/server/orders-read';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Orders and money' };

const MONEY: Record<string, { word: string; where: string }> = {
  approval_pending: { word: 'Waiting for approval', where: 'Not charged' },
  authorized: { word: 'On hold', where: 'Held by PayPal until you check it' },
  captured: { word: 'Paid', where: 'With Demo Store' },
  verified_match: { word: 'Paid after check', where: 'With Demo Store' },
  verified_mismatch: { word: 'Wrong item', where: 'Waiting for you to act' },
  verified_unsure: { word: 'Not sure yet', where: 'Unchanged' },
  case_open: { word: 'Case open', where: 'Asked Demo Store to refund' },
  voided: { word: 'Hold cancelled', where: 'Back with you' },
  resolved_refund: { word: 'Refunded', where: 'Back with you' },
  failed: { word: 'Not placed', where: 'Never charged' },
  confirmed: { word: 'Being placed', where: 'Not charged yet' },
};

export default async function Orders() {
  const user = await requireUser();
  const orders = await ordersForUser(user.id);
  const held = orders.filter((o) => o.status === 'authorized').reduce((a, o) => a + o.amountCents, 0);
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
        <table className="orders-table">
          <caption className="sr-only">Your orders, newest first, with where the money is</caption>
          <thead>
            <tr>
              <th scope="col">Item</th>
              <th scope="col">Amount</th>
              <th scope="col">Status</th>
              <th scope="col">Where the money is</th>
              <th scope="col">Date</th>
            </tr>
          </thead>
          <tbody>
            {orders.map((o) => (
              <tr key={o.id}>
                <th scope="row">
                  <Link href={`/app/orders/${o.id}`}>{o.title}</Link>
                </th>
                <td>{formatMoney({ cents: o.amountCents, currency: o.currency })}</td>
                <td>{MONEY[o.status]?.word ?? o.status}</td>
                <td>{MONEY[o.status]?.where ?? ''}</td>
                <td>{new Date(o.createdAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}</td>
              </tr>
            ))}
          </tbody>
        </table>
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
