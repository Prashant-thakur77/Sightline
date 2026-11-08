import Link from 'next/link';
import { PRODUCT_NAME } from '@sightline/core';
import { Wordmark } from '@/components/shell/mark';
import { ReadbackHero } from '@/components/landing/readback-hero';

export const metadata = { title: { absolute: `${PRODUCT_NAME}: is this the one I paid for?` } };

const NUMBERS = [
  {
    figure: '95.9%',
    text: 'of the top million home pages have accessibility failures a machine can detect. Store platforms average about 75 errors a page.',
    source: 'WebAIM Million, 2026',
    href: 'https://prioritypixels.co.uk/insights/web-accessibility-is-getting-worse-according-to-the-2026-webaim-million-report/',
  },
  {
    figure: '49%',
    text: 'of disabled shoppers who needed to return something had problems doing it. 14% could not use the return method at all.',
    source: 'Which? with RIDC',
    href: 'https://uk.finance.yahoo.com/news/retailers-returns-services-failing-disabled-consumers-000114090.html',
  },
  {
    figure: '27%',
    text: 'of people using assistive technology abandon purchases every month because of accessibility barriers.',
    source: 'Fable, state of online shopping',
    href: 'https://makeitfable.com/article/insights-the-state-of-online-shopping-for-people-with-disabilities/',
  },
];

const FILE = [
  {
    tab: 'Asked',
    title: 'Shop by voice. Three options, never more.',
    body: 'Say what you need. You hear at most three options, each with the facts that matter: colour, size, price, returns. If the listing does not say something, you hear “the listing doesn’t say”, never a guess.',
    said: '“I need a navy crew-neck sweater, medium, under forty dollars.”',
  },
  {
    tab: 'Paid',
    title: 'Hear exactly what you pay for. Then say yes twice.',
    body: 'Before any money moves, a template, not the AI, reads back the item, colour, size, seller and total. Paying needs your words and a second independent check. A repeated “yes” can never charge you twice: the PayPal request is bound to the readback.',
    said: '“Confirm purchase.”',
  },
  {
    tab: 'Arrived',
    title: 'The parcel is here. Is it the one you paid for?',
    body: 'Point your phone at it. The app talks you into frame (“move back a little”, “there’s a glare”) and takes the photos for you: the item, the size tag, any damage.',
    said: '“It arrived.”',
  },
  {
    tab: 'Checked',
    title: 'A plain answer, and how sure it is.',
    body: 'It compares what arrived with the listing you bought: colour measured in a colour space, the size tag read twice by two different readers, and the product itself. It says “not sure” instead of guessing, and can ask someone you trust to look.',
    said: '“This doesn’t match. The tag reads L, you ordered M. I’m sure about that.”',
  },
  {
    tab: 'Money back',
    title: 'Say “this is wrong”. Get your money back through PayPal.',
    body: 'It builds a signed evidence pack (your order, the readback, the listing as it was, your photos, the check), contacts the seller, opens a PayPal case if needed, reads every update aloud, and lets you accept an offer by voice.',
    said: '“Demo Store offered a full refund of $36.72. Say accept to accept.”',
  },
];

