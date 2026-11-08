import { mkdtemp, writeFile } from 'node:fs/promises';
import { createServer as createHttpServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { hashReadbackText } from '@sightline/evidence';
import { afterEach, describe, expect, it } from 'vitest';
import { resolveSigningKey } from '../src/config';
import { READBACK_RULES_URI } from '../src/rules';
import { call, closedPort, connect, textOf } from './helpers';

const closers: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (closers.length > 0) await closers.pop()!();
});

async function client(over: Parameters<typeof connect>[0] = {}) {
  const c = await connect(over);
  closers.push(c.close);
  return c.client;
}

const HARBOR = {
  items: [
    { title: 'Harbor knit crew-neck sweater', colour: 'Navy', size: 'M', unit_price: '34.00', quantity: 1 },
  ],
  seller: 'Demo Store',
  payment_label: 'your saved PayPal',
  delivery_date: '2026-11-17',
  return_policy: { window_days: 30, free: true },
};

describe('listing', () => {
  it('exposes the six tools and the rules resource', async () => {
    const c = await client();
    const { tools } = await c.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([
      'accessible_readback',
      'barrier_index',
      'build_evidence_pack',
      'check_confirmation_phrase',
      'verify_delivery',
      'verify_evidence_pack',
    ]);
    for (const t of tools) {
      expect(t.description!.length).toBeGreaterThan(80);
      expect(t.outputSchema).toBeDefined();
    }
    const { resources } = await c.listResources();
    expect(resources.map((r) => r.uri)).toContain(READBACK_RULES_URI);
    const rules = await c.readResource({ uri: READBACK_RULES_URI });
    const text = (rules.contents[0] as { text: string }).text;
    expect(text).toContain('Two-key confirmation');
    expect(text).toContain('word for word');
  });
});

describe('accessible_readback', () => {
  it('reads the Harbor sweater back word for word, with totals recomputed by Demo Store rules', async () => {
    const c = await client();
    const r = await call(c, 'accessible_readback', HARBOR);
    expect(r.isError).toBeFalsy();
    const out = r.structuredContent as {
      text: string;
      text_hash: string;
      fields: { key: string; value: string }[];
      totals: Record<string, { amount: string; spoken: string }>;
      totals_source: Record<string, string>;
    };
    expect(out.text).toBe(
      "Here's what you're buying. Harbor knit crew-neck sweater. Colour: navy. Size: M. Quantity: one. Sold by Demo Store. " +
        'Item $34.00, shipping free, tax $2.72, total $36.72, paid with your saved PayPal. Arrives by Tuesday 17 November. ' +
        "Free returns within 30 days. To pay, say 'confirm purchase'. To change something, say what to change.",
    );
    expect(out.text).toContain('total $36.72');
    expect(out.text_hash).toBe(hashReadbackText(out.text));
    expect(out.totals.total).toEqual({ amount: '36.72', currency: 'USD', spoken: '$36.72' });
    expect(out.totals_source).toEqual({ shipping: 'demo_store_rule', tax: 'demo_store_rule' });
    const byKey = Object.fromEntries(out.fields.map((f) => [f.key, f.value]));
    expect(byKey).toMatchObject({
      'line1.colour': 'navy',
      'line1.size': 'M',
      total: '$36.72',
      delivery: 'Tuesday 17 November',
    });
    expect(textOf(r)).toContain(out.text);
  });

  it('uses store-quoted shipping and tax when given, and charges shipping under the free threshold otherwise', async () => {
    const c = await client();
    const quoted = await call(c, 'accessible_readback', { ...HARBOR, shipping: '5.00', tax: '3.10' });
    const q = quoted.structuredContent as { text: string; totals_source: Record<string, string> };
    expect(q.text).toContain('Item $34.00, shipping $5.00, tax $3.10, total $42.10');
    expect(q.totals_source).toEqual({ shipping: 'caller', tax: 'caller' });

    const cheap = await call(c, 'accessible_readback', {
      ...HARBOR,
      items: [{ title: 'Speckled stoneware mug, 12 oz', colour: 'teal', unit_price: '16', quantity: 1 }],
      return_policy: undefined,
      delivery_date: undefined,
      verbosity: 'brief',
    });
    const t = (cheap.structuredContent as { text: string }).text;
    // $16.00 + $4.99 shipping + $1.28 tax
    expect(t).toContain('Total $22.27 with shipping and tax');
    expect(t).toContain("Size: the listing doesn't say.");
    expect(t).toContain("The seller hasn't given a delivery date.");
    expect(t).toContain("Returns: the listing doesn't say.");
  });

  it('refuses unknown fields instead of silently dropping them', async () => {
    const c = await client();
    const r = await call(c, 'accessible_readback', {
      ...HARBOR,
      items: [{ title: 'Harbor knit crew-neck sweater', color: 'navy', unit_price: '34.00', quantity: 1 }],
    });
    expect(r.isError).toBe(true);
    expect(textOf(r)).toMatch(/color/);
  });
});

