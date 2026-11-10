// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Verdict } from '@sightline/core';
import { AnnouncerProvider } from '@/components/a11y/announcer';
import { CheckFlow } from '@/components/check/check-flow';
import { canAskForRetake, retakeIntro, retakeShot } from '@/components/check/retake';
import { retakeAllowed } from '@/server/retake';

vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: () => undefined, push: () => undefined }) }));

/* When the check is "not sure" it asks for ONE extra photo, chosen from why it was not sure. The
   buyer can take it (camera or a file), or keep the first answer; focus and the announcer follow. */

const settle = () =>
  act(async () => {
    for (let i = 0; i < 6; i++) await new Promise((r) => setTimeout(r, 10));
  });

const UNSURE: Verdict = {
  kind: 'unsure',
  headline: 'I’m not sure this matches.',
  reasons: [
    {
      module: 'colour',
      finding: 'disagree',
      confidence: 'fairly_sure',
      expected: 'navy',
      observed: 'black',
      sentence: 'The colour looks black, not navy, but I’m only fairly sure from one photo.',
    },
  ],
  nextSteps: ['One more photo would help: the whole item next to white paper. Put a sheet of plain white paper flat next to the item, so both are in the photo.'],
  retake: { kind: 'paper', title: 'The whole item next to white paper', prompt: 'Put a sheet of plain white paper flat next to the item, so both are in the photo.' },
  looks: 1,
};

const AFTER: Verdict = {
  kind: 'mismatch',
  headline: 'This doesn’t match.',
  reasons: [{ module: 'colour', finding: 'disagree', confidence: 'sure', expected: 'navy', observed: 'black', sentence: 'The colour looks black, not navy. I’m sure about that.' }],
  nextSteps: ['Keep the item, its tags and the packaging as they are.'],
  retake: null,
  looks: 2,
};

const announcements = () => (window as unknown as { __announcements?: string[] }).__announcements ?? [];

beforeEach(() => {
  vi.stubGlobal('matchMedia', () => ({ matches: false, addEventListener() {}, removeEventListener() {} }));
  vi.stubGlobal('createImageBitmap', () => Promise.resolve({ width: 800, height: 600, close() {} }));
  URL.createObjectURL = vi.fn(() => 'blob:photo');
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const flow = () =>
  render(
    <AnnouncerProvider>
      <CheckFlow orderId="ord_1" itemName="sweater" ordered={{ title: 'Harbor knit sweater', colour: 'navy', size: 'M' }} initial={{ verdict: UNSURE }} />
    </AnnouncerProvider>,
  );

describe('the extra photo', () => {
  it('is a tag close-up for size and the whole item otherwise, offered once', () => {
    expect(retakeShot({ kind: 'tag', title: 'A close photo of the size tag', prompt: 'Hold it flat.' }).kind).toBe('label');
    expect(retakeShot(UNSURE.retake!).kind).toBe('item');
    expect(retakeIntro(UNSURE.retake!)).toMatch(/I’ll check again with both photos\. If you go back, your first answer stays as it is\.$/);
    expect(canAskForRetake(UNSURE)).toBe(true);
    expect(canAskForRetake({ ...UNSURE, looks: 2 })).toBe(false);
    expect(canAskForRetake({ ...UNSURE, retake: null })).toBe(false);
    expect(canAskForRetake(AFTER)).toBe(false);
  });

  it('is allowed by the server only for the latest "not sure" check that asked for it, with its stored results', () => {
    const ver = { id: 'ver_1', verdict: UNSURE, moduleOutputs: { modules: { colour: { finding: 'disagree' }, photos: {} } }, photos: [{ kind: 'item', blobId: 'b', sha256: 's' }] };
    const ok = retakeAllowed(ver);
    expect(ok.ok).toBe(true);
    if (ok.ok) {
      expect(ok.retake.kind).toBe('paper');
      expect(Object.keys(ok.modules)).toEqual(['colour']);
    }
    expect(retakeAllowed({ ...ver, verdict: { ...UNSURE, looks: 2 } }).ok).toBe(false);
    expect(retakeAllowed({ ...ver, verdict: AFTER }).ok).toBe(false);
    expect(retakeAllowed({ ...ver, moduleOutputs: { error: 'down' } }).ok).toBe(false);
    expect(retakeAllowed(null).ok).toBe(false);
  });

  it('is the main action of a "not sure" check, and going back keeps the first answer', async () => {
    flow();
    const take = screen.getByRole('button', { name: 'Take one more photo' });
    expect(take.className).toContain('btn-primary');
    expect(screen.getByRole('link', { name: 'Get my money back' }).className).not.toContain('btn-primary');
    fireEvent.click(take);
    await settle();
    const heading = screen.getByRole('heading', { level: 2 });
    expect(heading.textContent).toBe('One more photo');
    expect(document.activeElement).toBe(heading);
    expect(screen.getByText(/Put a sheet of plain white paper flat next to the item.*first answer stays as it is\./)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Keep my first answer' }));
    await settle();
    expect(document.activeElement).toBe(screen.getByRole('heading', { name: UNSURE.headline }));
    expect(announcements()).toContain('Kept your first answer.');
  });

  it('sends only the extra photo to the retake route and shows the answer from both photos', async () => {
    const fetchMock = vi.fn((_url: string, _init?: RequestInit) =>
      Promise.resolve(new Response(JSON.stringify({ verdict: AFTER, next: { kind: 'money-back', say: 'This doesn’t match.' } }), { status: 200 })),
    );
    vi.stubGlobal('fetch', fetchMock);
    flow();
    fireEvent.click(screen.getByRole('button', { name: 'Take one more photo' }));
    await settle();
    const input = document.getElementById('upload') as HTMLInputElement;
    Object.defineProperty(input, 'files', { value: [new File([new Uint8Array([1, 2, 3])], 'paper.jpg', { type: 'image/jpeg' })], configurable: true });
    fireEvent.change(input);
    await settle();
    expect(screen.getByRole('heading', { level: 2 }).textContent).toBe('Ready to check');
    expect(screen.getByRole('button', { name: 'Take it again' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Check it now' }));
    await settle();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('/api/orders/ord_1/check/retake');
    const body = init!.body as FormData;
    expect([...body.keys()].sort()).toEqual(['retake', 'retake-source']);
    expect(announcements()).toContain('Checking again with both photos. This takes a few seconds.');
    expect(document.activeElement).toBe(screen.getByRole('heading', { name: AFTER.headline }));
    expect(screen.queryByRole('button', { name: 'Take one more photo' })).toBeNull();
  });
});