export default function Landing() {
  return (
    <div className="landing">
      <header className="lp-header">
        <Link href="/" className="no-underline" aria-label={`${PRODUCT_NAME}, home`}>
          <Wordmark size={24} />
        </Link>
        <nav aria-label="Main">
          <ul className="lp-nav">
            <li>
              <a href="#how">How it works</a>
            </li>
            <li>
              <a href="#money">Pay after you check</a>
            </li>
            <li>
              <Link href="/judge">For judges</Link>
            </li>
            <li>
              <Link href="/start" className="btn btn-primary">
                Try it
              </Link>
            </li>
          </ul>
        </nav>
      </header>

      <main id="main" tabIndex={-1}>
        <section className="lp-hero" aria-labelledby="hero-h">
          <div className="lp-hero-copy">
            <p className="lp-kicker">For blind and low-vision shoppers</p>
            <h1 id="hero-h" className="lp-h1">
              Is this the one <span className="lp-band">I paid for?</span>
            </h1>
            <p className="lp-lede">
              {PRODUCT_NAME} shops by voice, reads back exactly what you will pay, checks the parcel with your phone camera, and gets your money back
              through PayPal when it is wrong.
            </p>
            <div className="lp-ctas">
              <Link href="/start" className="btn btn-primary btn-xl">
                Try it as Maya
              </Link>
              <Link href="/judge" className="btn btn-xl">
                The 60-second tour
              </Link>
            </div>
            <p className="lp-fine">No sign-up. Payments go to a PayPal sandbox test store, so no real money moves.</p>
          </div>
          <ReadbackHero />
        </section>

        <section className="lp-problem" aria-labelledby="problem-h">
          <h2 id="problem-h" className="lp-h2">
            Tools help blind people find products. Nothing helps them check what arrived, or get their money back.
          </h2>
          <ul className="lp-numbers">
            {NUMBERS.map((n) => (
              <li key={n.figure}>
                <p className="lp-figure">{n.figure}</p>
                <p>{n.text}</p>
                <p className="lp-source">
                  Source: <a href={n.href}>{n.source}</a>
                </p>
              </li>
            ))}
          </ul>
        </section>

        <section id="how" className="lp-file" aria-labelledby="file-h">
          <h2 id="file-h" className="lp-h2">
            Every order is a case file. Five moments, one voice.
          </h2>
          <nav aria-label="The five moments" className="lp-index">
            <ol>
              {FILE.map((f, i) => (
                <li key={f.tab}>
                  <a href={`#moment-${i + 1}`}>
                    <span className="lp-index-n" aria-hidden="true">
                      {i + 1}
                    </span>
                    {f.tab}
                  </a>
                </li>
              ))}
            </ol>
          </nav>
          <ol className="folders">
            {FILE.map((f, i) => (
              <li key={f.tab} id={`moment-${i + 1}`} className="folder" style={{ ['--k' as string]: i }}>
                <p className="folder-tab">
                  <span className="sr-only">Moment {i + 1}: </span>
                  {f.tab}
                </p>
                <div className="folder-body">
                  <h3 className="folder-h">{f.title}</h3>
                  <p>{f.body}</p>
                  <p className="folder-said">
                    <span className="sr-only">For example: </span>
                    {f.said}
                  </p>
                </div>
              </li>
            ))}
          </ol>
        </section>

        <section id="money" className="lp-money" aria-labelledby="money-h">
          <div>
            <h2 id="money-h" className="lp-h2">
              Money waits for the check.
            </h2>
            <p className="lp-lede">
              With stores that opt in, PayPal only holds the payment when you buy. The store is paid when the camera check passes. If the wrong item
              arrives, the hold is cancelled and the money never leaves your account.
            </p>
          </div>
          <ol className="flow" aria-label="Pay after check, step by step">
            <li>
              <span className="flow-k">Buy</span>
              <span>PayPal authorizes $36.72. Nothing is taken yet.</span>
            </li>
            <li>
              <span className="flow-k">Check</span>
              <span>You check the parcel with your camera.</span>
            </li>
            <li data-ok="">
              <span className="flow-k">✓ Matches</span>
              <span>PayPal captures the payment. The store is paid.</span>
            </li>
            <li data-bad="">
              <span className="flow-k">✕ Wrong item</span>
              <span>PayPal voids the hold. Your money never moved.</span>
            </li>
          </ol>
        </section>

        <section className="lp-claims" aria-labelledby="claims-h">
          <h2 id="claims-h" className="lp-h2">
            What we do not claim
          </h2>
          <ul>
            <li>It is not yet tested with blind users. That is the next step, and we will report what they say.</li>
            <li>Opening a PayPal case on a buyer’s behalf by API exists only in PayPal’s sandbox. In production, buyers file in PayPal’s Resolution Center; we show how an accessible path could work.</li>
            <li>Orders go to a sandbox demo store at the listed price, not to the real retailer.</li>
            <li>Colour in dim light is unreliable. We publish the error rate and say “not sure” rather than guess.</li>
            <li>Maya and Raj are demo personas, not real customers.</li>
          </ul>
        </section>
      </main>

      <footer className="lp-footer">
        <Wordmark size={20} />
        <p>Built for the PayPal AI Hackathon. PayPal sandbox only. No real money moves.</p>
        <p>
          <Link href="/judge">Judges start here</Link> · <Link href="/barrier-index">Checkout Barrier Index</Link>
        </p>
      </footer>
    </div>
  );
}
