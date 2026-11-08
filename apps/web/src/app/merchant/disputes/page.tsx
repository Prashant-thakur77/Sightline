import { currentUser } from '@/server/session';
import { CaseDesk } from '@/components/merchant/case-desk';
import { listMerchantCases, paypalConfigured } from '@/server/merchant';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Cases' };

export default async function MerchantCases() {
  const user = await currentUser();
  const cases = await listMerchantCases(user?.id ?? '__none__');
  const open = cases.filter((c) => c.open);
  const overdue = open.filter((c) => c.overdue).length;
  const paypalReady = paypalConfigured();

  return (
    <div className="mx-page">
      <header className="mx-page-head">
        <p className="eyebrow">Demo Store · Cases desk</p>
        <h1 className="mx-h1">Cases</h1>
        <p className="mx-lede">
          {open.length === 0
            ? 'Nothing needs a reply.'
            : `${open.length} open ${open.length === 1 ? 'case' : 'cases'}, soonest deadline first${overdue ? `, ${overdue} overdue` : ''}. Each one carries the buyer's signed evidence.`}
        </p>
        <p className="mx-hint">
          Every reply asks you to confirm first. Suggestions are shown to help you decide and are never sent
          on their own.
        </p>
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
            The sandbox keys are not set, so refunds cannot be sent and nothing here pretends otherwise.
            Offers are recorded on the case and the buyer is told.
          </p>
        </div>
      )}

      <CaseDesk cases={cases} />
    </div>
  );
}
