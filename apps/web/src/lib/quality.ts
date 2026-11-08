/**
 * Live framing checks that run in the browser on downscaled camera frames (about 160 × 120),
 * about five times a second, so they stay cheap: one pass over the pixels, one pass for edges,
 * then all the reasoning happens on a coarse grid of about 20 × 15 cells. The vision service
 * re-checks every captured photo; nothing here calls it.
 *
 * Finding the item. The outer ring of cells is the model of the surface: its median colour (in
 * CIELAB, so dark colours are not squashed together), a lightness slope for light fall-off across
 * a bed or table, and how much edge detail the surface itself has. A cell belongs to the item when
 * its colour differs from that model by clearly more than the surface's own spread, or when its
 * edge detail differs clearly from the surface's. So a navy sweater on a dark bedspread still shows
 * up through its colour, its knit and its outline, where a plain colour test misses it. Connected
 * cells make the item; its box gives the direction cues. Cells hugging only the frame edge are a
 * sliver, said as "something is at the edge" rather than guessed to be the item. When the surface
 * is patterned or only part of the item stands out, it says it can't tell instead of guessing.
 *
 * Blur is judged by how abrupt the item's edges are, across and down separately, so faint but
 * sharp edges pass. The size tag also needs strong fine detail and text-like contrast inside it.
 */

export type ShotMode = 'item' | 'label' | 'detail';
export type Edge = 'left' | 'right' | 'top' | 'bottom';
export type Confidence = 'sure' | 'fairly sure' | 'not sure';

export type GuidanceCode =
  | 'TOO_DARK'
  | 'TOO_BRIGHT'
  | 'GLARE'
  /** Nothing stands out from the surface. */
  | 'NOTHING'
  /** Something is there, but it can't be told apart from the surface well enough to guide. */
  | 'UNSURE'
  /** Only a sliver at the frame edge. */
  | 'EDGE_ONLY'
  /** The item touches one edge, or two edges at a corner. */
  | 'CUT'
  | 'TOO_CLOSE'
  | 'TOO_FAR'
  | 'BLURRY'
  /** Size tag: in view and sharp, but nothing that looks like writing yet. */
  | 'UNREADABLE'
  | 'OK';

/** Fractions of the frame, 0..1, left/top inclusive. */
export interface Box {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

export interface ItemEstimate {
  box: Box | null;
  /** Box area as a fraction of the frame. */
  area: number;
  /** Frame edges the item touches, most contact first. */
  edges: Edge[];
  centred: boolean;
  confidence: Confidence;
}

export interface FrameAnalysis {
  code: GuidanceCode;
  /** Edges for CUT and EDGE_ONLY; empty otherwise. */
  edges: Edge[];
  item: ItemEstimate;
  luminance: number; // 0..255 mean
  sharpness: number; // variance of the Laplacian over the item's box (the whole frame without one)
  glare: number; // share of near-white, low-saturation pixels
  /** Share of text-like cells inside the item's box: the size tag's readability proxy. */
  text: number;
  /** Lightness of the surface, used to suggest a contrasting one. */
  surface: 'light' | 'dark';
}

export interface Thresholds {
  minLuminance: number;
  maxLuminance: number;
  maxGlare: number;
  /** Edge crispness (second-to-first difference ratio on edges) below which a frame is smeared:
   * about 1 for a one-pixel step, 1/2 for a two-pixel ramp, 1/3 for three. */
  minCrispness: number;
  /** The tag's writing also needs strong fine detail (variance of the Laplacian). */
  minLabelSharpness: number;
  /** Smallest colour difference (ΔE, lightness weighted down) that counts as the item. */
  minColourDelta: number;
  /** Smallest change in mean edge strength that counts as the item. */
  minTextureDelta: number;
  /** Surface colour spread (ΔE) above which the background is too busy to separate. */
  busySpread: number;
  minItemArea: number;
  minLabelArea: number;
  /** Share of the frame's border on the item above which the item fills the view. */
  maxBorderShare: number;
  minTextShare: number;
  minTextCells: number;
  centreTolerance: number;
}

export const DEFAULT_THRESHOLDS: Thresholds = {
  // The server's limit is lower; being stricter here only nags in dark-on-dark scenes.
  minLuminance: 45,
  maxLuminance: 235,
  maxGlare: 0.06,
  minCrispness: 0.35,
  minLabelSharpness: 150,
  minColourDelta: 8,
  minTextureDelta: 8,
  busySpread: 10,
  minItemArea: 0.1,
  minLabelArea: 0.12,
  maxBorderShare: 0.45,
  minTextShare: 0.15,
  minTextCells: 3,
  centreTolerance: 0.15,
};

/** A cell this far past its threshold is a clear difference; weaker ones count only next to one. */
const SEED = 1.6;
/** Edge pixels for the crispness ratio: a step this strong (0..255 luma) at normal exposure. */
const AXIS_EDGE_STEP = 16;
/** Fewer edge pixels than this in a direction: too little to judge blur that way. */
const MIN_EDGE_PIXELS = 24;
/** This many separate crossings of the frame edge means a patterned surface, not an item. */
const PATTERN_RUNS = 4;
/** Cells within this many cells of the frame edge, and nowhere else, are a sliver. */
const STRIP_CELLS = 2;
/** Lightness counts for less than colour: shadows and light fall-off change lightness most. */
const KL = 1.5;
/** A pixel step this strong (central difference on 0..255 luma) counts as an edge pixel. */
const EDGE_STEP = 32;

function toLinear(c: number): number {
  const v = c / 255;
  return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
}

function labF(v: number): number {
  return v > 0.008856 ? Math.cbrt(v) : 7.787 * v + 16 / 116;
}

/** sRGB 0..255 to CIELAB (D65). */
export function toLab(r: number, g: number, b: number): [number, number, number] {
  const R = toLinear(r);
  const G = toLinear(g);
  const B = toLinear(b);
  const fx = labF((0.4124 * R + 0.3576 * G + 0.1805 * B) / 0.95047);
  const fy = labF(0.2126 * R + 0.7152 * G + 0.0722 * B);
  const fz = labF((0.0193 * R + 0.1192 * G + 0.9505 * B) / 1.08883);
  return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)];
}

