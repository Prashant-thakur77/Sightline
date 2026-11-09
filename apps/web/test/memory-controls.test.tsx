// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AnnouncerProvider } from '@/components/a11y/announcer';

/* "What I remember" in Settings: each memory says what the buyer said, can be changed or forgotten,
   forgetting everything asks first, and every result is focused and read, not announced twice. */

vi.mock('@/app/app/settings/actions', () => ({
  updateMemoryAction: vi.fn(async (_prev: unknown, form: FormData) =>
    String(form.get('value')) === 'Q'
      ? { ok: false, id: form.get('id'), message: 'Not changed. Use a size such as M, XL or 9. Then press Save again.' }
      : { ok: true, id: form.get('id'), message: "Changed. Now I remember that you're a large in sweaters." },
  ),
  forgetMemoryAction: vi.fn(async () => ({ ok: true, message: "Forgotten: you're a medium in sweaters. To set it again, tell me in the conversation." })),
  forgetAllMemoriesAction: vi.fn(async () => ({ ok: true, message: 'Done. I forgot all 2 things I remembered. Your other settings are unchanged.' })),
}));

const { MemoryControls } = await import('@/app/app/settings/memory-controls');

const settle = () =>
  act(async () => {
    for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 20));
  });
const MEMORIES = [
  { id: 'mem_1', sentence: "You're a medium in sweaters.", said: "I'm a medium in sweaters", when: 'Monday 9 November', value: 'M', field: 'Size' },
  { id: 'mem_2', sentence: 'You avoid wool.', said: 'nothing with wool', when: 'Monday 9 November', value: 'wool', field: 'Material to avoid' },
];
const wrap = (memories = MEMORIES) => render(<AnnouncerProvider><MemoryControls memories={memories} /></AnnouncerProvider>);

afterEach(cleanup);

describe('What I remember', () => {
  it('lists each memory with the buyer’s own words, and buttons that say which memory they act on', () => {
    wrap();
    expect(screen.getByRole('heading', { name: 'What I remember' })).toBeTruthy();
    expect(screen.getByText('You said: “nothing with wool”, on Monday 9 November.')).toBeTruthy();
    const changes = screen.getAllByRole('button', { name: 'Change' });
    expect(changes).toHaveLength(2);
    expect(changes[0]!.getAttribute('aria-describedby')).toBe(screen.getByText("You're a medium in sweaters.").id);
  });

  it('says plainly when there is nothing remembered', () => {
    wrap([]);
    expect(screen.getByText(/Nothing yet\. When you tell me your size/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Forget everything/ })).toBeNull();
  });

  it('change: focus goes to the field; a bad value is marked and explained; a good one is read from focus', async () => {
    wrap();
    fireEvent.click(screen.getAllByRole('button', { name: 'Change' })[0]!);
    await settle();
    const field = screen.getByLabelText('Size') as HTMLInputElement;
    expect(document.activeElement).toBe(field);
    fireEvent.change(field, { target: { value: 'Q' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await settle();
    expect(field.getAttribute('aria-invalid')).toBe('true');
    expect(document.getElementById(field.getAttribute('aria-describedby')!)!.textContent).toContain('Use a size such as M, XL or 9.');
    fireEvent.change(field, { target: { value: 'L' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await settle();
    expect(`${document.activeElement!.tagName}.${document.activeElement!.className}`).toBe('P.mb-result');
    expect(document.activeElement!.textContent).toBe("Changed. Now I remember that you're a large in sweaters.");
  });

  it('cancel keeps the value and puts focus back on Change', async () => {
    wrap();
    fireEvent.click(screen.getAllByRole('button', { name: 'Change' })[1]!);
    await settle();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    await settle();
    expect(document.activeElement).toBe(screen.getAllByRole('button', { name: 'Change' })[1]);
  });

  it('forget one, and forget everything only after asking', async () => {
    wrap();
    fireEvent.click(screen.getAllByRole('button', { name: 'Forget' })[0]!);
    await settle();
    expect(document.activeElement!.textContent).toMatch(/^Forgotten: you're a medium in sweaters\./);
    fireEvent.click(screen.getByRole('button', { name: 'Forget everything I remember' }));
    await settle();
    expect(document.activeElement!.textContent).toBe('Forget all 2 things I remember? You can tell me again any time.');
    fireEvent.click(screen.getByRole('button', { name: 'Keep them' }));
    await settle();
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Forget everything I remember' }));
    fireEvent.click(screen.getByRole('button', { name: 'Forget everything I remember' }));
    await settle();
    fireEvent.click(screen.getByRole('button', { name: 'Yes, forget them all' }));
    await settle();
    expect(document.activeElement!.textContent).toBe('Done. I forgot all 2 things I remembered. Your other settings are unchanged.');
  });
});
