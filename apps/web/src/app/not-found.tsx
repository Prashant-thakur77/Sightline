import type { Metadata } from 'next';
import Link from 'next/link';
import { SiteFooter, SiteHeader } from '@/components/shell/site-chrome';

export const metadata: Metadata = { title: 'Page not found' };

/** Every unknown address, and every notFound() from a page. Renders inside the root layout only. */
export default function NotFound() {
  return (
    <div className="min-h-dvh grid grid-rows-[auto_1fr_auto]">
      <SiteHeader />
      <main id="main" tabIndex={-1} className="w-full max-w-[880px] mx-auto px-[clamp(1rem,3vw,2.5rem)] py-[var(--space-7)] grid gap-5 content-start">
        <h1 className="text-[length:var(--step-4)]">Page not found</h1>
        <p className="text-[length:var(--step-1)] max-w-[var(--measure)]">Nothing is at this address, so start again from the home page.</p>
        <p>
          <Link className="btn btn-primary btn-xl" href="/">
            Go to the home page
          </Link>
        </p>
      </main>
      <SiteFooter />
    </div>
  );
}
