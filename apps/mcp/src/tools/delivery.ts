import { lookup } from 'node:dns/promises';
import { readFile } from 'node:fs/promises';
import { BlockList, isIP } from 'node:net';
import path from 'node:path';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { CONFIDENCE_WORDS, categoryOf, presentVerdict } from '@sightline/agent';
import type { Verdict } from '@sightline/core';
import { z } from 'zod';
import type { ServerConfig } from '../config';
import { fail, ok } from '../shared';

const MAX_PHOTO_BYTES = 10 * 1024 * 1024;
const PHOTO_FETCH_TIMEOUT_MS = 15_000;
const VISION_TIMEOUT_MS = 60_000;

const photo = z
  .strictObject({
    kind: z
      .enum(['item', 'label', 'damage'])
      .describe(
        'item: the delivered product (1 to 4). label: close-up of the size tag (at most 1). damage: close-up of possible damage (at most 1).',
      ),
    url: z.url().optional().describe('https URL of the photo. Give url or base64, not both.'),
    base64: z
      .string()
      .max(14_000_000)
      .optional()
      .describe('Photo bytes, base64 (a data: URL prefix is fine).'),
    mime: z.string().max(60).optional().describe('image/jpeg, image/png or image/webp.'),
  })
  .refine(
    (p) => (p.url ? 1 : 0) + (p.base64 ? 1 : 0) === 1,
    'Give each photo either url or base64, not both and not neither.',
  );

export const deliveryInput = {
  listing: z
    .strictObject({
      title: z.string().trim().min(1).max(500),
      colour: z
        .string()
        .trim()
        .max(80)
        .optional()
        .describe('Colour the listing gives for the variant ordered.'),
      size: z.string().trim().max(40).optional().describe('Size ordered.'),
      image_urls: z
        .array(z.string().min(1).max(2000))
        .max(4)
        .default([])
        .describe(
          'Listing photo URLs (https), or Demo Store paths such as /demo-store/harbor-knit-crew--navy.png.',
        ),
    })
    .describe('The listing the order was placed against.'),
  photos: z.array(photo).min(1).max(6).describe('Photos the user took of what arrived.'),
};

const reasonOut = z.object({
  module: z.enum(['colour', 'size', 'identity', 'damage', 'quality']),
  finding: z.enum(['agree', 'disagree', 'unknown']),
  confidence: z.enum(['sure', 'fairly_sure', 'not_sure']),
  confidence_words: z
    .string()
    .describe('sure, fairly sure or not sure. Say these words; never a percentage.'),
  expected: z.string().optional(),
  observed: z.string().optional(),
  sentence: z.string(),
});

export const deliveryOutput = {
  kind: z.enum(['match', 'mismatch', 'unsure']),
  headline: z.string(),
  reasons: z.array(reasonOut),
  next_steps: z.array(z.string()),
  spoken: z.string().describe('The whole verdict as template sentences, ready to read aloud.'),
  timings_ms: z.record(z.string(), z.number()).optional(),
};

const wireVerdict = z.object({
  verdict: z.object({
    kind: z.enum(['match', 'mismatch', 'unsure']),
    headline: z.string(),
    reasons: z.array(
      z.object({
        module: z.enum(['colour', 'size', 'identity', 'damage', 'quality']),
        finding: z.enum(['agree', 'disagree', 'unknown']),
        confidence: z.enum(['sure', 'fairly_sure', 'not_sure']),
        expected: z.string().nullish(),
        observed: z.string().nullish(),
        sentence: z.string(),
      }),
    ),
    next_steps: z.array(z.string()).optional(),
    nextSteps: z.array(z.string()).optional(),
  }),
  timings_ms: z.record(z.string(), z.number()).optional(),
});

type DeliveryArgs = z.infer<z.ZodObject<typeof deliveryInput>>;
type Photo = DeliveryArgs['photos'][number];

/** A problem the caller can fix or read out. Never turned into a verdict. */
export class DeliveryCheckError extends Error {}

// ---------------------------------------------------------------------------------------------
// Fetching photos given as URLs: https only, public addresses only, no redirects, size-capped.

const PRIVATE = new BlockList();
for (const [net, bits] of [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['224.0.0.0', 3],
] as const)
  PRIVATE.addSubnet(net, bits, 'ipv4');
for (const [net, bits] of [
  ['::', 127],
  ['fc00::', 7],
  ['fe80::', 10],
  ['ff00::', 8],
] as const)
  PRIVATE.addSubnet(net, bits, 'ipv6');

function isPrivateAddress(ip: string): boolean {
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(ip);
  if (mapped) return PRIVATE.check(mapped[1]!, 'ipv4');
  return PRIVATE.check(ip, isIP(ip) === 6 ? 'ipv6' : 'ipv4');
}

