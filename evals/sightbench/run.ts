/**
 * SightBench: does the parcel match? Runs the frozen test split through the running vision service
 * (POST /verify) and compares it with the CLIP baseline and two single-module ablations.
 *
 *   SIGHTLINE      the service's own verdict (fusion of colour, size, identity, damage, quality).
 *   COLOUR-ONLY    the colour module's finding from the same /verify call: disagree -> mismatch,
 *                  agree -> match, unknown -> unsure (any confidence). A strict variant uses the
 *                  fusion's rule for that module alone (mismatch needs "sure").
 *   OCR-ONLY       the OCR read of the size tag from the same call compared with the listing size:
 *                  different -> mismatch, same -> match, no read or not comparable -> unsure.
 *   CLIP           ViT-B/32 cosine similarity between listing image and delivered photo, threshold
 *                  fitted on dev only (py/sightbench/clip_baseline.py). Never abstains.
 *
 * Secondary metric (added after the first test run, reported next to the primary ones, never
 * instead of them): "names the difference". A mismatch counts when the verdict is mismatch, or
 * unsure with a disagreeing reason from the module that matches the true mismatch type; its
 * false-alarm twin is a matching pair called mismatch or given any disagreeing reason.
 *
 * Every image is a SYNTHETIC render (see README). Without --with-model the service must have no
 * model key; with --with-model it must have one (GET /health vlm.configured), so the same suite
 * re-runs with the vision-model reads later. Each test run is appended to details.testRuns, so
 * earlier runs (for example with other service thresholds) stay visible.
 *
 *   node evals/sightbench/check-splits.mjs
 *   (cd evals/sightbench/py && uv run --group clip python -m sightbench.clip_baseline)
 *   (cd evals && pnpm exec tsx sightbench/run.ts [--with-model] [--split dev] [--limit N] [--no-write])
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { EVALS_DIR, ofN, scriptPath, writeResult, type Headline } from '../lib/results';
import { bootstrapCI, f1, pct, percentile, wilson, wilsonText, type Interval } from '../lib/stats';

const SCRIPT = scriptPath(import.meta.url);
const HERE = path.join(EVALS_DIR, 'sightbench');
const MANIFESTS = path.join(HERE, 'manifests');
const RAW = path.join(EVALS_DIR, 'data', 'raw', 'sightbench');
const VISION = process.env.VISION_URL ?? 'http://127.0.0.1:8011';
const SYNTH = 'Synthetic renders, not real photos';

const argv = process.argv.slice(2);
const flag = (name: string) => argv.includes(name);
const opt = (name: string) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
};
const WITH_MODEL = flag('--with-model');
const SPLIT = opt('--split') ?? 'test';
const LIMIT = opt('--limit') ? Number(opt('--limit')) : undefined;
const NO_WRITE = flag('--no-write') || SPLIT !== 'test' || LIMIT !== undefined;
const REUSE = flag('--reuse');
/**
 * --responses-from <tag>: score saved responses written by services/vision `app.looks_bench
 * --write-responses` (the deployed rule over cached model reads) instead of calling the service.
 * Needs --reuse; every pair must have a saved response.
 */
const RESPONSES_FROM = opt('--responses-from');
/** The verdict rule a run used. Runs before the two-looks rule have no `rule` field. */
const OLD_RULE = 'one sure reason, reads without citations';
const RULE = RESPONSES_FROM ? `two looks before "sure", quoted reads (${RESPONSES_FROM})` : OLD_RULE;
const ENGINE = WITH_MODEL ? 'with-model' : 'no-model';

type Decision = 'match' | 'mismatch' | 'unsure';
type Expected = 'match' | 'mismatch';

interface Pair {
  id: string;
  product_id: string;
  product_type: string;
  item: string[];
  label: string | null;
  damage: string | null;
  listing_images: string[];
  listing: { title: string; colour: string; size: string | null; attributes: Record<string, string> };
  expected: Expected;
  mismatch_type: string | null;
  mismatch_subtype: string | null;
  lighting: 'day' | 'lamp' | 'dim';
  delivered: { product_id: string; colour: string; size: string | null; damage: { kind: string } | null };
  render: { scene: { background: { surface: string; material?: string; kind?: string; pattern?: string } } };
  sha256: Record<string, string>;
}

interface Manifest {
  name: string;
  split: string;
  counts: { pairs: number; match: number; mismatch: number };
  pairs: Pair[];
}

interface Reason {
  module: string;
  finding: string;
  confidence: string;
  sentence: string;
  expected?: string;
  observed?: string;
}

interface Row {
  id: string;
  productType: string;
  expected: Expected;
  mismatchType: string | null;
  subtype: string | null;
  lighting: string;
  surface: string;
  listing: { colour: string; size: string | null };
  delivered: { product: string; colour: string; size: string | null; damage: string | null };
  sightline: Decision;
  colourAny: Decision;
  colourStrict: Decision;
  ocrOnly: Decision;
  clip: Decision;
  clipScore: number;
  /** Null when the response was assembled from cached reads (no request was timed). */
  latencyMs: number | null;
  serverMs: number | null;
  error?: string;
  headline?: string;
  reasons: Reason[];
  colourModule?: { finding: string; confidence: string; deltaE: number | null; deltaEName: number | null; observed: string | null; light: string | null; abstain: string | null };
  sizeModule?: { finding: string; confidence: string; reason: string | null; ocr: string | null; expected: string | null };
  quality?: string;
}

// ------------------------------------------------------------------------------------------------
// Size comparison on canonical strings (mirrors compare_sizes in services/vision/app/label.py)

const LETTERS = new Set(['XXS', 'XS', 'S', 'M', 'L', 'XL', 'XXL', 'XXXL', '4XL', '5XL', 'OS']);
function parseCanonical(c: string): { letter: string | null; numeric: Array<[string | null, string]> } {
  let letter: string | null = null;
  const numeric: Array<[string | null, string]> = [];
  for (const part of c.split('/').map((s) => s.trim()).filter(Boolean)) {
    if (LETTERS.has(part)) letter = part;
    else {
      const m = /^(?:([A-Z]{2})\s+)?(\d+(?:\.5)?)$/.exec(part);
      if (m) numeric.push([m[1] ?? null, m[2]!]);
    }
  }
  return { letter, numeric };
}
function compareSizes(expected: string, observed: string): 'same' | 'different' | 'not_comparable' {
  const e = parseCanonical(expected);
  const o = parseCanonical(observed);
  if (e.letter && o.letter) return e.letter === o.letter ? 'same' : 'different';
  if (e.numeric.length && o.numeric.length) {
    if (e.numeric.every(([s]) => s === null) && o.numeric.every(([s]) => s === null)) {
      return e.numeric.map(([, v]) => v).join('/') === o.numeric.map(([, v]) => v).join('/') ? 'same' : 'different';
    }
    const verdicts = new Set<string>();
    for (const [es, ev] of e.numeric) for (const [os, ov] of o.numeric) if (es === os || es === null || os === null) verdicts.add(ev === ov ? 'same' : 'different');
    if (verdicts.has('same')) return 'same';
    if (verdicts.has('different')) return 'different';
  }
  return 'not_comparable';
}

// ------------------------------------------------------------------------------------------------
// Service calls

const RANK: Record<string, number> = { not_sure: 0, fairly_sure: 1, sure: 2 };

function mime(file: string): string {
  return file.endsWith('.png') ? 'image/png' : 'image/jpeg';
}

function filePart(form: FormData, field: string, file: string): void {
  const bytes = readFileSync(file);
  form.append(field, new Blob([bytes], { type: mime(file) }), path.basename(file));
}

