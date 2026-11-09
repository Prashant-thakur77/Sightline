import type { Metadata } from 'next';
import Link from 'next/link';
import { SiteFooter, SiteHeader } from '@/components/shell/site-chrome';
import '../../proof-pages.css';

export const metadata: Metadata = { title: 'Receipt not found' };

/** A receipt address with no receipt behind it. Has its own main, so the skip link always lands. */
export default function ReceiptNotFound() {
  return (
    <>
      <SiteHeader />
      <main id="main" tabIndex={-1} className="w-full max-w-[920px] mx-auto px-[clamp(1rem,3vw,2.5rem)] py-[var(--space-7)] grid gap-5 content-start">
        <p className="eyebrow">Receipt</p>
        <h1 className="text-[length:var(--step-4)] max-w-[20ch]">Receipt not found</h1>
        <p className="text-[length:var(--step-1)] max-w-[var(--measure)]">
          No receipt has this address. The link may be cut short. Open the receipt again from the order it belongs to.
        </p>
        <p className="flex flex-wrap gap-3">
          <Link className="btn btn-primary" href="/app/orders">
            Go to your orders
          </Link>
          <Link className="btn" href="/judge">
            Go to the judges&apos; page
          </Link>
        </p>
      </main>
      <SiteFooter />
    </>
  );
}
