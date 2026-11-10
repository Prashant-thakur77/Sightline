import React from "react";
import { AbsoluteFill, Sequence, useCurrentFrame, useVideoConfig } from "remotion";
import { T } from "../theme";
import { film } from "../film";
import { Chip, Footnote, KLine, Paper } from "../components/Ink";
import { Drawing, DRAW } from "../components/Drawings";
import { envelope, interp, OUT, pop, ramp } from "../lib/anim";

/** An ink-edged card with the cobalt (or other) offset slab under it. */
export const Card: React.FC<{ children: React.ReactNode; off?: string; w?: number | string; pad?: number; style?: React.CSSProperties }>
  = ({ children, off = T.bright, w, pad = 40, style }) => (
  <div style={{ position: "relative", width: w, ...style }}>
    <div style={{ position: "absolute", inset: 0, translate: `${T.OFF * 2}px ${T.OFF * 2}px`, background: off, borderRadius: 28 }} />
    <div style={{ position: "relative", background: T.surface, border: `3px solid ${T.ink}`, borderRadius: 28, padding: pad }}>{children}</div>
  </div>
);

/** The pain: two sourced numbers drawn as ink rings that fill, over the dimmed story footage. */
export const Pain: React.FC<{ dur: number; stats: { big: string; of: number; fill: number; text: string; at: number }[]; source: string }>
  = ({ dur, stats, source }) => {
  const f = useCurrentFrame();
  const { fps } = useVideoConfig();
  return (
    <AbsoluteFill>
      <Paper tone="warm" />
      <AbsoluteFill style={{ flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 90, paddingBottom: 60 }}>
        {stats.map((s, i) => {
          const a = Math.round(s.at * fps);
          const k = ramp(f, a, 16);
          const fillK = ramp(f, a + 12, 22);
          // a row of people as dots: `fill` of `of` drawn in cobalt (unit chart), the rest in ink outline
          return (
            <div key={i} style={{ opacity: k, translate: `0 ${(1 - k) * 20}px` }}>
              <Card w={720} pad={44}>
                <div style={{ fontFamily: T.display, fontWeight: 700, fontSize: 150, color: T.ink, lineHeight: 0.95 }}>{s.big}</div>
                <div style={{ display: "flex", gap: 14, margin: "26px 0 22px" }}>
                  {Array.from({ length: s.of }).map((_, j) => {
                    const on = j < s.fill && fillK > j / s.of;
                    return <div key={j} style={{ width: 34, height: 34, borderRadius: 17, border: `3px solid ${T.ink}`,
                      background: on ? T.bright : "transparent", scale: on ? `${0.9 + 0.1 * pop(f, fps, a + 12 + j * 2)}` : "1" }} />;
                  })}
                </div>
                <div style={{ fontFamily: T.font, fontSize: 38, color: T.ink, lineHeight: 1.3 }}>{s.text}</div>
              </Card>
            </div>
          );
        })}
      </AbsoluteFill>
      <Footnote text={source} at={10} />
    </AbsoluteFill>
  );
};

/** The signature transition as its own beat: an object is drawn in ink, its fill slides into register with a stamp,
 *  then floods the frame and becomes the ground for what follows (a title, the wordmark, a section name). */
export const Register: React.FC<{ dur: number; drawing: keyof typeof DRAW; title?: string; emphasis?: string[]; kicker?: string;
  wordmark?: boolean; floodAt?: number; ground?: "accent" | "paper" }>
  = ({ dur, drawing, title, emphasis, kicker, wordmark, floodAt = 1.1, ground = "accent" }) => {
  const f = useCurrentFrame();
  const { fps, width: W, height: H } = useVideoConfig();
  const fl = Math.round(floodAt * fps);
  const r = interp(f, [fl, fl + Math.round(fps * 0.55)], [0, Math.hypot(W, H) * 0.6], OUT);
  const floodColor = ground === "accent" ? T.accent : T.paper;
  const onFlood = f > fl + 6;
  const ink = ground === "accent" && onFlood ? "#ffffff" : T.ink;
  const objOut = ramp(f, fl + 4, 10);
  return (
    <AbsoluteFill>
      <Paper />
      <AbsoluteFill style={{ alignItems: "center", justifyContent: "center", opacity: 1 - objOut, scale: `${1 + 0.3 * objOut}` }}>
        <Drawing name={drawing} at={0} per={2} w={drawing === "parcel" ? 760 : 520} />
      </AbsoluteFill>
      <svg width={W} height={H} style={{ position: "absolute", inset: 0 }}>
        <circle cx={W / 2 + T.OFF * 2} cy={H / 2 + T.OFF * 2} r={r} fill={floodColor} />
      </svg>
      {onFlood && (
        <AbsoluteFill style={{ alignItems: "center", justifyContent: "center", flexDirection: "column", gap: 34, padding: "0 140px" }}>
          {kicker && <div style={{ fontFamily: T.font, fontWeight: 700, fontSize: 32, letterSpacing: 4, textTransform: "uppercase", color: ink,
            opacity: ramp(f, fl + 8, 10) }}>{kicker}</div>}
          {wordmark && <Wordmark at={fl + 8} color={ink} />}
          {title && <div style={{ color: ink }}><KLine text={title} at={fl + (wordmark ? 18 : 8)} size={wordmark ? 80 : 104}
            emphasis={emphasis} color={ink}
            emColor={ground === "accent" ? T.warm : T.accent} underline={ground === "accent" ? T.bright : T.sky} /></div>}
        </AbsoluteFill>
      )}
    </AbsoluteFill>
  );
};

