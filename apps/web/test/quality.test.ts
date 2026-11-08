import { describe, expect, it } from 'vitest';
import {
  analyzeFrame,
  AutoCapture,
  cueKey,
  cueText,
  GuidanceCoach,
  GuidanceSpeaker,
  type FrameAnalysis,
  type GuidanceCode,
} from '../src/lib/quality';

/* Synthetic camera frames at the size the camera samples (160 × 120), built by hand as RGBA. */

const W = 160;
const H = 120;
type RGB = [number, number, number];
interface Rect {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

/** Deterministic noise, so a run never flakes. */
function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function frame(fn: (x: number, y: number) => RGB, noise = 3, seed = 1): Uint8ClampedArray {
  const rand = rng(seed);
  const a = new Uint8ClampedArray(W * H * 4);
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      const [r, g, b] = fn(x, y);
      const j = (rand() * 2 - 1) * noise;
      const i = (y * W + x) * 4;
      a[i] = r + j;
      a[i + 1] = g + j;
      a[i + 2] = b + j;
      a[i + 3] = 255;
    }
  return a;
}

/** Rect in fractions of the frame; parts outside the frame are simply cut off. */
const inside = (x: number, y: number, r: Rect) => x >= r.x0 * W && x < r.x1 * W && y >= r.y0 * H && y < r.y1 * H;
const knit = (x: number, y: number, a: RGB, b: RGB): RGB => ((x + y) % 3 === 0 ? a : b);

const LIGHT_BED: RGB = [228, 228, 222];
const DARK_BED: RGB = [64, 62, 66];
const NAVY_A: RGB = [20, 30, 60];
const NAVY_B: RGB = [40, 52, 90];
const CENTRE: Rect = { x0: 0.25, y0: 0.25, x1: 0.75, y1: 0.75 };

/** A navy knit sweater laid at `r` on a surface. */
const sweater = (r: Rect, bed: RGB = LIGHT_BED, a: RGB = NAVY_A, b: RGB = NAVY_B) =>
  frame((x, y) => (inside(x, y, r) ? knit(x, y, a, b) : bed));

const analyse = (rgba: Uint8ClampedArray, mode: 'item' | 'label' | 'detail' = 'item') => analyzeFrame(rgba, W, H, mode);
/** The box is found to within about one grid cell (an edge pixel can pull in the next cell). */
function expectBox(a: FrameAnalysis, r: Rect) {
  const b = a.item.box!;
  expect(b).not.toBeNull();
  for (const k of ['x0', 'y0', 'x1', 'y1'] as const) expect(Math.abs(b[k] - r[k])).toBeLessThanOrEqual(0.075);
}
const say = (a: FrameAnalysis, mode: 'item' | 'label' | 'detail' = 'item', opts = {}) => cueText(a, mode, opts);

