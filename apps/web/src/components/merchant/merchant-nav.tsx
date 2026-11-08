'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';

const NAV = [
  { href: '/merchant', label: 'Orders' },
  { href: '/merchant/disputes', label: 'Cases' },
  { href: '/merchant/analytics', label: 'Analytics' },
];

export function MerchantNav() {
  const path = usePathname();
  return (
    <nav aria-label="Demo Store">
      <ul className="mx-nav">
        {NAV.map((n) => {
          const current = n.href === '/merchant' ? path === '/merchant' : path.startsWith(n.href);
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
  );
}
