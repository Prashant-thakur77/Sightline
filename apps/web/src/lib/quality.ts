/**
 * Live framing checks that run in the browser on downscaled camera frames (about 160 px wide).
 * They mirror the vision service's quality gate so guidance is instant; the server re-checks
 * every captured photo.
 */

export type GuidanceCode = 'TOO_DARK' | 'TOO_BRIGHT' | 'BLURRY' | 'GLARE' | 'TOO_FAR' | 'TOO_CLOSE' | 'OK';

export interface FrameStats {
  luminance: number; // 0..255 mean
  sharpness: number; // variance of Laplacian
  glare: number; // fraction of near-white, low-saturation pixels
  coverage: number; // fraction of pixels that differ from the border colour
  clippedDark: number; // fraction below 12
}

export interface Thresholds {
  minLuminance: number;
  maxLuminance: number;
  minSharpness: number;
  maxGlare: number;
  minCoverage: number;
  maxCoverage: number;
}

export const DEFAULT_THRESHOLDS: Thresholds = {
  minLuminance: 55,
  maxLuminance: 235,
  minSharpness: 40,
  maxGlare: 0.06,
  minCoverage: 0.18,
  maxCoverage: 0.92,
};

export const GUIDANCE_TEXT: Record<GuidanceCode, string> = {
  TOO_DARK: 'Too dark. Can you turn on a light?',
  TOO_BRIGHT: 'Too bright. Move out of direct light a little.',
  BLURRY: 'Hold still for a moment.',
  GLARE: "There's a glare. Tilt the phone a little.",
  TOO_FAR: 'Move the phone closer.',
  TOO_CLOSE: 'Move the phone back a little.',
  OK: 'Hold still, capturing.',
};

/** Compute stats from RGBA pixels (like ImageData.data). */
export function frameStats(rgba: Uint8ClampedArray | Uint8Array, width: number, height: number): FrameStats {
  const n = width * height;
  const gray = new Float32Array(n);
  let sum = 0;
  let glare = 0;
  let dark = 0;
  for (let i = 0; i < n; i++) {
    const r = rgba[i * 4]!;
    const g = rgba[i * 4 + 1]!;
    const b = rgba[i * 4 + 2]!;
    const y = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    gray[i] = y;
    sum += y;
    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    if (y > 245 && max - min < 18) glare++;
    if (y < 12) dark++;
  }
  // Variance of a 4-neighbour Laplacian over the interior.
  let lsum = 0;
  let lsq = 0;
  let count = 0;
  for (let y = 1; y < height - 1; y++) {
    for (let x = 1; x < width - 1; x++) {
      const i = y * width + x;
      const lap = gray[i - 1]! + gray[i + 1]! + gray[i - width]! + gray[i + width]! - 4 * gray[i]!;
      lsum += lap;
      lsq += lap * lap;
      count++;
    }
  }
  const mean = count ? lsum / count : 0;
  const sharpness = count ? lsq / count - mean * mean : 0;
  // Border colour estimate: mean of the outer 6% ring.
  const ring = Math.max(1, Math.round(Math.min(width, height) * 0.06));
  let br = 0;
  let bg = 0;
  let bb = 0;
  let bn = 0;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (x >= ring && x < width - ring && y >= ring && y < height - ring) continue;
      const i = (y * width + x) * 4;
      br += rgba[i]!;
      bg += rgba[i + 1]!;
      bb += rgba[i + 2]!;
      bn++;
    }
  }
  br /= bn;
  bg /= bn;
  bb /= bn;
  let fg = 0;
  for (let i = 0; i < n; i++) {
    const d = Math.abs(rgba[i * 4]! - br) + Math.abs(rgba[i * 4 + 1]! - bg) + Math.abs(rgba[i * 4 + 2]! - bb);
    if (d > 60) fg++;
  }
  return { luminance: sum / n, sharpness, glare: glare / n, coverage: fg / n, clippedDark: dark / n };
}

/** Order matters: light first (nothing else is reliable in the dark), then glare, framing, blur. */
export function guidanceFor(s: FrameStats, t: Thresholds = DEFAULT_THRESHOLDS): GuidanceCode {
  if (s.luminance < t.minLuminance) return 'TOO_DARK';
  if (s.luminance > t.maxLuminance) return 'TOO_BRIGHT';
  if (s.glare > t.maxGlare) return 'GLARE';
  if (s.coverage < t.minCoverage) return 'TOO_FAR';
  if (s.coverage > t.maxCoverage) return 'TOO_CLOSE';
  if (s.sharpness < t.minSharpness) return 'BLURRY';
  return 'OK';
}

/**
 * Decides when to speak. Guidance is only spoken when it changes and has been stable for a
 * moment, and never more often than `minGapMs`, so the user is not talked over.
 */
export class GuidanceSpeaker {
  private current: GuidanceCode | null = null;
  private candidate: GuidanceCode | null = null;
  private candidateSince = 0;
  private lastSpokenAt = -Infinity;

  constructor(
    private readonly stableMs = 700,
    private readonly minGapMs = 2200,
  ) {}

  /** Returns the code to speak now, or null. */
  update(code: GuidanceCode, now: number): GuidanceCode | null {
    if (code !== this.candidate) {
      this.candidate = code;
      this.candidateSince = now;
      return null;
    }
    if (code === this.current) return null;
    if (now - this.candidateSince < this.stableMs) return null;
    if (now - this.lastSpokenAt < this.minGapMs && code !== 'OK') return null;
    this.current = code;
    this.lastSpokenAt = now;
    return code;
  }

  reset(): void {
    this.current = null;
    this.candidate = null;
    this.candidateSince = 0;
    this.lastSpokenAt = -Infinity;
  }
}

/** Auto-capture once framing has been OK for `holdMs`. */
export class AutoCapture {
  private okSince: number | null = null;
  constructor(private readonly holdMs = 1100) {}
  update(code: GuidanceCode, now: number): boolean {
    if (code !== 'OK') {
      this.okSince = null;
      return false;
    }
    if (this.okSince === null) this.okSince = now;
    if (now - this.okSince >= this.holdMs) {
      this.okSince = null;
      return true;
    }
    return false;
  }
  /** 0..1 progress for haptic ticks and the visual ring. */
  progress(now: number): number {
    return this.okSince === null ? 0 : Math.min(1, (now - this.okSince) / this.holdMs);
  }
}
