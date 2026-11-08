// @vitest-environment jsdom
import { StrictMode } from 'react';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Verdict } from '@sightline/core';
import { AnnouncerProvider } from '@/components/a11y/announcer';
import { AskHelper } from '@/components/orders/ask-helper';
import { MoneyBack } from '@/components/orders/money-back';
import { VerdictView } from '@/components/check/verdict-view';
import { HelperAnswer } from '@/app/helper/[token]/helper-answer';
import { CaseDesk } from '@/components/merchant/case-desk';
import type { MerchantCase } from '@/server/merchant';

vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: () => undefined, push: () => undefined }) }));

/*
 * Focus and messages when a control is busy, replaced or fails (WCAG 2.4.3, 3.3.1, 4.1.3):
 * a busy control keeps focus, a replaced one hands focus to its replacement, a network failure
 * is shown and announced, and text that receives focus is not also put in a live region.
 */

const OFFLINE = 'Could not reach the server. Nothing changed. Try again.';

const json = (body: unknown, status = 200) => Promise.resolve(new Response(JSON.stringify(body), { status }));
const offline = () => Promise.reject(new TypeError('Failed to fetch'));

/** Everything sent to the announcer, and what reached a live region. */
const announced = () => (window as unknown as { __announcements?: string[] }).__announcements ?? [];
const live = () => [...document.querySelectorAll('[data-announcer]')].map((r) => r.textContent ?? '').join(' ');
/** The error shown on the page (not the copy in the live region). */
const shownError = () => document.querySelector('.card-refusal')?.textContent ?? null;

/** Runs pending promises, effects and animation frames. */
const settle = () =>
  act(async () => {
    for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 20));
  });

const wrap = (ui: React.ReactNode) => render(<AnnouncerProvider>{ui}</AnnouncerProvider>);

let fetchMock: ReturnType<typeof vi.fn>;
beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
  (window as unknown as { __announcements?: string[] }).__announcements = [];
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('AskHelper', () => {
  it('shows and announces a network failure, clears busy and keeps focus on the button', async () => {
    fetchMock.mockImplementation(offline);
    wrap(<AskHelper orderId="ord_1" helperName="Asha" />);
    const ask = screen.getByRole('button', { name: 'Ask Asha to look' });
    ask.focus();
    fireEvent.click(ask);
    expect(ask.getAttribute('aria-disabled')).toBe('true');
    expect(ask).toHaveProperty('disabled', false);
    await settle();
    expect(shownError()).toBe(OFFLINE);
    expect(announced()).toContain(OFFLINE);
    expect(ask.getAttribute('aria-disabled')).toBeNull();
    expect(document.activeElement).toBe(ask);
  });

  it('ignores a second press while busy', async () => {
    let finish: (r: Response) => void = () => undefined;
    fetchMock.mockImplementation(() => new Promise<Response>((r) => (finish = r)));
    wrap(<AskHelper orderId="ord_1" helperName="Asha" />);
    const ask = screen.getByRole('button', { name: 'Ask Asha to look' });
    fireEvent.click(ask);
    fireEvent.click(screen.getByRole('button', { name: 'Making a link…' }));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    finish(new Response(JSON.stringify({ link: 'https://example.test/h/abc' })));
    await settle();
  });

  it('moves focus to the link when it is made, and back to the button when it is cancelled', async () => {
    fetchMock.mockImplementationOnce(() => json({ link: 'https://example.test/h/abc' }));
    wrap(<AskHelper orderId="ord_1" helperName="Asha" />);
    const ask = screen.getByRole('button', { name: 'Ask Asha to look' });
    ask.focus();
    fireEvent.click(ask);
    await settle();
    expect(document.activeElement).toBe(screen.getByLabelText('Link for Asha'));

    fetchMock.mockImplementationOnce(offline);
    fireEvent.click(screen.getByRole('button', { name: 'Cancel this link' }));
    await settle();
    expect(shownError()).toBe(OFFLINE);
    expect(screen.getByLabelText('Link for Asha')).toBeTruthy();

    fetchMock.mockImplementationOnce(() => json({ revoked: 1 }));
    fireEvent.click(screen.getByRole('button', { name: 'Cancel this link' }));
    await settle();
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Ask Asha to look' }));
  });
});

