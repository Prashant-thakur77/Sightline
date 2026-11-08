/**
 * Small, dependency-free statistics for the eval suites: binomial intervals (Wilson score and
 * Clopper-Pearson exact), a seeded percentile bootstrap, and percentiles.
 */

export type Interval = [number, number];

/** Two-sided 95% normal quantile. */
export const Z95 = 1.959963984540054;

function checkCounts(k: number, n: number): void {
  if (!Number.isInteger(k) || !Number.isInteger(n) || n <= 0 || k < 0 || k > n) {
    throw new Error(`Invalid binomial counts: ${k} of ${n}`);
  }
}

/** Wilson score interval for k successes in n trials. */
export function wilson(k: number, n: number, z = Z95): Interval {
  checkCounts(k, n);
  const p = k / n;
  const z2 = z * z;
  const denom = 1 + z2 / n;
  const centre = (p + z2 / (2 * n)) / denom;
  const half = (z / denom) * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n));
  // Clamp float noise at the ends: 0 of n has a lower bound of exactly 0, n of n an upper of 1.
  const lo = k === 0 ? 0 : Math.max(0, centre - half);
  const hi = k === n ? 1 : Math.min(1, centre + half);
  return [lo, hi];
}

// ---------------------------------------------------------------------------------------------
// Regularised incomplete beta function and its inverse

const LANCZOS = [
  0.99999999999980993, 676.5203681218851, -1259.1392167224028, 771.32342877765313, -176.61502916214059,
  12.507343278686905, -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7,
];

/** ln Γ(x) for x > 0 (Lanczos, g = 7). */
export function logGamma(x: number): number {
  if (!(x > 0)) throw new Error(`logGamma needs x > 0, got ${x}`);
  if (x < 0.5) return Math.log(Math.PI / Math.sin(Math.PI * x)) - logGamma(1 - x);
  const xx = x - 1;
  let a = LANCZOS[0]!;
  const t = xx + 7.5;
  for (let i = 1; i < 9; i++) a += LANCZOS[i]! / (xx + i);
  return 0.5 * Math.log(2 * Math.PI) + (xx + 0.5) * Math.log(t) - t + Math.log(a);
}

/** Continued fraction for the incomplete beta function (modified Lentz). */
function betaContinuedFraction(x: number, a: number, b: number): number {
  const MAX_ITER = 10_000;
  const EPS = 1e-15;
  const TINY = 1e-300;
  const qab = a + b;
  const qap = a + 1;
  const qam = a - 1;
  let c = 1;
  let d = 1 - (qab * x) / qap;
  if (Math.abs(d) < TINY) d = TINY;
  d = 1 / d;
  let h = d;
  for (let m = 1; m <= MAX_ITER; m++) {
    const m2 = 2 * m;
    let aa = (m * (b - m) * x) / ((qam + m2) * (a + m2));
    d = 1 + aa * d;
    if (Math.abs(d) < TINY) d = TINY;
    c = 1 + aa / c;
    if (Math.abs(c) < TINY) c = TINY;
    d = 1 / d;
    h *= d * c;
    aa = (-(a + m) * (qab + m) * x) / ((a + m2) * (qap + m2));
    d = 1 + aa * d;
    if (Math.abs(d) < TINY) d = TINY;
    c = 1 + aa / c;
    if (Math.abs(c) < TINY) c = TINY;
    d = 1 / d;
    const del = d * c;
    h *= del;
    if (Math.abs(del - 1) < EPS) return h;
  }
  throw new Error('Incomplete beta continued fraction did not converge');
}

/** Regularised incomplete beta I_x(a, b) for a, b > 0 and 0 <= x <= 1. */
export function regIncBeta(x: number, a: number, b: number): number {
  if (!(a > 0 && b > 0)) throw new Error('regIncBeta needs a, b > 0');
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  const lnFront = logGamma(a + b) - logGamma(a) - logGamma(b) + a * Math.log(x) + b * Math.log(1 - x);
  const front = Math.exp(lnFront);
  // The continued fraction converges fast for x < (a + 1) / (a + b + 2); use symmetry otherwise.
  if (x < (a + 1) / (a + b + 2)) return (front * betaContinuedFraction(x, a, b)) / a;
  return 1 - (front * betaContinuedFraction(1 - x, b, a)) / b;
}