describe('check_confirmation_phrase', () => {
  it.each([
    ['confirm purchase', 'confirm', 'phrase'],
    ['yeah no', 'cancel', 'negation'],
    ['wait', 'hold', 'hold'],
    ['he said confirm', 'none', 'reported_speech'],
    ['yes', 'none', 'affirmative_only'],
  ])('"%s" -> %s (%s)', async (utterance, decision, reason) => {
    const c = await client();
    const r = await call(c, 'check_confirmation_phrase', { utterance });
    const out = r.structuredContent as {
      decision: string;
      reason: string;
      key1_passed: boolean;
      payment_allowed: boolean;
      next_step: string;
    };
    expect(out.decision).toBe(decision);
    expect(out.reason).toBe(reason);
    expect(out.key1_passed).toBe(decision === 'confirm');
    expect(out.payment_allowed).toBe(false);
  });

  it('says a second independent key is still required after key 1 passes', async () => {
    const c = await client();
    const r = await call(c, 'check_confirmation_phrase', { utterance: 'Confirm purchase.' });
    const out = r.structuredContent as { next_step: string };
    expect(out.next_step).toMatch(/second, independent key is required/);
    expect(textOf(r)).toMatch(/Key 1 decision: confirm/);
  });

  it('handles the offer phase', async () => {
    const c = await client();
    const accept = await call(c, 'check_confirmation_phrase', {
      utterance: 'accept the offer',
      phase: 'offer',
    });
    expect((accept.structuredContent as { decision: string }).decision).toBe('confirm');
    const decline = await call(c, 'check_confirmation_phrase', { utterance: 'decline', phase: 'offer' });
    expect((decline.structuredContent as { decision: string }).decision).toBe('cancel');
  });
});

// ---------------------------------------------------------------------------------------------

const VERDICT = {
  kind: 'mismatch',
  headline: "This doesn't match.",
  reasons: [
    {
      module: 'size',
      finding: 'disagree',
      confidence: 'sure',
      confidence_words: 'sure',
      expected: 'M',
      observed: 'L',
      sentence: "The size tag reads L, you ordered M. I'm sure about that.",
    },
  ],
  next_steps: ['Keep the item, its tags and the packaging as they are.'],
  spoken:
    "This doesn't match. The size tag reads L, you ordered M. I'm sure about that. Want me to get your money back?",
};
const ITEM_PHOTO = Buffer.from('item photo bytes').toString('base64');
const LABEL_PHOTO = Buffer.from('label photo bytes').toString('base64');

