// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AnnouncerProvider } from '@/components/a11y/announcer';
import { HelperAnswer } from '@/app/helper/[token]/helper-answer';

/* The helper's three answers weigh the same, the page says the answer can't be changed, and a
   second answer from the same link is not reported as a new one. */

const settle = () =>
  act(async () => {
    for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 20));
  });
const wrap = (ui: React.ReactNode) => render(<AnnouncerProvider>{ui}</AnnouncerProvider>);

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(new Response(JSON.stringify({ already: true }), { status: 200 }))));
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('HelperAnswer', () => {
  it('gives the three answers the same weight and says what happens next', () => {
    wrap(<HelperAnswer token="t" answered={false} buyerName="Maya" />);
    const classes = ['It matches', 'It’s different', 'I can’t tell'].map((name) => screen.getByRole('button', { name }).className);
    expect(new Set(classes).size).toBe(1);
    expect(classes[0]).not.toContain('btn-primary');
    expect(screen.getByText(/goes straight to Maya/).textContent).toContain('can’t change it');
  });

  it('says so when the link already has an answer, instead of thanking for a new one', async () => {
    wrap(<HelperAnswer token="t" answered={false} buyerName="Maya" />);
    fireEvent.click(screen.getByRole('button', { name: 'It’s different' }));
    await settle();
    const line = screen.getByText(/already has an answer from this link/);
    expect(document.activeElement).toBe(line);
    expect(screen.queryByText(/Thank you/)).toBeNull();
  });
});