/** The x with I_x(a, b) = p, by bisection. The CDF is monotone, so this always converges. */
export function betaQuantile(p: number, a: number, b: number): number {
  if (!(p >= 0 && p <= 1)) throw new Error('betaQuantile needs 0 <= p <= 1');
  if (p === 0) return 0;
  if (p === 1) return 1;
  let lo = 0;
  let hi = 1;
  for (let i = 0; i < 200 && hi - lo > 1e-15; i++) {
    const mid = (lo + hi) / 2;
    if (regIncBeta(mid, a, b) < p) lo = mid;
    else hi = mid;
  }
  return (lo + hi) / 2;
}

/** Clopper-Pearson exact interval for k successes in n trials. */
export function clopperPearson(k: number, n: number, alpha = 0.05): Interval {
  checkCounts(k, n);
  const lo = k === 0 ? 0 : betaQuantile(alpha / 2, k, n - k + 1);
  const hi = k === n ? 1 : betaQuantile(1 - alpha / 2, k + 1, n - k);
  return [lo, hi];
}

// ---------------------------------------------------------------------------------------------
// Bootstrap

/** Seeded 32-bit PRNG returning floats in [0, 1). */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function mean(xs: readonly number[]): number {
  if (xs.length === 0) throw new Error('mean of an empty sample');
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}

/** F1 over paired binary labels. Returns 0 when there are no true or predicted positives. */
export function f1(pairs: readonly { truth: boolean; predicted: boolean }[]): number {
  let tp = 0;
  let fp = 0;
  let fn = 0;
  for (const p of pairs) {
    if (p.truth && p.predicted) tp++;
    else if (!p.truth && p.predicted) fp++;
    else if (p.truth && !p.predicted) fn++;
  }
  return tp === 0 ? 0 : (2 * tp) / (2 * tp + fp + fn);
}

/** Percentile bootstrap CI for any statistic of a sample. Deterministic for a given seed. */
export function bootstrapCI<T>(
  data: readonly T[],
  stat: (sample: readonly T[]) => number,
  opts: { seed?: number; resamples?: number; alpha?: number } = {},
): Interval {
  if (data.length === 0) throw new Error('bootstrap of an empty sample');
  const rng = mulberry32(opts.seed ?? 1);
  const B = opts.resamples ?? 5000;
  const alpha = opts.alpha ?? 0.05;
  const stats: number[] = new Array(B);
  const sample: T[] = new Array(data.length);
  for (let b = 0; b < B; b++) {
    for (let i = 0; i < data.length; i++) sample[i] = data[Math.floor(rng() * data.length)]!;
    stats[b] = stat(sample);
  }
  return [percentile(stats, (100 * alpha) / 2), percentile(stats, 100 * (1 - alpha / 2))];
}

// ---------------------------------------------------------------------------------------------
// Percentiles and formatting

/** Percentile with linear interpolation between order statistics (the common "type 7"). */
export function percentile(xs: readonly number[], q: number): number {
  if (xs.length === 0) throw new Error('percentile of an empty sample');
  if (q < 0 || q > 100) throw new Error('percentile q must be in [0, 100]');
  const s = [...xs].sort((a, b) => a - b);
  const h = (s.length - 1) * (q / 100);
  const lo = Math.floor(h);
  const hi = Math.ceil(h);
  return s[lo]! + (h - lo) * (s[hi]! - s[lo]!);
}

export function pct(x: number, digits = 1): string {
  return `${(x * 100).toFixed(digits)}%`;
}

export function formatInterval([lo, hi]: Interval, digits = 1): string {
  return `${pct(lo, digits)}–${pct(hi, digits)}`;
}

/** "95% Wilson 0.0%–7.4%" */
export function wilsonText(k: number, n: number): string {
  return `95% Wilson ${formatInterval(wilson(k, n))}`;
}

/** "95% exact 0.0%–6.0%" */
export function exactText(k: number, n: number): string {
  return `95% exact ${formatInterval(clopperPearson(k, n))}`;
}
