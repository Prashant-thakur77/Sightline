import React from "react";
import { useCurrentFrame } from "remotion";
import { T } from "../theme";
import { ramp } from "../lib/anim";

/** The product's own drawings (apps/web/src/components/art/illustrations.tsx) as data, drawn frame by frame:
 *  ink lines draw in one after another, fills slide 5 px off the line into register after the lines. */
type El =
  | { k: "ln"; d: string; thin?: boolean }
  | { k: "fill"; d: string; c: "a" | "b" | "c" | "p" }
  | { k: "dot"; cx: number; cy: number; r: number; fill?: boolean };

const FILL = { a: T.bright, b: T.sky, c: T.warm, p: T.surface };

export const DRAW: Record<string, { vb: string; els: El[] }> = {
  parcel: {
    vb: "60 140 460 300",
    els: [
      { k: "fill", d: "M170 262 H400 V410 H170 Z", c: "b" },
      { k: "fill", d: "M400 262 L448 220 V372 L400 410 Z", c: "p" },
      { k: "fill", d: "M214 262 C222 214 258 202 300 205 C342 202 378 214 386 262 Z", c: "a" },
      { k: "fill", d: "M272 262 h30 v62 h-30 Z", c: "c" },
      { k: "fill", d: "M316 238 l20 -6 l9 26 l-20 6 l-9 -9 Z", c: "c" },
      { k: "ln", d: "M170 262 H400 V410 H170 Z" },
      { k: "ln", d: "M400 262 L448 220 V372 L400 410" },
      { k: "ln", d: "M170 262 L214 222 H448" },
      { k: "ln", d: "M170 262 L118 236 L160 196 L214 222" },
      { k: "ln", d: "M448 220 L498 208 L470 250 L400 262" },
      { k: "ln", d: "M272 262 V324 H302 V262" },
      { k: "ln", d: "M214 262 C222 214 258 202 300 205 C342 202 378 214 386 262" },
      { k: "ln", d: "M276 207 Q300 230 324 207" },
      { k: "ln", d: "M236 246 q6 -10 0 -20 M252 246 q6 -10 0 -20 M352 246 q-6 -10 0 -20 M368 246 q-6 -10 0 -20", thin: true },
      { k: "ln", d: "M300 222 Q304 236 316 238", thin: true },
      { k: "ln", d: "M316 238 l20 -6 l9 26 l-20 6 l-9 -9 Z" },
    ],
  },
  closed: { // the parcel shut: the close of the film
    vb: "60 140 460 300",
    els: [
      { k: "fill", d: "M170 262 H400 V410 H170 Z", c: "b" },
      { k: "fill", d: "M400 262 L448 220 V372 L400 410 Z", c: "p" },
      { k: "fill", d: "M170 262 L214 222 H448 L400 262 Z", c: "c" },
      { k: "ln", d: "M170 262 H400 V410 H170 Z" },
      { k: "ln", d: "M400 262 L448 220 V372 L400 410" },
      { k: "ln", d: "M170 262 L214 222 H448" },
      { k: "ln", d: "M285 262 L330 222", thin: true },
      { k: "ln", d: "M272 262 V324 H302 V262" },
    ],
  },
  sweater: {
    vb: "60 30 200 200",
    els: [
      { k: "fill", d: "M104 98 L144 76 H176 L216 98 L234 144 L210 154 L196 124 V206 H124 V124 L110 154 L86 144 Z", c: "a" },
      { k: "fill", d: "M152 84 h16 v22 h-16 Z", c: "c" },
      { k: "ln", d: "M104 98 L144 76 H176 L216 98 L234 144 L210 154 L196 124 V206 H124 V124 L110 154 L86 144 Z" },
      { k: "ln", d: "M144 76 Q160 94 176 76" },
      { k: "ln", d: "M152 84 h16 v22 h-16 Z" },
      { k: "ln", d: "M130 196 h60", thin: true },
      { k: "ln", d: "M64 60 V40 H86 M234 40 H256 V60 M256 196 V218 H234 M86 218 H64 V196" },
    ],
  },
  tag: { // the size tag, large: the match-cut object
    vb: "0 0 200 200",
    els: [
      { k: "fill", d: "M58 40 h84 a10 10 0 0 1 10 10 v100 a10 10 0 0 1 -10 10 h-84 a10 10 0 0 1 -10 -10 v-100 a10 10 0 0 1 10 -10 Z", c: "c" },
      { k: "ln", d: "M58 40 h84 a10 10 0 0 1 10 10 v100 a10 10 0 0 1 -10 10 h-84 a10 10 0 0 1 -10 -10 v-100 a10 10 0 0 1 10 -10 Z" },
      { k: "ln", d: "M40 40 H160", thin: true },
      { k: "ln", d: "M84 76 V124 H112" },
      { k: "ln", d: "M70 140 h60", thin: true },
    ],
  },
  hold: {
    vb: "60 20 220 200",
    els: [
      { k: "fill", d: "M108 64 h100 a30 30 0 0 1 30 30 v72 a30 30 0 0 1 -30 30 h-100 a30 30 0 0 1 -30 -30 v-72 a30 30 0 0 1 30 -30 Z", c: "b" },
      { k: "fill", d: "M158 94 a38 38 0 1 1 0 76 a38 38 0 1 1 0 -76 Z", c: "c" },
      { k: "ln", d: "M108 64 h100 a30 30 0 0 1 30 30 v72 a30 30 0 0 1 -30 30 h-100 a30 30 0 0 1 -30 -30 v-72 a30 30 0 0 1 30 -30 Z" },
      { k: "ln", d: "M134 64 V50 a24 24 0 0 1 48 0 V64" },
      { k: "ln", d: "M158 94 a38 38 0 1 1 0 76 a38 38 0 1 1 0 -76 Z" },
      { k: "ln", d: "M148 120 h20 M148 132 h20 M148 144 h20" },
    ],
  },
  phone: {
    vb: "0 0 200 200",
    els: [
      { k: "fill", d: "M70 30 h60 a14 14 0 0 1 14 14 v112 a14 14 0 0 1 -14 14 h-60 a14 14 0 0 1 -14 -14 v-112 a14 14 0 0 1 14 -14 Z", c: "p" },
      { k: "fill", d: "M92 72 a8 8 0 0 1 16 0 v18 a8 8 0 0 1 -16 0 Z", c: "a" },
      { k: "ln", d: "M70 30 h60 a14 14 0 0 1 14 14 v112 a14 14 0 0 1 -14 14 h-60 a14 14 0 0 1 -14 -14 v-112 a14 14 0 0 1 14 -14 Z" },
      { k: "ln", d: "M92 72 a8 8 0 0 1 16 0 v18 a8 8 0 0 1 -16 0 Z" },
      { k: "ln", d: "M86 86 a14 14 0 0 0 28 0 M100 100 v10", thin: true },
      { k: "ln", d: "M90 156 h20", thin: true },
      { k: "ln", d: "M160 70 q14 18 0 36 M176 60 q22 28 0 56", thin: true },
    ],
  },
};

