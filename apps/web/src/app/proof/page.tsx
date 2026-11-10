import Link from 'next/link';
import { PublicPage } from '@/components/landing/public-page';
import { featuredHeadlines } from '@/server/headlines';
import { keepCountTogether } from '@/components/landing/content';

export const metadata = { title: 'Proof' };
export const revalidate = 300;

export default async function Proof() {
  const measured = await featuredHeadlines(4);
  return (
    <PublicPage
      path="/proof"
      kicker="Proof"
      title="Measured, not claimed."
      lede="Every number comes from a script in the repository and is read from its result file, next to its baseline. What we cannot claim yet is listed too."
    >
      {measured.length > 0 && (
        <section className="lx-section lx-measured" aria-labelledby="measured-h">
          <div className="lx-wrap">
            <h2 id="measured-h" className="lx-h2">
              Four results
            </h2>
            <ul className="lx-mlist">
              {measured.map((h) => (
                <li key={h.id}>
                  <p className="lx-mval">{keepCountTogether(h.value)}</p>
                  <p>{h.label}</p>
                  {h.baseline && <p className="lx-mbase">Baseline: {h.baseline}</p>}
                  {h.context && <p className="lx-mbase">{h.context}</p>}
                </li>
              ))}
            </ul>
            <p className="lx-sub">
              The <Link href="/judge#numbers">judge page</Link> lists every number, with the negative results.
            </p>
          </div>
        </section>
      )}

      <section className="lx-section lx-limits" aria-labelledby="limits-h">
        <div className="lx-wrap">
          <h2 id="limits-h" className="lx-h2">
            What we do not claim
          </h2>
          <ul className="lx-limit-list">
            <li>It is not yet tested with blind users. That is the next step, and we will report what they say.</li>
            <li>
              Opening a PayPal case on a buyer’s behalf by API exists only in PayPal’s sandbox. In production, buyers file in PayPal’s Resolution Center;
              we show how an accessible path could work.
            </li>
            <li>Orders go to a sandbox demo store at the listed price, not to the real retailer.</li>
            <li>Colour in dim light is unreliable. We publish the error rate and say “not sure” rather than guess.</li>
            <li>Maya and Raj are demo personas, not real customers.</li>
          </ul>
        </div>
      </section>
    </PublicPage>
  );
}
