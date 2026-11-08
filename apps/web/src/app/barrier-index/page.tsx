import { PRODUCT_NAME } from '@sightline/core';
import { SiteFooter, SiteHeader } from '@/components/shell/site-chrome';
import { loadSuites } from '@/server/stats';
import { platformName, sentence } from '@/server/studio';
import { utcWhen } from '@/lib/when';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Checkout Barrier Index' };

interface PlatformRow {
  stores: number;
  crawled?: number;
  medianViolationsProduct?: number;
  medianViolationsHome?: number;
  keyboardReachAddToCartRate?: number;
  keyboardReachDenominator?: number;
}
interface Details {
  byPlatform?: Record<string, PlatformRow>;
  topRules?: { id: string; help?: string; storesAffected: number; totalNodes?: number }[];
}

const pct = (x?: number) => (typeof x === 'number' ? `${Math.round(x * 100)}%` : '—');
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** The interval as the results file wrote it, named: an IQR is a spread, not a 95% interval. */
function intervalText(interval: string): string {
  const iqr = /^IQR\s+(.*)$/i.exec(interval);
  if (iqr) return `Middle half of stores (interquartile range): ${iqr[1]}`;
  const wilson = /^95% Wilson\s+(.*)$/i.exec(interval);
  if (wilson) return `95% Wilson interval: ${wilson[1]}`;
  return interval;
}

export default async function BarrierIndex() {
  const suite = (await loadSuites()).find((s) => s.suite === 'barrier') as (Awaited<ReturnType<typeof loadSuites>>[number] & { details?: Details }) | undefined;
  const details = suite?.details;
  return (
    <div>
      <SiteHeader current="barrier" />
      <main id="main" tabIndex={-1} className="judge-main">
        <section aria-labelledby="bi-h" className="grid gap-4">
          <h1 id="bi-h" className="lp-h1 judge-h1">
            Checkout <span className="lp-band">Barrier Index</span>
          </h1>
          <p className="lp-lede">
            How hard real online stores are to use with a screen reader or a keyboard on the way to checkout, measured with automated accessibility
            checks and a keyboard-only walk on each product page. Stores are reported by platform, never named.
          </p>
          {suite && (
            <p className="muted">
              Measured {utcWhen(suite.ranAt)} · build {suite.gitSha}
            </p>
          )}
        </section>

        {!suite ? (
          <p className="text-[length:var(--step-1)]">The crawl has not been run on this build yet. Nothing here is typed in by hand.</p>
        ) : (
          <>
            <section aria-labelledby="bi-head-h" className="grid gap-4">
              <h2 id="bi-head-h" className="lp-h2">
                Headline results
              </h2>
              <ul className="bi-heads">
                {suite.headlines.map((h) => (
                  <li key={h.id}>
                    <p className="bi-fig">{h.value}</p>
                    <p>{h.label}</p>
                    {h.interval && (
                      <p className="muted">
                        {intervalText(h.interval)}
                        {h.n ? `, n = ${h.n}` : ''}
                      </p>
                    )}
                    {h.note && <p className="muted">{h.note}</p>}
                  </li>
                ))}
              </ul>
            </section>

            {details?.byPlatform && (
              <section aria-labelledby="bi-plat-h" className="grid gap-4">
                <h2 id="bi-plat-h" className="lp-h2">
                  By store platform
                </h2>
                {/* eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex -- a scrollable region must be reachable by keyboard (WCAG 2.1.1) */}
                <div className="table-wrap" tabIndex={0} role="region" aria-label="Results by store platform, scrolls sideways">
                  <table className="verdict-table">
                    <caption className="sr-only">Accessibility failures and keyboard reach by store platform</caption>
                    <thead>
                      <tr>
                        <th scope="col">Platform</th>
                        <th scope="col">Stores sampled</th>
                        <th scope="col">Product page audited</th>
                        <th scope="col">Median failures, product page</th>
                        <th scope="col">Median failures, home page</th>
                        <th scope="col">Add to cart reachable by keyboard</th>
                      </tr>
                    </thead>
                    <tbody>
                      {Object.entries(details.byPlatform).map(([name, r]) => (
                        <tr key={name}>
                          <th scope="row">{platformName(name)}</th>
                          <td>{r.stores}</td>
                          <td>{r.crawled ?? '—'}</td>
                          <td>{r.medianViolationsProduct ?? '—'}</td>
                          <td>{r.medianViolationsHome ?? '—'}</td>
                          <td>
                            {pct(r.keyboardReachAddToCartRate)}
                            {typeof r.keyboardReachAddToCartRate === 'number' && r.keyboardReachDenominator ? ` of ${r.keyboardReachDenominator} judged` : ''}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </section>
            )}

            {details?.topRules && (
              <section aria-labelledby="bi-rules-h" className="grid gap-4">
                <h2 id="bi-rules-h" className="lp-h2">
                  The most common failures, and how {PRODUCT_NAME} routes around them
                </h2>
                <ol className="bi-rules">
                  {details.topRules.slice(0, 10).map((r) => (
                    <li key={r.id}>
                      <strong className="mono">{r.id}</strong>: {sentence(r.help ?? '')} Found on {plural(r.storesAffected, 'store')}.
                    </li>
                  ))}
                </ol>
                <p>
                  {PRODUCT_NAME} never asks a blind shopper to use the store’s pages: product facts come from structured catalog data, the readback is
                  spoken text, and payment happens through PayPal with a spoken confirmation.
                </p>
              </section>
            )}

            {suite.limitations && (
              <section aria-labelledby="bi-lim-h" className="grid gap-3">
                <h2 id="bi-lim-h" className="lp-h2">
                  Limits of this measurement
                </h2>
                <ul className="claims">
                  {suite.limitations.map((l) => (
                    <li key={l}>{l}</li>
                  ))}
                </ul>
              </section>
            )}
          </>
        )}

        <section aria-labelledby="bi-method-h" className="grid gap-3">
          <h2 id="bi-method-h" className="lp-h2">
            How it was measured
          </h2>
          <ul className="claims">
            <li>Read-only: no add-to-cart clicks, no forms, no accounts, no personal data.</li>
            <li>robots.txt honoured, one page every five seconds per store, an honest user agent.</li>
            <li>Automated checks find only part of the barriers people meet; real numbers are worse, not better.</li>
            <li>
              The script and the aggregated data are in the repository: <span className="mono">evals/barrier/</span>.
            </li>
          </ul>
        </section>
      </main>
      <SiteFooter />
    </div>
  );
}
