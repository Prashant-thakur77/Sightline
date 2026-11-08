import { currentUser } from '@/server/session';
import { OrdersConsole } from '@/components/merchant/orders-console';
import { listMerchantOrders, paypalConfigured } from '@/server/merchant';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Orders' };

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

export default async function MerchantOrders() {
  const user = await currentUser();
  const rows = await listMerchantOrders(user?.id ?? '__none__');
  const paypalReady = paypalConfigured();
  const toShip = rows.filter((r) => r.can.ship).length;
  const inTransit = rows.filter((r) => r.shipment.state === 'in_transit').length;
  const needReply = rows.filter((r) => r.case.stage === 'seller_contacted').length;
  const held = rows.filter((r) => r.payment.tone === 'held').length;
  const counts = [
    { n: toShip, label: 'ready to ship' },
    { n: inTransit, label: 'in transit' },
    { n: held, label: "on hold until the buyer's check" },
    { n: needReply, label: needReply === 1 ? 'case needs your reply' : 'cases need your reply' },
  ];

  return (
    <div className="mx-page">
      <header className="mx-page-head">
        <p className="eyebrow">Demo Store · Orders</p>
        <h1 className="mx-h1">Orders</h1>
        <p className="mx-lede">
          {rows.length === 0 ? 'No orders yet.' : `${plural(rows.length, 'order', 'orders')}, newest first.`}
        </p>
        {rows.length > 0 && (
          <ul className="mx-counts" aria-label="At a glance">
            {counts.map((c) => (
              <li key={c.label} data-zero={c.n === 0 || undefined}>
                <span className="mx-count-n">{c.n}</span> {c.label}
              </li>
            ))}
          </ul>
        )}
      </header>

      {!paypalReady && (
        <div className="mx-notice">
          <p className="mx-notice-h">
            <span className="mx-glyph" aria-hidden="true">
              !
            </span>
            PayPal is not connected on this server
          </p>
          <p>
            The sandbox keys are not set. Shipping and delivery still work here, but tracking is recorded
            locally only, and refunds cannot be sent until the keys are added. Nothing pretends to reach
            PayPal.
          </p>
        </div>
      )}

      <OrdersConsole rows={rows} paypalReady={paypalReady} />
    </div>
  );
}