describe('HelperAnswer', () => {
  it('shows and announces a network failure and clears busy', async () => {
    fetchMock.mockImplementation(offline);
    wrap(<HelperAnswer token="t" answered={false} buyerName="Maya" />);
    const yes = screen.getByRole('button', { name: 'It matches' });
    yes.focus();
    fireEvent.click(yes);
    await settle();
    expect(shownError()).toBe(OFFLINE);
    expect(announced()).toContain(OFFLINE);
    expect(yes.getAttribute('aria-disabled')).toBeNull();
    expect(document.activeElement).toBe(yes);
  });

  it('names the answer buttons without their glyphs', () => {
    wrap(<HelperAnswer token="t" answered={false} buyerName="Maya" />);
    for (const name of ['It matches', 'It’s different', 'I can’t tell']) expect(screen.getByRole('button', { name })).toBeTruthy();
  });

  it('focuses the thank-you line and does not also put it in a live region', async () => {
    fetchMock.mockImplementation(() => json({ ok: true }));
    wrap(<HelperAnswer token="t" answered={false} buyerName="Maya" />);
    fireEvent.click(screen.getByRole('button', { name: 'It matches' }));
    await settle();
    const done = screen.getByText(/Thank you\. Maya has your answer/);
    expect(document.activeElement).toBe(done);
    expect(announced()).toContain('Thank you. Maya has your answer.');
    expect(live()).not.toContain('Thank you');
  });

  it('does not take focus when the page loads already answered', () => {
    wrap(<HelperAnswer token="t" answered buyerName="Maya" />);
    expect(document.activeElement).toBe(document.body);
  });
});

describe('MoneyBack', () => {
  const preview = { caseId: 'cas_1', evidencePackId: 'evp_1', summary: 'The size tag says L.', path: 'refund-request', amount: '$36.72' };

  it('returns focus to "Get my money back" after "Not now"', async () => {
    fetchMock.mockImplementation(() => json(preview));
    wrap(<MoneyBack orderId="ord_1" canStart />);
    fireEvent.click(screen.getByRole('button', { name: 'Get my money back' }));
    await settle();
    expect(document.activeElement).toBe(screen.getByRole('heading', { name: 'Before I send it' }));
    fireEvent.click(screen.getByRole('button', { name: 'Not now' }));
    await settle();
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Get my money back' }));
  });

  it('focuses the result after sending and does not also put it in a live region', async () => {
    fetchMock.mockImplementationOnce(() => json(preview));
    wrap(<MoneyBack orderId="ord_1" canStart />);
    fireEvent.click(screen.getByRole('button', { name: 'Get my money back' }));
    await settle();
    fetchMock.mockImplementationOnce(() => json({ say: 'Sent to Demo Store. They have 3 days to reply.' }));
    const send = screen.getByRole('button', { name: 'Send it to Demo Store' });
    send.focus();
    fireEvent.click(send);
    expect(send.getAttribute('aria-disabled')).toBe('true');
    expect(document.activeElement).toBe(send);
    await settle();
    expect(document.activeElement).toBe(screen.getByText('Sent to Demo Store. They have 3 days to reply.'));
    expect(announced()).toContain('Sent to Demo Store. They have 3 days to reply.');
    expect(live()).not.toContain('Sent to Demo Store');
  });

  it('shows and announces a network failure in plain words and keeps focus on the button', async () => {
    fetchMock.mockImplementation(offline);
    wrap(<MoneyBack orderId="ord_1" canStart />);
    const start = screen.getByRole('button', { name: 'Get my money back' });
    start.focus();
    fireEvent.click(start);
    await settle();
    expect(shownError()).toBe('Could not reach the server. Nothing was sent. Try again.');
    expect(announced()).toContain('Could not reach the server. Nothing was sent. Try again.');
    expect(document.activeElement).toBe(start);
  });

  it('does not take focus when the result was already there on load', () => {
    wrap(<MoneyBack orderId="ord_1" canStart done="Refunded." />);
    expect(document.activeElement).toBe(document.body);
  });
});

