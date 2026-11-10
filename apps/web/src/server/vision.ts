import 'server-only';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type { Verdict, VerdictRetake, ProductSnapshot } from '@sightline/core';
import { ENV } from './runtime';

export interface VisionResult {
  verdict: Verdict;
  modules: Record<string, unknown>;
  timings_ms: Record<string, number>;
}

export class VisionUnavailableError extends Error {}
/** The checker answered but refused the request (a 4xx): retrying the same photos won't help. */
export class VisionRefusedError extends Error {}

type WireReason = {
  module: Verdict['reasons'][number]['module'];
  finding: Verdict['reasons'][number]['finding'];
  confidence: Verdict['reasons'][number]['confidence'];
  expected?: string | null;
  observed?: string | null;
  sentence: string;
};

type WireRetake = { kind: 'tag' | 'light' | 'paper'; title: string; prompt: string } | null | undefined;
const RETAKE_KINDS = new Set(['tag', 'light', 'paper']);

export function fromWire(v: {
  kind: Verdict['kind'];
  reasons: WireReason[];
  headline: string;
  next_steps?: string[];
  nextSteps?: string[];
  retake?: WireRetake;
  looks?: number;
}): Verdict {
  // "Not sure" with real differences found should say so plainly, not sound like nothing was found.
  const differences = v.reasons.filter((r) => r.finding === 'disagree').length;
  const headline =
    v.kind === 'unsure' && differences > 0
      ? `This probably isn't what you ordered, but I'm not completely sure. ${differences === 1 ? 'One thing looks' : 'Two things look'} different.`
      : v.headline;
  // Only a known kind of extra photo is offered, and only while the check is "not sure".
  const retake =
    v.kind === 'unsure' && v.retake && RETAKE_KINDS.has(v.retake.kind) ? { kind: v.retake.kind, title: v.retake.title, prompt: v.retake.prompt } : null;
  return {
    kind: v.kind,
    headline,
    nextSteps: v.next_steps ?? v.nextSteps ?? [],
    retake,
    looks: v.looks ?? 1,
    reasons: v.reasons.map((r) => ({
      module: r.module,
      finding: r.finding,
      confidence: r.confidence,
      expected: r.expected ?? undefined,
      observed: r.observed ?? undefined,
      sentence: r.sentence,
    })),
  };
}

const MAX_LISTING_IMAGE_BYTES = 8 * 1024 * 1024;

/** Refuse anything that is not a public https address (no localhost, private or link-local ranges). */
export async function isPublicHttpsUrl(u: URL): Promise<boolean> {
  if (u.protocol !== 'https:' || u.username || u.password) return false;
  if (u.port && u.port !== '443') return false;
  const host = u.hostname.toLowerCase();
  if (host === 'localhost' || host.endsWith('.local') || host.endsWith('.internal')) return false;
  const { lookup } = await import('node:dns/promises');
  const addrs = await lookup(host, { all: true }).catch(() => []);
  if (addrs.length === 0) return false;
  return addrs.every(({ address, family }) => {
    if (family === 4) {
      const [a, b] = address.split('.').map(Number) as [number, number];
      return !(a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224);
    }
    const x = address.toLowerCase();
    return !(x === '::1' || x.startsWith('fc') || x.startsWith('fd') || x.startsWith('fe80') || x.startsWith('::ffff:') || x === '::');
  });
}

