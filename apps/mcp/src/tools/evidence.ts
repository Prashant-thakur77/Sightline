import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { newId, type OrderStatus, type Readback, type Verdict } from '@sightline/core';
import {
  buildManifest,
  hashEvidenceFile,
  hashReadbackText,
  isHexHash,
  signHash,
  verifyHashSignature,
  verifyManifest,
  type EvidenceManifest,
} from '@sightline/evidence';
import { z } from 'zod';
import type { ServerConfig } from '../config';
import { callerSnapshot, currencyCode, dollars, fail, isoDate, ok, toMoney } from '../shared';
import { toCoreVerdict } from './delivery';

const MAX_PHOTO_BYTES = 10 * 1024 * 1024;

const reasonIn = z.object({
  module: z.enum(['colour', 'size', 'identity', 'damage', 'quality']),
  finding: z.enum(['agree', 'disagree', 'unknown']),
  confidence: z.enum(['sure', 'fairly_sure', 'not_sure']),
  expected: z.string().nullish(),
  observed: z.string().nullish(),
  sentence: z.string().max(1000),
});

const fileName = z
  .string()
  .min(1)
  .max(100)
  .regex(/^[A-Za-z0-9._-]+$/, 'Use letters, numbers, dots, dashes or underscores, e.g. "item.jpg".');

function decodeBase64(s: string): Buffer {
  const m = /^data:[^,]*;base64,/.exec(s);
  return Buffer.from(m ? s.slice(m[0].length) : s, 'base64');
}

export const buildInput = {
  order: z.strictObject({
    id: z.string().min(1).max(100),
    amount: dollars.describe('Amount paid in dollars, e.g. "36.72".'),
    currency: currencyCode,
    merchant: z.string().min(1).max(200).describe('Seller name.'),
    placed_at: isoDate.describe('When the order was placed, ISO 8601.'),
    paypal_order_id: z.string().max(100).optional(),
  }),
  readback_text: z
    .string()
    .min(1)
    .max(10_000)
    .describe('The readback exactly as it was spoken before payment (the `text` from accessible_readback).'),
  listing: z.strictObject({
    title: z.string().min(1).max(500),
    colour: z.string().max(80).optional(),
    size: z.string().max(40).optional(),
    price: dollars,
  }),
  verdict: z
    .object({
      kind: z.enum(['match', 'mismatch', 'unsure']),
      headline: z.string().max(1000),
      reasons: z.array(reasonIn).max(20),
      next_steps: z.array(z.string().max(1000)).max(10).optional(),
    })
    .describe('The verdict exactly as verify_delivery returned it. Extra fields are ignored.'),
  photos: z
    .array(
      z.strictObject({
        name: fileName,
        base64: z.string().max(14_000_000),
        mime: z.string().max(60),
        taken_at: isoDate
          .optional()
          .describe('When the photo was taken. Defaults to when the pack is built.'),
      }),
    )
    .max(8)
    .describe('The photos the verdict was made from. Only their hashes go in the manifest.'),
  narrative: z
    .string()
    .min(1)
    .max(5000)
    .describe("Plain account of what went wrong, in the buyer's words or a factual summary."),
};

export const buildOutput = {
  manifest: z.record(z.string(), z.unknown()),
  manifest_hash: z.string(),
  signature: z.string().describe('Ed25519 signature, base64url, over the ASCII manifest_hash.'),
  signature_algorithm: z.literal('Ed25519'),
  public_key: z.string().describe('Raw Ed25519 public key, hex.'),
  key_fingerprint: z.string(),
  key_source: z.enum(['configured', 'ephemeral']),
  key_note: z.string(),
  files: z.array(z.object({ name: z.string(), hash: z.string(), size: z.number().optional() })),
};

export const verifyInput = {
  manifest: z
    .record(z.string(), z.unknown())
    .describe('The manifest object exactly as build_evidence_pack returned it.'),
  manifest_hash: z.string(),
  signature: z.string().max(200),
  public_key: z.string().max(200),
  expected_public_key: z
    .string()
    .max(200)
    .optional()
    .describe(
      'Pin the key you trust. Without it, a valid signature only proves whoever holds public_key signed this exact manifest.',
    ),
  files: z
    .array(z.strictObject({ name: fileName, base64: z.string().max(14_000_000) }))
    .max(8)
    .optional()
    .describe('Photo bytes to check against the manifest file hashes.'),
};

export const verifyOutput = {
  ok: z.boolean(),
  problems: z.array(z.string()),
  explanation: z.string(),
  recomputed_manifest_hash: z.string().nullable(),
  signature_valid: z.boolean(),
  files_checked: z.number(),
  public_key_is_this_servers: z.boolean(),
};

