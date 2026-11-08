// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AnnouncerProvider } from '@/components/a11y/announcer';
import AppError from '@/app/app/error';

/* When a page in the app fails, the boundary says what happened, takes focus, and can try again. */

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('app error boundary', () => {
  it('focuses its heading, says what happened, and retries', () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const retry = vi.fn();
    render(
      <AnnouncerProvider>
        <AppError error={new Error('boom')} retry={retry} />
      </AnnouncerProvider>,
    );
    const h = screen.getByRole('heading', { level: 1, name: 'That didn’t load' });
    expect(document.activeElement).toBe(h);
    expect(screen.getByText(/Everything you saved before is still saved/)).toBeTruthy();
    // Focus carries the message, so it is not also put in a live region.
    expect([...document.querySelectorAll('[data-announcer]')].map((r) => r.textContent).join('')).toBe('');
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(retry).toHaveBeenCalledOnce();
  });
});
