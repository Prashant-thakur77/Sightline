import { describe, expect, it } from 'vitest';
import {
  bootstrapCI,
  clopperPearson,
  f1,
  formatInterval,
  logGamma,
  mean,
  mulberry32,
  percentile,
  regIncBeta,
  betaQuantile,
  wilson,
} from './stats';

describe('wilson', () => {
  it('0 of 48 gives [0, 0.074]', () => {
    const [lo, hi] = wilson(0, 48);
    expect(lo).toBe(0);
    expect(hi).toBeCloseTo(0.0741, 4);
  });

  it('5 of 10 is symmetric around one half', () => {
    const [lo, hi] = wilson(5, 10);
    expect(lo).toBeCloseTo(0.2366, 4);
    expect(hi).toBeCloseTo(0.7634, 4);
  });

  it('n of n mirrors 0 of n', () => {
    const [lo, hi] = wilson(48, 48);
    expect(hi).toBe(1);
    expect(lo).toBeCloseTo(1 - 0.0741, 4);
  });

  it('rejects impossible counts', () => {
    expect(() => wilson(3, 2)).toThrow();
    expect(() => wilson(-1, 2)).toThrow();
    expect(() => wilson(0, 0)).toThrow();
  });
});

describe('incomplete beta and its quantile', () => {
  it('logGamma matches known values', () => {
    expect(logGamma(1)).toBeCloseTo(0, 10);
    expect(logGamma(5)).toBeCloseTo(Math.log(24), 10);
    expect(logGamma(0.5)).toBeCloseTo(Math.log(Math.sqrt(Math.PI)), 10);
  });

  it('I_0.5(2, 3) = 0.6875', () => {
    expect(regIncBeta(0.5, 2, 3)).toBeCloseTo(0.6875, 10);
  });

  it('I_x(1, 1) = x and the end points are exact', () => {
    expect(regIncBeta(0.3, 1, 1)).toBeCloseTo(0.3, 12);
    expect(regIncBeta(0, 2, 5)).toBe(0);
    expect(regIncBeta(1, 2, 5)).toBe(1);
  });

  it('the quantile inverts the CDF', () => {
    for (const [a, b, p] of [
      [2, 3, 0.1],
      [1, 60, 0.975],
      [10, 4, 0.5],
    ] as const) {
      expect(regIncBeta(betaQuantile(p, a, b), a, b)).toBeCloseTo(p, 9);
    }
  });
});

describe('clopperPearson', () => {
  it('0 of 60 has an upper bound of about 0.0596', () => {
    const [lo, hi] = clopperPearson(0, 60);
    expect(lo).toBe(0);
    expect(hi).toBeCloseTo(1 - 0.025 ** (1 / 60), 6);
    expect(hi).toBeCloseTo(0.0596, 4);
  });

  it('5 of 10 gives [0.1871, 0.8129]', () => {
    const [lo, hi] = clopperPearson(5, 10);
    expect(lo).toBeCloseTo(0.1871, 4);
    expect(hi).toBeCloseTo(0.8129, 4);
  });

  it('is wider than Wilson for small counts', () => {
    const [wl, wh] = wilson(2, 20);
    const [cl, ch] = clopperPearson(2, 20);
    expect(cl).toBeLessThanOrEqual(wl);
    expect(ch).toBeGreaterThanOrEqual(wh);
  });
});

describe('percentile', () => {
  it('interpolates linearly between order statistics', () => {
    const xs = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
    expect(percentile(xs, 50)).toBe(5.5);
    expect(percentile(xs, 95)).toBeCloseTo(9.55, 10);
    expect(percentile(xs, 0)).toBe(1);
    expect(percentile(xs, 100)).toBe(10);
    expect(percentile([7], 95)).toBe(7);
  });

  it('does not depend on input order', () => {
    expect(percentile([5, 1, 3], 50)).toBe(3);
  });
});

describe('bootstrap', () => {
  it('the seeded generator is deterministic', () => {
    const a = mulberry32(42);
    const b = mulberry32(42);
    const xs = Array.from({ length: 5 }, () => a());
    expect(Array.from({ length: 5 }, () => b())).toEqual(xs);
    for (const x of xs) {
      expect(x).toBeGreaterThanOrEqual(0);
      expect(x).toBeLessThan(1);
    }
  });

  it('a mean CI covers the sample mean and is reproducible', () => {
    const rng = mulberry32(7);
    const data = Array.from({ length: 400 }, () => (rng() < 0.3 ? 1 : 0));
    const ci1 = bootstrapCI(data, mean, { seed: 1, resamples: 2000 });
    const ci2 = bootstrapCI(data, mean, { seed: 1, resamples: 2000 });
    expect(ci1).toEqual(ci2);
    const m = mean(data);
    expect(ci1[0]).toBeLessThan(m);
    expect(ci1[1]).toBeGreaterThan(m);
    // Normal-approximation half width for p = 0.3, n = 400 is about 0.045.
    expect(ci1[1] - ci1[0]).toBeGreaterThan(0.06);
    expect(ci1[1] - ci1[0]).toBeLessThan(0.12);
  });

  it('f1 works on paired labels and inside the bootstrap', () => {
    const pairs = [
      { truth: true, predicted: true },
      { truth: true, predicted: false },
      { truth: false, predicted: true },
      { truth: true, predicted: true },
    ];
    // precision 2/3, recall 2/3
    expect(f1(pairs)).toBeCloseTo(2 / 3, 10);
    const [lo, hi] = bootstrapCI(pairs, f1, { seed: 3, resamples: 500 });
    expect(lo).toBeLessThanOrEqual(hi);
  });
});

describe('formatInterval', () => {
  it('writes a short percentage range', () => {
    expect(formatInterval([0, 0.0741])).toBe('0.0%–7.4%');
  });
});