const STATUS: Record<Verdict['kind'], OrderStatus> = {
  match: 'verified_match',
  mismatch: 'verified_mismatch',
  unsure: 'verified_unsure',
};

const PROBLEM_WORDS: Record<string, string> = {
  malformed: 'the manifest is not valid JSON data',
  schema: 'the manifest is not a recognised evidence pack version',
  manifest_hash_mismatch: 'the manifest has changed since its hash was taken',
  snapshot_hash_mismatch: 'the listing snapshot has changed',
  snapshot_malformed: 'the listing snapshot is missing or damaged',
  readback_text_hash_mismatch: 'the readback text has changed',
  readback_malformed: 'the readback is missing or damaged',
  bad_signature: 'the signature does not match this manifest hash and public key',
  public_key_malformed: 'the public key is not 32 bytes of hex',
  unexpected_key: 'it was signed with a different key from the one you pinned',
};

function explain(problem: string): string {
  const [code, name] = problem.split(':');
  const words: Record<string, string> = {
    duplicate_file_name: `two files are called ${name}`,
    file_hash_malformed: `the hash for ${name} is damaged`,
    unknown_file: `${name} is not in the manifest`,
    file_hash_mismatch: `${name} is not the photo that was packed`,
    file_size_mismatch: `${name} is a different size from the photo that was packed`,
  };
  return PROBLEM_WORDS[problem] ?? words[code!] ?? problem;
}

type BuildArgs = z.infer<z.ZodObject<typeof buildInput>>;
type VerifyArgs = z.infer<z.ZodObject<typeof verifyInput>>;

export class EvidenceError extends Error {}

export function buildEvidencePack(args: BuildArgs, config: Pick<ServerConfig, 'signingKey' | 'now'>) {
  if (!config.signingKey.ok) throw new EvidenceError(config.signingKey.error);
  const { keys, source } = config.signingKey;
  const now = config.now();
  const createdAt = now.toISOString();
  const currency = args.order.currency;
  const verdict = toCoreVerdict(args.verdict);

  const snapshot = callerSnapshot(
    {
      title: args.listing.title,
      colour: args.listing.colour || undefined,
      size: args.listing.size || undefined,
      price: toMoney(args.listing.price, currency),
      returnPolicy: null,
      sellerName: args.order.merchant,
    },
    new Date(args.order.placed_at),
    newId('snap'),
  );
  // Only the words were supplied, so the readback is not bound to a cart here: cartId and
  // cartHash stay empty rather than invented.
  const readback: Readback = {
    id: newId('rb'),
    cartId: '',
    cartHash: '',
    text: args.readback_text,
    fields: [],
    textHash: hashReadbackText(args.readback_text),
    createdAt: new Date(args.order.placed_at).toISOString(),
  };
  const photos = args.photos.map((p) => {
    const bytes = decodeBase64(p.base64);
    if (bytes.length === 0) throw new EvidenceError(`The photo ${p.name} is empty.`);
    if (bytes.length > MAX_PHOTO_BYTES) throw new EvidenceError(`The photo ${p.name} is over 10 megabytes.`);
    return {
      name: p.name,
      mime: p.mime,
      takenAt: p.taken_at ? new Date(p.taken_at).toISOString() : createdAt,
      bytes: new Uint8Array(bytes),
    };
  });

  let built;
  try {
    built = buildManifest<Verdict>({
      order: {
        id: args.order.id,
        paypalOrderId: args.order.paypal_order_id,
        status: STATUS[verdict.kind],
        amount: toMoney(args.order.amount, currency),
        payee: { merchantId: '', name: args.order.merchant },
        placedAt: new Date(args.order.placed_at).toISOString(),
      },
      readback,
      snapshot,
      photos,
      verification: verdict,
      narrative: args.narrative,
      createdAt,
    });
  } catch (e) {
    throw new EvidenceError(`I couldn't build the evidence pack: ${(e as Error).message}.`);
  }
  // Round-trip through JSON so what is returned is exactly what will be hashed on the way back.
  const manifest = JSON.parse(JSON.stringify(built.manifest)) as Record<string, unknown>;
  return {
    manifest,
    manifest_hash: built.manifestHash,
    signature: signHash(built.manifestHash, keys),
    signature_algorithm: 'Ed25519' as const,
    public_key: keys.publicKeyHex,
    key_fingerprint: keys.fingerprint,
    key_source: source,
    key_note:
      source === 'configured'
        ? 'Signed with the evidence key derived from RECEIPT_SIGNING_KEY. Anyone can check it offline with public_key.'
        : 'RECEIPT_SIGNING_KEY is not set, so this pack was signed with a temporary key that lasts only while this server process runs. The signature still shows the pack has not changed since signing, but the key is not tied to anyone. Set RECEIPT_SIGNING_KEY for a stable key.',
    files: built.manifest.files.map((f) => ({
      name: f.name,
      hash: f.hash,
      ...(f.size !== undefined ? { size: f.size } : {}),
    })),
  };
}