/** Draws one of the drawings. `at` = first line starts; lines follow every `per` frames; fills register after. */
export const Drawing: React.FC<{ name: keyof typeof DRAW; at?: number; per?: number; w: number; style?: React.CSSProperties; done?: boolean }>
  = ({ name, at = 0, per = 3, w, style, done }) => {
  const f = useCurrentFrame();
  const dr = DRAW[name];
  const [, , vw] = dr.vb.split(" ").map(Number);
  const s = w / vw; // px per unit: keeps the line weight and the 5 px offset true at any size
  const lines = dr.els.filter((e) => e.k === "ln").length;
  const fillAt = at + lines * per + 6;
  let li = 0;
  return (
    <svg viewBox={dr.vb} width={w} style={{ overflow: "visible", ...style }}>
      {dr.els.map((e, i) => {
        if (e.k === "fill") {
          const k = done ? 1 : ramp(f, fillAt, 14);
          const off = (T.OFF / s) * k;
          return <path key={i} d={e.d} fill={FILL[e.c]} opacity={k} transform={`translate(${off} ${off})`} />;
        }
        if (e.k === "dot") return <circle key={i} cx={e.cx} cy={e.cy} r={e.r} fill={e.fill ? T.ink : "none"} stroke={T.ink} strokeWidth={1.8 / 1} />;
        const k = done ? 1 : ramp(f, at + li++ * per, 16);
        return <path key={i} d={e.d} pathLength={1} fill="none" stroke={T.ink} strokeWidth={(e.thin ? 3.2 : 4.4) / s * 1.4}
          strokeLinecap="round" strokeLinejoin="round" strokeDasharray={1} strokeDashoffset={1 - k} />;
      })}
    </svg>
  );
};