/** Listing images: Demo Store files are read from disk; others only from public https hosts, size-capped. */
async function listingImage(url: string): Promise<{ bytes: Buffer; name: string } | null> {
  try {
    const u = new URL(url, ENV.APP_URL);
    if (u.pathname.startsWith('/demo-store/') && (u.origin === new URL(ENV.APP_URL).origin || url.startsWith('/'))) {
      const file = path.join(process.cwd(), 'public', 'demo-store', path.basename(u.pathname));
      return { bytes: await readFile(file), name: path.basename(file) };
    }
    if (!(await isPublicHttpsUrl(u))) return null;
    const res = await fetch(u, { signal: AbortSignal.timeout(8000), redirect: 'error' });
    if (!res.ok) return null;
    const len = Number(res.headers.get('content-length') ?? 0);
    if (len > MAX_LISTING_IMAGE_BYTES) return null;
    const type = res.headers.get('content-type') ?? '';
    if (!type.startsWith('image/')) return null;
    const bytes = Buffer.from(await res.arrayBuffer());
    if (bytes.byteLength > MAX_LISTING_IMAGE_BYTES) return null;
    return { bytes, name: path.basename(u.pathname) || 'listing.jpg' };
  } catch {
    return null;
  }
}

async function appendListing(form: FormData, snapshot: ProductSnapshot): Promise<void> {
  for (const img of snapshot.images.slice(0, 3)) {
    const li = await listingImage(img.url);
    if (li) form.append('listing_images', new Blob([new Uint8Array(li.bytes)]), li.name);
  }
  form.append(
    'listing',
    JSON.stringify({
      title: snapshot.title,
      colour: snapshot.attributes.colour ?? null,
      size: snapshot.attributes.size ?? null,
      attributes: snapshot.attributes,
    }),
  );
}

async function post(pathName: '/verify' | '/recheck', form: FormData): Promise<VisionResult> {
  if (!ENV.VISION_SERVICE_URL) throw new VisionUnavailableError('VISION_SERVICE_URL is not set');
  let res: Response;
  try {
    res = await fetch(`${ENV.VISION_SERVICE_URL.replace(/\/$/, '')}${pathName}`, { method: 'POST', body: form, signal: AbortSignal.timeout(45000) });
  } catch (e) {
    throw new VisionUnavailableError(`vision service unreachable: ${(e as Error).message}`);
  }
  if (res.status >= 400 && res.status < 500) throw new VisionRefusedError(`vision service refused the photos (${res.status})`);
  if (!res.ok) throw new VisionUnavailableError(`vision service returned ${res.status}`);
  const json = (await res.json()) as { verdict: Parameters<typeof fromWire>[0]; modules: Record<string, unknown>; timings_ms: Record<string, number> };
  return { verdict: fromWire(json.verdict), modules: json.modules, timings_ms: json.timings_ms };
}

export async function verifyDelivery(input: {
  snapshot: ProductSnapshot;
  photos: { kind: 'item' | 'label' | 'damage'; bytes: Buffer }[];
}): Promise<VisionResult> {
  if (!ENV.VISION_SERVICE_URL) throw new VisionUnavailableError('VISION_SERVICE_URL is not set');
  const form = new FormData();
  for (const p of input.photos) {
    const field = p.kind === 'item' ? 'item' : p.kind === 'label' ? 'label' : 'damage';
    form.append(field, new Blob([new Uint8Array(p.bytes)], { type: 'image/jpeg' }), `${p.kind}.jpg`);
  }
  await appendListing(form, input.snapshot);
  return post('/verify', form);
}

/**
 * Check again with the first check's module outputs (as stored on this server, never as sent by the
 * browser) and the ONE extra photo it asked for. The kind of photo also comes from the stored verdict.
 */
export async function recheckDelivery(input: {
  snapshot: ProductSnapshot;
  previousModules: Record<string, unknown>;
  kind: VerdictRetake['kind'];
  photo: Buffer;
}): Promise<VisionResult> {
  if (!ENV.VISION_SERVICE_URL) throw new VisionUnavailableError('VISION_SERVICE_URL is not set');
  const form = new FormData();
  form.append('retake', new Blob([new Uint8Array(input.photo)], { type: 'image/jpeg' }), `retake-${input.kind}.jpg`);
  form.append('retake_kind', input.kind);
  form.append('previous', JSON.stringify(input.previousModules));
  await appendListing(form, input.snapshot);
  return post('/recheck', form);
}
