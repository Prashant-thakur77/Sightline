import { SummaryGrid, type SummaryRow } from '@/components/merchant/summary-grid';
import { durationWords, merchantSummary } from '@/server/merchant';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Analytics' };

export default async function MerchantAnalytics() {
  const s = await merchantSummary();
  const rows: SummaryRow[] = [
    { id: 'orders', measure: 'Orders', value: String(s.orders), how: 'Every order placed with Demo Store.' },
    {
      id: 'verified',
      measure: 'Verified deliveries',
      value: String(s.verifiedDeliveries),
      how: 'Orders the buyer checked with the camera and got a verdict on.',
    },
    {
      id: 'avoided',
      measure: 'Cases avoided by pay after check',
      value: String(s.casesAvoided),
      how: `Holds released after a mismatch (${s.voidedAfterMismatch}) plus payments captured after a match (${s.capturedAfterMatch}). Neither needed a dispute.`,
    },
    {
      id: 'median',
      measure: 'Median time to resolution',
      value: s.medianResolutionMs === null ? 'None yet' : durationWords(s.medianResolutionMs),
      how: s.resolvedCases
        ? `From case opened to case resolved, across ${s.resolvedCases} resolved ${s.resolvedCases === 1 ? 'case' : 'cases'}.`
        : 'No case has been resolved yet.',
    },
  ];
  return (
    <div className="mx-page">
      <header className="mx-page-head">
        <p className="eyebrow">Demo Store · Analytics</p>
        <h1 className="mx-h1">Analytics</h1>
        <p className="mx-lede">Analytics dashboard: coming in AG Studio.</p>
        <p className="mx-hint">
          Until then, here are the counts that matter, read straight from the order and case records.
        </p>
      </header>
      <section aria-labelledby="sum-h" className="mx-grid-section">
        <h2 id="sum-h" className="mx-h2">
          Summary
        </h2>
        <SummaryGrid rows={rows} labelledBy="sum-h" />
      </section>
    </div>
  );
}
