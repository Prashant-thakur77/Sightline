import { randomUUID } from 'node:crypto';

export interface MultipartPart {
  name: string;
  value: string | Uint8Array;
  filename?: string;
  contentType?: string;
}

export interface MultipartBody {
  body: Uint8Array<ArrayBuffer>;
  contentType: string;
  boundary: string;
}

const CRLF = '\r\n';

function headerSafe(s: string): string {
  return s.replace(/[\r\n"]/g, '_');
}

export function newBoundary(): string {
  return `----paypal-form-${randomUUID().replace(/-/g, '')}`;
}

/**
 * Encodes multipart/form-data by hand so the bytes are exact and testable. Values are written verbatim:
 * the JSON in an `input` part is never re-serialised after the caller builds it.
 */
export function encodeMultipart(parts: MultipartPart[], boundary: string = newBoundary()): MultipartBody {
  const enc = new TextEncoder();
  const chunks: Uint8Array[] = [];
  for (const p of parts) {
    let head = `--${boundary}${CRLF}Content-Disposition: form-data; name="${headerSafe(p.name)}"`;
    if (p.filename !== undefined) head += `; filename="${headerSafe(p.filename)}"`;
    head += CRLF;
    if (p.contentType) head += `Content-Type: ${headerSafe(p.contentType)}${CRLF}`;
    head += CRLF;
    chunks.push(enc.encode(head));
    chunks.push(typeof p.value === 'string' ? enc.encode(p.value) : p.value);
    chunks.push(enc.encode(CRLF));
  }
  chunks.push(enc.encode(`--${boundary}--${CRLF}`));
  const total = chunks.reduce((n, c) => n + c.byteLength, 0);
  const body = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    body.set(c, off);
    off += c.byteLength;
  }
  return { body, contentType: `multipart/form-data; boundary=${boundary}`, boundary };
}