function median(values: number[]): number {
  if (!values.length) return 0;
  const s = [...values].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
}

/** Solves A·x = b by Gaussian elimination; null when singular. */
function solve(A: number[][], b: number[]): number[] | null {
  const n = b.length;
  const M = A.map((row, i) => [...row, b[i]!]);
  for (let col = 0; col < n; col++) {
    let piv = col;
    for (let r = col + 1; r < n; r++) if (Math.abs(M[r]![col]!) > Math.abs(M[piv]![col]!)) piv = r;
    if (Math.abs(M[piv]![col]!) < 1e-9) return null;
    [M[col], M[piv]] = [M[piv]!, M[col]!];
    for (let r = 0; r < n; r++) {
      if (r === col) continue;
      const f = M[r]![col]! / M[col]![col]!;
      for (let k = col; k <= n; k++) M[r]![k]! -= f * M[col]![k]!;
    }
  }
  return M.map((row, i) => row[n]! / row[i]!);
}

type Terms = (u: number, v: number) => number[];
const QUADRATIC: Terms = (u, v) => [1, u, v, u * u, v * v, u * v];
const PLANE: Terms = (u, v) => [1, u, v];

/**
 * Least-squares lightness surface over the frame from the border cells: quadratic (a lamp's
 * hotspot, fall-off towards the corners) when there are enough points, else a plane, else flat.
 * Kept within the border's own range so it never invents a surface far lighter or darker.
 */
function fitSurface(us: number[], vs: number[], ls: number[]): (u: number, v: number) => number {
  const lo = Math.min(...ls);
  const hi = Math.max(...ls);
  for (const [minPoints, terms] of [
    [16, QUADRATIC],
    [8, PLANE],
  ] as const) {
    if (ls.length < minPoints) continue;
    const k = terms(0, 0).length;
    const AtA = Array.from({ length: k }, () => new Array<number>(k).fill(0));
    const Atb = new Array<number>(k).fill(0);
    for (let i = 0; i < ls.length; i++) {
      const row = terms(us[i]!, vs[i]!);
      for (let r = 0; r < k; r++) {
        Atb[r]! += row[r]! * ls[i]!;
        for (let c = 0; c < k; c++) AtA[r]![c]! += row[r]! * row[c]!;
      }
    }
    const p = solve(AtA, Atb);
    if (p) return (u, v) => Math.min(hi + 5, Math.max(lo - 5, terms(u, v).reduce((sum, x, i) => sum + x * p[i]!, 0)));
  }
  const mean = ls.length ? ls.reduce((sum, x) => sum + x, 0) / ls.length : 50;
  return () => mean;
}