function packInput(readbackText: string) {
  return {
    order: {
      id: 'ord_123',
      amount: '36.72',
      merchant: 'Demo Store',
      placed_at: '2026-11-09T12:05:00Z',
      paypal_order_id: '5O190127TN364715T',
    },
    readback_text: readbackText,
    listing: { title: 'Harbor knit crew-neck sweater', colour: 'navy', size: 'M', price: '34.00' },
    verdict: VERDICT,
    photos: [
      { name: 'item.jpg', base64: ITEM_PHOTO, mime: 'image/jpeg' },
      { name: 'label.jpg', base64: LABEL_PHOTO, mime: 'image/jpeg', taken_at: '2026-11-17T15:00:00Z' },
    ],
    narrative: 'I ordered size M. The tag on the sweater that arrived says L.',
  };
}

type Pack = {
  manifest: Record<string, unknown>;
  manifest_hash: string;
  signature: string;
  public_key: string;
  key_source: string;
};
type Check = {
  ok: boolean;
  problems: string[];
  signature_valid: boolean;
  files_checked: number;
  public_key_is_this_servers: boolean;
};

describe('evidence packs', () => {
  it('round-trips: build then verify is ok, and any tampering is caught', async () => {
    const c = await client();
    const rb = await call(c, 'accessible_readback', HARBOR);
    const readbackText = (rb.structuredContent as { text: string }).text;

    const built = await call(c, 'build_evidence_pack', packInput(readbackText));
    expect(built.isError).toBeFalsy();
    const pack = built.structuredContent as Pack;
    expect(pack.manifest_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(pack.key_source).toBe('configured');
    expect(pack.manifest).toMatchObject({
      schema: 'sightline.evidence/v1',
      order: { id: 'ord_123', status: 'verified_mismatch', amount: { cents: 3672, currency: 'USD' } },
      readback: { text: readbackText, textHash: hashReadbackText(readbackText) },
      verification: { kind: 'mismatch', nextSteps: VERDICT.next_steps },
    });

    const verify = async (over: Partial<Pack> & { files?: unknown[]; expected_public_key?: string }) =>
      (
        await call(c, 'verify_evidence_pack', {
          manifest: pack.manifest,
          manifest_hash: pack.manifest_hash,
          signature: pack.signature,
          public_key: pack.public_key,
          ...over,
        })
      ).structuredContent as Check;

    const good = await verify({
      files: [
        { name: 'item.jpg', base64: ITEM_PHOTO },
        { name: 'label.jpg', base64: LABEL_PHOTO },
      ],
    });
    expect(good).toMatchObject({
      ok: true,
      problems: [],
      signature_valid: true,
      files_checked: 2,
      public_key_is_this_servers: true,
    });

    const tampered = await verify({ manifest: { ...pack.manifest, narrative: 'The sweater was fine.' } });
    expect(tampered.ok).toBe(false);
    expect(tampered.problems).toContain('manifest_hash_mismatch');

    const readback = pack.manifest.readback as Record<string, unknown>;
    const reworded = await verify({
      manifest: {
        ...pack.manifest,
        readback: { ...readback, text: String(readback.text).replace('$36.72', '$3.67') },
      },
    });
    expect(reworded.problems).toEqual(
      expect.arrayContaining(['manifest_hash_mismatch', 'readback_text_hash_mismatch']),
    );

    const forged = await verify({ signature: pack.signature.slice(0, -4) + 'AAAA' });
    expect(forged).toMatchObject({ ok: false, signature_valid: false });
    expect(forged.problems).toContain('bad_signature');

    const swappedPhoto = await verify({ files: [{ name: 'item.jpg', base64: LABEL_PHOTO }] });
    expect(swappedPhoto.problems).toContain('file_hash_mismatch:item.jpg');

    const otherKey = resolveSigningKey('cd'.repeat(32));
    const pinned = await verify({ expected_public_key: otherKey.ok ? otherKey.keys.publicKeyHex : '' });
    expect(pinned.problems).toContain('unexpected_key');
  });

  it('signs with an ephemeral key when none is configured, and says so', async () => {
    const c = await client({ signingKey: resolveSigningKey(undefined) });
    const built = await call(c, 'build_evidence_pack', packInput('Some readback.'));
    const pack = built.structuredContent as Pack & { key_note: string };
    expect(pack.key_source).toBe('ephemeral');
    expect(pack.key_note).toMatch(/RECEIPT_SIGNING_KEY is not set/);
    const check = await call(c, 'verify_evidence_pack', {
      manifest: pack.manifest,
      manifest_hash: pack.manifest_hash,
      signature: pack.signature,
      public_key: pack.public_key,
    });
    expect((check.structuredContent as Check).ok).toBe(true);
  });

  it('refuses to sign with a malformed configured key', async () => {
    const c = await client({ signingKey: resolveSigningKey('not-hex') });
    const built = await call(c, 'build_evidence_pack', packInput('Some readback.'));
    expect(built.isError).toBe(true);
    expect(textOf(built)).toMatch(/RECEIPT_SIGNING_KEY is set, but/);
  });
});

// ---------------------------------------------------------------------------------------------

const DELIVERY = {
  listing: {
    title: 'Harbor knit crew-neck sweater',
    colour: 'navy',
    size: 'M',
    image_urls: ['https://images.example/harbor-navy.jpg'],
  },
  photos: [
    { kind: 'item', base64: ITEM_PHOTO, mime: 'image/jpeg' },
    { kind: 'label', base64: `data:image/jpeg;base64,${LABEL_PHOTO}` },
  ],
};

async function fakeVision(
  respond: (form: FormData) => { status: number; body: unknown },
): Promise<{ url: string; seen: FormData[]; server: Server }> {
  const seen: FormData[] = [];
  const server = createHttpServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const form = await new Request('http://vision/verify', {
      method: 'POST',
      headers: { 'content-type': req.headers['content-type'] ?? '' },
      body: Buffer.concat(chunks),
    }).formData();
    seen.push(form);
    const { status, body } = respond(form);
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  closers.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, seen, server };
}

