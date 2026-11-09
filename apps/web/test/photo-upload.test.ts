import { beforeEach, describe, expect, it, vi } from 'vitest';
import sharp from 'sharp';
import { allowedPhotoTypes, PhotoTooLargeError, sanitisePhoto, UNREADABLE_PHOTO_SAY, UnreadablePhotoError } from '../src/server/blobs';
import { readPhotoFile, UNREADABLE_UPLOAD_SAY, type DecodedImage } from '../src/lib/photo-file';

/*
 * An unreadable photo (a damaged file, a GIF, an AVIF, an iPhone HEIC) used to end the check in a
 * 500 and a broken image. Now the server accepts exactly what its image library decodes, refuses
 * the rest with a 422 the buyer can act on, and stores nothing; the browser reads an added file
 * before showing it.
 */

const sample = (enc: (s: sharp.Sharp) => sharp.Sharp) =>
  enc(sharp({ create: { width: 64, height: 48, channels: 3, background: '#1f3a93' } })).toBuffer();

describe('sanitisePhoto: what this server decodes, checked at runtime', () => {
  it('lists the common photo types, and HEIC only when this build can really decode it', async () => {
    const types = await allowedPhotoTypes();
    for (const t of ['image/jpeg', 'image/png', 'image/webp']) expect(types.has(t)).toBe(true);
    let hevc = false;
    try {
      await sharp(await sample((s) => s.heif({ compression: 'hevc' }))).raw().toBuffer();
      hevc = true;
    } catch {
      /* prebuilt sharp has no HEVC */
    }
    expect(types.has('image/heic')).toBe(hevc);
  });

  it('reads every allowed type it can make, GIF and AVIF included, and re-encodes it as JPEG', async () => {
    const types = await allowedPhotoTypes();
    const makers: Record<string, (s: sharp.Sharp) => sharp.Sharp> = {
      'image/jpeg': (s) => s.jpeg(),
      'image/png': (s) => s.png(),
      'image/webp': (s) => s.webp(),
      'image/gif': (s) => s.gif(),
      'image/tiff': (s) => s.tiff(),
      'image/avif': (s) => s.avif(),
    };
    for (const [type, make] of Object.entries(makers)) {
      if (!types.has(type)) continue;
      const out = await sanitisePhoto(await sample(make));
      expect((await sharp(out).metadata()).format, type).toBe('jpeg');
    }
    expect(types.has('image/gif')).toBe(true);
    expect(types.has('image/avif')).toBe(true);
  });

  it('refuses a damaged JPEG, random bytes, an SVG and a HEIC it cannot decode, as unreadable', async () => {
    const jpeg = await sample((s) => s.jpeg());
    const truncated = jpeg.subarray(0, Math.floor(jpeg.length / 2));
    const random = Buffer.from(Array.from({ length: 4000 }, (_, i) => (i * 7919) % 251));
    const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><rect width="10" height="10"/></svg>');
    // The start of an iPhone photo: an ISO box of type ftyp with the heic brand, then nothing usable.
    const heic = Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from('ftypheic'), Buffer.from([0, 0, 0, 0]), Buffer.from('mif1heic'), Buffer.alloc(200)]);
    for (const [name, bytes] of [
      ['truncated JPEG', truncated],
      ['random bytes', random],
      ['SVG', svg],
      ['HEIC header', heic],
      ['empty', Buffer.alloc(0)],
    ] as const)
      await expect(sanitisePhoto(bytes), name).rejects.toBeInstanceOf(UnreadablePhotoError);
  });

  it('refuses a photo over the size cap before reading it', async () => {
    await expect(sanitisePhoto(Buffer.alloc(12 * 1024 * 1024 + 1))).rejects.toBeInstanceOf(PhotoTooLargeError);
  });

  it('says what to do next, and that the payment did not change', () => {
    expect(UNREADABLE_PHOTO_SAY).toBe(
      "I couldn't read that photo. Retake it with the camera, or choose a JPEG or PNG photo. Nothing about your payment changed.",
    );
    expect(UNREADABLE_UPLOAD_SAY).toBe(UNREADABLE_PHOTO_SAY);
  });
});