interface Component {
  cells: number[];
  /** Lies wholly within STRIP_CELLS of the frame edge. */
  strip: boolean;
}

/** 8-connected groups of set cells, largest first. */
function components(mask: Uint8Array, gw: number, gh: number): Component[] {
  const seen = new Uint8Array(mask.length);
  const out: Component[] = [];
  for (let s = 0; s < mask.length; s++) {
    if (!mask[s] || seen[s]) continue;
    const cells: number[] = [];
    const stack = [s];
    seen[s] = 1;
    let strip = true;
    while (stack.length) {
      const c = stack.pop()!;
      cells.push(c);
      const cx = c % gw;
      const cy = (c / gw) | 0;
      if (cx >= STRIP_CELLS && cy >= STRIP_CELLS && cx < gw - STRIP_CELLS && cy < gh - STRIP_CELLS) strip = false;
      for (let dy = -1; dy <= 1; dy++)
        for (let dx = -1; dx <= 1; dx++) {
          const nx = cx + dx;
          const ny = cy + dy;
          if (nx < 0 || ny < 0 || nx >= gw || ny >= gh) continue;
          const nc = ny * gw + nx;
          if (mask[nc] && !seen[nc]) {
            seen[nc] = 1;
            stack.push(nc);
          }
        }
    }
    out.push({ cells, strip });
  }
  return out.sort((a, b) => b.cells.length - a.cells.length);
}

const NO_ITEM: ItemEstimate = { box: null, area: 0, edges: [], centred: false, confidence: 'not sure' };

