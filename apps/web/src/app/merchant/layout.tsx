import { currentUser } from '@/server/session';
import Link from 'next/link';
import { PRODUCT_NAME } from '@sightline/core';
import { MerchantNav } from '@/components/merchant/merchant-nav';
import { ThemeSwitch } from '@/components/shell/theme-switch';
import './merchant.css';

export const dynamic = 'force-dynamic';
export const metadata = { title: { default: 'Demo Store', template: `%s · Demo Store · ${PRODUCT_NAME}` } };

export default async function MerchantLayout({ children }: { children: React.ReactNode }) {
  const user = await currentUser();
  return (
    <div className="mx-shell">
      <header className="mx-header">
        <p className="mx-banner">
          <span className="mx-banner-tag" aria-hidden="true">
            Sandbox
          </span>
          <span>Demo Store is a PayPal sandbox test merchant. Demo controls simulate shipping.</span>
        </p>
        <div className="mx-bar">
          <Link href="/merchant" className="mx-brand">
            <span className="mx-tag-mark" aria-hidden="true" />
            <span className="mx-brand-text">
              <span className="mx-brand-name">Demo Store</span>
              <span className="mx-brand-sub">Merchant console</span>
            </span>
          </Link>
          <MerchantNav />
          <div className="mx-tools">
            <Link href="/" className="mx-back">
              Back to {PRODUCT_NAME}
            </Link>
            <ThemeSwitch />
          </div>
        </div>
      </header>
      <main id="main" tabIndex={-1} className="mx-main">
        {user ? (
          children
        ) : (
          <section className="grid gap-4 max-w-[60ch]" aria-labelledby="mx-start-h">
            <h1 id="mx-start-h" className="text-[length:var(--step-4)]">
              Start a demo first
            </h1>
            <p className="text-[length:var(--step-1)]">
              In this demo you play both sides: a shopper and the Demo Store. The console shows only the orders from your own demo shopper, so
              nobody else can ship, refund or cancel them.
            </p>
            <p>
              <Link href="/start" className="btn btn-primary btn-xl">
                Start as a demo shopper
              </Link>
            </p>
          </section>
        )}
      </main>
    </div>
  );
}
