import Link from 'next/link';
import { PRODUCT_NAME } from '@sightline/core';
import { SiteFooter, SiteHeader } from '@/components/shell/site-chrome';
import { HeroArt } from '@/components/art/illustrations';
import { NUMBERS } from '@/components/landing/content';
import '@/components/landing/landing.css';

export const metadata = { title: { absolute: `${PRODUCT_NAME}: is this the one I paid for?` } };
export const revalidate = 300;

const EXPLORE = [
  { href: '/how', title: 'How it works', body: 'Five moments, from asking out loud to getting the money back.' },
  { href: '/agents', title: 'The agents', body: 'Your shopping agent, the store’s agent, and the people you trust.' },
  { href: '/paypal', title: 'PayPal and your money', body: 'PayPal holds the payment until the parcel is right.' },
  { href: '/proof', title: 'Proof', body: 'Every number from a script, with its baseline and what we do not claim.' },
];

export default function Landing() {
  return (
    <div className="landing">
      <SiteHeader current="home" />

      <main id="main" tabIndex={-1}>
        <section className="lx-hero" aria-labelledby="hero-h">
          <div className="lx-wrap lx-hero-grid">
            <div className="lx-hero-copy">
              <p className="lx-kicker">For blind and low-vision shoppers</p>
              <h1 id="hero-h" className="lx-h1">
                Is this the one I paid&nbsp;for?
              </h1>
              <p className="lx-lede">
                {PRODUCT_NAME} is a shopping companion you talk to. It reads back exactly what you will pay, lets PayPal hold the money until you have
                checked the parcel with your phone camera, and gets it back when it is wrong.
              </p>
              <div className="lx-ctas">
                <Link href="/start" className="btn btn-primary">
                  Try it as Maya
                </Link>
                <Link href="/how" className="btn">
                  See how it works
                </Link>
              </div>
              <p className="lx-fine">No sign-up. Everything runs in PayPal’s sandbox, so no real money moves.</p>
            </div>
            <div className="lx-hero-art">
              <HeroArt />
              {/* The moment in miniature: what Maya says, and the money waiting for her check. Decorative
                  (How it works says the same in full); real text, never text in an image. */}
              <p className="lx-bubble" aria-hidden="true">
                “A <b>navy</b> crew-neck, size <b>M</b>, under <b>$40</b>.”
              </p>
              <p className="lx-held" aria-hidden="true">
                <span className="lx-held-k">Held by PayPal</span>
                <span className="lx-held-v">$36.72</span>
                <span className="lx-held-n">until you check the parcel</span>
              </p>
            </div>
          </div>
          <div className="lx-wrap">
            <ul className="lx-built" aria-label="Built with">
              <li>PayPal Orders and Payments</li>
              <li>Claude</li>
              <li>Channel3 product data</li>
              <li>AG Studio dashboards</li>
              <li>Bryntum Scheduler</li>
              <li>AWS</li>
            </ul>
          </div>
        </section>

        <section className="lx-section lx-why" aria-labelledby="why-h">
          <div className="lx-wrap">
            <h2 id="why-h" className="lx-h2">
              Finding things got easier. Checking what arrived did not.
            </h2>
            <p className="lx-sub">
              Screen readers and voice assistants help blind people find a product. Whether the parcel is the right one, and getting the money
              back when it is not, is still left to them.
            </p>
            <ul className="lx-numbers">
              {NUMBERS.map((n) => (
                <li key={n.figure}>
                  <p className="lx-figure">{n.figure}</p>
                  <p>{n.text}</p>
                  <p className="lx-source">
                    Source: <a href={n.href}>{n.source}</a>
                  </p>
                </li>
              ))}
            </ul>
          </div>
        </section>

        <section className="lx-section lx-explore" aria-labelledby="explore-h">
          <div className="lx-wrap">
            <h2 id="explore-h" className="lx-h2">
              See it one part at a time.
            </h2>
            <ul className="lx-explore-grid">
              {EXPLORE.map((e) => (
                <li key={e.href} className="lx-explore-card">
                  <h3>
                    <Link href={e.href}>{e.title}</Link>
                  </h3>
                  <p>{e.body}</p>
                </li>
              ))}
            </ul>
          </div>
        </section>

        <section className="lx-cta" aria-labelledby="cta-h">
          <div className="lx-wrap lx-cta-inner">
            <h2 id="cta-h" className="lx-h2">
              Try it the way Maya would.
            </h2>
            <p>Talk or type. Hear the readback. Check a parcel. Get the money back. About three minutes.</p>
            <Link href="/start" className="btn btn-xl lx-cta-btn">
              Try it as Maya
            </Link>
          </div>
        </section>
      </main>

      <SiteFooter />
    </div>
  );
}
