'use client';

import { useEffect, useRef, useState } from 'react';

/**
 * PayPal JS SDK v6 checkout for the first purchase. The order is created on our server from the
 * confirmed readback (never from the browser) with `store_in_vault: ON_SUCCESS`, so PayPal saves
 * the buyer's PayPal and later purchases need only the spoken two-key confirmation. v6 vaults
 * with the public client id; no client token is needed.
 */

const SDK_URL = 'https://www.sandbox.paypal.com/web-sdk/v6/core';

type Session = { start: (opts: { presentationMode: string }, order: Promise<{ orderId: string }>) => Promise<void> };
type SdkInstance = {
  findEligibleMethods: (o: { currencyCode: string }) => Promise<{ isEligible: (m: string) => boolean }>;
  createPayPalOneTimePaymentSession: (o: {
    onApprove: (d: { orderId: string }) => void | Promise<void>;
    onCancel?: () => void;
    onError?: (e: { code?: string; message?: string }) => void;
  }) => Session;
};
declare module 'react' {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace JSX {
    interface IntrinsicElements {
      'paypal-button': React.DetailedHTMLProps<React.HTMLAttributes<HTMLElement>, HTMLElement> & { type?: string; class?: string };
    }
  }
}
declare global {
  interface Window {
    paypal?: { createInstance: (o: Record<string, unknown>) => Promise<SdkInstance> };
  }
}

let sdkLoading: Promise<void> | null = null;
function loadSdk(): Promise<void> {
  if (typeof window === 'undefined') return Promise.reject(new Error('no window'));
  if (window.paypal) return Promise.resolve();
  if (!sdkLoading)
    sdkLoading = new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = SDK_URL;
      s.async = true;
      s.onload = () => resolve();
      s.onerror = () => reject(new Error('PayPal SDK failed to load'));
      document.head.appendChild(s);
    });
  return sdkLoading;
}

export function PayPalCheckout({
  clientId,
  readbackId,
  intent,
  onApproved,
  onError,
}: {
  clientId: string;
  readbackId: string;
  intent: 'CAPTURE' | 'AUTHORIZE';
  onApproved: (paypalOrderId: string) => void;
  onError: (message: string) => void;
}) {
  const [state, setState] = useState<'loading' | 'ready' | 'unavailable' | 'working'>('loading');
  const session = useRef<Session | null>(null);

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        await loadSdk();
        if (!clientId) throw new Error('no client id');
        const sdk = await window.paypal!.createInstance({
          clientId,
          components: ['paypal-payments'],
          pageType: 'checkout',
          locale: 'en-US',
        });
        const methods = await sdk.findEligibleMethods({ currencyCode: 'USD' });
        if (!methods.isEligible('paypal')) throw new Error('not eligible');
        session.current = sdk.createPayPalOneTimePaymentSession({
          onApprove: (d) => {
            setState('ready');
            onApproved(d.orderId);
          },
          onCancel: () => {
            setState('ready');
            onError('You closed the PayPal window. Nothing was charged. Press Pay with PayPal to try again.');
          },
          onError: () => {
            setState('ready');
            onError('PayPal could not finish. Nothing was charged. You can try again.');
          },
        });
        if (alive) setState('ready');
      } catch {
        if (alive) setState('unavailable');
      }
    })();
    return () => {
      alive = false;
    };
  }, [clientId, onApproved, onError]);

  const createOrder = async (): Promise<{ orderId: string }> => {
    const res = await fetch('/api/paypal/orders', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ readbackId, intent }),
    });
    if (!res.ok) throw new Error('create order failed');
    return (await res.json()) as { orderId: string };
  };

  const start = async () => {
    if (!session.current) return;
    setState('working');
    try {
      await session.current.start({ presentationMode: 'auto' }, createOrder());
    } catch {
      setState('ready');
      onError('PayPal could not open. Nothing was charged. You can try again.');
    }
  };

  if (state === 'unavailable')
    return (
      <p role="status" className="receipt-note">
        PayPal checkout is not available right now. Nothing was charged.
      </p>
    );

  return (
    <div className="paypal-slot">
      {state === 'ready' ? (
        <paypal-button type="pay" class="paypal-gold" onClick={start} />
      ) : (
        <p role="status">{state === 'loading' ? 'Loading PayPal…' : 'PayPal window open. Finish there, then come back here.'}</p>
      )}
      <p className="receipt-note">A PayPal window opens. Log in there, approve, and you come back here.</p>
    </div>
  );
}
