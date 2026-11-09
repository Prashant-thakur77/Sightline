// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { useEffect } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AnnouncerProvider, useAnnouncer } from '@/components/a11y/announcer';
import { PayPalCheckout, paypalWindowSentence } from '@/components/conversation/paypal-checkout';

/* Before PayPal's own window opens, the buyer hears in one sentence what it will ask and how to
   come back; the same sentence describes the button; on return, the result is said. */

const settle = () =>
  act(async () => {
    for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 20));
  });

let said: string[] = [];
function Listen() {
  const { subscribe } = useAnnouncer();
  useEffect(() => subscribe((a) => said.push(a.text)), [subscribe]);
  return null;
}

afterEach(() => {
  cleanup();
  said = [];
  delete (window as { paypal?: unknown }).paypal;
});

function fakePayPal(outcome: 'approve' | 'cancel') {
  window.paypal = {
    createInstance: async () => ({
      findEligibleMethods: async () => ({ isEligible: () => true }),
      createPayPalOneTimePaymentSession: (h: { onApprove: (d: { orderId: string }) => void; onCancel?: () => void }) => ({
        start: async () => {
          if (outcome === 'approve') await h.onApprove({ orderId: 'PP-1' });
          else h.onCancel?.();
        },
      }),
    }),
  };
}

describe('PayPal approval, spoken', () => {
  it('says what the window will ask and how to come back, once, and on the button too', async () => {
    fakePayPal('approve');
    render(
      <AnnouncerProvider>
        <Listen />
        <PayPalCheckout clientId="sandbox-client" paypalOrderId="PP-1" total="$36.72" onApproved={() => {}} onError={() => {}} />
      </AnnouncerProvider>,
    );
    await settle();
    const sentence = paypalWindowSentence('$36.72');
    expect(sentence).toBe(
      "When you press Pay with PayPal, PayPal's own window opens and asks you to log in and approve $36.72; when you approve or close it, you come straight back here and I tell you what happened.",
    );
    expect(said.filter((s) => s === sentence)).toHaveLength(1);
    const button = document.querySelector('paypal-button')!;
    expect(document.getElementById(button.getAttribute('aria-describedby')!)!.textContent).toBe(sentence);
  });

  it('says the result on return, then finishes the order', async () => {
    fakePayPal('approve');
    const onApproved = vi.fn();
    render(
      <AnnouncerProvider>
        <Listen />
        <PayPalCheckout clientId="sandbox-client" paypalOrderId="PP-1" total="$36.72" onApproved={onApproved} onError={() => {}} />
      </AnnouncerProvider>,
    );
    await settle();
    fireEvent.click(document.querySelector('paypal-button')!);
    await settle();
    expect(said).toContain("Back from PayPal. You approved $36.72. I'm finishing the order now.");
    expect(onApproved).toHaveBeenCalledWith('PP-1');
  });

  it('a closed window is reported with nothing charged', async () => {
    fakePayPal('cancel');
    const onError = vi.fn();
    render(
      <AnnouncerProvider>
        <PayPalCheckout clientId="sandbox-client" paypalOrderId="PP-1" total="$36.72" onApproved={() => {}} onError={onError} />
      </AnnouncerProvider>,
    );
    await settle();
    fireEvent.click(document.querySelector('paypal-button')!);
    await settle();
    expect(onError).toHaveBeenCalledWith('You closed the PayPal window. Nothing was charged. Press Pay with PayPal to try again.');
    expect(screen.queryByText(/PayPal window open/)).toBeNull();
  });
});
