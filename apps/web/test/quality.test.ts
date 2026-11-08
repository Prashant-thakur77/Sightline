import { describe, expect, it } from 'vitest';
import { AutoCapture, frameStats, GuidanceSpeaker, guidanceFor } from '../src/lib/quality';

const W = 80;
const H = 60;
function frame(fn: (x: number, y: number) => [number, number, number]): Uint8ClampedArray {
  const a = new Uint8ClampedArray(W * H * 4);
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      const [r, g, b] = fn(x, y);
      const i = (y * W + x) * 4;
      a[i] = r;
      a[i + 1] = g;
      a[i + 2] = b;
      a[i + 3] = 255;
    }
  return a;
}
const inItem = (x: number, y: number, s = 0.5) => Math.abs(x - W / 2) < (W * s) / 2 && Math.abs(y - H / 2) < (H * s) / 2;
// A navy item with a knit texture on a light background.
const good = frame((x, y) => (inItem(x, y) ? ((x + y) % 3 === 0 ? [20, 30, 60] : [40, 52, 90]) : [228, 228, 222]));

describe('frame quality', () => {
  it('accepts a well-lit, framed, sharp item', () => {
    expect(guidanceFor(frameStats(good, W, H))).toBe('OK');
  });
  it('asks for light when dark', () => {
    const dark = frame((x, y) => (inItem(x, y) ? [5, 6, 10] : [30, 30, 28]));
    expect(guidanceFor(frameStats(dark, W, H))).toBe('TOO_DARK');
  });
  it('detects glare', () => {
    const glare = frame((x, y) => (x < 30 && y < 20 ? [255, 255, 255] : inItem(x, y) ? [40, 52, 90] : [200, 200, 196]));
    expect(guidanceFor(frameStats(glare, W, H))).toBe('GLARE');
  });
  it('asks to move closer when the item is tiny', () => {
    const far = frame((x, y) => (inItem(x, y, 0.2) ? [40, 52, 90] : [228, 228, 222]));
    expect(guidanceFor(frameStats(far, W, H))).toBe('TOO_FAR');
  });
  it('asks to hold still when there is no detail', () => {
    const flat = frame((x, y) => (inItem(x, y) ? [60, 70, 100] : [228, 228, 222]));
    const s = frameStats(flat, W, H);
    expect(s.sharpness).toBeLessThan(frameStats(good, W, H).sharpness);
  });
});

describe('guidance speaker', () => {
  it('speaks only stable changes and respects the gap', () => {
    const s = new GuidanceSpeaker(500, 2000);
    expect(s.update('TOO_DARK', 0)).toBeNull();
    expect(s.update('TOO_DARK', 600)).toBe('TOO_DARK');
    expect(s.update('TOO_DARK', 900)).toBeNull();
    expect(s.update('TOO_FAR', 1000)).toBeNull();
    expect(s.update('TOO_FAR', 1600)).toBeNull(); // within 2 s gap
    expect(s.update('TOO_FAR', 2700)).toBe('TOO_FAR');
    expect(s.update('OK', 2800)).toBeNull();
    expect(s.update('OK', 3400)).toBe('OK');
  });
});

describe('auto capture', () => {
  it('fires after a steady OK and resets on any problem', () => {
    const a = new AutoCapture(1000);
    expect(a.update('OK', 0)).toBe(false);
    expect(a.progress(500)).toBeCloseTo(0.5);
    expect(a.update('BLURRY', 600)).toBe(false);
    expect(a.update('OK', 700)).toBe(false);
    expect(a.update('OK', 1600)).toBe(false);
    expect(a.update('OK', 1700)).toBe(true);
  });
});
