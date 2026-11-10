import type { ReactNode } from 'react';
import { SiteFooter, SiteHeader } from '@/components/shell/site-chrome';
import { NextPage } from '@/components/shell/site-nav';
import '@/components/landing/landing.css';

/** A public page: header, a short page head with the page's one h1, its sections, the next page, footer. */
export function PublicPage({ path, kicker, title, lede, children }: { path: string; kicker: string; title: string; lede: ReactNode; children: ReactNode }) {
  return (
    <div className="landing">
      <SiteHeader />
      <main id="main" tabIndex={-1}>
        <header className="lx-pagehead">
          <div className="lx-wrap">
            <p className="lx-kicker">{kicker}</p>
            <h1 className="lx-h1 lx-h1-page">{title}</h1>
            <p className="lx-lede">{lede}</p>
          </div>
        </header>
        {children}
        <NextPage from={path} />
      </main>
      <SiteFooter />
    </div>
  );
}
