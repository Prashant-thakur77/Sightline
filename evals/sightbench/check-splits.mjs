#!/usr/bin/env node
/**
 * SightBench split guard. Exits 1 when:
 *   - any product id (listed or delivered) appears in both the dev and the test manifest,
 *   - a pair id appears in both,
 *   - the test manifest's sha256 differs from the freeze record (manifests/test.freeze.json),
 *   - with --files: an image is missing or its sha256 differs from the manifest.
 *
 *   node evals/sightbench/check-splits.mjs [--files]
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MANIFESTS = path.join(HERE, 'manifests');
const checkFiles = process.argv.includes('--files');
const problems = [];
const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');

function load(split) {
  const file = path.join(MANIFESTS, `${split}.json`);
  if (!existsSync(file)) {
    problems.push(`missing manifest ${path.relative(process.cwd(), file)}`);
    return null;
  }
  const bytes = readFileSync(file);
  return { file, bytes, json: JSON.parse(bytes.toString('utf8')) };
}

const productIds = (m) => new Set(m.json.pairs.flatMap((p) => [p.product_id, p.delivered.product_id]));

const dev = load('dev');
const test = load('test');

if (dev && test) {
  const devProducts = productIds(dev);
  const both = [...productIds(test)].filter((id) => devProducts.has(id));
  if (both.length > 0) problems.push(`product ids in both splits: ${both.join(', ')}`);
  const devPairs = new Set(dev.json.pairs.map((p) => p.id));
  const sharedPairs = test.json.pairs.filter((p) => devPairs.has(p.id)).map((p) => p.id);
  if (sharedPairs.length > 0) problems.push(`pair ids in both splits: ${sharedPairs.join(', ')}`);
}

const freezeFile = path.join(MANIFESTS, 'test.freeze.json');
let freeze = null;
if (!existsSync(freezeFile)) problems.push('missing freeze record manifests/test.freeze.json');
else freeze = JSON.parse(readFileSync(freezeFile, 'utf8'));
if (test && freeze) {
  const actual = sha256(test.bytes);
  if (actual !== freeze.sha256) problems.push(`test manifest changed since it was frozen: ${actual} != ${freeze.sha256}`);
}

let filesChecked = 0;
if (checkFiles) {
  for (const m of [dev, test]) {
    if (!m) continue;
    for (const pair of m.json.pairs) {
      for (const [rel, expected] of Object.entries(pair.sha256)) {
        const file = path.resolve(path.dirname(m.file), rel);
        if (!existsSync(file)) {
          problems.push(`missing image ${rel} (regenerate with the generator)`);
          continue;
        }
        filesChecked++;
        if (sha256(readFileSync(file)) !== expected) problems.push(`image changed: ${rel}`);
      }
    }
  }
}

for (const m of [dev, test]) {
  if (!m) continue;
  const c = m.json.counts;
  console.log(`${m.json.split}: ${c.pairs} pairs (${c.match} match, ${c.mismatch} mismatch), ${productIds(m).size} products`);
}
if (freeze) console.log(`freeze: ${freeze.sha256.slice(0, 16)}... frozen ${freeze.frozen_at}`);
if (checkFiles) console.log(`files: ${filesChecked} hashed`);
if (problems.length > 0) {
  for (const p of problems.slice(0, 40)) console.error(`check-splits: ${p}`);
  if (problems.length > 40) console.error(`check-splits: ... and ${problems.length - 40} more`);
  process.exit(1);
}
console.log('check-splits: ok (no product in both splits, test manifest unchanged since freeze)');