async function verify(pair: Pair): Promise<{ status: number; body: any; ms: number }> {
  const form = new FormData();
  for (const p of pair.item) filePart(form, 'item', path.resolve(MANIFESTS, p));
  if (pair.label) filePart(form, 'label', path.resolve(MANIFESTS, pair.label));
  if (pair.damage) filePart(form, 'damage', path.resolve(MANIFESTS, pair.damage));
  for (const p of pair.listing_images) filePart(form, 'listing_images', path.resolve(MANIFESTS, p));
  form.append('listing', JSON.stringify(pair.listing));
  const t0 = performance.now();
  const res = await fetch(`${VISION}/verify`, { method: 'POST', body: form });
  const body = await res.json().catch(() => null);
  const ms = performance.now() - t0;
  return { status: res.status, body, ms };
}

function surfaceOf(pair: Pair): string {
  const b = pair.render.scene.background;
  return `${b.surface}: ${b.material ?? b.kind ?? b.pattern ?? 'plain'}`;
}

function decisionsFrom(pair: Pair, body: any): Pick<Row, 'sightline' | 'colourAny' | 'colourStrict' | 'ocrOnly' | 'reasons' | 'colourModule' | 'sizeModule' | 'quality' | 'headline' | 'serverMs'> {
  const v = body.verdict;
  const c = body.modules?.colour ?? {};
  const s = body.modules?.size ?? {};
  const colourAny: Decision = c.finding === 'disagree' ? 'mismatch' : c.finding === 'agree' ? 'match' : 'unsure';
  const colourStrict: Decision =
    c.finding === 'disagree' && c.confidence === 'sure' ? 'mismatch' : c.finding === 'agree' && RANK[c.confidence]! >= RANK.fairly_sure! ? 'match' : 'unsure';
  const ocr: string | null = s.read_b?.size ?? null;
  const expected: string | null = s.expected ?? null;
  let ocrOnly: Decision = 'unsure';
  if (ocr && expected && pair.listing.size) {
    const cmp = compareSizes(expected, ocr);
    ocrOnly = cmp === 'same' ? 'match' : cmp === 'different' ? 'mismatch' : 'unsure';
  }
  return {
    sightline: v.kind,
    colourAny,
    colourStrict,
    ocrOnly,
    headline: v.headline,
    reasons: (v.reasons as Reason[]).map((r) => ({ module: r.module, finding: r.finding, confidence: r.confidence, sentence: r.sentence, ...(r.expected ? { expected: r.expected } : {}), ...(r.observed ? { observed: r.observed } : {}) })),
    colourModule: {
      finding: c.finding ?? 'unknown',
      confidence: c.confidence ?? 'not_sure',
      deltaE: c.delta_e ?? null,
      deltaEName: c.delta_e_name ?? null,
      observed: c.observed_name ?? null,
      light: c.light_quality ?? null,
      abstain: c.abstain_reason ?? null,
    },
    sizeModule: { finding: s.finding ?? 'unknown', confidence: s.confidence ?? 'not_sure', reason: s.reason ?? null, ocr, expected },
    quality: body.modules?.quality?.code,
    serverMs: body.timings_ms?.total ?? null,
  };
}

// ------------------------------------------------------------------------------------------------
// Metrics

interface Rate {
  k: number;
  n: number;
  value: number | null;
  wilson: Interval | null;
  text: string;
}

function rate(k: number, n: number): Rate {
  if (n === 0) return { k, n, value: null, wilson: null, text: 'n/a (0 pairs)' };
  return { k, n, value: k / n, wilson: wilson(k, n), text: `${ofN(k, n)} (${pct(k / n)}), ${wilsonText(k, n)}` };
}

type Picker = (r: Row) => Decision;

function summary(rows: Row[], pick: Picker, seed = 11) {
  const mm = rows.filter((r) => r.expected === 'mismatch');
  const ma = rows.filter((r) => r.expected === 'match');
  const count = (xs: Row[], f: (r: Row) => boolean) => xs.filter(f).length;
  const decided = rows.filter((r) => pick(r) !== 'unsure');
  const f1Pairs = (xs: readonly Row[]) => xs.map((r) => ({ truth: r.expected === 'mismatch', predicted: pick(r) === 'mismatch' }));
  const f1Value = rows.length ? f1(f1Pairs(rows)) : 0;
  const f1Ci = rows.length ? bootstrapCI(rows, (s) => f1(f1Pairs(s)), { seed, resamples: 2000 }) : ([0, 0] as Interval);
  return {
    n: rows.length,
    mismatchRecall: rate(count(mm, (r) => pick(r) === 'mismatch'), mm.length),
    falseAlarm: rate(count(ma, (r) => pick(r) === 'mismatch'), ma.length),
    abstention: rate(count(rows, (r) => pick(r) === 'unsure'), rows.length),
    coverage: rate(decided.length, rows.length),
    accuracyWhenDecided: rate(count(decided, (r) => pick(r) === r.expected), decided.length),
    matchConfirmed: rate(count(ma, (r) => pick(r) === 'match'), ma.length),
    wrongMatch: rate(count(mm, (r) => pick(r) === 'match'), mm.length),
    f1: { value: Number(f1Value.toFixed(4)), bootstrap95: [Number(f1Ci[0].toFixed(4)), Number(f1Ci[1].toFixed(4))] as Interval, positive: 'mismatch; "unsure" counts as not flagged' },
  };
}

function countBy<T>(xs: T[], key: (x: T) => string): Record<string, number> {
  const out: Record<string, number> = {};
  for (const x of xs) out[key(x)] = (out[key(x)] ?? 0) + 1;
  return Object.fromEntries(Object.entries(out).sort(([, a], [, b]) => b - a));
}

function groupBy<T>(xs: T[], key: (x: T) => string | null | undefined): Record<string, T[]> {
  const out: Record<string, T[]> = {};
  for (const x of xs) {
    const k = key(x);
    if (k === null || k === undefined) continue;
    (out[k] ??= []).push(x);
  }
  return Object.fromEntries(Object.entries(out).sort(([a], [b]) => a.localeCompare(b)));
}

// ------------------------------------------------------------------------------------------------
// Secondary metric: does the buyer hear the right difference? (Added after the first test run.)

/** The module whose disagreement names each mismatch type. */
const MODULE_OF: Record<string, string> = { colour: 'colour', size: 'size', model: 'identity', damage: 'damage' };

interface SecondaryRow {
  expected: Expected;
  mismatchType: string | null;
  lighting: string;
  verdict: Decision;
  /** Modules that gave a disagreeing reason. */
  disagree: string[];
}

function secondaryRow(r: Row): SecondaryRow {
  return { expected: r.expected, mismatchType: r.mismatchType, lighting: r.lighting, verdict: r.sightline, disagree: r.reasons.filter((x) => x.finding === 'disagree').map((x) => x.module) };
}

const namesIt = (r: SecondaryRow) => r.verdict === 'mismatch' || (r.verdict === 'unsure' && r.mismatchType !== null && r.disagree.includes(MODULE_OF[r.mismatchType] ?? ''));
const twinAlarm = (r: SecondaryRow) => r.verdict === 'mismatch' || r.disagree.length > 0;

