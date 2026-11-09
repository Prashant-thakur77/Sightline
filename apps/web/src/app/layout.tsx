import type { Metadata, Viewport } from 'next';
import { Atkinson_Hyperlegible_Mono, Atkinson_Hyperlegible_Next, Fraunces } from 'next/font/google';
import { PRODUCT_NAME } from '@sightline/core';
import { AnnouncerProvider } from '@/components/a11y/announcer';
import { ThemeBoot } from '@/components/shell/theme-boot';
import './globals.css';
import '@/components/art/art.css';

const sans = Atkinson_Hyperlegible_Next({
  subsets: ['latin'],
  variable: '--font-atkinson',
  display: 'swap',
  weight: ['400', '500', '700', '800'],
});
/** Display serif for headlines only (28px and up); soft and warm at heavy weights. */
const display = Fraunces({
  subsets: ['latin'],
  variable: '--font-fraunces',
  display: 'swap',
  axes: ['SOFT', 'opsz'],
});
const mono = Atkinson_Hyperlegible_Mono({
  subsets: ['latin'],
  variable: '--font-atkinson-mono',
  display: 'swap',
  weight: ['400', '700'],
});

export const metadata: Metadata = {
  title: { default: `${PRODUCT_NAME}: shop, check and get your money back, by voice`, template: `%s · ${PRODUCT_NAME}` },
  description:
    'A voice-first shopping agent for blind and low-vision people. It reads back exactly what you pay for, checks the parcel with your phone camera, and gets your money back through PayPal when the item is wrong.',
  applicationName: PRODUCT_NAME,
  manifest: '/manifest.webmanifest',
};

export const viewport: Viewport = {
  themeColor: [
    { media: '(prefers-color-scheme: light)', color: '#f3f6fb' },
    { media: '(prefers-color-scheme: dark)', color: '#0a0f1f' },
  ],
};

/**
 * Applies the saved theme and text scale before first paint so nothing flashes or shifts. With no
 * saved theme, a device set to more contrast gets the high-contrast theme.
 */
const themeScript = `(function(){try{var t=localStorage.getItem('sl-theme');if(t)document.documentElement.dataset.theme=t;else if(window.matchMedia&&matchMedia('(prefers-contrast: more)').matches)document.documentElement.dataset.theme='contrast';var s=parseFloat(localStorage.getItem('sl-text-scale')||'1');if(s>1)document.documentElement.style.setProperty('--text-scale',String(s));}catch(e){}})();`;

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${sans.variable} ${mono.variable} ${display.variable}`} suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeScript }} />
      </head>
      <body>
        <a className="skip-link" href="#main">
          Skip to main content
        </a>
        <ThemeBoot />
        <AnnouncerProvider>{children}</AnnouncerProvider>
      </body>
    </html>
  );
}
