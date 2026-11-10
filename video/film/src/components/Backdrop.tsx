import React from "react";
import { AbsoluteFill, useCurrentFrame } from "remotion";
import { T } from "../theme";

/** Calm, always-moving ground: two slow light pools, a faint grid, film grain. Never busy behind text. */
export const Backdrop: React.FC<{ dim?: number }> = ({ dim = 0 }) => {
  const f = useCurrentFrame();
  const a = f / 240;
  const x1 = 30 + Math.sin(a) * 12, y1 = 30 + Math.cos(a * 0.8) * 10;
  const x2 = 72 + Math.cos(a * 0.7) * 12, y2 = 70 + Math.sin(a * 0.9) * 10;
  return (
    <AbsoluteFill style={{ backgroundColor: T.bg }}>
      <AbsoluteFill
        style={{
          background: `radial-gradient(60% 55% at ${x1}% ${y1}%, ${T.accent}2e, transparent 70%),
                       radial-gradient(55% 50% at ${x2}% ${y2}%, ${T.accent2}26, transparent 70%)`,
        }}
      />
      <AbsoluteFill
        style={{
          backgroundImage: `linear-gradient(${T.fg}0a 1px, transparent 1px), linear-gradient(90deg, ${T.fg}0a 1px, transparent 1px)`,
          backgroundSize: "64px 64px",
          backgroundPosition: `0 ${(f * 0.3) % 64}px`,
          maskImage: "radial-gradient(70% 70% at 50% 50%, black, transparent)",
        }}
      />
      <AbsoluteFill style={{ opacity: 0.06, mixBlendMode: "overlay" }}>
        <svg width="100%" height="100%">
          <filter id="g">
            <feTurbulence type="fractalNoise" baseFrequency="0.9" numOctaves="2" seed={f % 12} />
          </filter>
          <rect width="100%" height="100%" filter="url(#g)" />
        </svg>
      </AbsoluteFill>
      {dim > 0 && <AbsoluteFill style={{ backgroundColor: `rgba(0,0,0,${dim})` }} />}
    </AbsoluteFill>
  );
};
