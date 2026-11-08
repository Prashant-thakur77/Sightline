import 'server-only';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type { Verdict, ProductSnapshot } from '@sightline/core';
import { ENV } from './runtime';

export interface VisionResult {
  verdict: Verdict;
  modules: Record<string, unknown>;
  timings_ms: Record<string, number>;
}

export class VisionUnavailableError extends Error {}

type WireReason = {
  module: Verdict['reasons'][number]['module'];
  finding: Verdict['reasons'][number]['finding'];
  confidence: Verdict['reasons'][number]['confidence'];
  expected?: string | null;
  observed?: string | null;
  sentence: string;
};

function fromWire(v: { kind: Verdict['kind']; reasons: WireReason[]; headline: string; next_steps?: string[]; nextSteps?: string[] }): Verdict {
  return {
    kind: v.kind,
    headline: v.headline,
    nextSteps: v.next_steps ?? v.nextSteps ?? [],
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

/** Listing images: local Demo Store files are read from disk, others fetched. */
async function listingImage(url: string): Promise<{ bytes: Buffer; name: string } | null> {
  try {
    const u = new URL(url, ENV.APP_URL);
    if (u.pathname.startsWith('/demo-store/')) {
      const file = path.join(process.cwd(), 'public', u.pathname);
      return { bytes: await readFile(file), name: path.basename(file) };
    }
    const res = await fetch(u, { signal: AbortSignal.timeout(8000) });
    if (!res.ok) return null;
    return { bytes: Buffer.from(await res.arrayBuffer()), name: path.basename(u.pathname) || 'listing.jpg' };
  } catch {
    return null;
  }
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
  for (const img of input.snapshot.images.slice(0, 3)) {
    const li = await listingImage(img.url);
    if (li) form.append('listing_images', new Blob([new Uint8Array(li.bytes)]), li.name);
  }
  form.append(
    'listing',
    JSON.stringify({
      title: input.snapshot.title,
      colour: input.snapshot.attributes.colour ?? null,
      size: input.snapshot.attributes.size ?? null,
      attributes: input.snapshot.attributes,
    }),
  );
  let res: Response;
  try {
    res = await fetch(`${ENV.VISION_SERVICE_URL.replace(/\/$/, '')}/verify`, { method: 'POST', body: form, signal: AbortSignal.timeout(45000) });
  } catch (e) {
    throw new VisionUnavailableError(`vision service unreachable: ${(e as Error).message}`);
  }
  if (!res.ok) throw new VisionUnavailableError(`vision service returned ${res.status}`);
  const json = (await res.json()) as { verdict: Parameters<typeof fromWire>[0]; modules: Record<string, unknown>; timings_ms: Record<string, number> };
  return { verdict: fromWire(json.verdict), modules: json.modules, timings_ms: json.timings_ms };
}