/** The Sightline mark: two braille cells (as on the site) and the name in Fraunces. */
export const Wordmark: React.FC<{ at: number; color?: string; size?: number }> = ({ at, color = T.ink, size = 150 }) => {
  const f = useCurrentFrame();
  const { fps } = useVideoConfig();
  const dots = [[0, 0, 1], [1, 0, 0], [0, 1, 1], [1, 1, 1], [0, 2, 0], [1, 2, 1]];
  const name = (film as unknown as { product: string }).product; // PRODUCT_NAME from @sightline/core, via make_film.py
  return (
    <div style={{ display: "flex", alignItems: "center", gap: size * 0.28 }}>
      <div style={{ position: "relative", width: size * 0.5, height: size * 0.72 }}>
        {dots.map(([x, y, on], i) => (
          <div key={i} style={{ position: "absolute", left: x * size * 0.26, top: y * size * 0.26, width: size * 0.2, height: size * 0.2,
            borderRadius: size, background: on ? color : "transparent", border: `${size * 0.03}px solid ${color}`,
            scale: `${pop(f, fps, at + i * 2)}` }} />
        ))}
      </div>
      <div style={{ fontFamily: T.display, fontWeight: 700, fontSize: size, color, letterSpacing: -size * 0.03, lineHeight: 1,
        clipPath: `inset(0 ${100 - 100 * ramp(f, at + 6, 16)}% 0 0)` }}>{name}</div>
    </div>
  );
};

/** Proof: baseline bar first, ours last; the delta stamp lands with a hit; footnote says how it was measured. */
export type ProofRow = { label: string; k: number; n: number; ours?: boolean; tone?: "good" | "bad" };
export const ProofCards: React.FC<{ dur: number; cards: { at: number; title: string; rows: ProofRow[]; stamp: string; stampTone?: "good" | "bad"; foot: string }[];
  kicker?: string }> = ({ dur, cards, kicker }) => {
  const f = useCurrentFrame();
  const { fps } = useVideoConfig();
  return (
    <AbsoluteFill>
      <Paper />
      {kicker && <div style={{ position: "absolute", left: T.safeX, top: 70, fontFamily: T.font, fontWeight: 700, fontSize: 30, letterSpacing: 4,
        textTransform: "uppercase", color: T.accent, opacity: ramp(f, 0, 10) }}>{kicker}</div>}
      <AbsoluteFill style={{ flexDirection: "row", gap: 70, alignItems: "center", justifyContent: "center", paddingTop: 20 }}>
        {cards.map((c, ci) => {
          const a = Math.round(c.at * fps);
          const k = ramp(f, a, 14);
          if (f < a - 2) return <div key={ci} style={{ width: 800 }} />;
          return (
            <div key={ci} style={{ opacity: k, translate: `0 ${(1 - k) * 40}px`, scale: cards.length === 1 ? "1.3" : "1" }}>
              <Card w={800} pad={42} off={c.stampTone === "bad" ? T.warm : T.bright}>
                <div style={{ fontFamily: T.display, fontWeight: 700, fontSize: 50, color: T.ink, lineHeight: 1.08, marginBottom: 30 }}>{c.title}</div>
                {c.rows.map((r, ri) => {
                  const ra = a + 10 + ri * Math.round(fps * 0.7);
                  const g = ramp(f, ra, 20);
                  const val = Math.round(r.k * g);
                  const col = r.tone === "bad" ? T.mismatch : r.ours ? T.bright : T.muted;
                  return (
                    <div key={ri} style={{ marginBottom: 26, opacity: ramp(f, ra - 4, 8) }}>
                      <div style={{ display: "flex", justifyContent: "space-between", fontFamily: T.font, fontSize: 32, color: T.ink, marginBottom: 10 }}>
                        <span style={{ fontWeight: r.ours ? 700 : 400 }}>{r.label}</span>
                        <span style={{ fontFamily: T.display, fontWeight: 700, fontSize: 46 }}>{val} <span style={{ fontFamily: T.font, fontWeight: 400, fontSize: 30, color: T.muted }}>of {r.n}</span></span>
                      </div>
                      <div style={{ height: 30, border: `3px solid ${T.ink}`, borderRadius: 8, background: T.paper, overflow: "hidden" }}>
                        <div style={{ height: "100%", width: `${(100 * r.k / r.n) * g}%`, minWidth: g > 0.9 && r.k === 0 ? 0 : undefined, background: col }} />
                      </div>
                    </div>
                  );
                })}
                {(() => {
                  const sa = a + 10 + c.rows.length * Math.round(fps * 0.7) + 8;
                  if (f < sa) return <div style={{ height: 64 }} />;
                  const p = pop(f, fps, sa, 10);
                  const bad = c.stampTone === "bad";
                  return <div style={{ display: "inline-flex", alignItems: "center", gap: 12, marginTop: 6, scale: `${1.4 - 0.4 * p}`, opacity: Math.min(1, p * 1.5),
                    transformOrigin: "0 50%", fontFamily: T.font, fontWeight: 700, fontSize: 32, color: "#fff", background: bad ? T.mismatch : T.match,
                    padding: "10px 22px", borderRadius: 12, rotate: "-2deg", boxShadow: `${T.OFF}px ${T.OFF}px 0 ${T.ink}` }}>{bad ? "✕" : "✓"} {c.stamp}</div>;
                })()}
                <div style={{ fontFamily: T.font, fontSize: 26, color: T.muted, marginTop: 24, lineHeight: 1.35 }}>{c.foot}</div>
              </Card>
            </div>
          );
        })}
      </AbsoluteFill>
    </AbsoluteFill>
  );
};