export function verifyEvidencePack(args: VerifyArgs, config: Pick<ServerConfig, 'signingKey'>) {
  const files = (args.files ?? []).map((f) => ({
    name: f.name,
    bytes: new Uint8Array(decodeBase64(f.base64)),
  }));
  const manifest = args.manifest as unknown as EvidenceManifest<unknown>;
  const check = verifyManifest({ manifest, manifestHash: args.manifest_hash }, files);
  const problems = [...check.problems];

  const keyOk = /^[0-9a-f]{64}$/i.test(args.public_key);
  if (!keyOk) problems.push('public_key_malformed');
  const signatureValid =
    keyOk &&
    isHexHash(args.manifest_hash) &&
    verifyHashSignature(args.manifest_hash, args.signature, args.public_key);
  if (keyOk && !signatureValid) problems.push('bad_signature');
  if (args.expected_public_key && args.expected_public_key.toLowerCase() !== args.public_key.toLowerCase())
    problems.push('unexpected_key');

  const ours =
    config.signingKey.ok &&
    config.signingKey.keys.publicKeyHex.toLowerCase() === args.public_key.toLowerCase();
  const okAll = problems.length === 0;
  const explanation = okAll
    ? `The pack is intact: every hash recomputes and the Ed25519 signature is valid for this public key${ours ? ", which is this server's evidence key" : ''}.${
        files.length === 0 ? ' Photo bytes were not checked; pass them in files to check them too.' : ''
      }`
    : `The pack failed verification: ${problems.map(explain).join('; ')}.`;
  return {
    ok: okAll,
    problems,
    explanation,
    recomputed_manifest_hash: check.manifestHash,
    signature_valid: signatureValid,
    files_checked: check.filesChecked,
    public_key_is_this_servers: ours,
  };
}

export function registerEvidence(server: McpServer, config: ServerConfig): void {
  server.registerTool(
    'build_evidence_pack',
    {
      title: 'Build a signed evidence pack',
      description: [
        'Builds a tamper-evident evidence pack for a buyer-protection claim (wrong item, wrong size or colour, damage) after verify_delivery.',
        'The manifest embeds the order, the readback exactly as spoken before payment, the listing, the verdict, the narrative and a SHA-256 hash of each photo. It is hashed with canonical JSON and signed with Ed25519, so anyone can check offline that nothing was changed.',
        'Pass the verdict exactly as verify_delivery returned it and the same photos. Use the result as evidence in a PayPal dispute or a message to the seller; verify it with verify_evidence_pack.',
        'If no signing key is configured, a temporary key is used and key_source says "ephemeral".',
      ].join(' '),
      inputSchema: buildInput,
      outputSchema: buildOutput,
      annotations: { readOnlyHint: true, idempotentHint: false, openWorldHint: false },
    },
    async (args) => {
      try {
        const out = buildEvidencePack(args, config);
        return ok(
          out,
          [
            `Evidence pack built for order ${args.order.id} (${out.files.length} photo${out.files.length === 1 ? '' : 's'}).`,
            `manifest_hash ${out.manifest_hash}`,
            `Ed25519 signature ${out.signature}`,
            `public_key ${out.public_key} (${out.key_source})`,
            out.key_note,
          ].join('\n'),
        );
      } catch (e) {
        if (e instanceof EvidenceError) return fail(e.message);
        throw e;
      }
    },
  );

  server.registerTool(
    'verify_evidence_pack',
    {
      title: 'Verify an evidence pack',
      description: [
        'Checks an evidence pack from build_evidence_pack: recomputes the manifest hash, the listing snapshot hash and the readback text hash, and checks the Ed25519 signature over the manifest hash.',
        'Returns ok plus a list of problems in plain words. Pass expected_public_key to pin the key you trust, and files (photo bytes) to check the photos too.',
      ].join(' '),
      inputSchema: verifyInput,
      outputSchema: verifyOutput,
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    },
    async (args) => {
      const out = verifyEvidencePack(args, config);
      return ok(out, `${out.ok ? 'Verified.' : 'Not verified.'} ${out.explanation}`);
    },
  );
}
