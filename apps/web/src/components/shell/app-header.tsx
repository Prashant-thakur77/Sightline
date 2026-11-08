'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { Wordmark } from './mark';
import { ThemeSwitch } from './theme-switch';

const NAV = [
  { href: '/app', label: 'Shop' },
  { href: '/app/orders', label: 'Orders and money' },
  { href: '/app/settings', label: 'Settings' },
];

export function AppHeader({ userName }: { userName?: string }) {
  const path = usePathname();
  return (
    <header className="app-header">
      <Link href="/" className="app-home">
        <Wordmark size={22} />
      </Link>
      <nav aria-label="Main">
        <ul className="app-nav">
          {NAV.map((n) => {
            const current = n.href === '/app' ? path === '/app' : path.startsWith(n.href);
            return (
              <li key={n.href}>
                <Link href={n.href} aria-current={current ? 'page' : undefined}>
                  {n.label}
                </Link>
              </li>
            );
          })}
        </ul>
      </nav>
      <div className="app-header-tools">
        {userName && <span className="app-user">Signed in as {userName}</span>}
        <ThemeSwitch />
      </div>
    </header>
  );
}