function secondary(rows: SecondaryRow[]) {
  const mm = rows.filter((r) => r.expected === 'mismatch');
  const ma = rows.filter((r) => r.expected === 'match');
  const named = (xs: SecondaryRow[]) => rate(xs.filter(namesIt).length, xs.length);
  const alarmed = (xs: SecondaryRow[]) => rate(xs.filter(twinAlarm).length, xs.length);
  return {
    definition: {
      namesTheDifference: 'A mismatching pair whose verdict is mismatch, or unsure with a disagreeing reason from the module matching the true mismatch type (colour -> colour, size -> size, model -> identity, damage -> damage).',
      falseAlarmTwin: 'A matching pair whose verdict is mismatch, or that got any disagreeing reason (the buyer hears a difference that is not there).',
      added: 'Added after the first test run, which had already been scored on the primary metrics. Reported next to them, never instead of them.',
    },
    namesTheDifference: named(mm),
    falseAlarmTwin: alarmed(ma),
    perType: Object.fromEntries(Object.entries(groupBy(mm, (r) => r.mismatchType)).map(([k, v]) => [k, named(v)])),
    perLighting: Object.fromEntries(Object.entries(groupBy(rows, (r) => r.lighting)).map(([k, v]) => [k, { namesTheDifference: named(v.filter((r) => r.expected === 'mismatch')), falseAlarmTwin: alarmed(v.filter((r) => r.expected === 'match')) }])),
    falseAlarmTwinByModule: countBy(ma.flatMap((r) => (r.disagree.length ? [...new Set(r.disagree)] : [])), (m) => m),
  };
}

// ------------------------------------------------------------------------------------------------
// Test-run history: every test run stays in the result file.

interface TestRun {
  run: number;
  ranAt: string;
  engine: string;
  thresholds: string;
  label: string;
  mismatchRecall: Rate;
  falseAlarm: Rate;
  abstention: Rate;
  accuracyWhenDecided: Rate;
  recallByType: Record<string, Rate>;
  namesTheDifference: Rate;
  falseAlarmTwin: Rate;
  falseAlarms: unknown[];
  /** Set when the run was re-scored later from its saved responses. */
  rescoredAt?: string;
  /** The verdict rule (missing on runs before two looks: OLD_RULE). */
  rule?: string;
}

const LETTER_DECISIONS = new Set(['match', 'mismatch', 'unsure']);

/** How a run is named in headlines and limitations, from its threshold set and verdict rule. */
const runLabel = (thresholds: string, rule = OLD_RULE) =>
  `${thresholds === 'initial-unfitted' ? 'unfitted thresholds' : `thresholds fitted on dev (${thresholds})`}${rule === OLD_RULE ? '' : `, ${rule}`}`;

/** Summary of an earlier result file (its own rows), for details.testRuns. */
function summariseEarlierRun(prev: any): TestRun | null {
  const d = prev?.details;
  const o = d?.metrics?.sightline?.overall;
  const rows = d?.pairs?.rows;
  if (!o || !Array.isArray(rows) || d.split !== 'test') return null;
  const sec = secondary(
    rows
      .filter((r: any) => LETTER_DECISIONS.has(r.sightline))
      .map((r: any) => ({
        expected: r.expected,
        mismatchType: r.mismatchType,
        lighting: r.lighting,
        verdict: r.sightline,
        disagree: (r.reasons as string[]).map((s) => s.split(' ')).filter((p) => p[1] === 'disagree').map((p) => p[0]!),
      })),
  );
  const thresholds = String(d.service?.health?.thresholds ?? 'unknown');
  return {
    run: 1,
    ranAt: prev.ranAt,
    engine: d.service?.engine ?? 'unknown',
    thresholds,
    label: runLabel(thresholds),
    mismatchRecall: o.mismatchRecall,
    falseAlarm: o.falseAlarm,
    abstention: o.abstention,
    accuracyWhenDecided: o.accuracyWhenDecided,
    recallByType: Object.fromEntries(Object.entries(d.metrics.sightline.perType ?? {}).map(([k, v]: [string, any]) => [k, v.recall])),
    namesTheDifference: sec.namesTheDifference,
    falseAlarmTwin: sec.falseAlarmTwin,
    falseAlarms: d.worstCases?.sightlineFalseAlarms ?? [],
  };
}

function breakdown(rows: Row[], pick: Picker) {
  const mm = rows.filter((r) => r.expected === 'mismatch');
  const recallOf = (xs: Row[]) => ({
    recall: rate(xs.filter((r) => pick(r) === 'mismatch').length, xs.length),
    unsure: rate(xs.filter((r) => pick(r) === 'unsure').length, xs.length),
    wrongMatch: rate(xs.filter((r) => pick(r) === 'match').length, xs.length),
  });
  const perType = Object.fromEntries(Object.entries(groupBy(mm, (r) => r.mismatchType)).map(([k, v]) => [k, recallOf(v)]));
  const perSubtype = Object.fromEntries(Object.entries(groupBy(mm, (r) => `${r.mismatchType}: ${r.subtype}`)).map(([k, v]) => [k, recallOf(v)]));
  const perLighting = Object.fromEntries(Object.entries(groupBy(rows, (r) => r.lighting)).map(([k, v]) => [k, summary(v, pick)]));
  const perTypeLighting = Object.fromEntries(
    Object.entries(groupBy(mm, (r) => `${r.mismatchType} / ${r.lighting}`)).map(([k, v]) => [k, rate(v.filter((r) => pick(r) === 'mismatch').length, v.length)]),
  );
  const perProductType = Object.fromEntries(
    Object.entries(groupBy(rows, (r) => r.productType)).map(([k, v]) => {
      const s = summary(v, pick);
      return [k, { mismatchRecall: s.mismatchRecall, falseAlarm: s.falseAlarm, abstention: s.abstention }];
    }),
  );
  const perSurface = Object.fromEntries(
    Object.entries(groupBy(rows, (r) => r.surface)).map(([k, v]) => {
      const s = summary(v, pick);
      return [k, { mismatchRecall: s.mismatchRecall, falseAlarm: s.falseAlarm, abstention: s.abstention }];
    }),
  );
  return { overall: summary(rows, pick), perType, perSubtype, perLighting, perTypeLighting, perProductType, perSurface };
}

// ------------------------------------------------------------------------------------------------

function loadManifest(split: string): { m: Manifest; sha: string } {
  const file = path.join(MANIFESTS, `${split}.json`);
  const bytes = readFileSync(file);
  return { m: JSON.parse(bytes.toString('utf8')) as Manifest, sha: createHash('sha256').update(bytes).digest('hex') };
}

