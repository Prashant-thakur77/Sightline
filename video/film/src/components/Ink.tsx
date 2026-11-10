import React from "react";
import { AbsoluteFill, useCurrentFrame, useVideoConfig } from "remotion";
import { T } from "../theme";
import { envelope, OUT, pop, ramp } from "../lib/anim";

/** The Offset Print language, frame-driven: an ink line that draws in (pathLength 1), and a flat fill that slides
 *  into register a few px off the line, exactly like apps/web/src/components/art. */

export const InkPath: React.FC<{ d: string; at?: number; dur?: number; w?: number; color?: string; dash?: boolean; scale?: number }>
  = ({ d, at = 0, dur = 18, w = 2.6, color = T.ink, dash, scale = 1 }) => {
  const f = useCurrentFrame();
  const k = ramp(f, at, dur);
  return <path d={d} pathLength={1} fill="none" stroke={color} strokeWidth={w / scale} strokeLinecap="round" strokeLinejoin="round"
    strokeDasharray={dash ? "0.012 0.02" : 1} strokeDashoffset={dash ? 0 : 1 - k} opacity={dash ? k : 1} />;
};

/** A fill that arrives 0 px off and slides to the offset (the register snap). */
export const OffsetFill: React.FC<{ d: string; at?: number; fill?: string; off?: number }> = ({ d, at = 12, fill = T.bright, off = T.OFF }) => {
  const f = useCurrentFrame();
  const k = ramp(f, at, 14);
  return <path d={d} fill={fill} opacity={k} transform={`translate(${off * k} ${off * k})`} />;
};

/** Provenance chip, top-left: what this take is (live, persona, demo control, sped up...). */
export const Chip: React.FC<{ text: string; at?: number; until?: number; tone?: "ink" | "warm" | "accent"; x?: number; y?: number }>
  = ({ text, at = 0, until = 1e9, tone = "ink", x = 56, y = 48 }) => {
  const f = useCurrentFrame();
  const o = envelope(f, at, until, 9, 8);
  if (o <= 0) return null;
  const bg = tone === "warm" ? T.warm : tone === "accent" ? T.accent : T.ink;
  const fg = tone === "warm" ? T.ink : "#fff";
  return (
    <div style={{ position: "absolute", left: x, top: y, opacity: o, translate: `0 ${(1 - ramp(f, at, 10)) * 12}px`,
      fontFamily: T.font, fontWeight: 700, fontSize: 30, color: fg, background: bg, padding: "9px 20px 11px", borderRadius: 999,
      border: tone === "warm" ? `2px solid ${T.ink}` : "none", letterSpacing: 0.3, whiteSpace: "nowrap" }}>{text}</div>
  );
};

/** The model pill: names the model while it works. Ink outline, cobalt fill offset by 5 px. */
export const ModelPill: React.FC<{ model: string; job: string; at?: number; until?: number }> = ({ model, job, at = 0, until = 1e9 }) => {
  const f = useCurrentFrame();
  const { fps } = useVideoConfig();
  const o = envelope(f, at, until, 9, 8);
  if (o <= 0) return null;
  const p = pop(f, fps, at);
  const pulse = 0.5 + 0.5 * Math.sin((f - at) / 9);
  return (
    <div style={{ position: "absolute", right: 56, top: 44, opacity: o, scale: `${0.85 + 0.15 * p}`, transformOrigin: "100% 0" }}>
      <div style={{ position: "absolute", inset: 0, translate: `${T.OFF}px ${T.OFF}px`, background: T.bright, borderRadius: 999 }} />
      <div style={{ position: "relative", display: "flex", alignItems: "center", gap: 14, background: T.surface, border: `2.6px solid ${T.ink}`,
        borderRadius: 999, padding: "10px 24px 11px 16px", fontFamily: T.font, color: T.ink, whiteSpace: "nowrap" }}>
        <div style={{ width: 16, height: 16, borderRadius: 8, background: T.bright, boxShadow: `0 0 0 ${4 + 6 * pulse}px ${T.bright}33` }} />
        <span style={{ fontWeight: 700, fontSize: 30 }}>{model}</span>
        <span style={{ fontSize: 26, color: T.muted }}>· {job}</span>
      </div>
    </div>
  );
};

