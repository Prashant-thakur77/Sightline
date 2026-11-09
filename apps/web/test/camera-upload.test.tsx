// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AnnouncerProvider } from '@/components/a11y/announcer';
import { CameraCheck } from '@/components/check/camera-check';
import { UNREADABLE_UPLOAD_SAY } from '@/lib/photo-file';

/* An added photo the browser can't read is refused at once: said through the announcer, shown
   under the photo field and tied to it, focus left where the buyer is, and nothing added. */

const settle = () =>
  act(async () => {
    for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 10));
  });

beforeEach(() => {
  vi.stubGlobal('matchMedia', () => ({ matches: false, addEventListener() {}, removeEventListener() {} }));
  URL.createObjectURL = vi.fn(() => 'blob:photo');
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const choose = async (file: File) => {
  const input = document.getElementById('upload') as HTMLInputElement;
  input.focus();
  Object.defineProperty(input, 'files', { value: [file], configurable: true });
  fireEvent.change(input);
  await settle();
  return input;
};

describe('CameraCheck, adding a photo from a file', () => {
  it('says at once that an unreadable photo was not added, and keeps focus on the photo field', async () => {
    vi.stubGlobal('createImageBitmap', () => Promise.reject(new DOMException('The source image could not be decoded.', 'InvalidStateError')));
    render(
      <AnnouncerProvider>
        <CameraCheck itemName="sweater" onSubmit={() => undefined} />
      </AnnouncerProvider>,
    );
    const input = await choose(new File([new Uint8Array([1, 2, 3])], 'IMG_0001.HEIC', { type: 'image/heic' }));
    const error = document.getElementById('upload-error');
    expect(error?.textContent).toContain(UNREADABLE_UPLOAD_SAY);
    expect(input.getAttribute('aria-describedby')).toBe('upload-error');
    expect(input.getAttribute('aria-invalid')).toBe('true');
    expect(document.activeElement).toBe(input);
    expect((window as unknown as { __announcements?: string[] }).__announcements).toContain(UNREADABLE_UPLOAD_SAY);
    expect(screen.queryByText('Photos so far')).toBeNull();
    expect(screen.getByRole('heading', { level: 2 }).textContent).toBe('Check your parcel');
  });

  it('adds a readable photo and moves on to the next one, with no error left behind', async () => {
    vi.stubGlobal('createImageBitmap', () => Promise.resolve({ width: 800, height: 600, close() {} }));
    render(
      <AnnouncerProvider>
        <CameraCheck itemName="sweater" onSubmit={() => undefined} />
      </AnnouncerProvider>,
    );
    await choose(new File([new Uint8Array([1, 2, 3])], 'sweater.jpg', { type: 'image/jpeg' }));
    expect(screen.getByRole('heading', { level: 2 }).textContent).toBe('Photo 2 of 3: The size tag');
    expect(document.getElementById('upload-error')).toBeNull();
    expect(screen.getByText('Photos so far')).toBeTruthy();
  });
});
