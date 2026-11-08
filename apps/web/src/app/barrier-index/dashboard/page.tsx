import Link from 'next/link';
import { SiteFooter, SiteHeader } from '@/components/shell/site-chrome';
import { BarrierStudio } from '@/components/studio/barrier-studio';
import { BARRIER_TITLE } from '@/components/studio/barrier-report';
import { FiguresTicket } from '@/components/studio/figures-ticket';
import { barrierFigures, loadBarrierIndex, studioAgentStatus, studioLicenceKey } from '@/server/studio';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Barrier Index dashboard' };

const METHOD = [
  { term: 'Read-only', text: 'No add-to-cart clicks, no forms, no accounts. robots.txt is honoured and each store gets one page every five seconds.' },
  { term: 'Failures', text: 'Distinct automated accessibility rules (WCAG A and AA) failed on a page. Automated checks catch only part of WCAG, so real barriers are more.' },
  { term: 'Keyboard reach', text: 'Tab only, from the top of the product page, up to 150 presses. Pages where a dialog held focus or a size must be chosen first are left out.' },
  { term: 'Stores', text: 'Named only by a hash of their domain and grouped by platform. Per-platform groups are small, so treat them as indicative.' },
];

const day = (iso: string) =>
  iso ? new Date(iso).toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric', timeZone: 'UTC' }) : 'date unknown';

export default async function BarrierDashboard() {
  const data = await loadBarrierIndex();
  return (
    <div>
      <SiteHeader />
      <main id="main" tabIndex={-1} className="sx-main">
        <div className="sx-page">
          <div className="sx-head">
            <header className="sx-head-copy">
              <p className="eyebrow">Research · Dashboard</p>
              <h1 className="lp-h1 sx-h1">
                Checkout <span className="lp-band">Barrier Index</span>
              </h1>
              <p className="lp-lede sx-lede">
                The crawl&apos;s results as a dashboard: how many accessibility rules each store fails, whether a keyboard alone reaches add to
                cart, and which failures are most common.
              </p>
              <p className="muted sx-small">
                <Link href="/barrier-index">Read the write-up and its limits</Link>.
                {data && ` Measured ${day(data.ranAt)}, build ${data.gitSha}. Read from the results file the analysis script writes; nothing is typed in by hand.`}
              </p>
              <section className="sx-defs-wrap" aria-labelledby="bi-defs-h">
                <h2 id="bi-defs-h" className="sx-defs-h">
                  How it was measured
                </h2>
                <dl className="sx-defs">
                  {METHOD.map((d) => (
                    <div key={d.term}>
                      <dt>{d.term}</dt>
                      <dd>{d.text}</dd>
                    </div>
                  ))}
                </dl>
              </section>
            </header>
            {data && (
              <FiguresTicket
                headingId="bi-figures-h"
                heading="The figures"
                asOf={day(data.ranAt)}
                figures={barrierFigures(data)}
                stub={`${data.summary.crawled} stores · ${data.platforms.length} ${data.platforms.length === 1 ? 'platform' : 'platforms'} · ${data.rules.length} rules`}
              />
            )}
          </div>

          <section className="sx-section" aria-labelledby="bi-dash-h">
            <div className="sx-section-head">
              <h2 id="bi-dash-h" className="sx-h2">
                {BARRIER_TITLE}
              </h2>
              <p className="muted sx-small">
                An AG Studio dashboard for sighted readers. Every number on it is also on the ticket above and in the write-up.
              </p>
            </div>
            {data ? (
              <BarrierStudio data={data} licenseKey={studioLicenceKey()} agent={studioAgentStatus()} />
            ) : (
              <div className="sx-empty">
                <p className="sx-empty-h">The crawl has not been run on this build yet</p>
                <p>
                  The dashboard fills in from the results file once the crawl and its analysis have run. Nothing here is typed in by hand.
                </p>
              </div>
            )}
          </section>
        </div>
      </main>
      <SiteFooter />
    </div>
  );
}
