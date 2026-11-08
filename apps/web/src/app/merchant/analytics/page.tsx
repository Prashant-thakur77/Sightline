import Link from 'next/link';
import { FiguresTicket } from '@/components/studio/figures-ticket';
import { VerifiedDeliveryStudio } from '@/components/studio/verified-delivery-studio';
import { ChartTables } from '@/components/studio/chart-tables';
import { VERIFIED_DELIVERY_TITLE, verifiedDeliveryChartTables } from '@/components/studio/verified-delivery-report';
import type { VerifiedDeliverySummary } from '@/components/studio/types';
import { currentUser } from '@/server/session';
import { loadVerifiedDelivery, studioAgentStatus, studioLicenceKey, verifiedDeliveryFigures } from '@/server/studio';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Verified delivery' };

const DEFINITIONS = [
  { term: 'Verified delivery', text: 'The carrier delivered the parcel and the buyer then checked it with the camera.' },
  { term: 'Wrong-item rate', text: 'Checks that found a mismatch, out of all checks. A check that could not tell is not counted as wrong.' },
  {
    term: 'On hold, paid, released, refunded',
    text: "Each order counted once, under its PayPal payment state now. On hold means PayPal holds the money until the buyer's check. An order with no PayPal order counts as not paid: nothing was charged.",
  },
  { term: 'Cases avoided', text: 'Holds released after the check found the wrong item. The buyer was never charged, so no dispute was needed.' },
  { term: 'Time to resolution', text: 'From the case being opened to it being resolved.' },
];

const stamp = (iso: string) =>
  new Date(iso).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZone: 'UTC' }) + ' UTC';

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** The lede says the money waited for the check only when PayPal really held it. */
function lede(s: VerifiedDeliverySummary): string {
  if (s.orders === 0) return 'No orders yet. The dashboard fills in as buyers order, check their parcels and open cases.';
  const checked = `What happened after each parcel arrived: ${s.verifiedDeliveries} of ${plural(s.delivered, 'delivered order')} ${s.verifiedDeliveries === 1 ? 'was' : 'were'} checked with the camera.`;
  if (s.heldForCheck > 0)
    return `${checked} For ${s.heldForCheck === s.verifiedDeliveries ? (s.heldForCheck === 1 ? 'it' : 'all of them') : `${s.heldForCheck} of them`}, PayPal held the money until the check answered.`;
  if (s.noPayPalOrders > 0)
    return s.noPayPalOrders === s.orders
      ? `${checked} ${s.orders === 1 ? 'This order has no PayPal order' : 'None of these orders has a PayPal order'}, so no money was held or charged.`
      : `${checked} ${plural(s.noPayPalOrders, 'order')} ${s.noPayPalOrders === 1 ? 'has' : 'have'} no PayPal order, so nothing was charged for ${s.noPayPalOrders === 1 ? 'it' : 'them'}.`;
  return checked;
}

export default async function MerchantAnalytics() {
  // The layout asks for a demo session first; this page shows only that demo shopper's orders.
  const user = await currentUser();
  const data = await loadVerifiedDelivery(user?.id ?? '__none__');
  const figures = verifiedDeliveryFigures(data);
  const s = data.summary;

  return (
    <div className="mx-page sx-page">
      <div className="sx-head">
        <header className="sx-head-copy">
          <p className="eyebrow">Demo Store · Analytics</p>
          <h1 className="mx-h1">Verified delivery</h1>
          <p className="mx-lede">
            {lede(s)}
          </p>
          <p className="mx-hint">
            Read from your demo shopper&apos;s order, check and case records each time the page loads. The ticket gives the
            same numbers the dashboard draws, written out.
          </p>
          <section className="sx-defs-wrap" aria-labelledby="vd-defs-h">
            <h2 id="vd-defs-h" className="sx-defs-h">
              How each figure is counted
            </h2>
            <dl className="sx-defs">
              {DEFINITIONS.map((d) => (
                <div key={d.term}>
                  <dt>{d.term}</dt>
                  <dd>{d.text}</dd>
                </div>
              ))}
            </dl>
          </section>
        </header>
        <FiguresTicket
          headingId="vd-figures-h"
          heading="The figures"
          asOf={stamp(data.asOf)}
          figures={figures}
          stub={`${plural(s.orders, 'order')} · ${plural(s.checks, 'check')} · ${plural(s.openCases + s.resolvedCases, 'case')}`}
        />
      </div>

      <section className="sx-section" aria-labelledby="vd-dash-h">
        <div className="sx-section-head">
          <h2 id="vd-dash-h" className="sx-h2">
            {VERIFIED_DELIVERY_TITLE}
          </h2>
          <p className="mx-hint">
            An AG Studio dashboard for sighted staff at the store. Switch to Edit to move, add or change widgets; changes
            stay in this browser tab.
          </p>
        </div>
        {s.orders === 0 && (
          <div className="sx-empty">
            <p className="sx-empty-h">Your demo shopper has no orders yet</p>
            <p>
              Order something in the <Link href="/app">shopper app</Link>, ship it from the Orders tab and check it when it
              arrives. Every widget below fills in from your own orders.
            </p>
          </div>
        )}
        <VerifiedDeliveryStudio data={data} licenseKey={studioLicenceKey()} agent={studioAgentStatus()} />
        <ChartTables id="vd" tables={verifiedDeliveryChartTables(data)} />
      </section>
    </div>
  );
}