describe('finding the item', () => {
  it('says "Centred. Hold still." for a sharp item in the middle', () => {
    const a = analyse(sweater(CENTRE));
    expect(a.code).toBe('OK');
    expect(a.item.centred).toBe(true);
    expect(a.item.confidence).toBe('sure');
    expectBox(a, CENTRE);
    expect(say(a)).toBe('Centred. Hold still.');
  });

  it('says "All in view" rather than "Centred" when the whole item is in view but off to one side', () => {
    const a = analyse(sweater({ x0: 0.1, y0: 0.2, x1: 0.42, y1: 0.75 }));
    expect(a.code).toBe('OK');
    expect(say(a)).toBe('All in view. Hold still.');
  });

  const cases: { edge: string; r: Rect; text: string }[] = [
    { edge: 'left', r: { x0: -0.2, y0: 0.25, x1: 0.45, y1: 0.75 }, text: 'The item is cut off on the left. Move the phone left.' },
    { edge: 'right', r: { x0: 0.55, y0: 0.25, x1: 1.2, y1: 0.75 }, text: 'The item is cut off on the right. Move the phone right.' },
    { edge: 'top', r: { x0: 0.3, y0: -0.2, x1: 0.7, y1: 0.5 }, text: 'The item is cut off at the top. Tilt the phone up.' },
    { edge: 'bottom', r: { x0: 0.3, y0: 0.5, x1: 0.7, y1: 1.2 }, text: 'The item is cut off at the bottom. Tilt the phone down.' },
  ];
  for (const c of cases) {
    it(`says which way to move when the item is cut off ${c.edge === 'left' || c.edge === 'right' ? 'on the' : 'at the'} ${c.edge}`, () => {
      const a = analyse(sweater(c.r));
      expect(a.code).toBe('CUT');
      expect(a.edges).toEqual([c.edge]);
      expect(say(a)).toBe(c.text);
    });
  }

  it('names both edges at a corner', () => {
    const a = analyse(sweater({ x0: -0.2, y0: -0.2, x1: 0.45, y1: 0.5 }));
    expect(a.code).toBe('CUT');
    expect([...a.edges].sort()).toEqual(['left', 'top']);
    const text = say(a);
    expect(text).toMatch(/^The item is cut off (on the left and at the top|at the top and on the left)\./);
    expect(text).toMatch(/move (the phone|it) left/i);
    expect(text).toMatch(/tilt (the phone|it) up/i);
  });

  it('swaps left and right for a front camera, so the words match the person', () => {
    const a = analyse(sweater(cases[0]!.r));
    expect(say(a, 'item', { mirrored: true })).toBe('The item is cut off on the right. Move the phone right.');
  });

  it('asks to move back when the item runs past opposite edges', () => {
    const a = analyse(sweater({ x0: -0.1, y0: 0.2, x1: 1.1, y1: 0.8 }));
    expect(a.code).toBe('TOO_CLOSE');
    expect(say(a)).toBe('The item goes past the edges. Move the phone back a little.');
  });

  it('asks to come closer when the item is small', () => {
    const a = analyse(sweater({ x0: 0.42, y0: 0.4, x1: 0.6, y1: 0.62 }));
    expect(a.code).toBe('TOO_FAR');
    expect(say(a)).toBe('The item looks small. Move the phone a little closer.');
  });

  it('hedges when only a sliver shows at an edge, instead of guessing it is the item', () => {
    const a = analyse(sweater({ x0: 0.94, y0: 0.3, x1: 1.2, y1: 0.7 }));
    expect(a.code).toBe('EDGE_ONLY');
    expect(a.edges).toEqual(['right']);
    expect(say(a)).toBe("Something is at the right edge. If it's the item, move the phone right.");
  });
});

describe('dark on dark', () => {
  // A plain colour-difference test (sum of RGB differences over 60) misses this navy sweater on
  // a dark bedspread and loops "move the phone closer".
  const navyA: RGB = [38, 48, 84];
  const navyB: RGB = [48, 58, 96];
  const rgbDiff = (p: RGB, q: RGB) => Math.abs(p[0] - q[0]) + Math.abs(p[1] - q[1]) + Math.abs(p[2] - q[2]);

  it('finds a navy sweater on a dark bedspread', () => {
    expect(rgbDiff(navyB, DARK_BED)).toBeLessThan(60);
    const a = analyse(sweater(CENTRE, DARK_BED, navyA, navyB));
    expect(a.code).toBe('OK');
    expectBox(a, CENTRE);
  });

  it('still gives the direction when that sweater is cut off', () => {
    const a = analyse(sweater({ x0: 0.3, y0: 0.4, x1: 0.7, y1: 1.2 }, DARK_BED, navyA, navyB));
    expect(a.code).toBe('CUT');
    expect(a.edges).toEqual(['bottom']);
  });

  it('finds a knit of the same average colour as the bedspread by its texture', () => {
    // One stitch in three dark: the cell average equals the smooth bedspread's colour.
    const bed: RGB = [80, 80, 84];
    const rgba = frame((x, y) => (inside(x, y, CENTRE) ? knit(x, y, [20, 20, 24], [110, 110, 114]) : bed), 2);
    const a = analyse(rgba);
    expect(a.item.box).not.toBeNull();
    expect(a.code).toBe('OK');
  });
});