/** Kinetic line in Fraunces: words rise from a mask in spoken order; emphasis words get the cobalt underline sweep. */
export const KLine: React.FC<{ text: string; at?: number; size?: number; emphasis?: string[]; color?: string; per?: number; weight?: number;
  emColor?: string; underline?: string }>
  = ({ text, at = 0, size = 96, emphasis = [], color = T.ink, per = 3, weight = 600, emColor = T.accent, underline = T.sky }) => {
  const f = useCurrentFrame();
  const words = text.split(" ");
  return (
    <div style={{ display: "flex", flexWrap: "wrap", justifyContent: "center", columnGap: size * 0.26, rowGap: size * 0.05 }}>
      {words.map((w, i) => {
        const k = ramp(f, at + i * per, 14);
        const em = emphasis.some((e) => w.toLowerCase().replace(/[^a-z0-9$.']/g, "").startsWith(e.toLowerCase()));
        const u = ramp(f, at + i * per + 10, 12);
        return (
          <span key={i} style={{ overflow: "hidden", display: "inline-block", paddingBottom: size * 0.12 }}>
            <span style={{ display: "inline-block", translate: `0 ${(1 - k) * size * 0.9}px`, fontFamily: T.display, fontWeight: weight,
              fontSize: size, color: em ? emColor : color, letterSpacing: -size * 0.02, lineHeight: 1.04, position: "relative" }}>
              {w}
              {em && <span style={{ position: "absolute", left: 0, right: 0, bottom: -size * 0.02, height: size * 0.09, background: underline,
                zIndex: -1, transformOrigin: "0 50%", scale: `${u} 1` }} />}
            </span>
          </span>
        );
      })}
    </div>
  );
};

/** Ice paper with faint halftone dots and grain, always drifting a little (nothing static). */
export const Paper: React.FC<{ tone?: "paper" | "warm" | "ink" }> = ({ tone = "paper" }) => {
  const f = useCurrentFrame();
  const bg = tone === "warm" ? "#fbf3ee" : tone === "ink" ? T.ink : T.paper;
  const dot = tone === "ink" ? "#ffffff10" : `${T.ink}0d`;
  return (
    <AbsoluteFill style={{ backgroundColor: bg }}>
      <AbsoluteFill style={{ backgroundImage: `radial-gradient(${dot} 1.4px, transparent 1.6px)`, backgroundSize: "14px 14px",
        backgroundPosition: `${(f * 0.12) % 14}px ${(f * 0.2) % 14}px`,
        maskImage: `radial-gradient(60% 70% at ${50 + 18 * Math.sin(f / 200)}% ${40 + 12 * Math.cos(f / 240)}%, black, transparent 75%)` }} />
      <AbsoluteFill style={{ opacity: tone === "ink" ? 0.08 : 0.05, mixBlendMode: "multiply" }}>
        <svg width="100%" height="100%"><filter id="pg"><feTurbulence type="fractalNoise" baseFrequency="0.85" numOctaves="2" seed={Math.floor(f / 2) % 10} /></filter>
          <rect width="100%" height="100%" filter="url(#pg)" /></svg>
      </AbsoluteFill>
    </AbsoluteFill>
  );
};

/** Source / footnote line, bottom-left, small but ≥ 26 px. */
export const Footnote: React.FC<{ text: string; at?: number; color?: string }> = ({ text, at = 0, color = T.muted }) => {
  const f = useCurrentFrame();
  return <div style={{ position: "absolute", left: T.safeX, bottom: 40, right: T.safeX, fontFamily: T.font, fontSize: 26, color,
    opacity: ramp(f, at, 12) }}>{text}</div>;
};

export const ease = OUT;
