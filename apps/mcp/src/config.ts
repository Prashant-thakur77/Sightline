import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { loadEnv } from '@sightline/core/env';
import { keyPairFromSeed, type Ed25519KeyPair } from '@sightline/evidence';

export const DEFAULT_VISION_SERVICE_URL = 'http://localhost:8011';
/** Context string for the evidence key, so it never equals the web app's receipt key. */
export const EVIDENCE_KEY_CONTEXT = 'mcp-evidence';

export type SigningKey =
  { ok: true; keys: Ed25519KeyPair; source: 'configured' | 'ephemeral' } | { ok: false; error: string };

export interface ServerConfig {
  visionServiceUrl: string;
  /** Resolved once per process, so every request on a stateless HTTP server signs with the same key. */
  signingKey: SigningKey;
  barrierResultsPath: string;
  /** Path to the web app's public folder, for Demo Store listing images given as /demo-store/... paths. */
  webPublicDir: string;
  now: () => Date;
  fetch: typeof fetch;
}

export function resolveSigningKey(seedHex: string | undefined): SigningKey {
  if (seedHex) {
    try {
      return { ok: true, keys: keyPairFromSeed(seedHex, EVIDENCE_KEY_CONTEXT), source: 'configured' };
    } catch {
      return {
        ok: false,
        error:
          'RECEIPT_SIGNING_KEY is set, but it is not at least 32 bytes of hex, so I did not sign anything. Fix the value and restart the server.',
      };
    }
  }
  return {
    ok: true,
    keys: keyPairFromSeed(randomBytes(32).toString('hex'), EVIDENCE_KEY_CONTEXT),
    source: 'ephemeral',
  };
}

export const DEFAULT_BARRIER_RESULTS_PATH = fileURLToPath(
  new URL('../../../evals/results/barrier.json', import.meta.url),
);
export const DEFAULT_WEB_PUBLIC_DIR = fileURLToPath(new URL('../../web/public/', import.meta.url));

/**
 * Configuration from the environment. loadEnv() also refuses to run unless PayPal is configured
 * for the sandbox, the same boot check every process makes.
 */
export function configFromEnv(source: Record<string, string | undefined> = process.env): ServerConfig {
  const env = loadEnv(source);
  return {
    visionServiceUrl: (env.VISION_SERVICE_URL ?? DEFAULT_VISION_SERVICE_URL).replace(/\/+$/, ''),
    signingKey: resolveSigningKey(env.RECEIPT_SIGNING_KEY),
    barrierResultsPath: source.BARRIER_RESULTS_PATH?.trim() || DEFAULT_BARRIER_RESULTS_PATH,
    webPublicDir: DEFAULT_WEB_PUBLIC_DIR,
    now: () => new Date(),
    fetch: globalThis.fetch,
  };
}

/** Load the repo's .env.local and .env when present. Values already in the environment win. */
export function loadRepoEnvFiles(): void {
  for (const name of ['.env.local', '.env']) {
    try {
      process.loadEnvFile(fileURLToPath(new URL(`../../../${name}`, import.meta.url)));
    } catch {
      // Missing file: nothing to load.
    }
  }
}