describe('nothing to see, or not sure', () => {
  it('says it cannot see the item on an empty bedspread', () => {
    const a = analyse(frame(() => DARK_BED, 4));
    expect(a.code).toBe('NOTHING');
    expect(a.item.box).toBeNull();
    expect(say(a)).toBe("I can't see the item yet. Hold the phone about an arm's length above it.");
  });

  it('says it cannot see the item when the item fills the whole view', () => {
    const a = analyse(frame((x, y) => knit(x, y, [90, 96, 120], [140, 146, 170])));
    expect(a.code).toBe('NOTHING');
  });

  it('does not mistake light falling off across an empty table for an item', () => {
    const a = analyse(frame((x, y) => [150 + (x / W) * 60 + (y / H) * 20, 150 + (x / W) * 60 + (y / H) * 20, 145 + (x / W) * 60], 2));
    expect(a.code).toBe('NOTHING');
  });

  it('does not mistake a lamp’s bright spot on an empty bed for an item', () => {
    const lamp = (x: number, y: number) => 40 * Math.exp(-((x - W / 2) ** 2 + (y - H / 2) ** 2) / (2 * (W / 3) ** 2));
    const a = analyse(frame((x, y) => [150 + lamp(x, y), 146 + lamp(x, y), 140 + lamp(x, y)], 2));
    expect(a.code).toBe('NOTHING');
  });

  it('does not call an item cut off when a lamp brightens the edge beside it', () => {
    const lamp = (x: number, y: number) => 70 * Math.exp(-((x + 10) ** 2 + (y - H / 2) ** 2) / (2 * 30 ** 2));
    const rgba = frame((x, y) => {
      const l = lamp(x, y);
      return inside(x, y, { x0: 0.18, y0: 0.2, x1: 0.8, y1: 0.8 }) ? knit(x, y, NAVY_A, NAVY_B) : [170 + l, 150 + l, 150 + l];
    });
    const a = analyse(rgba);
    expect(a.edges).toEqual([]);
    expect(a.code).toBe('OK');
  });

  it('does not take bedding stripes running to the edge for the item being cut off', () => {
    const striped = frame((x, y) =>
      inside(x, y, { x0: 0.3, y0: 0.4, x1: 0.7, y1: 0.65 }) ? [120, 40, 45] : x % 10 < 5 ? [225, 220, 205] : [150, 148, 140],
    );
    const a = analyse(striped);
    expect(['CUT', 'TOO_CLOSE', 'EDGE_ONLY']).not.toContain(a.code);
  });

  it('says it cannot tell on spotty bedding, rather than calling the spots part of the item', () => {
    const rand = rng(11);
    const spots = Array.from({ length: 70 }, () => [rand() * W, rand() * H, 2 + rand() * 3] as const);
    const spotty = frame((x, y) =>
      inside(x, y, CENTRE)
        ? knit(x, y, NAVY_A, NAVY_B)
        : spots.some(([sx, sy, r]) => (x - sx) ** 2 + (y - sy) ** 2 < r * r)
          ? [210, 200, 180]
          : [70, 72, 80],
    );
    expect(analyse(spotty).code).toBe('UNSURE');
  });

  it('suggests a contrasting surface: light on a dark one, dark on a light one', () => {
    const dark = analyse(frame(() => DARK_BED));
    expect(say(dark, 'item', { tip: true })).toBe(
      "I can't see the item yet. Hold the phone about an arm's length above it. A plain, light surface under it helps.",
    );
    const light = analyse(frame(() => LIGHT_BED));
    expect(say(light, 'item', { tip: true })).toContain('A plain, dark surface under it helps.');
  });

  it('says what it cannot tell on a busy patterned surface, rather than guessing', () => {
    const rand = rng(7);
    const tiles: RGB[] = Array.from({ length: 400 }, () => [rand() * 255, rand() * 255, rand() * 255]);
    const busy = frame((x, y) => (inside(x, y, CENTRE) ? knit(x, y, NAVY_A, NAVY_B) : tiles[((y / 10) | 0) * 16 + ((x / 10) | 0)]!));
    const a = analyse(busy);
    expect(a.code).toBe('UNSURE');
    expect(say(a, 'item', { tip: true })).toMatch(/^I can't tell the item from the background\. A plain, (light|dark) surface under it helps\.$/);
    expect(say(a)).toBe("I can't tell the item from the background. You can press Capture now to take the photo anyway.");
  });
});

describe('light, glare and blur', () => {
  it('asks for light when dark', () => {
    const a = analyse(frame((x, y) => (inside(x, y, CENTRE) ? [5, 6, 10] : [30, 30, 28])));
    expect(a.code).toBe('TOO_DARK');
    expect(say(a)).toBe('Too dark. Can you turn on a light?');
  });

  it('detects glare', () => {
    const a = analyse(frame((x, y) => (x < 60 && y < 40 ? [255, 255, 255] : inside(x, y, CENTRE) ? NAVY_B : [200, 200, 196]), 0));
    expect(a.code).toBe('GLARE');
  });

  it('asks to hold still when the item has no sharp detail', () => {
    // Soft edges and no texture, like a frame taken while the phone moves.
    const ramp = (v: number, a: number, b: number) => Math.max(0, Math.min(1, Math.min(v - a, b - v) / 14));
    const soft = frame((x, y) => {
      const k = ramp(x, 0.25 * W, 0.75 * W) * ramp(y, 0.2 * H, 0.8 * H);
      return [228 - k * 170, 228 - k * 160, 222 - k * 120];
    }, 0);
    const a = analyse(soft);
    expect(a.item.box).not.toBeNull();
    expect(a.code).toBe('BLURRY');
    expect(a.sharpness).toBeLessThan(analyse(sweater(CENTRE)).sharpness);
  });
});

describe('shake', () => {
  /** Smear a frame sideways over `k` pixels, like the phone moving while the photo is taken. */
  function smear(rgba: Uint8ClampedArray, k: number): Uint8ClampedArray {
    const out = new Uint8ClampedArray(rgba.length);
    for (let y = 0; y < H; y++)
      for (let x = 0; x < W; x++)
        for (let ch = 0; ch < 4; ch++) {
          let s = 0;
          for (let d = 0; d < k; d++) s += rgba[(y * W + Math.min(W - 1, Math.max(0, x + d - (k >> 1)))) * 4 + ch]!;
          out[(y * W + x) * 4 + ch] = s / k;
        }
    return out;
  }

  it('asks to hold still when the picture is smeared one way', () => {
    const a = analyse(smear(sweater(CENTRE), 6));
    expect(a.code).toBe('BLURRY');
    expect(say(a)).toBe('Hold still for a moment.');
  });

  it('does not call a sharp, low-contrast item blurry', () => {
    // A plain navy sweater on a dark bedspread: sharp edges, but faint ones.
    const a = analyse(frame((x, y) => (inside(x, y, CENTRE) ? [42, 52, 90] : DARK_BED), 2));
    expect(a.code).toBe('OK');
  });
});

describe('the size tag', () => {
  const GARMENT: RGB = [40, 52, 90];
  const TAG: RGB = [238, 236, 230];
  /** Rows of letters: short dark strokes with gaps, like printed writing. */
  const writing = (x: number, y: number, r: Rect) => {
    const lx = x - r.x0 * W;
    const ly = y - r.y0 * H;
    const h = (r.y1 - r.y0) * H;
    if (ly < 4 || ly > h - 4 || lx < 4 || lx > (r.x1 - r.x0) * W - 4) return false;
    return ly % 8 < 4 && lx % 4 < 2;
  };
  const tag = (r: Rect, printed = true) =>
    frame((x, y) => (inside(x, y, r) ? (printed && writing(x, y, r) ? [25, 25, 30] : TAG) : knit(x, y, GARMENT, [30, 40, 72])));

  it('auto-captures only when the tag is big enough, sharp and shows writing', () => {
    const a = analyse(tag({ x0: 0.22, y0: 0.25, x1: 0.78, y1: 0.75 }), 'label');
    expect(a.code).toBe('OK');
    expect(a.text).toBeGreaterThan(0.15);
    expect(say(a, 'label')).toBe('The writing looks clear. Hold still.');
  });

  it('asks to bring a small tag closer', () => {
    const a = analyse(tag({ x0: 0.42, y0: 0.4, x1: 0.62, y1: 0.6 }), 'label');
    expect(a.code).toBe('TOO_FAR');
    expect(say(a, 'label')).toBe('The tag looks small. Bring it a little closer to the phone.');
  });

  it('does not capture a tag with no writing showing', () => {
    const a = analyse(tag({ x0: 0.22, y0: 0.25, x1: 0.78, y1: 0.75 }, false), 'label');
    expect(a.code).not.toBe('OK');
    expect(['UNREADABLE', 'BLURRY']).toContain(a.code);
  });

  it('does not capture a blurred tag', () => {
    // Writing smeared into soft grey bands.
    const r: Rect = { x0: 0.22, y0: 0.25, x1: 0.78, y1: 0.75 };
    const blurred = frame((x, y) => {
      if (!inside(x, y, r)) return knit(x, y, GARMENT, [30, 40, 72]);
      const ly = y - r.y0 * H;
      const v = 238 - 60 * (0.5 + 0.5 * Math.cos((ly / 8) * 2 * Math.PI));
      return [v, v, v - 6];
    }, 0);
    const a = analyse(blurred, 'label');
    expect(['BLURRY', 'UNREADABLE']).toContain(a.code);
  });

  it('says the tag, not the item, when it is cut off', () => {
    const a = analyse(tag({ x0: -0.2, y0: 0.25, x1: 0.5, y1: 0.75 }), 'label');
    expect(a.code).toBe('CUT');
    expect(say(a, 'label')).toBe('The tag is cut off on the left. Move the phone left.');
  });
});

describe('damage close-ups', () => {
  it('only checks light and sharpness: a frame full of fabric is fine', () => {
    const a = analyse(frame((x, y) => knit(x, y, [90, 96, 120], [140, 146, 170])), 'detail');
    expect(a.code).toBe('OK');
    expect(say(a, 'detail')).toBe('Hold still, capturing.');
  });
});

describe('cue pacing', () => {
  const fake = (code: GuidanceCode, edges: FrameAnalysis['edges'] = []): FrameAnalysis => ({
    code,
    edges,
    item: { box: null, area: 0, edges, centred: true, confidence: 'sure' },
    luminance: 120,
    sharpness: 100,
    glare: 0,
    text: 0,
    surface: 'dark',
  });

  it('never says the same cue twice within 2.5 seconds, however the frames flicker', () => {
    const s = new GuidanceSpeaker({ stableMs: 0, minGapMs: 0, repeatMs: 0 });
    const rand = rng(3);
    const keys = ['CUT:left', 'CUT:top', 'OK', 'BLURRY'];
    const spoken = new Map<string, number[]>();
    for (let now = 0; now < 60_000; now += 200) {
      const key = keys[Math.floor(rand() * keys.length)]!;
      if (s.update(key, now)) spoken.set(key, [...(spoken.get(key) ?? []), now]);
    }
    expect(spoken.size).toBeGreaterThan(1);
    for (const times of spoken.values()) for (let i = 1; i < times.length; i++) expect(times[i]! - times[i - 1]!).toBeGreaterThanOrEqual(2500);
  });

  it('speaks a cue only once it is stable, and waits after another cue', () => {
    const s = new GuidanceSpeaker({ stableMs: 500, minGapMs: 2000, repeatMs: 4000 });
    expect(s.update('TOO_DARK', 0)).toBe(false);
    expect(s.update('TOO_DARK', 600)).toBe(true);
    expect(s.update('TOO_DARK', 900)).toBe(false);
    expect(s.update('CUT:left', 1000)).toBe(false);
    expect(s.update('CUT:left', 1600)).toBe(false); // within the 2 s gap
    expect(s.update('CUT:left', 2700)).toBe(true);
    expect(s.update('CUT:left', 5000)).toBe(false); // repeats no sooner than 4 s
    expect(s.update('CUT:left', 6800)).toBe(true);
    // The go-ahead is not held back by the gap.
    expect(s.update('OK', 6900)).toBe(false);
    expect(s.update('OK', 7500)).toBe(true);
  });

  it('says "I can\'t see the item yet" after a few seconds, and the surface tip only once', () => {
    const coach = new GuidanceCoach();
    const said: { at: number; text: string }[] = [];
    for (let now = 0; now <= 30_000; now += 200) {
      const text = coach.update(fake('NOTHING'), 'item', now);
      if (text) said.push({ at: now, text });
    }
    expect(said[0]!.at).toBeGreaterThanOrEqual(3000);
    expect(said[0]!.at).toBeLessThan(4000);
    expect(said[0]!.text).toContain('A plain, light surface under it helps.');
    expect(said.length).toBeGreaterThan(1);
    for (const s of said.slice(1)) expect(s.text).toBe("I can't see the item yet. Hold the phone about an arm's length above it.");
    for (let i = 1; i < said.length; i++) expect(said[i]!.at - said[i - 1]!.at).toBeGreaterThanOrEqual(2500);

    // A brief flicker of nothing does not trigger it.
    const quick = new GuidanceCoach();
    let spoke = false;
    for (let now = 0; now < 2000; now += 200) spoke = Boolean(quick.update(fake('NOTHING'), 'item', now)) || spoke;
    expect(spoke).toBe(false);

    // The tip is not repeated for "can't tell", and not after a new shot.
    coach.reset();
    const later: string[] = [];
    for (let now = 40_000; now <= 60_000; now += 200) {
      const text = coach.update(fake('UNSURE'), 'item', now);
      if (text) later.push(text);
    }
    expect(later.length).toBeGreaterThan(0);
    for (const t of later) expect(t).not.toContain('surface');
  });

  it('keys cues by what is said', () => {
    expect(cueKey(fake('CUT', ['left', 'top']))).toBe('CUT:left+top');
    expect(cueKey(fake('OK'))).toBe('OK');
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
