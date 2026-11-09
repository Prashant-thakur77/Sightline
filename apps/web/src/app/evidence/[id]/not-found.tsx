import type { Metadata } from 'next';
import Link from 'next/link';
import { SiteFooter, SiteHeader } from '@/components/shell/site-chrome';
import '../../proof-pages.css';

export const metadata: Metadata = { title: 'Evidence pack not found' };

/** An evidence pack address with no pack behind it. Has its own main, so the skip link always lands. */
export default function EvidenceNotFound() {
  return (
    <>
      <SiteHeader />
      <main id="main" tabIndex={-1} className="w-full max-w-[960px] mx-auto px-[clamp(1rem,3vw,2.5rem)] py-[var(--space-7)] grid gap-5 content-start">
        <p className="eyebrow">Evidence pack</p>
        <h1 className="text-[length:var(--step-4)] max-w-[22ch]">Evidence pack not found</h1>
        <p className="text-[length:var(--step-1)] max-w-[var(--measure)]">
          No evidence pack has this address. The link may be cut short. Open the pack again from the order or the case it belongs to.
        </p>
        <p className="flex flex-wrap gap-3">
          <Link className="btn btn-primary" href="/app/orders">
            Go to your orders
          </Link>
          <Link className="btn" href="/merchant/disputes">
            Go to the store&apos;s cases
          </Link>
        </p>
      </main>
      <SiteFooter />
    </>
  );
}