async function assertPublicHost(hostname: string): Promise<void> {
  const host = hostname.replace(/^\[|\]$/g, '');
  const addresses = isIP(host) ? [{ address: host }] : await lookup(host, { all: true }).catch(() => []);
  if (addresses.length === 0)
    throw new DeliveryCheckError(`I couldn't find the host ${hostname} for a photo URL.`);
  if (addresses.some((a) => isPrivateAddress(a.address)))
    throw new DeliveryCheckError('Photo URLs must point to a public host. Send the photo as base64 instead.');
}

async function readCapped(res: Response, max: number): Promise<Uint8Array> {
  const declared = Number(res.headers.get('content-length') ?? '0');
  if (declared > max)
    throw new DeliveryCheckError('A photo is over 10 megabytes. Please send a smaller one.');
  const chunks: Uint8Array[] = [];
  let total = 0;
  const reader = res.body?.getReader();
  if (!reader) return new Uint8Array();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > max) {
      await reader.cancel();
      throw new DeliveryCheckError('A photo is over 10 megabytes. Please send a smaller one.');
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks);
}

async function photoBytes(p: Photo, fetchImpl: typeof fetch): Promise<{ bytes: Uint8Array; mime: string }> {
  if (p.base64) {
    const m = /^data:([^;,]+)?(;base64)?,/.exec(p.base64);
    const raw = m ? p.base64.slice(m[0].length) : p.base64;
    const bytes = Buffer.from(raw, 'base64');
    if (bytes.length === 0) throw new DeliveryCheckError(`A ${p.kind} photo was empty.`);
    if (bytes.length > MAX_PHOTO_BYTES)
      throw new DeliveryCheckError('A photo is over 10 megabytes. Please send a smaller one.');
    return { bytes, mime: p.mime ?? m?.[1] ?? 'application/octet-stream' };
  }
  const url = new URL(p.url!);
  if (url.protocol !== 'https:')
    throw new DeliveryCheckError('Photo URLs must start with https://. Or send the photo as base64.');
  await assertPublicHost(url.hostname);
  let res: Response;
  try {
    res = await fetchImpl(url, { redirect: 'error', signal: AbortSignal.timeout(PHOTO_FETCH_TIMEOUT_MS) });
  } catch {
    throw new DeliveryCheckError(
      `I couldn't download the ${p.kind} photo from ${url.host}. Send it as base64 instead.`,
    );
  }
  if (!res.ok)
    throw new DeliveryCheckError(`Downloading the ${p.kind} photo failed with status ${res.status}.`);
  const bytes = await readCapped(res, MAX_PHOTO_BYTES);
  return {
    bytes,
    mime: p.mime ?? res.headers.get('content-type')?.split(';')[0]?.trim() ?? 'application/octet-stream',
  };
}

// ---------------------------------------------------------------------------------------------
// Listing images: https URLs go to the service, which fetches them with its own guards. Demo Store
// paths are read from the web app's public folder.

const DEMO_STORE_PATH = /^\/demo-store\/[a-z0-9-]+\.(png|jpe?g|webp)$/;
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

type ListingImage = { url: string } | { file: string };

function listingImage(ref: string, webPublicDir: string): ListingImage {
  if (DEMO_STORE_PATH.test(ref)) return { file: path.join(webPublicDir, ref) };
  let u: URL;
  try {
    u = new URL(ref);
  } catch {
    throw new DeliveryCheckError(`"${ref}" is not a listing image URL I can use. Use an https URL.`);
  }
  if (LOCAL_HOSTS.has(u.hostname) && DEMO_STORE_PATH.test(u.pathname))
    return { file: path.join(webPublicDir, u.pathname) };
  if (u.protocol !== 'https:') throw new DeliveryCheckError('Listing image URLs must start with https://.');
  return { url: u.toString() };
}

// ---------------------------------------------------------------------------------------------

function countKinds(photos: Photo[]): void {
  const n = { item: 0, label: 0, damage: 0 };
  for (const p of photos) n[p.kind]++;
  if (n.item === 0) throw new DeliveryCheckError('Add at least one photo of the item itself (kind "item").');
  if (n.item > 4) throw new DeliveryCheckError('Send at most 4 photos of the item.');
  if (n.label > 1) throw new DeliveryCheckError('Send at most one size tag photo (kind "label").');
  if (n.damage > 1) throw new DeliveryCheckError('Send at most one damage photo (kind "damage").');
}

export function toCoreVerdict(v: z.infer<typeof wireVerdict>['verdict']): Verdict {
  return {
    kind: v.kind,
    headline: v.headline,
    nextSteps: v.next_steps ?? v.nextSteps ?? [],
    reasons: v.reasons.map((r) => ({
      module: r.module,
      finding: r.finding,
      confidence: r.confidence,
      ...(r.expected ? { expected: r.expected } : {}),
      ...(r.observed ? { observed: r.observed } : {}),
      sentence: r.sentence,
    })),
  };
}

