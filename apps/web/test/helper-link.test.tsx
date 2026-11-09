// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AnnouncerProvider } from '@/components/a11y/announcer';
import { AskHelper } from '@/components/orders/ask-helper';

vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: () => undefined, push: () => undefined }) }));

/* Sending the helper's link: the share sheet when the phone has one, else copy, with the text
   field kept as a fallback, focus kept on the button, and errors that say what to do. */

const LINK = 'https://example.test/h/abc';
const settle = () =>
  act(async () => {
    for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 20));
  });
const announced = () => (window as unknown as { __announcements?: string[] }).__announcements ?? [];
const shownError = () => document.querySelector('#helper .card-refusal')?.textContent ?? null;

async function makeLink() {
  render(
    <AnnouncerProvider>
      <AskHelper orderId="ord_1" helperName="Asha" />
    </AnnouncerProvider>,
  );
  fireEvent.click(screen.getByRole('button', { name: 'Ask Asha to look' }));
  await settle();
}

function setNavigator(key: 'share' | 'clipboard', value: unknown) {
  Object.defineProperty(navigator, key, { value, configurable: true, writable: true });
}

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(new Response(JSON.stringify({ link: LINK }), { status: 200 }))));
  (window as unknown as { __announcements?: string[] }).__announcements = [];
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  setNavigator('share', undefined);
  setNavigator('clipboard', undefined);
});

describe('sending the helper link', () => {
  it('copies the link, says what to do with it, and keeps focus on the button', async () => {
    const writeText = vi.fn(() => Promise.resolve());
    setNavigator('clipboard', { writeText });
    await makeLink();
    const copy = screen.getByRole('button', { name: 'Copy the link' });
    expect(document.activeElement).toBe(copy);
    fireEvent.click(copy);
    await settle();
    expect(writeText).toHaveBeenCalledWith(LINK);
    expect(announced()).toContain('Link copied. Paste it into a message to Asha.');
    expect(document.querySelector('#helper .helper-status')?.textContent).toBe('Link copied. Paste it into a message to Asha.');
    expect(document.activeElement).toBe(copy);
    // The text field stays as a fallback.
    expect((screen.getByLabelText('Link for Asha') as HTMLInputElement).value).toBe(LINK);
  });

  it('says how to copy by hand when copying fails', async () => {
    setNavigator('clipboard', { writeText: () => Promise.reject(new Error('denied')) });
    await makeLink();
    const copy = screen.getByRole('button', { name: 'Copy the link' });
    fireEvent.click(copy);
    await settle();
    expect(shownError()).toMatch(/^I couldn’t copy the link\. Go to the field named Link for Asha/);
    expect(announced().some((a) => a.startsWith('I couldn’t copy the link.'))).toBe(true);
    expect(document.activeElement).toBe(copy);
  });

  it('uses the share sheet when the phone has one', async () => {
    const share = vi.fn(() => Promise.resolve());
    setNavigator('share', share);
    await makeLink();
    const button = screen.getByRole('button', { name: 'Share the link' });
    expect(document.activeElement).toBe(button);
    fireEvent.click(button);
    await settle();
    expect(share).toHaveBeenCalledWith(expect.objectContaining({ url: LINK }));
    expect(announced()).toContain('Link shared. When Asha answers, you’ll see it on this order.');
    expect(document.activeElement).toBe(button);
  });

  it('treats closing the share sheet as not shared, not as an error', async () => {
    setNavigator('share', () => Promise.reject(Object.assign(new Error('cancel'), { name: 'AbortError' })));
    await makeLink();
    fireEvent.click(screen.getByRole('button', { name: 'Share the link' }));
    await settle();
    expect(shownError()).toBeNull();
    expect(announced().some((a) => a.startsWith('Not shared. The link still works.'))).toBe(true);
  });

  it('falls back to copying when the share sheet cannot open', async () => {
    const writeText = vi.fn(() => Promise.resolve());
    setNavigator('share', () => Promise.reject(Object.assign(new Error('no'), { name: 'NotAllowedError' })));
    setNavigator('clipboard', { writeText });
    await makeLink();
    fireEvent.click(screen.getByRole('button', { name: 'Share the link' }));
    await settle();
    expect(writeText).toHaveBeenCalledWith(LINK);
    expect(announced()).toContain('Link copied. Paste it into a message to Asha.');
  });
});

describe('a helper link made before this page loaded', () => {
  afterEach(cleanup);
  it('says it is waiting and offers to cancel it, instead of making a second live link', () => {
    render(
      <AnnouncerProvider>
        <AskHelper orderId="ord_1" helperName="Asha" waitingUntil="Tuesday 10 November, 9:00 am UTC" />
      </AnnouncerProvider>,
    );
    expect(screen.getByText(/Waiting for Asha\. The link you made works until Tuesday 10 November, 9:00 am UTC\./)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Cancel the link' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Ask Asha to look' })).toBeNull();
  });
});
