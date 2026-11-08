#!/usr/bin/env node
// Offline verifier for receipts and evidence packs. Needs only Node.js: no network, no server.
// Usage: node scripts/verify-receipt.mjs <receipt.json | evidence.json> [expected-public-key-hex]
import { createHash, createPublicKey, verify } from 'node:crypto';
import { readFileSync } from 'node:fs';

const [file, expectedKey] = process.argv.slice(2);
if (!file) {
  console.error('Usage: node scripts/verify-receipt.mjs <receipt.json> [expected-public-key-hex]');
  process.exit(2);
}
const r = JSON.parse(readFileSync(file, 'utf8'));

// Canonical JSON: keys sorted by UTF-16 code units, no whitespace, JSON.stringify escaping.
function canonical(v) {
  if (v === null || typeof v === 'boolean') return JSON.stringify(v);
  if (typeof v === 'number') {
    if (!Number.isFinite(v)) throw new Error('non-finite number');
    return JSON.stringify(Object.is(v, -0) ? 0 : v);
  }
  if (typeof v === 'string') return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  if (typeof v === 'object') {
    const keys = Object.keys(v).filter((k) => v[k] !== undefined).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonical(v[k])}`).join(',')}}`;
  }
  throw new Error(`not JSON: ${typeof v}`);
}

// Domain-separated SHA-256: 4-byte big-endian tag length, "SIGHTLINE/v1/<domain>", 0x00, payload.
function hashDomain(domain, data) {
  const tag = Buffer.from(`SIGHTLINE/v1/${domain}`, 'utf8');
  const len = Buffer.alloc(4);
  len.writeUInt32BE(tag.length);
  return createHash('sha256').update(Buffer.concat([len, tag, Buffer.from([0])])).update(Buffer.from(data, 'utf8')).digest('hex');
}

const key = expectedKey ?? r.publicKey;
// Evidence packs carry { manifest, manifestHash }; receipts carry { body, hash }.
const isEvidence = r.manifest !== undefined;
const hash = isEvidence ? r.manifestHash : r.hash;
const recomputed = isEvidence ? hashDomain('evidence-manifest', canonical(r.manifest)) : hashDomain('receipt', canonical(r.body));
const hashOk = recomputed === hash;
let sigOk = false;
try {
  const spki = Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), Buffer.from(key, 'hex')]);
  sigOk = verify(null, Buffer.from(hash, 'utf8'), createPublicKey({ key: spki, format: 'der', type: 'spki' }), Buffer.from(r.ed25519 ?? '', 'base64url'));
} catch {
  sigOk = false;
}
const keyOk = !expectedKey || expectedKey.toLowerCase() === String(r.publicKey).toLowerCase();
console.log(`hash recomputed from body: ${hashOk ? 'MATCHES' : 'DOES NOT MATCH'}`);
console.log(`Ed25519 signature:         ${sigOk ? 'VALID' : 'INVALID'}`);
if (expectedKey) console.log(`public key pinned:         ${keyOk ? 'MATCHES' : 'DIFFERENT KEY'}`);
const ok = hashOk && sigOk && keyOk;
const what = isEvidence ? 'Evidence pack' : 'Receipt';
console.log(ok ? `${what} is authentic and unchanged.` : `${what} failed verification.`);
process.exit(ok ? 0 : 1);
