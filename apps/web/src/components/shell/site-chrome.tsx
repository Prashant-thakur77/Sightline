import Link from 'next/link';
import { PRODUCT_NAME } from '@sightline/core';
import { Wordmark } from './mark';
import { SiteNav } from './site-nav';
import { REPO_URL, VIDEO_URL } from '@/lib/links';

/** Header for public pages: same wordmark, nav and theme switch everywhere. The current page is marked by the nav itself. */
export function SiteHeader(_props: { current?: 'home' | 'judge' | 'barrier' }) {
  return (
    <header className="lp-header">
      <Link href="/" className="no-underline lp-home" aria-label={`${PRODUCT_NAME}, home`}>
        <Wordmark size={24} />
      </Link>
      <SiteNav />
    </header>
  );
}

export function SiteFooter() {
  return (
    <footer className="lp-footer">
      <Wordmark size={20} />
      <p>Built for the PayPal AI Hackathon. PayPal sandbox only. No real money moves.</p>
      <p>
        <Link className="link-target" href="/judge">
          Judges start here
        </Link>{' '}
        ·{' '}
        <Link className="link-target" href="/barrier-index">
          Checkout Barrier Index
        </Link>{' '}
        ·{' '}
        <Link className="link-target" href="/merchant">
          Demo Store console
        </Link>
      </p>
      <p>
        {VIDEO_URL && (
          <>
            <a className="link-target" href={VIDEO_URL}>
              Watch the demo video (YouTube)
            </a>{' '}
            ·{' '}
          </>
        )}
        <a className="link-target" href={REPO_URL}>
          Source code on GitHub
        </a>{' '}
        · MIT licence
      </p>
    </footer>
  );
}