/** Analyse one RGBA frame (like ImageData.data) for the given shot. */
export function analyzeFrame(
  rgba: Uint8ClampedArray | Uint8Array,
  width: number,
  height: number,
  mode: ShotMode = 'item',
  t: Thresholds = DEFAULT_THRESHOLDS,
): FrameAnalysis {
  const n = width * height;
  const cs = Math.max(2, Math.round(Math.min(width, height) / 15));
  const gw = Math.ceil(width / cs);
  const gh = Math.ceil(height / cs);
  const gn = gw * gh;

  // Pass 1: luma, glare, and per-cell colour sums and luma range.
  const gray = new Float32Array(n);
  const sR = new Float32Array(gn);
  const sG = new Float32Array(gn);
  const sB = new Float32Array(gn);
  const cnt = new Float32Array(gn);
  const lo = new Float32Array(gn).fill(255);
  const hi = new Float32Array(gn);
  let sum = 0;
  let glare = 0;
  for (let y = 0; y < height; y++) {
    const row = ((y / cs) | 0) * gw;
    for (let x = 0; x < width; x++) {
      const i = y * width + x;
      const p = i * 4;
      const r = rgba[p]!;
      const g = rgba[p + 1]!;
      const b = rgba[p + 2]!;
      const yv = 0.2126 * r + 0.7152 * g + 0.0722 * b;
      gray[i] = yv;
      sum += yv;
      if (yv > 245 && Math.max(r, g, b) - Math.min(r, g, b) < 18) glare++;
      const c = row + ((x / cs) | 0);
      sR[c]! += r;
      sG[c]! += g;
      sB[c]! += b;
      cnt[c]!++;
      if (yv < lo[c]!) lo[c] = yv;
      if (yv > hi[c]!) hi[c] = yv;
    }
  }
  const luminance = n ? sum / n : 0;
  // Brighten a dim frame to a normal exposure first, as a camera's auto-exposure would, so colour
  // and edge differences are judged the same way in a dim room as in daylight.
  const gain = luminance > 0 && luminance < 110 ? Math.min(2.5, 110 / luminance) : 1;
  const edgeStep = EDGE_STEP / gain;

  // Pass 2: edge strength, edge pixels and the Laplacian, per cell.
  const texSum = new Float32Array(gn);
  const edgePx = new Float32Array(gn);
  const lapS = new Float64Array(gn);
  const lapQ = new Float64Array(gn);
  const gN = new Float32Array(gn);
  // On edge pixels only, across and down separately: how abrupt the edges are, whatever their
  // contrast (see `crisp` below).
  const xLap = new Float32Array(gn);
  const xGrad = new Float32Array(gn);
  const xN = new Float32Array(gn);
  const yLap = new Float32Array(gn);
  const yGrad = new Float32Array(gn);
  const yN = new Float32Array(gn);
  const axisStep = AXIS_EDGE_STEP / gain;
  for (let y = 1; y < height - 1; y++) {
    const row = ((y / cs) | 0) * gw;
    for (let x = 1; x < width - 1; x++) {
      const i = y * width + x;
      const l = gray[i - 1]!;
      const r = gray[i + 1]!;
      const u = gray[i - width]!;
      const d = gray[i + width]!;
      const mag = Math.abs(r - l) + Math.abs(d - u);
      const lap = l + r + u + d - 4 * gray[i]!;
      const c = row + ((x / cs) | 0);
      texSum[c]! += mag;
      if (mag >= edgeStep) edgePx[c]!++;
      lapS[c]! += lap;
      lapQ[c]! += lap * lap;
      gN[c]!++;
      const m = gray[i]!;
      if (Math.abs(r - l) >= axisStep) {
        xLap[c]! += Math.abs(l + r - 2 * m);
        xGrad[c]! += Math.abs(r - l);
        xN[c]!++;
      }
      if (Math.abs(d - u) >= axisStep) {
        yLap[c]! += Math.abs(u + d - 2 * m);
        yGrad[c]! += Math.abs(d - u);
        yN[c]!++;
      }
    }
  }

  // Cell features.
  const L = new Float32Array(gn);
  const A = new Float32Array(gn);
  const B = new Float32Array(gn);
  const tex = new Float32Array(gn);
  for (let c = 0; c < gn; c++) {
    const k = (cnt[c] || 1) / gain;
    const [l, a, b] = toLab(Math.min(255, sR[c]! / k), Math.min(255, sG[c]! / k), Math.min(255, sB[c]! / k));
    L[c] = l;
    A[c] = a;
    B[c] = b;
    tex[c] = gN[c] ? (gain * texSum[c]!) / gN[c]! : 0;
  }
  const cu = (c: number) => ((c % gw) + 0.5) / gw - 0.5;
  const cv = (c: number) => (((c / gw) | 0) + 0.5) / gh - 0.5;

  // Surface model from the outer ring of cells, ignoring ring cells that are clearly not surface.
  // The ring in order round the frame: top, right, bottom, left.
  const ring: number[] = [];
  for (let cx = 0; cx < gw; cx++) ring.push(cx);
  for (let cy = 1; cy < gh; cy++) ring.push(cy * gw + gw - 1);
  for (let cx = gw - 2; cx >= 0; cx--) ring.push((gh - 1) * gw + cx);
  for (let cy = gh - 2; cy >= 1; cy--) ring.push(cy * gw);
  const mL = median(ring.map((c) => L[c]!));
  const mA = median(ring.map((c) => A[c]!));
  const mB = median(ring.map((c) => B[c]!));
  const dist = (dl: number, da: number, db: number) => Math.sqrt((dl / KL) ** 2 + da * da + db * db);
  const d0 = ring.map((c) => dist(L[c]! - mL, A[c]! - mA, B[c]! - mB));
  const keep = Math.max(6, 2.5 * median(d0));
  const inl = ring.filter((_, k) => d0[k]! <= keep);
  const lightAt = fitSurface(
    inl.map(cu),
    inl.map(cv),
    inl.map((c) => L[c]!),
  );
  const bgA = inl.reduce((s, c) => s + A[c]!, 0) / (inl.length || 1);
  const bgB = inl.reduce((s, c) => s + B[c]!, 0) / (inl.length || 1);
  const colourDelta = (c: number) => dist(L[c]! - lightAt(cu(c), cv(c)), A[c]! - bgA, B[c]! - bgB);
  const spread = median(inl.map(colourDelta));
  const texBg = median(inl.map((c) => tex[c]!));
  const texMad = median(inl.map((c) => Math.abs(tex[c]! - texBg)));
  const tC = Math.max(t.minColourDelta, 3 * spread);
  const tT = Math.max(t.minTextureDelta, 3 * texMad, 0.75 * texBg);

  const score = new Float32Array(gn);
  const fg = new Uint8Array(gn);
  for (let c = 0; c < gn; c++) {
    score[c] = Math.max(colourDelta(c) / tC, Math.abs(tex[c]! - texBg) / tT);
    if (score[c]! >= 1) fg[c] = 1;
  }
  const borderShare = ring.filter((c) => fg[c]).length / ring.length;

  // Item cells: clear differences ("seeds"), plus weaker cells right next to one. Weak cells away
  // from any seed, like stripes in the bedding or light fall-off at an edge, are left out.
  const near = new Uint8Array(gn);
  let seeds = 0;
  for (let c = 0; c < gn; c++) {
    if (score[c]! < SEED) continue;
    near[c] = 1;
    seeds++;
  }
  for (let c = 0; c < gn; c++) {
    if (!fg[c] || near[c]) continue;
    const cx = c % gw;
    const cy = (c / gw) | 0;
    for (let dy = -1; dy <= 1 && !near[c]; dy++)
      for (let dx = -1; dx <= 1; dx++) {
        const nx = cx + dx;
        const ny = cy + dy;
        if (nx >= 0 && ny >= 0 && nx < gw && ny < gh && score[ny * gw + nx]! >= SEED) {
          near[c] = 1;
          break;
        }
      }
  }
  // Separate runs of clear differences round the edge: an item crosses the edge in one or two
  // places, while stripes, spots and florals cross it again and again.
  let runs = 0;
  for (let k = 0; k < ring.length; k++) if (near[ring[k]!] && !near[ring[(k + ring.length - 1) % ring.length]!]) runs++;
  const patterned = runs >= PATTERN_RUNS;
  const comps = components(near, gw, gh).filter((c) => c.cells.length >= 2);
  const inner = comps.filter((c) => !c.strip);
  let itemCells: number[] = [];
  let stripOnly = false;
  if (inner.length) {
    const main = inner[0]!.cells.length;
    for (const comp of inner) if (comp.cells.length >= 0.25 * main) itemCells.push(...comp.cells);
  } else if (comps[0] && comps[0].cells.length >= 3) {
    itemCells = comps[0].cells;
    stripOnly = true;
  }
  // No clear item, but a faint patch: that is "can't tell", not "nothing there".
  const faint = !itemCells.length && components(fg, gw, gh).some((c) => c.cells.length >= 4);
  // The item's cells, and the same grown by one cell all round.
  const inItem = new Uint8Array(gn);
  const nearItem = new Uint8Array(gn);
  for (const c of itemCells) {
    inItem[c] = 1;
    const cx = c % gw;
    const cy = (c / gw) | 0;
    for (let dy = -1; dy <= 1; dy++)
      for (let dx = -1; dx <= 1; dx++) {
        const nx = cx + dx;
        const ny = cy + dy;
        if (nx >= 0 && ny >= 0 && nx < gw && ny < gh) nearItem[ny * gw + nx] = 1;
      }
  }

  let item: ItemEstimate = NO_ITEM;
  let bx0 = 0;
  let by0 = 0;
  let bx1 = gw - 1;
  let by1 = gh - 1;
  if (itemCells.length) {
    bx0 = gw;
    by0 = gh;
    bx1 = -1;
    by1 = -1;
    const contact: Record<Edge, number> = { left: 0, right: 0, top: 0, bottom: 0 };
    for (const c of itemCells) {
      const cx = c % gw;
      const cy = (c / gw) | 0;
      bx0 = Math.min(bx0, cx);
      by0 = Math.min(by0, cy);
      bx1 = Math.max(bx1, cx);
      by1 = Math.max(by1, cy);
      // Only clear cells count as touching an edge: a faint stripe or shadow running from the
      // item to the edge doesn't mean the item is cut off.
      if (score[c]! < SEED) continue;
      if (cx === 0) contact.left++;
      if (cx === gw - 1) contact.right++;
      if (cy === 0) contact.top++;
      if (cy === gh - 1) contact.bottom++;
    }
    const box: Box = {
      x0: (bx0 * cs) / width,
      y0: (by0 * cs) / height,
      x1: Math.min(width, (bx1 + 1) * cs) / width,
      y1: Math.min(height, (by1 + 1) * cs) / height,
    };
    const edges = (Object.keys(contact) as Edge[]).filter((e) => contact[e] > 0).sort((a, b) => contact[b] - contact[a]);
    const strength = median(itemCells.map((c) => score[c]!));
    // Clear differences elsewhere in the frame too: other things compete with the item.
    const itemSeeds = itemCells.filter((c) => score[c]! >= SEED).length;
    const fragmented = seeds >= 6 && itemSeeds / seeds < 0.6;
    // The clear part sits inside a faint patch (most cells round it differ a little): only part of
    // the item stands out, so its real outline is unknown.
    let around = 0;
    let aroundFaint = 0;
    for (let c = 0; c < gn; c++) {
      if (!nearItem[c] || inItem[c]) continue;
      around++;
      if (fg[c]) aroundFaint++;
    }
    const partial = around > 0 && aroundFaint / around >= 0.5;
    // On a patterned surface the pattern also touches the edges, so edge contact can't be trusted.
    const confidence: Confidence =
      spread > t.busySpread || fragmented || partial || strength < 1.3 || (patterned && edges.length)
        ? 'not sure'
        : strength < 1.8 || patterned
          ? 'fairly sure'
          : 'sure';
    item = {
      box,
      area: (box.x1 - box.x0) * (box.y1 - box.y0),
      edges,
      centred: Math.abs((box.x0 + box.x1) / 2 - 0.5) <= t.centreTolerance && Math.abs((box.y0 + box.y1) / 2 - 0.5) <= t.centreTolerance,
      confidence,
    };
  }

  // Sharpness over the item's box plus one cell, so a plain surface doesn't read as blur.
  // Scaled as if the frame were normally exposed, like the colours.
  let ls = 0;
  let lq = 0;
  let lk = 0;
  const ax = { lap: 0, grad: 0, n: 0 };
  const ay = { lap: 0, grad: 0, n: 0 };
  for (let cy = Math.max(0, by0 - 1); cy <= Math.min(gh - 1, by1 + 1); cy++)
    for (let cx = Math.max(0, bx0 - 1); cx <= Math.min(gw - 1, bx1 + 1); cx++) {
      const c = cy * gw + cx;
      ls += lapS[c]!;
      lq += lapQ[c]!;
      lk += gN[c]!;
      // Crispness only on the item and the cells round it, not a soft rug or wood grain behind it.
      if (itemCells.length && !nearItem[c]) continue;
      ax.lap += xLap[c]!;
      ax.grad += xGrad[c]!;
      ax.n += xN[c]!;
      ay.lap += yLap[c]!;
      ay.grad += yGrad[c]!;
      ay.n += yN[c]!;
    }
  const sharpness = lk ? (lq / lk - (ls / lk) ** 2) * gain * gain : 0;
  // A sharp edge changes within a pixel, so its second difference is about as strong as its first;
  // a blurred edge spreads over several pixels and the ratio falls. Across and down are judged
  // apart, because shake smears one way. This doesn't depend on contrast, so a sharp navy sweater
  // on a dark bedspread isn't taken for blur. Too few edges to judge counts as sharp.
  const crispness = (a: { lap: number; grad: number; n: number }) => (a.n >= MIN_EDGE_PIXELS && a.grad > 0 ? a.lap / a.grad : 1);
  const crisp = Math.min(crispness(ax), crispness(ay));

  // Readability proxy for the size tag: cells inside the box (not on its rim) with strong
  // light-dark contrast and many edge pixels, like printed or woven writing.
  let textCells = 0;
  let textArea = 0;
  if (item.box) {
    const ix0 = bx1 - bx0 >= 2 ? bx0 + 1 : bx0;
    const ix1 = bx1 - bx0 >= 2 ? bx1 - 1 : bx1;
    const iy0 = by1 - by0 >= 2 ? by0 + 1 : by0;
    const iy1 = by1 - by0 >= 2 ? by1 - 1 : by1;
    for (let cy = iy0; cy <= iy1; cy++)
      for (let cx = ix0; cx <= ix1; cx++) {
        const c = cy * gw + cx;
        textArea++;
        if (gain * (hi[c]! - lo[c]!) >= 80 && gN[c]! > 0 && edgePx[c]! / gN[c]! >= 0.12) textCells++;
      }
  }
  const text = textArea ? textCells / textArea : 0;

  const result = (code: GuidanceCode, edges: Edge[] = []): FrameAnalysis => ({
    code,
    edges,
    item,
    luminance,
    sharpness,
    glare: n ? glare / n : 0,
    text,
    surface: lightAt(0, 0) < 50 ? 'dark' : 'light',
  });

  // Light first (nothing else is reliable in the dark), then glare, then framing, then blur.
  if (luminance < t.minLuminance) return result('TOO_DARK');
  if (luminance > t.maxLuminance) return result('TOO_BRIGHT');
  if (n && glare / n > t.maxGlare) return result('GLARE');
  if (mode === 'detail') return result(crisp < t.minCrispness ? 'BLURRY' : 'OK');
  if (!item.box) return result(spread > t.busySpread || faint || patterned ? 'UNSURE' : 'NOTHING');
  if (borderShare > t.maxBorderShare) return result('TOO_CLOSE');
  if (item.confidence === 'not sure') return result('UNSURE');
  if (stripOnly) return result('EDGE_ONLY', item.edges);
  const e = item.edges;
  if (e.length >= 3 || (e.includes('left') && e.includes('right')) || (e.includes('top') && e.includes('bottom'))) return result('TOO_CLOSE');
  if (e.length) return result('CUT', e);
  // Small and only fairly sure is more often a faint item showing a sliver of detail than a far one.
  if (item.area < (mode === 'label' ? t.minLabelArea : t.minItemArea)) return result(item.confidence === 'sure' ? 'TOO_FAR' : 'UNSURE');
  // Writing also needs strong fine detail, so the tag must pass the Laplacian test too.
  if (crisp < t.minCrispness || (mode === 'label' && sharpness < t.minLabelSharpness)) return result('BLURRY');
  if (mode === 'label' && (textCells < t.minTextCells || text < t.minTextShare)) return result('UNREADABLE');
  return result('OK');
}

