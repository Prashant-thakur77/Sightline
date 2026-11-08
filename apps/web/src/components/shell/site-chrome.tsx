import Link from 'next/link';
import { PRODUCT_NAME } from '@sightline/core';
import { Wordmark } from './mark';
import { ThemeSwitch } from './theme-switch';

/** Header for public pages: same wordmark, nav and theme switch everywhere. */
export function SiteHeader({ current }: { current?: 'home' | 'judge' | 'barrier' }) {
  return (
    <header className="lp-header">
      <Link href="/" className="no-underline" aria-label={`${PRODUCT_NAME}, home`}>
        <Wordmark size={24} />
      </Link>
      <nav aria-label="Main">
        <ul className="lp-nav">
          <li>
            <Link href="/#how">How it works</Link>
          </li>
          <li>
            <Link href="/judge" aria-current={current === 'judge' ? 'page' : undefined}>
              For judges
            </Link>
          </li>
          <li>
            <Link href="/barrier-index" aria-current={current === 'barrier' ? 'page' : undefined}>
              Barrier Index
            </Link>
          </li>
          <li>
            <ThemeSwitch />
          </li>
          <li>
            <Link href="/start" className="btn btn-primary">
              Try it
            </Link>
          </li>
        </ul>
      </nav>
    </header>
  );
}

export function SiteFooter() {
  return (
    <footer className="lp-footer">
      <Wordmark size={20} />
      <p>Built for the PayPal AI Hackathon. PayPal sandbox only. No real money moves.</p>
      <p>
        <Link href="/judge">Judges start here</Link> · <Link href="/barrier-index">Checkout Barrier Index</Link> · <Link href="/merchant">Demo Store console</Link>
      </p>
    </footer>
  );
}
