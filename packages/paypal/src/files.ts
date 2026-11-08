import { PayPalValidationError } from './errors';
import type { MultipartPart } from './multipart';

/** A file attached to a dispute call (evidence, message, supporting info). */
export interface EvidenceFile {
  filename: string;
  contentType: string;
  data: Uint8Array;
}

/** Live docs: .jpg, .jpeg, .gif, .png and .pdf; each file under 10 MB; at most 50 MB per call. */
export const EVIDENCE_MAX_FILE_BYTES = 10 * 1024 * 1024;
export const EVIDENCE_MAX_TOTAL_BYTES = 50 * 1024 * 1024;

const TYPES: Record<string, { exts: string[]; magic: (b: Uint8Array) => boolean }> = {
  'image/jpeg': { exts: ['jpg', 'jpeg'], magic: (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  'image/png': {
    exts: ['png'],
    magic: (b) => b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47,
  },
  'image/gif': {
    exts: ['gif'],
    magic: (b) => b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x38,
  },
  'application/pdf': {
    exts: ['pdf'],
    magic: (b) => b[0] === 0x25 && b[1] === 0x50 && b[2] === 0x44 && b[3] === 0x46,
  },
};

export const EVIDENCE_CONTENT_TYPES = Object.keys(TYPES);

/** PayPal's document name pattern (letters, digits, "-", "_", ",", whitespace, one extension), with spaces only. */
const NAME_PATTERN = /^[A-Za-z0-9\-_, ]+\.[A-Za-z]+$/;

/** Checks type, extension, magic bytes, name, per-file and total size before anything is uploaded. */
export function validateEvidenceFiles(files: readonly EvidenceFile[]): void {
  let total = 0;
  files.forEach((f, i) => {
    const field = `files[${i}]`;
    const type = TYPES[f.contentType.toLowerCase()];
    if (!type)
      throw new PayPalValidationError(
        field,
        `type "${f.contentType}" is not accepted. Use JPG, GIF, PNG or PDF.`,
      );
    if (!NAME_PATTERN.test(f.filename))
      throw new PayPalValidationError(
        field,
        `name "${f.filename}" must use letters, digits, "-", "_" or "," and one extension.`,
      );
    const ext = f.filename.split('.').pop()!.toLowerCase();
    if (!type.exts.includes(ext))
      throw new PayPalValidationError(field, `extension ".${ext}" does not match ${f.contentType}.`);
    if (f.data.byteLength === 0) throw new PayPalValidationError(field, 'file is empty.');
    if (f.data.byteLength >= EVIDENCE_MAX_FILE_BYTES)
      throw new PayPalValidationError(field, 'file must be smaller than 10 MB.');
    if (!type.magic(f.data))
      throw new PayPalValidationError(field, `content is not a ${f.contentType} file.`);
    total += f.data.byteLength;
  });
  if (total > EVIDENCE_MAX_TOTAL_BYTES)
    throw new PayPalValidationError('files', 'all files together must be at most 50 MB.');
}

/** Multipart parts for files, named file1..fileN as in PayPal's dispute examples. */
export function fileParts(files: readonly EvidenceFile[]): MultipartPart[] {
  return files.map((f, i) => ({
    name: `file${i + 1}`,
    filename: f.filename,
    contentType: f.contentType.toLowerCase(),
    value: f.data,
  }));
}