async function main() {
  // 1. The split guard must pass before anything is evaluated.
  const guard = spawnSync(process.execPath, [path.join(HERE, 'check-splits.mjs')], { encoding: 'utf8' });
  process.stdout.write(guard.stdout);
  if (guard.status !== 0) {
    process.stderr.write(guard.stderr);
    console.error('sightbench: split check failed; not running.');
    process.exit(1);
  }
  const freeze = JSON.parse(readFileSync(path.join(MANIFESTS, 'test.freeze.json'), 'utf8'));
  const { m, sha } = loadManifest(SPLIT);
  const devInfo = loadManifest('dev');

  // 2. The CLIP baseline scores (threshold fitted on dev only).
  const clipFile = path.join(RAW, 'clip-scores.json');
  const thresholdFile = path.join(HERE, 'clip-threshold.json');
  if (!existsSync(clipFile) || !existsSync(thresholdFile)) {
    console.error('sightbench: no CLIP scores. Run: (cd evals/sightbench/py && uv run --group clip python -m sightbench.clip_baseline)');
    process.exit(1);
  }
  const clip = JSON.parse(readFileSync(clipFile, 'utf8'));
  const fitted = JSON.parse(readFileSync(thresholdFile, 'utf8'));
  if (fitted.fitted_on !== 'dev' || fitted.threshold !== clip.threshold || clip.test_manifest_sha256 !== freeze.sha256) {
    console.error('sightbench: CLIP scores do not match the dev-fitted threshold or the frozen test manifest; rerun clip_baseline.');
    process.exit(1);
  }
  const clipById = new Map<string, { score: number; decision: Decision }>(clip.pairs.map((p: any) => [p.id, { score: p.score, decision: p.decision }]));

  // 3. The service must be in the mode the flag says.
  const health = await (await fetch(`${VISION}/health`)).json();
  if (WITH_MODEL && !health.vlm?.configured) {
    console.error('sightbench: --with-model needs the vision service to have VISION_MODEL and ANTHROPIC_API_KEY set (GET /health vlm.configured is false).');
    process.exit(1);
  }
  if (!WITH_MODEL && health.vlm?.configured) {
    console.error('sightbench: the vision service has a model key. Pass --with-model, or restart it without the key for the no-model run.');
    process.exit(1);
  }
  const THRESHOLDS = String(health.thresholds ?? 'unknown');
  const UNFITTED = THRESHOLDS === 'initial-unfitted';
  console.log(`sightbench: ${SPLIT} split, ${m.pairs.length} pairs, service ${VISION} (${ENGINE}, thresholds ${THRESHOLDS})`);

  // 4. One request at a time (one heavy process at a time on the dev laptop). Responses are kept
  //    per threshold set, so a run with other thresholds never overwrites an earlier one.
  const respDir = path.join(
    RAW,
    'responses',
    ENGINE,
    `${THRESHOLDS}${RESPONSES_FROM ? `__${RESPONSES_FROM}` : ''}`.replace(/[^A-Za-z0-9._-]/g, '_'),
  );
  mkdirSync(respDir, { recursive: true });
  const pairs = LIMIT ? m.pairs.slice(0, LIMIT) : m.pairs;
  if (RESPONSES_FROM) {
    const missing = pairs.filter((p) => !existsSync(path.join(respDir, `${p.id}.json`)));
    if (!REUSE || missing.length) {
      console.error(`sightbench: --responses-from needs --reuse and a saved response for every pair (${missing.length} missing in ${respDir}).`);
      process.exit(1);
    }
  }
  const rows: Row[] = [];
  let errors = 0;
  let reused = 0;
  for (const [i, pair] of pairs.entries()) {
    const cached = path.join(respDir, `${pair.id}.json`);
    let status = 0;
    let body: any = null;
    let ms: number | null = 0;
    if (REUSE && existsSync(cached)) {
      ({ status, body, ms } = JSON.parse(readFileSync(cached, 'utf8')));
      reused++;
    } else {
      ({ status, body, ms } = await verify(pair));
      writeFileSync(cached, JSON.stringify({ status, ms, body }));
    }
    const c = clipById.get(pair.id);
    if (!c) throw new Error(`no CLIP score for ${pair.id}`);
    const base = {
      id: pair.id,
      productType: pair.product_type,
      expected: pair.expected,
      mismatchType: pair.mismatch_type,
      subtype: pair.mismatch_subtype,
      lighting: pair.lighting,
      surface: surfaceOf(pair),
      listing: { colour: pair.listing.colour, size: pair.listing.size },
      delivered: { product: pair.delivered.product_id, colour: pair.delivered.colour, size: pair.delivered.size, damage: pair.delivered.damage?.kind ?? null },
      clip: c.decision,
      clipScore: c.score,
      latencyMs: typeof ms === 'number' ? Number(ms.toFixed(1)) : null,
    };
    if (status !== 200 || !body?.verdict) {
      errors++;
      rows.push({ ...base, sightline: 'unsure', colourAny: 'unsure', colourStrict: 'unsure', ocrOnly: 'unsure', serverMs: null, reasons: [], error: `HTTP ${status}: ${JSON.stringify(body?.detail ?? body).slice(0, 200)}` });
    } else {
      rows.push({ ...base, ...decisionsFrom(pair, body) });
    }
    if ((i + 1) % 50 === 0) console.log(`  ${i + 1}/${pairs.length}`);
  }

  // 5. Metrics.
  const systems: Record<string, { label: string; pick: Picker; abstains: boolean; definition: string }> = {
    sightline: { label: `Sightline fusion (${WITH_MODEL ? 'with' : 'no'} model reads)`, pick: (r) => r.sightline, abstains: true, definition: 'The verdict from POST /verify.' },
    clip: {
      label: 'CLIP ViT-B/32 image similarity',
      pick: (r) => r.clip,
      abstains: false,
      definition: `cosine(listing image, delivered photo) < ${clip.threshold} -> mismatch, else match. Threshold fitted on dev only (${fitted.rule}).`,
    },
    colourOnly: { label: 'Colour module only (any confidence)', pick: (r) => r.colourAny, abstains: true, definition: 'modules.colour.finding: disagree -> mismatch, agree -> match, unknown -> unsure.' },
    colourStrict: {
      label: 'Colour module only (fusion confidence rule)',
      pick: (r) => r.colourStrict,
      abstains: true,
      definition: 'disagree at "sure" -> mismatch; agree at "fairly sure" or better -> match; else unsure.',
    },
    ocrOnly: {
      label: 'Size-tag OCR only',
      pick: (r) => r.ocrOnly,
      abstains: true,
      definition: 'modules.size.read_b (OCR) compared with the listing size: different -> mismatch, same -> match; no read, no size or not comparable -> unsure.',
    },
  };
  const results = Object.fromEntries(Object.entries(systems).map(([k, s]) => [k, { label: s.label, definition: s.definition, abstains: s.abstains, ...breakdown(rows, s.pick) }]));
  // A trivial reference, not a system: flag every pair. With 50% mismatches its F1 is 2/3, so any
  // F1 near that says nothing; recall minus false-alarm rate (Youden's J) is 0 for it.
  const reference = { label: 'Reference only: flag every pair as a mismatch', overall: summary(rows, () => 'mismatch') };
  const ranking = [...Object.entries(results), ['flagEverything', reference] as const]
    .map(([k, r]) => ({
      system: k,
      label: r.label,
      reference: k === 'flagEverything',
      f1: r.overall.f1.value,
      f1Lower: r.overall.f1.bootstrap95[0],
      f1Upper: r.overall.f1.bootstrap95[1],
      recallLower: r.overall.mismatchRecall.wilson?.[0] ?? 0,
      recallMinusFalseAlarm: Number(((r.overall.mismatchRecall.value ?? 0) - (r.overall.falseAlarm.value ?? 0)).toFixed(4)),
      mismatchRecall: r.overall.mismatchRecall.text,
      falseAlarm: r.overall.falseAlarm.text,
      coverage: r.overall.coverage.text,
      accuracyWhenDecided: r.overall.accuracyWhenDecided.text,
    }))
    .sort((a, b) => b.f1Lower - a.f1Lower || b.recallLower - a.recallLower)
    .map((r, i) => ({ rank: i + 1, ...r }));

  // Surfaces the colour module cannot white-balance against.
  const woodRows = rows.filter((r) => /^(table: wood|floor: planks)/.test(r.surface));
  const otherRows = rows.filter((r) => !/^(table: wood|floor: planks)/.test(r.surface));
  const castOn = (xs: Row[]) => rate(xs.filter((r) => r.colourModule?.abstain === 'heavy_cast').length, xs.length);
  const woodCast = castOn(woodRows);
  const otherCast = castOn(otherRows);

  // Navy vs black, the known hard case.
  const nbMismatch = rows.filter((r) => r.subtype === 'near: navy/black');
  const nbMatch = rows.filter((r) => r.expected === 'match' && (r.listing.colour === 'navy' || r.listing.colour === 'black'));
  const navyBlack = Object.fromEntries(
    ['day', 'lamp', 'dim'].map((light) => {
      const mmx = nbMismatch.filter((r) => r.lighting === light);
      const max = nbMatch.filter((r) => r.lighting === light);
      return [
        light,
        {
          mismatchesCaught: Object.fromEntries(Object.entries(systems).map(([k, s]) => [k, rate(mmx.filter((r) => s.pick(r) === 'mismatch').length, mmx.length)])),
          colourModuleOnMismatches: mmx.map((r) => ({ id: r.id, listed: r.listing.colour, delivered: r.delivered.colour, finding: r.colourModule?.finding, confidence: r.colourModule?.confidence, deltaE: r.colourModule?.deltaE, observed: r.colourModule?.observed, abstain: r.colourModule?.abstain, verdict: r.sightline })),
          matchingNavyBlackItems: { n: max.length, falseAlarms: rate(max.filter((r) => r.sightline === 'mismatch').length, max.length), unsure: rate(max.filter((r) => r.sightline === 'unsure').length, max.length) },
        },
      ];
    }),
  );

  // Why the colour module abstained, by light level and by surface.
  const colourAbstain = {
    byLighting: Object.fromEntries(Object.entries(groupBy(rows, (r) => r.lighting)).map(([k, v]) => [k, countBy(v, (r) => r.colourModule?.abstain ?? (r.colourModule ? 'answered' : 'error'))])),
    bySurface: Object.fromEntries(Object.entries(groupBy(rows, (r) => r.surface)).map(([k, v]) => [k, countBy(v, (r) => r.colourModule?.abstain ?? (r.colourModule ? 'answered' : 'error'))])),
    qualityCodes: countBy(rows, (r) => r.quality ?? 'error'),
    sizeReasons: countBy(rows, (r) => r.sizeModule?.reason ?? r.sizeModule?.finding ?? 'error'),
  };

  // Latency.
  const ok = rows.filter((r) => !r.error);
  const lat = ok.map((r) => r.latencyMs).filter((x): x is number => typeof x === "number");
  const srv = ok.map((r) => r.serverMs).filter((x): x is number => typeof x === 'number');
  const latency = {
    what: 'Client wall time of POST /verify over localhost, one request at a time, CPU-only service on the dev laptop; includes multipart upload and JSON response.',
    n: lat.length,
    p50Ms: lat.length ? Number(percentile(lat, 50).toFixed(0)) : null,
    p95Ms: lat.length ? Number(percentile(lat, 95).toFixed(0)) : null,
    maxMs: lat.length ? Number(Math.max(...lat).toFixed(0)) : null,
    serverTotalP50Ms: srv.length ? Number(percentile(srv, 50).toFixed(0)) : null,
    serverTotalP95Ms: srv.length ? Number(percentile(srv, 95).toFixed(0)) : null,
    clip: clip.timing,
  };

  // Worst cases.
  const brief = (r: Row) => ({
    id: r.id,
    truth: r.expected === 'match' ? 'match' : `${r.mismatchType} (${r.subtype})`,
    lighting: r.lighting,
    listed: `${r.listing.colour}${r.listing.size ? `, ${r.listing.size}` : ''}`,
    delivered: `${r.delivered.product} ${r.delivered.colour}${r.delivered.size ? `, ${r.delivered.size}` : ''}${r.delivered.damage ? `, ${r.delivered.damage}` : ''}`,
    sightline: r.sightline,
    reasons: r.reasons.filter((x) => x.finding !== 'agree' || x.confidence === 'sure').map((x) => x.sentence),
    clip: `${r.clip} (${r.clipScore})`,
  });
  const falseAlarms = rows.filter((r) => r.expected === 'match' && r.sightline === 'mismatch').map(brief);
  const wrongMatches = rows.filter((r) => r.expected === 'mismatch' && r.sightline === 'match').map(brief);
  const colourFooled = rows
    .filter((r) => r.mismatchType === 'colour' && r.colourModule?.finding === 'agree')
    .sort((a, b) => RANK[b.colourModule!.confidence]! - RANK[a.colourModule!.confidence]! || (a.colourModule!.deltaE ?? 99) - (b.colourModule!.deltaE ?? 99))
    .map((r) => ({ ...brief(r), colour: r.colourModule }));
  const ocrWrong = rows.filter((r) => r.mismatchType === 'size' ? r.ocrOnly === 'match' : r.ocrOnly === 'mismatch').map((r) => ({ ...brief(r), size: r.sizeModule }));
  const clipMissed = rows.filter((r) => r.expected === 'mismatch').sort((a, b) => b.clipScore - a.clipScore).slice(0, 10).map(brief);
  const clipFalse = rows.filter((r) => r.expected === 'match').sort((a, b) => a.clipScore - b.clipScore).slice(0, 10).map(brief);
  const sl = results.sightline!;
  const sec = secondary(rows.map(secondaryRow));
  // The colour module's "sure" disagreements on pairs whose delivered colour is the listed one
  // (matches and size, model or damage mismatches): what the dev split fits away.
  const sameColour = rows.filter((r) => r.delivered.colour === r.listing.colour);
  const otherColour = rows.filter((r) => r.delivered.colour !== r.listing.colour);
  const colourSure = (xs: Row[]) => rate(xs.filter((r) => r.colourModule?.finding === 'disagree' && r.colourModule.confidence === 'sure').length, xs.length);
  const colourAnyDisagree = (xs: Row[]) => rate(xs.filter((r) => r.colourModule?.finding === 'disagree').length, xs.length);
  const colourCalls = {
    sureDisagreeWhenColourIsRight: colourSure(sameColour),
    sureDisagreeWhenColourIsWrong: colourSure(otherColour),
    anyDisagreeWhenColourIsRight: colourAnyDisagree(sameColour),
    anyDisagreeWhenColourIsWrong: colourAnyDisagree(otherColour),
  };
  const worstCells = Object.entries(sl.perTypeLighting)
    .map(([k, v]) => ({ cell: k, ...(v as Rate) }))
    .sort((a, b) => (a.value ?? 0) - (b.value ?? 0) || b.n - a.n)
    .slice(0, 6)
    .map((c) => ({ cell: c.cell, caught: c.text }));

  // 6. Console summary.
  for (const r of ranking) console.log(`  #${r.rank} ${r.label}: F1 ${r.f1} [${r.f1Lower}, ${r.f1Upper}] | FA ${r.falseAlarm.split(',')[0]} | coverage ${r.coverage.split(',')[0]}`);
  for (const [k, s] of Object.entries(results)) {
    console.log(`  ${k}: recall ${s.overall.mismatchRecall.text.split(',')[0]}; per type ${Object.entries(s.perType).map(([t, v]) => `${t} ${(v as any).recall.k}/${(v as any).recall.n}`).join(', ')}`);
  }
  console.log(`  navy/black caught by Sightline: ${['day', 'lamp', 'dim'].map((l) => `${l} ${(navyBlack[l] as any).mismatchesCaught.sightline.k}/${(navyBlack[l] as any).mismatchesCaught.sightline.n}`).join(', ')}`);
  console.log(`  secondary (added after the first test run): names the difference ${sec.namesTheDifference.text}; false-alarm twin ${sec.falseAlarmTwin.text}`);
  console.log(`    per type ${Object.entries(sec.perType).map(([t, v]) => `${t} ${v.k}/${v.n}`).join(', ')}; twin alarms by module ${JSON.stringify(sec.falseAlarmTwinByModule)}`);
  console.log(
    `  colour module "sure" disagreements: colour right ${colourCalls.sureDisagreeWhenColourIsRight.k}/${colourCalls.sureDisagreeWhenColourIsRight.n}, colour wrong ${colourCalls.sureDisagreeWhenColourIsWrong.k}/${colourCalls.sureDisagreeWhenColourIsWrong.n}; any confidence: right ${colourCalls.anyDisagreeWhenColourIsRight.k}/${colourCalls.anyDisagreeWhenColourIsRight.n}, wrong ${colourCalls.anyDisagreeWhenColourIsWrong.k}/${colourCalls.anyDisagreeWhenColourIsWrong.n}`,
  );
  console.log(`  latency p50 ${latency.p50Ms} ms, p95 ${latency.p95Ms} ms; errors ${errors}`);
  if (NO_WRITE) {
    console.log('sightbench: --no-write (or a dev/limited run): result file not written.');
    return;
  }

  // 7. Headlines and the result file.
  const cl = results.clip!;
  const o = sl.overall;
  const short = (x: Rate) => `${ofN(x.k, x.n)} (${pct(x.value ?? 0)})`;
  const nbDim = (navyBlack.dim as any).mismatchesCaught;
  const nbDay = (navyBlack.day as any).mismatchesCaught;
  const sizeSl = (sl.perType as any).size.recall as Rate;
  const sizeOcr = ((results.ocrOnly!.perType as any).size.recall) as Rate;
  const dmgSl = (sl.perType as any).damage.recall as Rate;
  const dmgClip = (cl.perType as any).damage.recall as Rate;
  const modelSl = (sl.perType as any).model.recall as Rate;
  const modelClip = (cl.perType as any).model.recall as Rate;
  const modelNote = WITH_MODEL ? '' : ' No model reads in this run: identity and damage report unknown, so the service never says match.';
  const faRows = rows.filter((r) => r.expected === 'match' && r.sightline === 'mismatch');
  const faColourSure = faRows.filter((r) => r.colourModule?.finding === 'disagree' && r.colourModule.confidence === 'sure').length;
  const faColours = [...new Set(faRows.map((r) => r.listing.colour))].join(', ') || 'none';
  const nbDimRows = (navyBlack.dim as any).colourModuleOnMismatches as Array<{ finding: string }>;
  const nbDimCol = {
    disagree: nbDimRows.filter((x) => x.finding === 'disagree').length,
    agree: nbDimRows.filter((x) => x.finding === 'agree').length,
    unknown: nbDimRows.filter((x) => x.finding !== 'disagree' && x.finding !== 'agree').length,
  };

  // Every test run stays visible: carry the earlier runs forward from the result file being replaced.
  const resultFile = path.join(EVALS_DIR, 'results', 'sightbench.json');
  const earlier = existsSync(resultFile) ? JSON.parse(readFileSync(resultFile, 'utf8')) : null;
  const earlierSummary = summariseEarlierRun(earlier);
  const previousRuns: TestRun[] = (Array.isArray(earlier?.details?.testRuns) ? (earlier.details.testRuns as TestRun[]) : earlierSummary ? [earlierSummary] : []).map((r) => ({
    ...r,
    rule: r.rule ?? OLD_RULE,
    label: runLabel(r.thresholds, r.rule ?? OLD_RULE),
  }));
  const thisRun: TestRun = {
    run: previousRuns.length + 1,
    ranAt: new Date().toISOString(),
    engine: ENGINE,
    thresholds: THRESHOLDS,
    rule: RULE,
    label: runLabel(THRESHOLDS, RULE),
    mismatchRecall: o.mismatchRecall,
    falseAlarm: o.falseAlarm,
    abstention: o.abstention,
    accuracyWhenDecided: o.accuracyWhenDecided,
    recallByType: Object.fromEntries(Object.entries(sl.perType).map(([k, v]) => [k, (v as any).recall as Rate])),
    namesTheDifference: sec.namesTheDifference,
    falseAlarmTwin: sec.falseAlarmTwin,
    falseAlarms: rows.filter((r) => r.expected === 'match' && r.sightline === 'mismatch').map(brief),
  };
  // Re-scoring the saved responses of the latest run (--reuse, nothing sent to the service) is not
  // a new test run: it replaces that run's entry and keeps its number and date.
  const last = previousRuns.at(-1);
  const rescored =
    reused === pairs.length && last !== undefined && last.thresholds === THRESHOLDS && last.engine === ENGINE && (last.rule ?? OLD_RULE) === RULE;
  // The run just before this one under another verdict rule: shown as "before" next to this run.
  const before = [...previousRuns].reverse().find((r) => (r.rule ?? OLD_RULE) !== RULE && r.engine === ENGINE);
  // A run scored from cached reads has no timings: show the last timed run's, saying which.
  type Lat = { n: number; p50Ms: number | null; p95Ms: number | null; serverTotalP50Ms: number | null; from?: string };
  const earlierShown = (earlier?.details?.latencyShown ?? (earlier?.details?.latency?.n ? { ...earlier.details.latency, from: `run ${last?.run}, ${last?.ranAt?.slice(0, 10)}` } : null)) as Lat | null;
  const latencyShown: Lat = latency.n > 0 || !earlierShown ? { ...latency, from: 'this run' } : earlierShown;
  const testRuns = rescored
    ? [...previousRuns.slice(0, -1), { ...thisRun, run: last.run, ranAt: last.ranAt, rescoredAt: thisRun.ranAt }]
    : [...previousRuns, thisRun];
  const first = testRuns[0]!;
  const showFirst = testRuns.length > 1 && first.thresholds !== THRESHOLDS;
  const slash = (x: Rate) => `${x.k}/${x.n}`;
  const byType = Object.keys(thisRun.recallByType)
    .map((t) => `${t} ${first.recallByType[t]?.k ?? '?'} -> ${thisRun.recallByType[t]!.k} of ${thisRun.recallByType[t]!.n}`)
    .join(', ');
  const firstNote = showFirst
    ? ` Mismatches flagged per type, first run -> this run: ${byType}. Secondary metric, first run -> this run: named ${ofN(first.namesTheDifference.k, first.namesTheDifference.n)} -> ${ofN(sec.namesTheDifference.k, sec.namesTheDifference.n)}, twin false alarms ${ofN(first.falseAlarmTwin.k, first.falseAlarmTwin.n)} -> ${ofN(sec.falseAlarmTwin.k, sec.falseAlarmTwin.n)}.`
    : '';

  const headlines: Headline[] = [
    {
      id: 'mismatch-recall',
      label: `Mismatches flagged on the frozen test split, Sightline${WITH_MODEL ? '' : ' without model reads'}`,
      value: short(o.mismatchRecall),
      baseline: `CLIP ViT-B/32, dev-fitted: ${short(cl.overall.mismatchRecall)}`,
      interval: wilsonText(o.mismatchRecall.k, o.mismatchRecall.n),
      n: o.mismatchRecall.n,
      script: SCRIPT,
      negative: (o.mismatchRecall.value ?? 0) < 0.5,
      note: `${SYNTH}. Stratified over colour, size, model and damage mismatches.${modelNote}${
        before ? ` Verdict rule: ${RULE}. Before it (run ${before.run}, ${OLD_RULE}): ${ofN(before.mismatchRecall.k, before.mismatchRecall.n)} flagged, ${ofN(before.falseAlarm.k, before.falseAlarm.n)} false alarms.` : ''
      } CLIP's dev-fitted threshold also flags ${short(cl.overall.falseAlarm)} of matching pairs (dev balanced accuracy ${fitted.dev?.balanced_accuracy}), so its recall says little.${
        showFirst && o.mismatchRecall.k < first.mismatchRecall.k
          ? ` The first test run (${first.label}) flagged ${ofN(first.mismatchRecall.k, first.mismatchRecall.n)}: the dev-fitted colour rules removed false alarms but also real colour catches (see "First test run").`
          : ''
      }`,
    },
    {
      id: 'false-alarms',
      label: 'Matching items wrongly called a mismatch (false alarms), Sightline',
      value: short(o.falseAlarm),
      baseline: `CLIP: ${short(cl.overall.falseAlarm)}`,
      interval: wilsonText(o.falseAlarm.k, o.falseAlarm.n),
      n: o.falseAlarm.n,
      script: SCRIPT,
      note: `${SYNTH}. A false alarm tells a buyer to return an item that is right. ${faColourSure} of ${o.falseAlarm.k} came from a "sure" colour disagreement (listed: ${faColours}); see details.worstCases.sightlineFalseAlarms.`,
    },
    {
      id: 'abstention',
      label: 'Pairs where Sightline answered "not sure" (abstained)',
      value: short(o.abstention),
      baseline: 'CLIP baseline never abstains',
      interval: wilsonText(o.abstention.k, o.abstention.n),
      n: o.abstention.n,
      script: SCRIPT,
      note: `Coverage ${short(o.coverage)}. Accuracy when Sightline did answer: ${short(o.accuracyWhenDecided)}; CLIP accuracy: ${short(cl.overall.accuracyWhenDecided)}.${modelNote}`,
    },
    {
      id: 'accuracy-when-answering',
      label: 'Accuracy when Sightline gives an answer (match or mismatch)',
      value: short(o.accuracyWhenDecided),
      baseline: `CLIP (always answers): ${short(cl.overall.accuracyWhenDecided)}`,
      interval: o.accuracyWhenDecided.n ? wilsonText(o.accuracyWhenDecided.k, o.accuracyWhenDecided.n) : undefined,
      n: o.accuracyWhenDecided.n,
      script: SCRIPT,
    },
    {
      id: 'names-the-difference',
      label: 'Secondary metric, added after the first test run: mismatches where Sightline names the difference (mismatch, or "not sure" with the right module disagreeing)',
      value: short(sec.namesTheDifference),
      baseline: showFirst ? `first test run (unfitted): ${ofN(first.namesTheDifference.k, first.namesTheDifference.n)}` : undefined,
      interval: wilsonText(sec.namesTheDifference.k, sec.namesTheDifference.n),
      n: sec.namesTheDifference.n,
      script: SCRIPT,
      note: `${SYNTH}. What the buyer hears, for example "The size tag seems to read L, you ordered M, but I'm only fairly sure.", and the money-back path stays open for "not sure". Per type: ${Object.entries(sec.perType).map(([t, v]) => `${t} ${ofN(v.k, v.n)}`).join(', ')}. Defined after the first test run's primary numbers were known, so it is reported next to them, never instead of them.`,
    },
    {
      id: 'names-the-difference-false-alarms',
      label: 'False-alarm twin of the secondary metric: matching items called a mismatch or given any disagreeing reason',
      value: short(sec.falseAlarmTwin),
      baseline: showFirst ? `first test run (unfitted): ${ofN(first.falseAlarmTwin.k, first.falseAlarmTwin.n)}` : undefined,
      interval: wilsonText(sec.falseAlarmTwin.k, sec.falseAlarmTwin.n),
      n: sec.falseAlarmTwin.n,
      script: SCRIPT,
      negative: (sec.falseAlarmTwin.value ?? 0) > 0.1,
      note: `${SYNTH}. The buyer hears a difference that is not there, even if only as "not sure". Disagreeing modules on these pairs: ${Object.entries(sec.falseAlarmTwinByModule).map(([k, v]) => `${k} ${v}`).join(', ') || 'none'}.`,
    },
    ...(showFirst
      ? [
          {
            id: 'first-test-run',
            label: `First test run (${first.label}, ${first.ranAt.slice(0, 10)}): mismatches flagged / false alarms / not sure`,
            value: `${slash(first.mismatchRecall)} · ${slash(first.falseAlarm)} · ${slash(first.abstention)}`,
            baseline: `this run: ${slash(o.mismatchRecall)} · ${slash(o.falseAlarm)} · ${slash(o.abstention)}`,
            n: first.abstention.n,
            script: SCRIPT,
            note: `The frozen test split has been run ${testRuns.length} times: first with the hand-set thresholds, then with thresholds fitted on the dev split only. Nothing was tuned on test. Every run's numbers are in details.testRuns.${firstNote}`,
          } satisfies Headline,
        ]
      : []),
    ...(before
      ? [
          {
            id: 'before-two-looks',
            label: `Before two looks and quoted reads (run ${before.run}, ${before.ranAt.slice(0, 10)}): mismatches flagged / false alarms / not sure / accuracy when answering`,
            value: `${slash(before.mismatchRecall)} · ${slash(before.falseAlarm)} · ${slash(before.abstention)} · ${slash(before.accuracyWhenDecided)}`,
            baseline: `this run: ${slash(o.mismatchRecall)} · ${slash(o.falseAlarm)} · ${slash(o.abstention)}`,
            n: before.abstention.n,
            script: SCRIPT,
            negative: o.mismatchRecall.k < before.mismatchRecall.k,
            note: `Same frozen test split, same thresholds; only the verdict rule and the identity and damage reads changed. This run: ${RULE}; accuracy when answering ${slash(o.accuracyWhenDecided)}. Mismatches flagged per type, before -> this run: ${Object.keys(thisRun.recallByType)
              .map((t) => `${t} ${before.recallByType[t]?.k ?? '?'} -> ${thisRun.recallByType[t]!.k} of ${thisRun.recallByType[t]!.n}`)
              .join(', ')}. One simulated extra photo per "not sure" pair is scored in the sightbench-looks suite.`,
          } satisfies Headline,
        ]
      : []),
    {
      id: 'navy-black-dim',
      label: 'Navy delivered for black (or black for navy) in dim light: mismatches caught by Sightline',
      value: ofN(nbDim.sightline.k, nbDim.sightline.n),
      baseline: `in daylight: ${ofN(nbDay.sightline.k, nbDay.sightline.n)}; CLIP dim: ${ofN(nbDim.clip.k, nbDim.clip.n)}`,
      interval: nbDim.sightline.n ? wilsonText(nbDim.sightline.k, nbDim.sightline.n) : undefined,
      n: nbDim.sightline.n,
      script: SCRIPT,
      negative: (nbDim.sightline.value ?? 0) < 0.5,
      note: `${SYNTH}. In dim light the colour module disagreed on ${nbDimCol.disagree}, but dim light lowers its confidence below "sure", so the verdict was "not sure"; it agreed (wrongly) on ${nbDimCol.agree} and gave up on ${nbDimCol.unknown}. CLIP's ${ofN(nbDim.clip.k, nbDim.clip.n)} means little: it flags ${pct(cl.overall.falseAlarm.value ?? 0)} of matching pairs too. Only ${nbDim.sightline.n} pairs per light level, so intervals are wide.`,
    },
    {
      id: 'size-mismatch',
      label: `Wrong size delivered: caught by Sightline${WITH_MODEL ? '' : ' without model reads'}`,
      value: ofN(sizeSl.k, sizeSl.n),
      baseline: `size-tag OCR alone: ${ofN(sizeOcr.k, sizeOcr.n)}`,
      interval: wilsonText(sizeSl.k, sizeSl.n),
      n: sizeSl.n,
      script: SCRIPT,
      negative: (sizeSl.value ?? 0) < 0.5,
      note: WITH_MODEL
        ? 'Size needs both tag reads (model and OCR) to agree before a mismatch is "sure".'
        : `With OCR as the only tag read, a size is at most "fairly sure", and fusion needs "sure" to call a mismatch, so these end as "not sure". OCR alone called ${ofN(results.ocrOnly!.overall.falseAlarm.k, results.ocrOnly!.overall.falseAlarm.n)} matching pairs a mismatch (synthetic tags).`,
    },
    {
      id: 'model-damage',
      label: `Different model or damage marks: caught by Sightline${WITH_MODEL ? '' : ' without model reads'}`,
      value: `model ${ofN(modelSl.k, modelSl.n)}, damage ${ofN(dmgSl.k, dmgSl.n)}`,
      baseline: `CLIP: model ${ofN(modelClip.k, modelClip.n)}, damage ${ofN(dmgClip.k, dmgClip.n)}`,
      n: modelSl.n + dmgSl.n,
      script: SCRIPT,
      negative: (modelSl.value ?? 0) + (dmgSl.value ?? 0) < 1,
      note: WITH_MODEL ? 'Identity and damage come from the vision-model reads.' : 'Identity and damage checks need the vision model, which this run did not have.',
    },
    {
      id: 'colour-cast-wood',
      label: 'Colour check gave up ("heavy colour cast") on wood tables and plank floors',
      value: ofN(woodCast.k, woodCast.n),
      baseline: `other surfaces: ${ofN(otherCast.k, otherCast.n)}`,
      interval: wilsonText(woodCast.k, woodCast.n),
      n: woodCast.n,
      script: SCRIPT,
      negative: (woodCast.value ?? 0) > 0.5,
      note: `${SYNTH}. Without a sheet of white paper in view, white balance is gray world over the background, so an orange wood surface reads as a strong colour cast and the colour module abstains. Holds in daylight too. Checked on dev: the item masks on wood are tight and the background pixels are plain wood, so this is the gray-world assumption, not a mask bug; it was not fitted away.`,
    },
    {
      id: 'latency',
      label: 'POST /verify latency on the dev laptop, p50 / p95',
      value: `${((latencyShown.p50Ms ?? 0) / 1000).toFixed(2)} s / ${((latencyShown.p95Ms ?? 0) / 1000).toFixed(2)} s`,
      n: latencyShown.n,
      script: SCRIPT,
      note: `Client wall time, one request at a time over localhost, CPU only${WITH_MODEL ? ', including model calls' : ', no model calls'}. Server-side total p50 ${latencyShown.serverTotalP50Ms} ms.${
        latency.n === 0 ? ` Not timed in this run (it scored responses assembled from cached model reads); measured in an earlier run (${latencyShown.from}).` : ''
      }`,
    },
  ];

  const limitations = [
    `${SYNTH}: listing images are clean procedural renders and delivered photos are phone-like renders (perspective, rotation, uneven light, colour casts, blur, noise, JPEG). Real photos will differ; the real photo set (evals/sightbench/real/SHOTLIST.md) is not collected yet.`,
    RESPONSES_FROM
      ? `This run used the deployed verdict rule (${RULE}). Its responses were written by services/vision app.looks_bench with the service's own pipeline code: identity and damage read by the vision model with prompt version ${RESPONSES_FROM} (cached per pair, read once), the size-tag model reads reused from run ${before?.run ?? '?'} (that prompt did not change), colour, OCR and quality recomputed. No request was timed.`
      : WITH_MODEL
      ? 'This run used the vision-model reads (GET /health vlm.configured true).'
      : 'No vision-model reads in this run (no ANTHROPIC_API_KEY): the service ran colour, OCR, quality and fusion only. Identity and damage report unknown, so it can never answer match, and a size read once by OCR is at most fairly sure. Re-run with --with-model once the service has a key.',
    UNFITTED
      ? `Service thresholds are the hand-set starting values (${THRESHOLDS}); nothing in the service was fitted. Only the CLIP threshold was fitted, on the dev split only: ${fitted.threshold} (${fitted.rule}).`
      : `Service thresholds: ${THRESHOLDS}, fitted on the dev split only (services/vision/app/thresholds.json, "fitted"); the hand-set set is kept as initial-unfitted. The CLIP threshold was also fitted on dev only: ${fitted.threshold} (${fitted.rule}). Dev has only ${devInfo.m.counts.pairs} pairs (${devInfo.m.pairs.filter((x) => x.mismatch_type === 'colour').length} colour mismatches), so the fit is coarse.`,
    `The frozen test split has been run ${testRuns.length} time${testRuns.length === 1 ? '' : 's'}: ${testRuns.map((r) => `run ${r.run} on ${r.ranAt.slice(0, 10)} (${r.engine}, ${r.label})`).join('; ')}. Each run's numbers are in details.testRuns; nothing was tuned on test.`,
    'The secondary metric ("names the difference" and its false-alarm twin) was defined after the first test run had been scored. It is reported next to the primary metrics, never instead of them.',
    `The test split (${m.counts.pairs} pairs, sha256 ${freeze.sha256.slice(0, 12)}) was frozen before any system ran. Products never cross splits (check-splits.mjs).`,
    'One delivered photo, one tag photo (not for mugs) and one listing image per pair; no damage close-up was sent, because a blind buyer may not know where to aim.',
    'Navy/black is deliberately oversampled (40% of colour mismatches), but that is still 7 pairs per light level; per-cell intervals are wide.',
    'The CLIP baseline sees only the listing image and the delivered photo, never the tag or the listing text, so it cannot see size by design.',
    'Ablations are decision rules applied to the module outputs of the same /verify calls, not separate service runs.',
  ];

  writeResult('sightbench', {
    title: 'SightBench: does the parcel match?',
    headlines,
    limitations,
    details: {
      label: `${SYNTH}. ${WITH_MODEL ? 'With' : 'Without'} vision-model reads.`,
      split: SPLIT,
      freeze: { sha256: freeze.sha256, frozenAt: freeze.frozen_at, manifest: freeze.manifest, generatorSha256: freeze.generator_sha256 },
      manifests: {
        test: { pairs: m.counts.pairs, match: m.counts.match, mismatch: m.counts.mismatch, sha256: sha },
        dev: {
          pairs: devInfo.m.counts.pairs,
          sha256: devInfo.sha,
          usedFor: UNFITTED ? 'fitting the CLIP threshold only' : 'fitting the CLIP threshold and the service thresholds (colour confidence rules)',
        },
      },
      service: { url: VISION, health, engine: ENGINE },
      clipBaseline: { model: clip.model, pretrained: clip.pretrained, device: clip.device, threshold: clip.threshold, fitted },
      systems: Object.fromEntries(Object.entries(systems).map(([k, s]) => [k, { label: s.label, definition: s.definition, abstains: s.abstains }])),
      ranking: {
        rule: 'Sorted by the lower end of the 95% bootstrap interval of F1 (mismatch = positive, "unsure" = not flagged); ties by the Wilson lower bound of mismatch recall.',
        caveat: 'With 50% mismatches, flagging every pair scores F1 = 2/3 (the reference row). Read F1 together with recallMinusFalseAlarm (0 for flagging everything) and coverage.',
        table: ranking,
      },
      colourCastBySurface: { woodAndPlanks: woodCast, otherSurfaces: otherCast },
      metrics: results,
      secondary: sec,
      colourCalls,
      testRuns,
      navyBlack,
      colourAbstain,
      latency,
      latencyShown,
      errors,
      worstCases: {
        sightlineFalseAlarms: falseAlarms,
        sightlineWrongMatches: wrongMatches,
        colourModuleAgreedOnColourMismatch: colourFooled.slice(0, 15),
        ocrWrongReads: ocrWrong.slice(0, 15),
        clipMostSimilarMismatches: clipMissed,
        clipLeastSimilarMatches: clipFalse,
        sightlineWorstTypeLightCells: worstCells,
      },
      pairs: {
        note: 'One row per test pair. reasons = "module finding confidence"; the spoken sentences for the worst cases are under worstCases, and every raw response is in evals/data/raw/sightbench/responses/.',
        rows: rows.map(({ reasons, headline, ...r }) => ({ ...r, reasons: reasons.map((x) => `${x.module} ${x.finding} ${x.confidence}`) })),
      },
    },
  });
  console.log(`sightbench: wrote evals/results/sightbench.json`);
}

await main();