describe('verify_delivery', () => {
  it('returns an error result, not a verdict, when the vision service is down', async () => {
    const c = await client({ visionServiceUrl: `http://127.0.0.1:${await closedPort()}` });
    const r = await call(c, 'verify_delivery', DELIVERY);
    expect(r.isError).toBe(true);
    expect(r.structuredContent).toBeUndefined();
    expect(textOf(r)).toMatch(/isn't reachable/);
    expect(textOf(r)).toMatch(/there is no verdict/);
  });

  it('sends the photos and listing in the service contract and maps the verdict back', async () => {
    const vision = await fakeVision(() => ({
      status: 200,
      body: {
        verdict: {
          kind: 'mismatch',
          headline: "This doesn't match.",
          reasons: [
            {
              module: 'size',
              finding: 'disagree',
              confidence: 'sure',
              expected: 'M',
              observed: 'L',
              sentence: "The size tag reads L, you ordered M. I'm sure about that.",
            },
            {
              module: 'colour',
              finding: 'agree',
              confidence: 'fairly_sure',
              expected: 'navy',
              observed: 'navy',
              sentence: 'The colour looks navy.',
            },
          ],
          next_steps: ['Keep the item, its tags and the packaging as they are.'],
        },
        modules: {},
        timings_ms: { total: 630 },
      },
    }));
    const c = await client({ visionServiceUrl: vision.url });
    const r = await call(c, 'verify_delivery', DELIVERY);
    expect(r.isError).toBeFalsy();

    const form = vision.seen[0]!;
    expect(form.getAll('item')).toHaveLength(1);
    expect(Buffer.from(await (form.get('label') as Blob).arrayBuffer()).toString()).toBe('label photo bytes');
    expect(form.getAll('listing_image_url')).toEqual(['https://images.example/harbor-navy.jpg']);
    expect(JSON.parse(form.get('listing') as string)).toEqual({
      title: 'Harbor knit crew-neck sweater',
      colour: 'navy',
      size: 'M',
      attributes: { colour: 'navy', size: 'M' },
    });

    const out = r.structuredContent as {
      kind: string;
      reasons: { confidence_words: string }[];
      next_steps: string[];
      spoken: string;
    };
    expect(out.kind).toBe('mismatch');
    expect(out.reasons.map((x) => x.confidence_words)).toEqual(['sure', 'fairly sure']);
    expect(out.next_steps).toEqual(['Keep the item, its tags and the packaging as they are.']);
    expect(out.spoken).toBe(
      "This doesn't match. The size tag reads L, you ordered M. I'm sure about that. Want me to get your money back?",
    );
  });

  it('reads Demo Store listing images from the web app and relays service errors in plain words', async () => {
    const vision = await fakeVision(() => ({
      status: 422,
      body: { detail: { code: 'no_item_photo', message: 'Please add a photo of the item.' } },
    }));
    const c = await client({ visionServiceUrl: vision.url });
    const r = await call(c, 'verify_delivery', {
      ...DELIVERY,
      listing: { ...DELIVERY.listing, image_urls: ['/demo-store/harbor-knit-crew--navy.png'] },
    });
    expect(vision.seen[0]!.getAll('listing_image')).toHaveLength(1);
    expect(r.isError).toBe(true);
    expect(textOf(r)).toMatch(/Please add a photo of the item\. \(no_item_photo\)/);
  });

  it('rejects photo sets the service cannot use before calling it', async () => {
    const c = await client();
    const noItem = await call(c, 'verify_delivery', {
      ...DELIVERY,
      photos: [{ kind: 'label', base64: LABEL_PHOTO }],
    });
    expect(textOf(noItem)).toMatch(/at least one photo of the item/);
    const privateUrl = await call(c, 'verify_delivery', {
      ...DELIVERY,
      photos: [{ kind: 'item', url: 'https://127.0.0.1/x.jpg' }],
    });
    expect(textOf(privateUrl)).toMatch(/public host/);
    const plainHttp = await call(c, 'verify_delivery', {
      ...DELIVERY,
      photos: [{ kind: 'item', url: 'http://images.example/x.jpg' }],
    });
    expect(textOf(plainHttp)).toMatch(/https/);
  });
});

describe('barrier_index', () => {
  it('says the index has not been run when there are no results', async () => {
    const c = await client();
    const r = await call(c, 'barrier_index', {});
    expect(r.structuredContent).toMatchObject({ available: false, n: null, by_platform: [] });
    expect(textOf(r)).toMatch(/has not been run/);
  });

  it('reports aggregated results, by platform when asked', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'barrier-'));
    const file = path.join(dir, 'barrier.json');
    await writeFile(
      file,
      JSON.stringify({
        run_at: '2026-11-08',
        n: 52,
        by_platform: {
          shopify: {
            stores: 20,
            median_violations: 14,
            keyboard_fail_rate: 0.35,
            top_rules: [{ rule: 'label', stores: 12 }],
          },
          custom: { stores: 32, median_violations: 22, keyboard_fail_rate: 0.5 },
        },
        top_rules: [
          { rule: 'color-contrast', stores: 40 },
          { rule: 'button-name', stores: 31 },
        ],
      }),
    );
    const c = await client({ barrierResultsPath: file });
    const all = await call(c, 'barrier_index', {});
    expect(all.structuredContent).toMatchObject({
      available: true,
      run_at: '2026-11-08',
      n: 52,
      platforms_available: ['shopify', 'custom'],
    });
    expect((all.structuredContent as { top_failing_rules: unknown[] }).top_failing_rules[0]).toEqual({
      rule: 'color-contrast',
      stores: 40,
    });

    const shopify = await call(c, 'barrier_index', { platform: 'Shopify' });
    expect(shopify.structuredContent).toMatchObject({
      by_platform: [{ platform: 'shopify', stores: 20 }],
      top_failing_rules: [{ rule: 'label', stores: 12 }],
    });
    const missing = await call(c, 'barrier_index', { platform: 'magento' });
    expect(textOf(missing)).toMatch(/no Barrier Index results for "magento"/);
  });
});