/** What the camera should be called for each shot. */
export function modeForShot(kind: 'item' | 'label' | 'damage'): ShotMode {
  return kind === 'item' ? 'item' : kind === 'label' ? 'label' : 'detail';
}

/** Stable identity of a cue: the same key is the same thing said. */
export function cueKey(a: Pick<FrameAnalysis, 'code' | 'edges'>): string {
  return a.edges.length ? `${a.code}:${a.edges.join('+')}` : a.code;
}

const MIRROR: Record<Edge, Edge> = { left: 'right', right: 'left', top: 'top', bottom: 'bottom' };
const WHERE: Record<Edge, string> = { left: 'on the left', right: 'on the right', top: 'at the top', bottom: 'at the bottom' };
const EDGE_NAME: Record<Edge, string> = { left: 'left edge', right: 'right edge', top: 'top edge', bottom: 'bottom edge' };
const MOVE: Record<Edge, string> = { left: 'move the phone left', right: 'move the phone right', top: 'tilt the phone up', bottom: 'tilt the phone down' };
const MOVE_IT: Record<Edge, string> = { left: 'move it left', right: 'move it right', top: 'tilt it up', bottom: 'tilt it down' };
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

export interface CueOptions {
  /** Add the one-time tip about a contrasting surface. */
  tip?: boolean;
  /** Front camera: the picture is the other way round from the person, so left and right swap. */
  mirrored?: boolean;
}

