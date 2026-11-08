import Link from 'next/link';
import { desc, eq } from 'drizzle-orm';
import { tables } from '@sightline/db';
import { PRODUCT_NAME } from '@sightline/core';
import { SiteFooter, SiteHeader } from '@/components/shell/site-chrome';
import { loadSuites } from '@/server/stats';
import { featuredHeadlines } from '@/server/headlines';
import { db, INTEGRATIONS } from '@/server/runtime';
import { JudgeStart } from './judge-start';
import { LifecycleRun } from './lifecycle-run';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'For judges' };

const REPO = 'https://github.com/Prashant-thakur77/sightline-paypal';

export default async function Judge() {
  const suites = await loadSuites();
  const featured = await featuredHeadlines(6);
  const headlines = suites.flatMap((s) => s.headlines.map((h) => ({ ...h, suite: s.title, ranAt: h.ranAt ?? s.ranAt, gitSha: h.gitSha ?? s.gitSha })));
  const [receipt] = await db().select({ id: tables.receipts.id }).from(tables.receipts).where(eq(tables.receipts.kind, 'gate')).orderBy(desc(tables.receipts.createdAt)).limit(1);
  const live: [string, boolean, string][] = [
    ['PayPal sandbox (Orders v2, Vault, Payments, tracking, Disputes, webhooks)', INTEGRATIONS.paypal, 'Every payment, hold, capture, void and refund'],
    ['Claude (agent, confirmation check, vision, case writing)', INTEGRATIONS.anthropic, 'Second confirmation key, free questions, size-tag reading'],
    ['Channel3 product data', INTEGRATIONS.channel3, 'Real products and variants; Demo Store catalog otherwise'],
    ['Deepgram speech to text', INTEGRATIONS.deepgram, 'Streaming voice input; browser speech otherwise'],
    ['KERNEL cloud browsers', INTEGRATIONS.kernel, 'Reading store pages and the Barrier Index'],
    ['Vision service', INTEGRATIONS.vision, 'Colour, size tag, identity and damage checks'],
  ];
  return (
    <div className="judge">
      <SiteHeader current="judge" />
      <main id="main" tabIndex={-1} className="judge-main">
        <section aria-labelledby="j-h" className="grid gap-4">
          <h1 id="j-h" className="lp-h1 judge-h1">
            Independence doesn’t end at <span className="lp-band">checkout.</span>
          </h1>
          <p className="lp-lede">
            {PRODUCT_NAME} lets a blind shopper buy by voice, hear exactly what they will pay, check the parcel with a phone camera, and get the money
            back through PayPal when it is wrong. Money waits for the check.
          </p>
        </section>

        <section aria-labelledby="path-h" className="grid gap-4">
          <h2 id="path-h" className="lp-h2">
            The 60-second path
          </h2>
          <ol className="jpath">
            <li>
              <span className="jpath-n" aria-hidden="true">1</span>
              <div>
                <h3>Try it with the Speech Viewer on</h3>
                <p>Shop as Maya. The Speech Viewer panel shows, word for word, what a screen reader says on every screen.</p>
                <JudgeStart />
              </div>
            </li>
            <li>
              <span className="jpath-n" aria-hidden="true">2</span>
              <div>
                <h3>Check the numbers</h3>
                <p>Every number below is read from a result file written by a script in the repository, on every page load.</p>
                <a className="btn" href="#numbers">
                  Go to the numbers
                </a>
              </div>
            </li>
            <li>
              <span className="jpath-n" aria-hidden="true">3</span>
              <div>
                <h3>Verify a payment receipt yourself</h3>
                <p>Each payment decision is signed. The page re-checks the hash and the Ed25519 signature on load; the repo has an offline verifier.</p>
                {receipt ? (
                  <Link className="btn" href={`/receipts/${receipt.id}`}>
                    Open a real receipt
                  </Link>
                ) : (
                  <p className="muted">No payment has been made on this server yet. Shop as Maya to create one.</p>
                )}
              </div>
            </li>
            <li>
              <span className="jpath-n" aria-hidden="true">4</span>
              <div>
                <h3>Read the code</h3>
                <p>Payment gate, PayPal client, vision checks and every eval script.</p>
                <a className="btn" href={REPO}>
                  Open the repository
                </a>
              </div>
            </li>
          </ol>
        </section>

        <section aria-labelledby="run-all-h" className="grid gap-4">
          <h2 id="run-all-h" className="lp-h2">
            Watch the whole lifecycle run
          </h2>
          <p className="lp-lede">
            One button runs every step for real on the PayPal sandbox: voice request, readback, two-key confirmation, PayPal hold, the wrong size shipped,
            the camera check, and the money back. You hear what Maya hears.
          </p>
          <LifecycleRun ready={INTEGRATIONS.paypal && INTEGRATIONS.vision} missing={[!INTEGRATIONS.paypal && 'PayPal sandbox keys', !INTEGRATIONS.vision && 'the vision service'].filter(Boolean) as string[]} />
        </section>

        <section id="numbers" aria-labelledby="num-h" className="grid gap-4">
          <h2 id="num-h" className="lp-h2">
            Numbers, recomputed on load
          </h2>
          {headlines.length === 0 ? (
            <p className="text-[length:var(--step-1)]">No evaluation has been run on this build yet. Nothing on this page is typed in by hand, so this stays empty until the scripts run.</p>
          ) : (
            <>
              <ul className="lp-mlist">
                {featured.map((h) => (
                  <li key={h.id}>
                    <p className="lp-mval">{h.value}</p>
                    <p>{h.label}</p>
                    {h.baseline && <p className="lp-mbase">Baseline: {h.baseline}</p>}
                  </li>
                ))}
              </ul>
              <details className="jall">
                <summary className="btn">All {headlines.length} results, with intervals, scripts and negative results</summary>
                <ol className="jcards">
                  {headlines.map((h) => (
                    <li key={`${h.suite}-${h.id}`} data-negative={h.negative || undefined}>
                      <p className="jcard-suite">
                        {h.suite}
                        {h.negative && <span className="neg-tag"> · negative result</span>}
                      </p>
                      <p className="jcard-label">{h.label}</p>
                      <p className="jcard-value">{h.value}</p>
                      <dl className="jcard-meta">
                        {h.baseline && (
                          <div>
                            <dt>Baseline</dt>
                            <dd>{h.baseline}</dd>
                          </div>
                        )}
                        {h.interval && (
                          <div>
                            <dt>Interval</dt>
                            <dd>
                              {h.interval}
                              {h.n ? `, n = ${h.n}` : ''}
                            </dd>
                          </div>
                        )}
                        {h.note && (
                          <div>
                            <dt>Note</dt>
                            <dd>{h.note}</dd>
                          </div>
                        )}
                        <div>
                          <dt>Script</dt>
                          <dd>
                            <a href={`${REPO}/blob/main/${h.script}`} className="mono">
                              {h.script}
                            </a>
                          </dd>
                        </div>
                      </dl>
                    </li>
                  ))}
                </ol>
              </details>
            </>
          )}
        </section>

        <section aria-labelledby="live-h" className="grid gap-4">
          <h2 id="live-h" className="lp-h2">
            What is connected on this server
          </h2>
          <ul className="rchecks">
            {live.map(([name, on, what]) => (
              <li key={name} className="rcheck" data-ok={String(on)}>
                <span className="rcheck-mark" aria-hidden="true">
                  {on ? '✓' : '–'}
                </span>
                <span>
                  <strong>
                    {name}: {on ? 'live' : 'not connected'}.
                  </strong>{' '}
                  {what}.
                </span>
              </li>
            ))}
          </ul>
        </section>

        <section aria-labelledby="claims-h" className="grid gap-3">
          <h2 id="claims-h" className="lp-h2">
            What we do not claim
          </h2>
          <ul className="claims">
            <li>It has not yet been tested with blind users. That is the next step.</li>
            <li>Opening a PayPal case for a buyer by API is a sandbox capability; in production buyers file in PayPal’s Resolution Center.</li>
            <li>Orders go to a sandbox Demo Store at the listed price, not to the real retailer.</li>
            <li>Colour in dim light is unreliable; we publish that error rate and the app says “not sure”.</li>
            <li>Maya and Raj are demo personas, not customers. No medical, legal or financial advice.</li>
          </ul>
        </section>

        <section aria-labelledby="run-h" className="grid gap-3">
          <h2 id="run-h" className="lp-h2">
            Sandbox access and running it yourself
          </h2>
          <p>
            No sign-up is needed: “Shop as Maya” uses a seeded demo account. PayPal’s window, when it appears, uses a sandbox buyer account listed in the
            README. To run locally: clone the repository, copy <span className="mono">.env.example</span> to <span className="mono">.env.local</span>, then
            run <span className="mono">pnpm install && pnpm db:up && pnpm db:migrate && pnpm dev</span>.
          </p>
        </section>
      </main>
      <SiteFooter />
    </div>
  );
}
