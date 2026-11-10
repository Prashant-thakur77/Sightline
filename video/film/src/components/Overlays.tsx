import React, { useEffect, useState } from "react";
import { AbsoluteFill, continueRender, delayRender, Img, Sequence, staticFile, useCurrentFrame, useVideoConfig } from "remotion";
import { Lottie, type LottieAnimationData } from "@remotion/lottie";
import { Gif } from "@remotion/gif";
import type { Overlay } from "../film";
import { T } from "../theme";
import { envelope, pop } from "../lib/anim";

/** Timed accents on top of any scene: Lottie (LottieFiles free license), GIF, image, a label chip, or a drawn arrow.
 *  x/y are 0..1 of the frame; w is px. One accent at a time; they punctuate a beat, they don't decorate. */
export const Overlays: React.FC<{ items: Overlay[] }> = ({ items }) => {
  const { fps } = useVideoConfig();
  return (
    <>
      {items.map((o, i) => (
        <Sequence key={i} from={Math.round(o.at * fps)} durationInFrames={Math.max(1, Math.round(o.dur * fps))} layout="none">
          <One o={o} />
        </Sequence>
      ))}
    </>
  );
};

const LottieAt: React.FC<{ src: string; loop?: boolean; style: React.CSSProperties }> = ({ src, loop, style }) => {
  const [data, setData] = useState<LottieAnimationData | null>(null);
  const [h] = useState(() => delayRender("lottie " + src));
  useEffect(() => {
    fetch(staticFile(src)).then((r) => r.json()).then((j) => { setData(j); continueRender(h); }).catch(() => continueRender(h));
  }, [src, h]);
  return data ? <Lottie animationData={data} loop={loop} style={style} /> : null;
};

const One: React.FC<{ o: Overlay }> = ({ o }) => {
  const f = useCurrentFrame();
  const { fps, width: W, height: H, durationInFrames } = useVideoConfig();
  const len = Math.round(o.dur * fps);
  const e = envelope(f, 0, len);
  const p = pop(f, fps, 0);
  if (o.kind === "arrow") {
    const [x1, y1] = [o.from[0] * W, o.from[1] * H], [x2, y2] = [o.to[0] * W, o.to[1] * H];
    const L = Math.hypot(x2 - x1, y2 - y1);
    const t = Math.min(1, f / (fps * 0.45));
    const ang = Math.atan2(y2 - y1, x2 - x1);
    return (
      <AbsoluteFill style={{ opacity: e }}>
        <svg width={W} height={H}>
          <path d={`M${x1},${y1} L${x2},${y2}`} stroke={T.accent} strokeWidth={7} strokeLinecap="round" fill="none"
            strokeDasharray={L} strokeDashoffset={L * (1 - t)} />
          {t >= 1 && <path d={`M${x2},${y2} l${-28 * Math.cos(ang - 0.45)},${-28 * Math.sin(ang - 0.45)} M${x2},${y2} l${-28 * Math.cos(ang + 0.45)},${-28 * Math.sin(ang + 0.45)}`}
            stroke={T.accent} strokeWidth={7} strokeLinecap="round" fill="none" />}
        </svg>
      </AbsoluteFill>
    );
  }
  const pos: React.CSSProperties = { position: "absolute", left: (o.x ?? 0.5) * W, top: (o.y ?? 0.5) * H, translate: "-50% -50%" };
  if (o.kind === "label") {
    const bg = o.tone === "good" ? T.good : o.tone === "bad" ? T.bad : o.tone === "plain" ? T.surface : T.accent;
    return (
      <div style={{ ...pos, scale: `${0.7 + 0.3 * p}`, opacity: e, background: bg, color: o.tone === "plain" ? T.fg : T.bg,
        fontFamily: T.font, fontWeight: 650, fontSize: T.small, padding: "12px 24px", borderRadius: 999, whiteSpace: "nowrap",
        boxShadow: "0 16px 40px rgba(0,0,0,.4)" }}>{o.text}</div>
    );
  }
  const w = o.w ?? 360;
  const style: React.CSSProperties = { ...pos, width: w, opacity: e, scale: `${0.85 + 0.15 * p}` };
  if (o.kind === "lottie") return <div style={style}><LottieAt src={o.src} loop={o.loop} style={{ width: w }} /></div>;
  if (o.kind === "gif") return <div style={style}><Gif src={staticFile(o.src)} width={w} height={o.h ?? w} fit="contain" /></div>;
  void durationInFrames;
  return <Img src={staticFile(o.src)} style={{ ...style, borderRadius: 16 }} />;
};
