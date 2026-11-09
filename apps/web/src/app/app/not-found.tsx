import type { Metadata } from 'next';
import Link from 'next/link';

export const metadata: Metadata = { title: 'Not found' };

/**
 * An order or page inside the app that isn't there (an old link, or an order from another
 * account). Renders inside the app layout, so the app's header and navigation stay.
 */
export default function AppNotFound() {
  return (
    <section aria-labelledby="nf-h" className="grid gap-5 max-w-[var(--measure)]">
      <h1 id="nf-h" className="text-[length:var(--step-4)]">
        I couldn’t find that
      </h1>
      <p className="text-[length:var(--step-1)]">
        Nothing is at this address. The link may be old, or the order may belong to another account. Nothing has changed.
      </p>
      <p>Your orders, and where the money is for each one, are on the orders page.</p>
      <div className="flex flex-wrap gap-3">
        <Link className="btn btn-primary btn-xl" href="/app/orders">
          All orders and money
        </Link>
        <Link className="btn btn-xl" href="/app">
          Shop
        </Link>
      </div>
    </section>
  );
}