describe('VerdictView', () => {
  const verdict = (headline: string): Verdict => ({ kind: 'mismatch', headline, reasons: [], nextSteps: [] }) as unknown as Verdict;
  const ordered = { title: 'Harbor knit crew-neck sweater' };

  it('leaves focus alone on load under Strict Mode, then focuses a new verdict', async () => {
    const first = verdict('This is not what you ordered.');
    const { rerender } = render(
      <StrictMode>
        <VerdictView verdict={first} ordered={ordered} focusOnMount={false} />
      </StrictMode>,
    );
    await settle();
    expect(document.activeElement).toBe(document.body);
    rerender(
      <StrictMode>
        <VerdictView verdict={verdict('It matches.')} ordered={ordered} focusOnMount={false} />
      </StrictMode>,
    );
    await settle();
    expect(document.activeElement).toBe(screen.getByRole('heading', { name: 'It matches.' }));
  });

  it('focuses a fresh verdict on mount', async () => {
    render(
      <StrictMode>
        <VerdictView verdict={verdict('It matches.')} ordered={ordered} />
      </StrictMode>,
    );
    await settle();
    expect(document.activeElement).toBe(screen.getByRole('heading', { name: 'It matches.' }));
  });
});

describe('CaseDesk', () => {
  const kase = (open: boolean) =>
    ({
      id: 'cas_1',
      ref: 'C1',
      orderId: 'ord_1',
      orderRef: 'O1',
      buyer: 'Maya',
      item: 'crew-neck sweater',
      colour: null,
      size: null,
      amount: '$36.72',
      stage: open ? 'seller_contacted' : 'resolved',
      status: { word: open ? 'Waiting for Demo Store' : 'Resolved', glyph: open ? '…' : '✓', tone: open ? 'waiting' : 'good' },
      open,
      reason: 'wrong size',
      title: 'Maya’s crew-neck sweater may be the wrong size',
      createdAt: '2026-11-01T00:00:00.000Z',
      dueAt: null,
      dueWords: null,
      overdue: false,
      evidencePackId: null,
      evidenceSummary: null,
      readbackText: null,
      verdict: null,
      shippingRecord: null,
      payment: { word: 'Held', glyph: '…', tone: 'waiting' },
      refundPath: 'void',
      offers: [],
      outcome: null,
      suggestion: { action: 'refund', title: 'Release the hold', why: 'The check found the wrong size.' },
      dispute: null,
    }) as unknown as MerchantCase;

  it('focuses the result instead of announcing it, and keeps it focused when the case moves to Closed', async () => {
    const message = 'Released the $36.72 hold. The case is closed.';
    fetchMock.mockImplementation(() => json({ ok: true, message }));
    const { rerender } = wrap(<CaseDesk cases={[kase(true)]} />);
    fireEvent.click(screen.getByRole('button', { name: /^Refund in full/ }));
    await settle();
    fireEvent.click(screen.getByRole('button', { name: 'Yes, release $36.72' }));
    await settle();
    expect(document.activeElement?.id).toBe('case-cas_1-result');
    expect(announced()).toContain(message);
    expect(live()).not.toContain('Released');

    // The refresh closes the case: its card is rebuilt under Closed.
    rerender(
      <AnnouncerProvider>
        <CaseDesk cases={[kase(false)]} />
      </AnnouncerProvider>,
    );
    await settle();
    expect(screen.getByRole('heading', { name: /Closed/ })).toBeTruthy();
    expect(document.activeElement?.id).toBe('case-cas_1-result');
    expect(document.activeElement?.textContent).toContain(message);
  });
});
