import React from "react";
import { AbsoluteFill, Sequence, staticFile, useCurrentFrame, useVideoConfig } from "remotion";
import { Video } from "@remotion/media";
import { T } from "../theme";
import { Chip, KLine, Paper } from "../components/Ink";
import { Drawing, DRAW } from "../components/Drawings";
import { envelope, interp, ramp } from "../lib/anim";

/** The owner's real footage (story grade, slow push), one clip after another. A clip that has not arrived yet is a
 *  clearly labelled drawn placeholder of the same action, in the product's own drawing style. */
export type Clip = { id: string; src?: string; trimBefore?: number; dur: number; drawing: keyof typeof DRAW; action: string;
  push?: "in" | "out" | "left" | "right" };

export const StoryClip: React.FC<{ c: Clip; dur: number; dim?: number }> = ({ c, dur, dim = 0 }) => {
  const f = useCurrentFrame();
  const { fps } = useVideoConfig();
  const push = c.push ?? "in";
  const s = push === "in" ? interp(f, [0, dur], [1.0, 1.08]) : push === "out" ? interp(f, [0, dur], [1.08, 1.0]) : 1.05;
  const tx = push === "left" ? interp(f, [0, dur], [24, -24]) : push === "right" ? interp(f, [0, dur], [-24, 24]) : 0;
  if (c.src) {
    return (
      <AbsoluteFill style={{ background: "#000", overflow: "hidden" }}>
        <AbsoluteFill style={{ scale: `${s}`, translate: `${tx}px 0`, filter: "sepia(.14) saturate(.82) contrast(1.05) brightness(.95)" }}>
          <Video src={staticFile(c.src)} trimBefore={Math.round((c.trimBefore ?? 0) * fps)} muted
            style={{ width: "100%", height: "100%", objectFit: "cover" }} />
        </AbsoluteFill>
        <AbsoluteFill style={{ background: "radial-gradient(80% 80% at 50% 45%, transparent 55%, rgba(13,21,48,.35))" }} />
        {dim > 0 && <AbsoluteFill style={{ background: `rgba(13,21,48,${dim})` }} />}
      </AbsoluteFill>
    );
  }
  // Placeholder: the same action drawn, labelled, so the cut reads before the real clip arrives.
  return (
    <AbsoluteFill>
      <Paper tone="warm" />
      <AbsoluteFill style={{ alignItems: "center", justifyContent: "center", scale: `${s}`, translate: `${tx}px 0` }}>
        <Drawing name={c.drawing} at={2} per={2} w={c.drawing === "parcel" || c.drawing === "closed" ? 980 : 620} />
      </AbsoluteFill>
      {dim > 0 && <AbsoluteFill style={{ background: `rgba(243,246,251,${dim})` }} />}
      <div style={{ position: "absolute", left: 56, bottom: 150, fontFamily: T.font, fontSize: 28, color: T.ink, background: "#fff",
        border: `2.5px dashed ${T.ink}`, borderRadius: 14, padding: "10px 18px", opacity: ramp(f, 4, 10) }}>
        <b>Placeholder · owner clip {c.id}</b> · {c.action}
      </div>
    </AbsoluteFill>
  );
};

export const Story: React.FC<{ clips: Clip[]; dur: number; lines?: { text: string; at: number; until: number; emphasis?: string[] }[];
  lower?: { name: string; role: string; at: number; until: number }; chips?: { text: string; at: number; until: number }[] }>
  = ({ clips, dur, lines = [], lower, chips = [] }) => {
  const { fps } = useVideoConfig();
  const f = useCurrentFrame();
  let t = 0;
  return (
    <AbsoluteFill style={{ background: T.ink }}>
      {clips.map((c, i) => {
        const from = Math.round(t * fps);
        const len = i === clips.length - 1 ? dur - from : Math.round(c.dur * fps);
        t += c.dur;
        return (
          <Sequence key={c.id + i} from={from} durationInFrames={Math.max(1, len + (i < clips.length - 1 ? 8 : 0))} layout="none">
            <AbsoluteFill style={{ opacity: i === 0 ? 1 : ramp(f - from, 0, 8) }}>
              <StoryClip c={c} dur={len} />
            </AbsoluteFill>
          </Sequence>
        );
      })}
      {lines.map((l, i) => {
        const a = Math.round(l.at * fps), b = Math.round(l.until * fps);
        const o = envelope(f, a, b, 8, 10);
        if (o <= 0) return null;
        return (
          <Sequence key={i} from={a} layout="none">
            <AbsoluteFill style={{ justifyContent: "flex-start", alignItems: "center", paddingTop: 110, opacity: o }}>
              <div style={{ background: "rgba(243,246,251,.92)", borderRadius: 24, padding: "14px 40px 6px", boxShadow: `${T.OFF * 2}px ${T.OFF * 2}px 0 ${T.bright}` }}>
                <KLine text={l.text} size={92} emphasis={l.emphasis} />
              </div>
            </AbsoluteFill>
          </Sequence>
        );
      })}
      {lower && (() => {
        const a = Math.round(lower.at * fps), b = Math.round(lower.until * fps);
        const o = envelope(f, a, b, 10, 10);
        if (o <= 0) return null;
        return (
          <div style={{ position: "absolute", left: 96, bottom: 240, opacity: o, translate: `${(1 - ramp(f, a, 12)) * -30}px 0` }}>
            <div style={{ position: "absolute", inset: 0, translate: `${T.OFF * 2}px ${T.OFF * 2}px`, background: T.bright, borderRadius: 18 }} />
            <div style={{ position: "relative", background: T.surface, border: `3px solid ${T.ink}`, borderRadius: 18, padding: "16px 28px" }}>
              <div style={{ fontFamily: T.display, fontWeight: 700, fontSize: 52, color: T.ink, lineHeight: 1 }}>{lower.name}</div>
              <div style={{ fontFamily: T.font, fontSize: 28, color: T.muted, marginTop: 6 }}>{lower.role}</div>
            </div>
          </div>
        );
      })()}
      {chips.map((c, i) => <Chip key={i} text={c.text} at={Math.round(c.at * fps)} until={Math.round(c.until * fps)} tone="warm" />)}
    </AbsoluteFill>
  );
};
