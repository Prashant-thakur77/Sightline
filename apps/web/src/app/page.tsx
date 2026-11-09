import Link from 'next/link';
import { PRODUCT_NAME } from '@sightline/core';
import { SiteFooter, SiteHeader } from '@/components/shell/site-chrome';
import { HeroArt, AgentArt, StoreArt, HelperArt } from '@/components/art/illustrations';
import { Journey, type JourneyStep } from '@/components/landing/journey';
import { featuredHeadlines } from '@/server/headlines';
import '@/components/landing/landing.css';

export const metadata = { title: { absolute: `${PRODUCT_NAME}: is this the one I paid for?` } };
export const revalidate = 300;

const NUMBERS = [
  {
    figure: '95.9%',
    text: 'of the top million home pages have accessibility failures a machine can find. Shop home pages average about 75 errors each.',
    source: 'WebAIM Million, 2026',
    href: 'https://webaim.org/projects/million/',
  },
  {
    figure: '49%',
    text: 'of disabled shoppers who needed to return something had problems doing it. One in seven could not use the return method at all.',
    source: 'Which? with RIDC, 844 disabled consumers',
    href: 'https://www.which.co.uk/policy-and-insight/article/retailers-and-returns-services-potentially-breaking-law-on-returns-for-disabled-consumers-which-finds-ac8dn1v6s5K7',
  },
  {
    figure: '27%',
    text: 'of people who use assistive technology abandon a purchase every month because of accessibility barriers.',
    source: 'Fable, the state of online shopping',
    href: 'https://makeitfable.com/article/insights-the-state-of-online-shopping-for-people-with-disabilities/',
  },
];

const STEPS: JourneyStep[] = [
  {
    key: 'ask',
    label: 'Ask',
    title: 'Say what you need.',
    body: 'Talk or type. Your agent searches real stores, asks one question when it has to, and gives you three options at most, each with the facts that matter: colour, size, price and returns. When a listing does not say, it tells you so.',
    said: '“A warm navy sweater, medium, nothing scratchy, under sixty dollars.”',
  },
  {
    key: 'readback',
    label: 'Hear it back',
    title: 'Hear exactly what you will pay.',
    body: 'Before any money moves, a fixed template, not the AI, reads back the item, colour, size, seller and total. You confirm with your voice and one more press. Saying yes twice can never charge you twice.',
    said: '“Harbor knit crew-neck, navy, size M, from Demo Store. Total $36.72. Say confirm to pay.”',
  },
  {
    key: 'hold',
    label: 'PayPal holds it',
    title: 'The money waits for you.',
    body: 'PayPal holds the payment instead of taking it. The store is paid only after your check passes. If the store does not answer in time, the hold is released by itself.',
    said: '“PayPal is holding $36.72. Demo Store is paid after you check the parcel.”',
  },
  {
    key: 'check',
    label: 'Check it',
    title: 'Check it with your camera.',
    body: 'When the parcel arrives, your phone talks you into frame and takes the photos for you: the item, the size tag, any damage. You hear a plain answer and how sure it is. Not sure? Send a private link to someone you trust.',
    said: '“The tag reads L. You ordered M. I’m fairly sure.”',
  },
  {
    key: 'back',
    label: 'Money back',
    title: 'Get your money back.',
    body: 'Say it is wrong. Your agent signs an evidence pack, talks to the store’s agent and reads you their offer. Accept with two presses, and PayPal releases the hold or refunds you.',
    said: '“Demo Store offers a replacement in size M. Press accept twice to take it.”',
  },
];

const AGENT = [
  {
    title: 'Shops like a friend who knows',
    body: 'It searches several ways, reads the details, compares and explains the trade-offs in plain words, and asks you when it is unsure.',
  },
  {
    title: 'Remembers your sizes and likes',
    body: 'Only when you say so. “I’m a medium in sweaters, nothing with wool.” See, change or forget any of it in Settings.',
  },
  {
    title: 'Answers your money questions',
    body: '“What is on hold?” “When does it expire?” “Did I get my refund?” Answered from your real orders and PayPal’s states, never a guess.',
  },
  {
    title: 'Talks to the store’s agent',
    body: 'The store’s own agent reads the signed evidence and proposes a fix within the store’s rules. You hear it and decide.',
  },
  {
    title: 'Shows every step it took',
    body: 'A plain timeline on every order: what your agent did, with which tool, and when. Nothing happens out of sight.',
  },
  {
    title: 'Never pays on its own',
    body: 'Money moves only after the spoken readback, your yes and a second press, through a safety check that blocks repeats and changed totals.',
  },
];

const PAYPAL = [
  ['Orders v2', 'authorize at checkout, so the money is held, not taken'],
  ['Payments v2', 'capture after the check, void a wrong order, refund, reauthorize'],
  ['Webhooks', 'every PayPal update verified by signature and read aloud'],
  ['Package tracking', 'the carrier and tracking number added to the PayPal order'],
  ['Disputes', 'a case with the signed evidence pack when a store does not answer'],
  ['Vault', 'a returning buyer pays without retyping a card'],
];

/** "0 of 266" never breaks between its words; anything after it, like "(82.7%)", still can. */
const keepCountTogether = (value: string) => value.replace(/(\d) of (\d)/g, '$1 of $2');