function unreachable(url: string): string {
  return [
    `The delivery check service at ${url} isn't reachable, so I couldn't check this parcel and there is no verdict.`,
    'Nothing has been decided about the item. Tell the user the check could not run and that they can try again shortly.',
    'To fix it, start the vision service (port 8011) or set VISION_SERVICE_URL to where it runs.',
  ].join(' ');
}

export async function verifyDelivery(
  args: DeliveryArgs,
  config: Pick<ServerConfig, 'visionServiceUrl' | 'webPublicDir' | 'fetch'>,
) {
  countKinds(args.photos);
  const form = new FormData();
  for (const [i, p] of args.photos.entries()) {
    const { bytes, mime } = await photoBytes(p, config.fetch);
    form.append(p.kind, new Blob([new Uint8Array(bytes)], { type: mime }), `${p.kind}-${i + 1}`);
  }
  for (const ref of args.listing.image_urls) {
    const img = listingImage(ref, config.webPublicDir);
    if ('url' in img) form.append('listing_image_url', img.url);
    else {
      const bytes = await readFile(img.file).catch(() => {
        throw new DeliveryCheckError(`I couldn't find the Demo Store image ${path.basename(img.file)}.`);
      });
      form.append('listing_image', new Blob([new Uint8Array(bytes)]), path.basename(img.file));
    }
  }
  const { title, colour, size } = args.listing;
  form.append(
    'listing',
    JSON.stringify({
      title,
      colour: colour ?? null,
      size: size ?? null,
      attributes: { ...(colour ? { colour } : {}), ...(size ? { size } : {}) },
    }),
  );

  let res: Response;
  try {
    res = await config.fetch(`${config.visionServiceUrl}/verify`, {
      method: 'POST',
      body: form,
      signal: AbortSignal.timeout(VISION_TIMEOUT_MS),
    });
  } catch {
    throw new DeliveryCheckError(unreachable(config.visionServiceUrl));
  }
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as {
      detail?: { code?: string; message?: string };
    } | null;
    const message = body?.detail?.message;
    if (res.status < 500 && message)
      throw new DeliveryCheckError(
        `The delivery check couldn't use these photos: ${message} (${body?.detail?.code ?? res.status}). There is no verdict yet.`,
      );
    throw new DeliveryCheckError(
      `The delivery check service returned an error (status ${res.status}), so there is no verdict. Try again shortly.`,
    );
  }
  const parsed = wireVerdict.safeParse(await res.json().catch(() => null));
  if (!parsed.success)
    throw new DeliveryCheckError(
      'The delivery check service sent a reply I could not read, so there is no verdict.',
    );

  const verdict = toCoreVerdict(parsed.data.verdict);
  const productNoun = categoryOf(title)?.canonical;
  return {
    kind: verdict.kind,
    headline: verdict.headline,
    reasons: verdict.reasons.map((r) => ({ ...r, confidence_words: CONFIDENCE_WORDS[r.confidence] })),
    next_steps: verdict.nextSteps,
    spoken: presentVerdict(verdict, productNoun ? { productNoun } : {}).text,
    ...(parsed.data.timings_ms ? { timings_ms: parsed.data.timings_ms } : {}),
  };
}

export function registerDelivery(server: McpServer, config: ServerConfig): void {
  server.registerTool(
    'verify_delivery',
    {
      title: 'Check a delivered item against its listing',
      description: [
        'Checks photos of a delivered item against the listing it was bought from: colour, the size on the tag, whether it is the same product, and visible damage.',
        'Pass the listing (title, colour, size, listing image URLs) and the photos: 1 to 4 of the item, optionally one close-up of the size tag (kind "label") and one of any damage.',
        'Returns match, mismatch or unsure with a reason per check. Confidence is given in words (sure, fairly sure, not sure); say those words, never percentages.',
        'It never says match unless every check that applies agrees. Read `spoken` aloud, or the headline then each reason sentence.',
        'On a mismatch, offer to build an evidence pack with build_evidence_pack. If the check service is unavailable you get an error and no verdict: never invent one.',
      ].join(' '),
      inputSchema: deliveryInput,
      outputSchema: deliveryOutput,
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
    },
    async (args) => {
      try {
        const out = await verifyDelivery(args, config);
        const text = [
          `Verdict: ${out.kind}. ${out.headline}`,
          ...out.reasons.map((r) => `- ${r.module} (${r.finding}, ${r.confidence_words}): ${r.sentence}`),
          ...(out.next_steps.length > 0 ? [`Next steps: ${out.next_steps.join(' ')}`] : []),
          `Read aloud: ${out.spoken}`,
        ].join('\n');
        return ok(out, text);
      } catch (e) {
        if (e instanceof DeliveryCheckError) return fail(e.message);
        throw e;
      }
    },
  );
}