describe('readPhotoFile: an added photo is read in the browser first', () => {
  const image = (w = 4000, h = 3000): DecodedImage & { closed: boolean } => {
    const img = { width: w, height: h, closed: false, close: () => void (img.closed = true) };
    return img;
  };
  const jpegOut = new Blob([new Uint8Array([1, 2, 3])], { type: 'image/jpeg' });

  it('refuses a file the browser cannot decode, with the same words as the server', async () => {
    const r = await readPhotoFile(new Blob([new Uint8Array([9, 9, 9])], { type: 'image/heic' }), {
      decode: () => Promise.reject(new Error('InvalidStateError')),
      toJpeg: () => Promise.resolve(jpegOut),
    });
    expect(r).toEqual({ ok: false, say: UNREADABLE_UPLOAD_SAY });
  });

  it('keeps a JPEG, PNG or WebP as it is', async () => {
    const file = new Blob([new Uint8Array([1])], { type: 'image/png' });
    const img = image();
    const toJpeg = vi.fn(() => Promise.resolve(jpegOut));
    const r = await readPhotoFile(file, { decode: () => Promise.resolve(img), toJpeg });
    expect(r).toEqual({ ok: true, blob: file, converted: false });
    expect(toJpeg).not.toHaveBeenCalled();
    expect(img.closed).toBe(true);
  });

  it('turns a HEIC the browser can read into a JPEG no larger than 2000 px, so the server can read it too', async () => {
    const img = image(4032, 3024);
    const toJpeg = vi.fn((_i: DecodedImage, _w: number, _h: number) => Promise.resolve(jpegOut));
    const r = await readPhotoFile(new Blob([new Uint8Array([1])], { type: 'image/heic' }), { decode: () => Promise.resolve(img), toJpeg });
    expect(r).toEqual({ ok: true, blob: jpegOut, converted: true });
    expect(toJpeg.mock.calls[0]!.slice(1)).toEqual([2000, 1500]);
  });

  it('refuses an empty file, an empty image, or one the browser cannot re-encode', async () => {
    const deps = { decode: () => Promise.resolve(image()), toJpeg: () => Promise.resolve(null) };
    expect((await readPhotoFile(new Blob([]), deps)).ok).toBe(false);
    expect((await readPhotoFile(new Blob([new Uint8Array([1])], { type: 'image/gif' }), deps)).ok).toBe(false);
    expect((await readPhotoFile(new Blob([new Uint8Array([1])], { type: 'image/jpeg' }), { ...deps, decode: () => Promise.resolve(image(0, 0)) })).ok).toBe(false);
  });
});

describe('POST /api/orders/[id]/check with an unreadable photo', () => {
  const putBlob = vi.fn();
  const audit = vi.fn();
  const verifyDelivery = vi.fn();
  beforeEach(() => {
    vi.resetModules();
    putBlob.mockReset();
    audit.mockReset();
    verifyDelivery.mockReset();
    vi.doMock('@/server/session', () => ({ requireUser: async () => ({ id: 'usr_test' }), HttpError: class extends Error {} }));
    vi.doMock('@/server/orders-read', () => ({ orderForUser: async () => ({ order: { id: 'ord_test' }, snapshot: { title: 'Sweater' } }) }));
    vi.doMock('@/server/blobs', async (orig) => ({ ...(await orig<typeof import('../src/server/blobs')>()), putBlob }));
    vi.doMock('@/server/audit', () => ({ audit }));
    vi.doMock('@/server/vision', () => ({ verifyDelivery, VisionRefusedError: class extends Error {}, VisionUnavailableError: class extends Error {} }));
    vi.doMock('@/server/after-check', () => ({ afterVerdict: vi.fn() }));
  });

  const post = async (files: Record<string, Blob>) => {
    const { POST } = await import('../src/app/api/orders/[id]/check/route');
    const form = new FormData();
    for (const [k, b] of Object.entries(files)) form.append(k, b, `${k}.bin`);
    return POST(new Request('http://localhost/api/orders/ord_test/check', { method: 'POST', body: form }), { params: Promise.resolve({ id: 'ord_test' }) });
  };

  it('answers 422 with words the buyer can act on, and stores nothing', async () => {
    const good = await sample((s) => s.jpeg());
    const res = await post({
      item: new Blob([new Uint8Array(good)], { type: 'image/jpeg' }),
      label: new Blob([new Uint8Array([0x47, 0x49, 0x46, 0x38, 1, 2, 3])], { type: 'image/gif' }),
    });
    expect(res.status).toBe(422);
    expect(await res.json()).toEqual({ error: UNREADABLE_PHOTO_SAY });
    expect(putBlob).not.toHaveBeenCalled();
    expect(audit).not.toHaveBeenCalled();
    expect(verifyDelivery).not.toHaveBeenCalled();
  });

  it('answers 413 for a photo over the cap, and stores nothing', async () => {
    const res = await post({ item: new Blob([new Uint8Array(12 * 1024 * 1024 + 10)], { type: 'image/jpeg' }) });
    expect(res.status).toBe(413);
    expect(((await res.json()) as { error: string }).error).toMatch(/^That photo is too large to send\. .*Nothing about your payment changed\.$/);
    expect(putBlob).not.toHaveBeenCalled();
  });
});