export default async function Landing() {
  const measured = await featuredHeadlines(4);
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
                <Link href="#how" className="btn">
                  See how it works
                </Link>
              </div>
              <p className="lx-fine">No sign-up. Everything runs in PayPal’s sandbox, so no real money moves.</p>
            </div>
            <div className="lx-hero-art">
              <HeroArt />
              {/* The moment in miniature: what Maya says, and the money waiting for her check. Decorative
                  (the journey below says the same in full); real text, never text in an image. */}
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
              <li>Render</li>
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

        <section id="how" className="lx-section lx-journey" aria-labelledby="how-h">
          <div className="lx-wrap">
            <h2 id="how-h" className="lx-h2">
              One voice, from asking to money back.
            </h2>
            <p className="lx-sub">Five moments. You stay in charge of every one.</p>
            <Journey steps={STEPS} />
          </div>
        </section>

        <section className="lx-section lx-agent" aria-labelledby="agent-h">
          <div className="lx-wrap lx-agent-grid">
            <div className="lx-agent-intro">
              <h2 id="agent-h" className="lx-h2">
                An agent that works for you, and never pays without you.
              </h2>
              <p className="lx-sub">
                Claude does the legwork: searching, comparing, remembering, checking and negotiating. Money only moves through steps you hear and
                confirm.
              </p>
              <div className="lx-agent-art">
                <AgentArt />
              </div>
            </div>
            <ul className="lx-cards">
              {AGENT.map((a) => (
                <li key={a.title} className="lx-card">
                  <h3>{a.title}</h3>
                  <p>{a.body}</p>
                </li>
              ))}
            </ul>
          </div>
        </section>

        <section id="money" className="lx-section lx-money" aria-labelledby="money-h">
          <div className="lx-wrap">
            <h2 id="money-h" className="lx-h2">
              The money waits for the check.
            </h2>
            <ol className="lx-flow" aria-label="Pay after check, step by step">
              <li>
                <span className="lx-flow-k">Buy</span>
                <span>PayPal authorizes $36.72. Nothing is taken yet.</span>
              </li>
              <li>
                <span className="lx-flow-k">Check</span>
                <span>You check the parcel with your camera.</span>
              </li>
              <li data-tone="good">
                <span className="lx-flow-k">
                  <span aria-hidden="true">✓ </span>It matches
                </span>
                <span>PayPal captures the payment. The store is paid.</span>
              </li>
              <li data-tone="bad">
                <span className="lx-flow-k">
                  <span aria-hidden="true">✕ </span>It is wrong
                </span>
                <span>The store fixes it, or PayPal releases the hold. If the store does not answer in 3 business days, the hold is released anyway.</span>
              </li>
            </ol>
            <h3 className="lx-h3">Built on PayPal, end to end</h3>
            <ul className="lx-apis">
              {PAYPAL.map(([api, what]) => (
                <li key={api}>
                  <strong>{api}</strong>
                  <span>{what}</span>
                </li>
              ))}
            </ul>
          </div>
        </section>

        {measured.length > 0 && (
          <section className="lx-section lx-measured" aria-labelledby="measured-h">
            <div className="lx-wrap">
              <h2 id="measured-h" className="lx-h2">
                Measured, not claimed.
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
                Every number comes from a script in the repository and is read from its result file. The <Link href="/judge#numbers">judge page</Link>{' '}
                lists them all, with the negative results.
              </p>
            </div>
          </section>
        )}

        <section className="lx-section lx-sides" aria-labelledby="sides-h">
          <div className="lx-wrap">
            <h2 id="sides-h" className="lx-h2">
              Fair to stores. Close to family.
            </h2>
            <ul className="lx-sides-grid">
              <li className="lx-side">
                <div className="lx-side-art">
                  <StoreArt />
                </div>
                <h3>For stores</h3>
                <p>
                  A case desk with the signed evidence, a store agent that proposes fixes within your rules, and dashboards that show what was
                  checked and why. Honest buyers get paid-after-check; stores get fewer disputes.
                </p>
                <Link className="link-target" href="/merchant">
                  Open the Demo Store console
                </Link>
              </li>
              <li className="lx-side">
                <div className="lx-side-art">
                  <HelperArt />
                </div>
                <h3>For the people you trust</h3>
                <p>
                  When the camera is not sure, send a private link. Your helper sees only the photos and the listing, never payment details, and
                  answers with one press. The link expires in two days.
                </p>
              </li>
            </ul>
          </div>
        </section>

        <section className="lx-section lx-limits" aria-labelledby="limits-h">
          <div className="lx-wrap">
            <h2 id="limits-h" className="lx-h2">
              What we do not claim
            </h2>
            <ul className="lx-limit-list">
              <li>It is not yet tested with blind users. That is the next step, and we will report what they say.</li>
              <li>
                Opening a PayPal case on a buyer’s behalf by API exists only in PayPal’s sandbox. In production, buyers file in PayPal’s Resolution
                Center; we show how an accessible path could work.
              </li>
              <li>Orders go to a sandbox demo store at the listed price, not to the real retailer.</li>
              <li>Colour in dim light is unreliable. We publish the error rate and say “not sure” rather than guess.</li>
              <li>Maya and Raj are demo personas, not real customers.</li>
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