/** The words for a cue. Short sentences, each one says what to do next. */
export function cueText(a: Pick<FrameAnalysis, 'code' | 'edges' | 'item' | 'surface'>, mode: ShotMode, opts: CueOptions = {}): string {
  const thing = mode === 'label' ? 'tag' : 'item';
  const edges = opts.mirrored ? a.edges.map((e) => MIRROR[e]) : a.edges;
  const surfaceTip = `A plain, ${a.surface === 'dark' ? 'light' : 'dark'} surface under it helps.`;
  switch (a.code) {
    case 'TOO_DARK':
      return 'Too dark. Can you turn on a light?';
    case 'TOO_BRIGHT':
      return 'Too bright. Move out of direct light a little.';
    case 'GLARE':
      return "There's a glare. Tilt the phone a little.";
    case 'NOTHING':
      if (mode === 'label') return "I can't see the tag yet. Hold it about a hand's width from the phone.";
      return `I can't see the item yet. Hold the phone about an arm's length above it.${opts.tip ? ` ${surfaceTip}` : ''}`;
    case 'UNSURE':
      if (mode === 'label') return "I can't tell the tag from what's behind it. Hold it flat, about a hand's width from the phone.";
      return `I can't tell the item from the background. ${opts.tip ? surfaceTip : 'You can press Capture now to take the photo anyway.'}`;
    case 'EDGE_ONLY': {
      const e = edges[0] ?? 'left';
      return `Something is at the ${EDGE_NAME[e]}. If it's the ${thing}, ${MOVE[e]}.`;
    }
    case 'CUT': {
      const [e1 = 'left', e2] = edges;
      const verb = a.item.confidence === 'sure' ? 'is' : 'seems';
      const where = e2 ? `${WHERE[e1]} and ${WHERE[e2]}` : WHERE[e1];
      const move = e2 ? `${cap(MOVE[e1])} and ${MOVE_IT[e2]}` : cap(MOVE[e1]);
      return `The ${thing} ${verb} cut off ${where}. ${move}.`;
    }
    case 'TOO_CLOSE':
      return mode === 'label'
        ? 'The tag goes past the edges. Move it a little further from the phone.'
        : 'The item goes past the edges. Move the phone back a little.';
    case 'TOO_FAR':
      return mode === 'label' ? 'The tag looks small. Bring it a little closer to the phone.' : 'The item looks small. Move the phone a little closer.';
    case 'BLURRY':
      return mode === 'label' ? 'The tag is blurry. Hold still. If it stays blurry, move it a little further away.' : 'Hold still for a moment.';
    case 'UNREADABLE':
      return "I can't make out the writing yet. Hold the tag flat and still.";
    case 'OK':
      if (mode === 'label') return 'The writing looks clear. Hold still.';
      if (mode === 'detail') return 'Hold still, capturing.';
      return a.item.centred ? 'Centred. Hold still.' : 'All in view. Hold still.';
  }
}

