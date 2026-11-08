'use client';

import Link from 'next/link';
import { useEffect, useRef, useSyncExternalStore } from 'react';
import { useAnnouncer } from '@/components/a11y/announcer';

const subscribe = (onChange: () => void) => {
  window.addEventListener('online', onChange);
  window.addEventListener('offline', onChange);
  return () => {
    window.removeEventListener('online', onChange);
    window.removeEventListener('offline', onChange);
  };
};

/**
 * When a page inside the app fails, this replaces only the page: the header and navigation stay.
 * Focus moves to the heading, which says what happened, so nothing is also sent to a live region.
 */
export default function AppError({ error, retry }: { error: unknown; retry: () => void }) {
  const heading = useRef<HTMLHeadingElement>(null);
  const { announce } = useAnnouncer();
  const online = useSyncExternalStore(
    subscribe,
    () => navigator.onLine,
    () => true,
  );
  const what = online ? 'This page didn’t load. It may be a short problem on our side.' : 'You’re offline, so this page didn’t load.';

  useEffect(() => {
    console.error(error);
    heading.current?.focus();
    announce(`That didn’t load. ${what}`, { politeness: 'assertive', source: 'page', live: false });
    // Once per error, not again on every online or offline change.
  }, [error]);

  return (
    <section aria-labelledby="error-h" className="grid gap-5 max-w-[var(--measure)]">
      <h1 id="error-h" ref={heading} tabIndex={-1} className="text-[length:var(--step-4)]">
        That didn’t load
      </h1>
      <p className="text-[length:var(--step-1)]">{what}</p>
      <p>Everything you saved before is still saved. Press Try again to load the page again{online ? '' : ' when you’re back online'}.</p>
      <div className="flex flex-wrap gap-3">
        <button type="button" className="btn btn-primary btn-xl" onClick={() => retry()}>
          Try again
        </button>
        <Link className="btn btn-xl" href="/app/orders">
          See orders and money
        </Link>
      </div>
    </section>
  );
}
