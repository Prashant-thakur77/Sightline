import Link from 'next/link';
import { and, desc, eq, sql } from 'drizzle-orm';
import { tables } from '@sightline/db';
import { PRODUCT_NAME } from '@sightline/core';
import { SiteFooter, SiteHeader } from '@/components/shell/site-chrome';
import { loadSuites } from '@/server/stats';
import { featuredHeadlines } from '@/server/headlines';
import { db, INTEGRATIONS } from '@/server/runtime';
import { currentUser } from '@/server/session';
import { latestDemoTimeline } from '@/server/timeline';
import { JUDGE_EMAIL } from '@/server/lifecycle';
import { AgentTimelineView } from '@/components/orders/agent-timeline';
import { JudgeStart } from './judge-start';
import { LifecycleRun } from './lifecycle-run';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'For judges' };

const REPO = 'https://github.com/Prashant-thakur77/Sightline';

export default async function Judge() {
  const suites = await loadSuites();
  const featured = await featuredHeadlines(6);
  // The same check the run button uses: the lede only promises a run this server can do.
  const runReady = INTEGRATIONS.paypal && INTEGRATIONS.vision;
  const runMissing = [!INTEGRATIONS.paypal && 'PayPal sandbox keys', !INTEGRATIONS.vision && 'the vision service'].filter(Boolean) as string[];
  const headlines = suites.flatMap((s) => s.headlines.map((h) => ({ ...h, suite: s.title, ranAt: h.ranAt ?? s.ranAt, gitSha: h.gitSha ?? s.gitSha })));
  // Show a payment the gate allowed when there is one (a refusal is a less useful first example).
  const [allowed] = await db()
    .select({ id: tables.receipts.id })
    .from(tables.receipts)
    .where(and(eq(tables.receipts.kind, 'gate'), sql`${tables.receipts.body}->>'allowed' = 'true'`))
    .orderBy(desc(tables.receipts.createdAt))
    .limit(1);
  const [anyReceipt] = allowed
    ? [allowed]
    : await db().select({ id: tables.receipts.id }).from(tables.receipts).where(eq(tables.receipts.kind, 'gate')).orderBy(desc(tables.receipts.createdAt)).limit(1);
  const receipt = anyReceipt;
  // The visitor's own latest demo order, or the scripted run's: never another visitor's.
  const demo = await latestDemoTimeline((await currentUser())?.id ?? null, JUDGE_EMAIL).catch(() => null);
  const live: [string, boolean, string][] = [
    ['PayPal sandbox (Orders v2, Vault, Payments, tracking, Disputes, webhooks)', INTEGRATIONS.paypal, 'Every payment, hold, capture, void and refund'],
    ['Claude (agent, confirmation check, vision, case writing)', INTEGRATIONS.anthropic, 'Shopping agent for open requests, second confirmation key, free questions, size-tag reading'],
    ['Channel3 product data', INTEGRATIONS.channel3, 'Real products and variants, searched with the Demo Store catalog; Demo Store catalog alone otherwise'],
    ['Deepgram speech to text', INTEGRATIONS.deepgram, 'Streaming voice input; browser speech otherwise'],
    ['KERNEL cloud browsers', INTEGRATIONS.kernel, 'Reading store pages (the Barrier Index crawl ran on a local browser)'],
    [
      'Vision service',
      INTEGRATIONS.vision,
      INTEGRATIONS.anthropic
        ? 'Colour, the size tag read twice, the product and damage'
        : 'Colour and one size-tag reader only; the product, damage and the second size reader need the Claude key',
    ],
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
                <p>Shop as Maya. The Speech Viewer panel simulates what a screen reader says on every screen, and lists every announcement the app makes.</p>
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
          {runReady ? (
            <p className="lp-lede">
              One button runs every step for real on the PayPal sandbox: voice request, readback, two-key confirmation, PayPal hold, the wrong size
              shipped, the camera check and the money back. Then Demo Store’s own agent reads the signed evidence and answers inside the store’s
              policy, and Maya’s agent reads her the offer and its reasons. You hear what Maya hears.
            </p>
          ) : (
            <p className="lp-lede">
              On a server with PayPal sandbox keys, one button runs every step on the PayPal sandbox, from the voice request to the money back. It is
              switched off here. You can still shop as Maya up to the payment check, open a signed receipt, and read every number below.
            </p>
          )}
          <LifecycleRun ready={runReady} missing={runMissing} />
        </section>

        {demo ? (
          <AgentTimelineView
            steps={demo.steps}
            headingId="agents-h"
            headingClassName="lp-h2"
            heading="What the agents did on the latest demo order"
            intro={
              <p className="lp-lede">
                {demo.whose === 'yours' ? 'Your latest demo order' : 'The latest order from the lifecycle run'}: {demo.title}. Every step, from
                the voice request to PayPal’s last word, with who did it (the buyer, the buyer’s agent, the store’s agent, store staff or PayPal),
                the tool used, whether a model or fixed rules decided it, and PayPal’s own ids and statuses.
              </p>
            }
          />
        ) : (
          <section aria-labelledby="agents-h" className="grid gap-3">
            <h2 id="agents-h" className="lp-h2">
              What the agents did on the latest demo order
            </h2>
            <p>No demo order on this server yet. Run the whole lifecycle above, or shop as Maya, and every step shows here.</p>
          </section>
        )}

        <section id="numbers" aria-labelledby="num-h" className="grid gap-4">
          <h2 id="num-h" className="lp-h2">
            Numbers, read from the result files
          </h2>
          {headlines.length === 0 ? (
            <p className="text-[length:var(--step-1)]">No evaluation has been run on this build yet. Nothing on this page is typed in by hand, so this stays empty until the scripts run.</p>
          ) : (
            <>
              <ul className="lp-mlist">
                {featured.map((h) => (
                  <li key={h.id} data-negative={h.negative || undefined}>
                    {/* Ink on the receipt card in every theme: the red tag colour is too light on it in dark mode. */}
                    {h.negative && <p className="lp-mbase font-bold uppercase">Negative result</p>}
                    <p className="lp-mval">{h.value}</p>
                    <p>{h.label}</p>
                    {h.baseline && <p className="lp-mbase">Baseline: {h.baseline}</p>}
                    {h.context && <p>{h.context}</p>}
                  </li>
                ))}
              </ul>
              <p>
                <Link className="link-target" href="/barrier-index">
                  The Checkout Barrier Index
                </Link>{' '}
                and{' '}
                <Link className="link-target" href="/barrier-index/dashboard">
                  its dashboard
                </Link>
                .
              </p>
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
            No sign-up is needed: “Shop as Maya” uses a seeded demo account. If PayPal’s window appears, sign in with a PayPal sandbox buyer account of
            your own, made in PayPal’s developer dashboard. We do not publish login details. To run locally: clone the repository, copy{' '}
            <span className="mono">.env.example</span> to <span className="mono">.env.local</span>, then run{' '}
            <span className="mono">pnpm install && pnpm db:up && pnpm db:migrate && pnpm dev</span>.
          </p>
        </section>
      </main>
      <SiteFooter />
    </div>
  );
}
