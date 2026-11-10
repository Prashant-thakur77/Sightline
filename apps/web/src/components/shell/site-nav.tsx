'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import { ThemeSwitch } from './theme-switch';

/** The public pages, in reading order. The header lists them all; each page links to the next. */
export const SITE_PAGES = [
  { href: '/how', label: 'How it works' },
  { href: '/agents', label: 'The agents' },
  { href: '/paypal', label: 'PayPal' },
  { href: '/proof', label: 'Proof' },
  { href: '/judge', label: 'For judges' },
] as const;

/**
 * Main navigation for public pages. Wide screens show every link; narrow screens show a Menu button
 * that opens the same list (a disclosure, not a menu widget, so links behave as links). Escape closes
 * it and puts focus back on the button; following a link closes it.
 */
export function SiteNav() {
  const pathname = usePathname();
  const [open, setOpen] = useState(false);
  const button = useRef<HTMLButtonElement>(null);

  useEffect(() => setOpen(false), [pathname]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      setOpen(false);
      button.current?.focus();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open]);

  return (
    <nav aria-label="Main" className="lp-navwrap">
      <button
        ref={button}
        type="button"
        className="btn lp-menu-btn"
        aria-expanded={open}
        aria-controls="site-menu"
        onClick={() => setOpen((o) => !o)}
      >
        <span aria-hidden="true" className="lp-menu-icon" data-open={open} />
        Menu
      </button>
      <ul id="site-menu" className="lp-nav" data-open={open}>
        {SITE_PAGES.map((p) => (
          <li key={p.href}>
            <Link href={p.href} aria-current={pathname === p.href ? 'page' : undefined}>
              {p.label}
            </Link>
          </li>
        ))}
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
  );
}

/** "Next: …" at the end of each public page, so the pages read as one story without the menu. */
export function NextPage({ from }: { from: string }) {
  const i = SITE_PAGES.findIndex((p) => p.href === from);
  const next = SITE_PAGES[i + 1];
  if (!next) return null;
  return (
    <p className="lx-next">
      <Link href={next.href} className="btn btn-xl">
        Next: {next.label} <span aria-hidden="true">→</span>
      </Link>
    </p>
  );
}
