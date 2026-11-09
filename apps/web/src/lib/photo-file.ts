/**
 * A photo the buyer added from a file, read in the browser before it is shown or sent. A file the
 * browser can't decode (damaged, or a format it doesn't know) is refused at once, so the review
 * never shows a broken image and the check never fails later on the server. A photo the browser
 * can read but the server may not (iPhone HEIC in Safari, AVIF, GIF, TIFF) is turned into a JPEG
 * here, from the pixels, so it reaches the check in a form every server can read.
 */

/** Said when an added photo can't be read. The same words as the server's. */
export const UNREADABLE_UPLOAD_SAY =
  "I couldn't read that photo. Retake it with the camera, or choose a JPEG or PNG photo. Nothing about your payment changed.";

/** Sent as they are: every server decodes these. */
const AS_IS = new Set(['image/jpeg', 'image/png', 'image/webp']);
/** Longest side of a converted photo, the same cap the server applies. */
const MAX_SIDE = 2000;

export interface DecodedImage {
  width: number;
  height: number;
  close?: () => void;
}

export interface PhotoFileDeps {
  decode: (file: Blob) => Promise<DecodedImage>;
  /** Draw the decoded image at this size and encode it as a JPEG; null when the browser can't. */
  toJpeg: (image: DecodedImage, width: number, height: number) => Promise<Blob | null>;
}

export type ReadPhotoResult = { ok: true; blob: Blob; converted: boolean } | { ok: false; say: string };

function browserDeps(): PhotoFileDeps {
  return {
    decode: (file) => createImageBitmap(file),
    toJpeg: async (image, width, height) => {
      const canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext('2d');
      if (!ctx) return null;
      ctx.drawImage(image as ImageBitmap, 0, 0, width, height);
      return new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.9));
    },
  };
}

export async function readPhotoFile(file: Blob, deps: PhotoFileDeps = browserDeps()): Promise<ReadPhotoResult> {
  const no = { ok: false as const, say: UNREADABLE_UPLOAD_SAY };
  if (file.size === 0) return no;
  let image: DecodedImage;
  try {
    image = await deps.decode(file);
  } catch {
    return no;
  }
  try {
    if (!image.width || !image.height) return no;
    if (AS_IS.has(file.type)) return { ok: true, blob: file, converted: false };
    const scale = Math.min(1, MAX_SIDE / Math.max(image.width, image.height));
    const jpeg = await deps.toJpeg(image, Math.round(image.width * scale), Math.round(image.height * scale)).catch(() => null);
    return jpeg && jpeg.size > 0 ? { ok: true, blob: jpeg, converted: true } : no;
  } finally {
    image.close?.();
  }
}