/** End card: the wordmark, the line, the address to try it, the honest labels. Breathes, never static. */
export const End: React.FC<{ dur: number; tagline: string; url: string; repo: string; notes: string }> = ({ dur, tagline, url, repo, notes }) => {
  const f = useCurrentFrame();
  const s = 1 + 0.025 * (f / Math.max(1, dur));
  return (
    <AbsoluteFill>
      <Paper />
      <AbsoluteFill style={{ alignItems: "center", justifyContent: "center", flexDirection: "column", gap: 40, scale: `${s}` }}>
        <Wordmark at={4} size={170} />
        <div style={{ opacity: ramp(f, 22, 12) }}><KLine text={tagline} at={22} size={60} emphasis={["actually"]} /></div>
        <div style={{ opacity: ramp(f, 40, 12), marginTop: 10 }}>
          <Card pad={26} w={undefined}>
            <div style={{ fontFamily: T.font, fontWeight: 700, fontSize: 44, color: T.ink }}>Try it: <span style={{ color: T.accent }}>{url}</span></div>
          </Card>
        </div>
        <div style={{ fontFamily: T.font, fontSize: 30, color: T.muted, opacity: ramp(f, 52, 12) }}>{repo}</div>
        <div style={{ fontFamily: T.font, fontSize: 28, color: T.muted, opacity: ramp(f, 60, 12) }}>{notes}</div>
      </AbsoluteFill>
    </AbsoluteFill>
  );
};

/** Recap: fast montage stills from the real takes (~1 s each) under kinetic lines, then the model-to-job table. */
export const Recap: React.FC<{ dur: number; lines: { text: string; at: number }[]; table: { model: string; job: string }[]; tableAt: number;
  shots: React.ReactNode[] }> = ({ dur, lines, table, tableAt, shots }) => {
  const f = useCurrentFrame();
  const { fps } = useVideoConfig();
  const ta = Math.round(tableAt * fps);
  const per = Math.max(1, Math.floor(ta / Math.max(1, shots.length)));
  const idx = Math.min(shots.length - 1, Math.floor(f / per));
  return (
    <AbsoluteFill>
      <Paper />
      {f < ta && (
        <AbsoluteFill style={{ opacity: 0.32, scale: `${1.04 + 0.03 * ((f % per) / per)}` }}>{shots[idx]}</AbsoluteFill>
      )}
      {f < ta && <AbsoluteFill style={{ alignItems: "center", justifyContent: "center", flexDirection: "column", gap: 20 }}>
        {lines.map((l, i) => {
          const a = Math.round(l.at * fps);
          if (f < a) return null;
          return <div key={i} style={{ background: "rgba(243,246,251,.93)", borderRadius: 18, padding: "4px 34px 0", border: `3px solid ${T.ink}`,
            boxShadow: `${T.OFF * 2}px ${T.OFF * 2}px 0 ${T.bright}` }}><KLine text={l.text} at={a} size={78} per={2} /></div>;
        })}
      </AbsoluteFill>}
      {f >= ta && (
        <AbsoluteFill style={{ alignItems: "center", justifyContent: "center" }}>
          <Card w={1360} pad={46}>
            <div style={{ fontFamily: T.display, fontWeight: 700, fontSize: 54, color: T.ink, marginBottom: 26 }}>Who does what</div>
            {table.map((r, i) => (
              <div key={i} style={{ display: "flex", gap: 30, padding: "16px 0", borderTop: i ? `2px solid ${T.hairline}` : `3px solid ${T.ink}`,
                opacity: ramp(f, ta + 4 + i * 5, 8), translate: `0 ${(1 - ramp(f, ta + 4 + i * 5, 10)) * 12}px` }}>
                <div style={{ width: 380, fontFamily: T.font, fontWeight: 700, fontSize: 36, color: i < 2 ? T.accent : T.ink }}>{r.model}</div>
                <div style={{ flex: 1, fontFamily: T.font, fontSize: 34, color: T.ink, lineHeight: 1.3 }}>{r.job}</div>
              </div>
            ))}
          </Card>
        </AbsoluteFill>
      )}
    </AbsoluteFill>
  );
};