export interface Pacing {
  /** A cue must hold this long before it is spoken. */
  stableMs: number;
  /** "Can't see" and "can't tell" must hold this long: a few seconds, not a passing frame. */
  slowStableMs: number;
  /** After any cue, wait this long before a different one (except the go-ahead). */
  minGapMs: number;
  /** The same cue is never said again sooner than this. */
  repeatMs: number;
  slowRepeatMs: number;
}

export const DEFAULT_PACING: Pacing = { stableMs: 600, slowStableMs: 3000, minGapMs: 2000, repeatMs: 4000, slowRepeatMs: 9000 };

/**
 * Decides when to speak. A cue is spoken once it has been stable for a moment, never sooner than
 * `minGapMs` after another cue, and the same cue never more often than `repeatMs`, so the person
 * is not talked over. The go-ahead (OK) skips the gap, so it is heard before the photo is taken.
 */
export class GuidanceSpeaker {
  private candidate: string | null = null;
  private candidateSince = 0;
  private lastAt = -Infinity;
  private readonly spokenAt = new Map<string, number>();
  private readonly pacing: Pacing;

  constructor(pacing: Partial<Pacing> = {}) {
    this.pacing = { ...DEFAULT_PACING, ...pacing };
  }

  /** True when `key` should be spoken now. `slow` cues need longer to settle and repeat less. */
  update(key: string, now: number, slow = false): boolean {
    const p = this.pacing;
    if (key !== this.candidate) {
      this.candidate = key;
      this.candidateSince = now;
    }
    if (now - this.candidateSince < (slow ? p.slowStableMs : p.stableMs)) return false;
    const last = this.spokenAt.get(key);
    if (last !== undefined && now - last < Math.max(2500, slow ? p.slowRepeatMs : p.repeatMs)) return false;
    if (key !== 'OK' && now - this.lastAt < p.minGapMs) return false;
    this.spokenAt.set(key, now);
    this.lastAt = now;
    return true;
  }

  reset(): void {
    this.candidate = null;
    this.candidateSince = 0;
    this.lastAt = -Infinity;
    this.spokenAt.clear();
  }
}

/**
 * Turns frame analyses into spoken guidance for one camera session: pacing from GuidanceSpeaker,
 * and the contrasting-surface tip said once, not on a loop.
 */
export class GuidanceCoach {
  private readonly speaker: GuidanceSpeaker;
  private tipGiven = false;

  constructor(pacing: Partial<Pacing> = {}) {
    this.speaker = new GuidanceSpeaker(pacing);
  }

  /** The words to speak now, or null. */
  update(a: FrameAnalysis, mode: ShotMode, now: number, opts: { mirrored?: boolean } = {}): string | null {
    const slow = a.code === 'NOTHING' || a.code === 'UNSURE';
    if (!this.speaker.update(cueKey(a), now, slow)) return null;
    const tip = slow && mode === 'item' && !this.tipGiven;
    if (tip) this.tipGiven = true;
    return cueText(a, mode, { tip, mirrored: opts.mirrored });
  }

  /** A new shot: forget what was said and when, but keep the one-time tip given. */
  reset(): void {
    this.speaker.reset();
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
  reset(): void {
    this.okSince = null;
  }
}
