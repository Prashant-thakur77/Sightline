import React, { useEffect, useState } from "react";
import { AbsoluteFill, continueRender, delayRender, staticFile, useCurrentFrame, useVideoConfig } from "remotion";
import { Video } from "@remotion/media";
import { T } from "../theme";
import { interp, pop, ramp } from "../lib/anim";

type Box = { x: number; y: number; w: number; h: number };
type Focus = { at: number; dur?: number; box: Box; scale?: number };

/** The real product, recorded. Sits in a window on the backdrop, and a virtual camera pushes in on each
 *  action (from capture.mjs events.json or hand-placed `zooms`), holds while the UI responds, then pulls back.
 *  Keep text ≥ 26px after the push; never tilt product UI in 3D here. */
export const Screen: React.FC<{
  src: string; events?: string; zooms?: Focus[]; trimBefore?: number; playbackRate?: number;
  callouts?: { at: number; dur?: number; text: string; x: number; y: number }[]; title?: string; chrome?: boolean; url?: string;
  masks?: { x: number; y: number; w: number; h: number; color?: string }[];
  dur: number;
}> = ({ src, events, zooms = [], trimBefore = 0, playbackRate = 1, callouts = [], title, chrome = true, url, masks = [], dur }) => {
  const f = useCurrentFrame();
  const { fps, width: W, height: H } = useVideoConfig();
  const [auto, setAuto] = useState<Focus[]>([]);
  const [handle] = useState(() => (events ? delayRender("events " + events) : null));

  useEffect(() => {
    if (!events || handle === null) return;
    fetch(staticFile(events))
      .then((r) => r.json())
      .then((j) => {
        const ev = (j.events || []).filter((e: any) => e.box && e.type !== "scroll");
        setAuto(ev.map((e: any) => ({ at: (e.t - trimBefore) / playbackRate, box: e.box, dur: e.type === "zoom" ? 3 : 2.2 })));
        continueRender(handle);
      })
      .catch(() => continueRender(handle));
  }, [events, handle, trimBefore, playbackRate]);

  // window placement
  const top = title ? 150 : 118;
  const chromeH = chrome ? 44 : 0;
  const winW = W * 0.86;
  const k = Math.min(winW / W, (H - top - 60 - chromeH) / H);
  const vw = W * k, vh = H * k;
  const winX = (W - vw) / 2, winY = top + (H - top - vh - chromeH) / 2;

  // camera keyframes (all in frames)
  const focus = [...auto, ...zooms].filter((z) => z.at * fps < dur).sort((a, b) => a.at - b.at);
  const C = [W / 2, H / 2];
  const kf: { t: number; s: number; x: number; y: number }[] = [{ t: 0, s: 1, x: W / 2, y: H / 2 }];
  const move = Math.round(fps * 0.5);
  focus.forEach((z, i) => {
    const sx = winX + (z.box.x + z.box.w / 2) * k;
    const sy = winY + chromeH + (z.box.y + z.box.h / 2) * k;
    const fit = Math.min((W * 0.5) / (z.box.w * k), (H * 0.5) / (z.box.h * k));
    const s = z.scale ?? Math.max(1.3, Math.min(1.8, fit));
    const t = Math.max(kf[kf.length - 1].t + 2, Math.round(z.at * fps) - move);
    kf.push({ t, s: kf[kf.length - 1].s, x: kf[kf.length - 1].x, y: kf[kf.length - 1].y });
    kf.push({ t: t + move, s, x: sx, y: sy });
    const hold = Math.round((z.dur ?? 2.2) * fps);
    const next = focus[i + 1];
    const until = next ? Math.round(next.at * fps) - move : Infinity;
    if (until - (t + move + hold) > fps * 1.2) {
      kf.push({ t: t + move + hold, s, x: sx, y: sy });
      kf.push({ t: t + move * 2 + hold, s: 1, x: W / 2, y: H / 2 });
    }
  });
  const ts = kf.map((p) => p.t);
  const S = kf.length > 1 ? interp(f, ts, kf.map((p) => p.s)) : 1;
  const FX = kf.length > 1 ? interp(f, ts, kf.map((p) => p.x)) : W / 2;
  const FY = kf.length > 1 ? interp(f, ts, kf.map((p) => p.y)) : H / 2;
  const S2 = kf.length > 1 ? interp(f + 1, ts, kf.map((p) => p.s)) : 1;
  const blur = Math.min(3, Math.abs(S2 - S) * 60);
  const tx = S === 1 && FX === W / 2 ? 0 : C[0] - S * FX;
  const ty = S === 1 && FY === H / 2 ? 0 : C[1] - S * FY;

  const enter = ramp(f, 0, Math.round(fps * 0.6));
  return (
    <AbsoluteFill>
      {title && (
        <div style={{ position: "absolute", left: T.safeX, top: 56, fontFamily: T.font, fontWeight: 600, fontSize: T.h3,
          color: T.fg, letterSpacing: -1, opacity: (1 - Math.min(1, (S - 1) * 3)) * enter }}>
          {title}
        </div>
      )}
      <AbsoluteFill style={{ transformOrigin: "0 0", transform: S === 1 ? undefined : `translate(${tx}px, ${ty}px) scale(${S})`,
        filter: blur > 0.3 ? `blur(${blur}px)` : undefined }}>
        <div style={{ position: "absolute", left: winX, top: winY, width: vw, height: vh + chromeH, borderRadius: 18,
          overflow: "hidden", background: T.surface, opacity: enter, translate: `0 ${(1 - enter) * 40}px`,
          boxShadow: `${T.OFF * 2}px ${T.OFF * 2}px 0 ${T.bright}, 0 30px 90px rgba(13,21,48,.18)`, border: `3px solid ${T.ink}` }}>
          {chrome && (
            <div style={{ height: chromeH, display: "flex", alignItems: "center", gap: 10, padding: "0 18px",
              background: T.paper2, borderBottom: `2px solid ${T.ink}` }}>
              {[0, 1, 2].map((c) => <div key={c} style={{ width: 13, height: 13, borderRadius: 7, border: `2px solid ${T.ink}`, background: c === 0 ? T.bright : "transparent" }} />)}
              {url && <div style={{ marginLeft: 24, fontFamily: T.monoFont, fontSize: 22, color: T.ink, background: T.surface,
                padding: "6px 16px", borderRadius: 8 }}>{url}</div>}
            </div>
          )}
          <Video src={staticFile(src)} trimBefore={Math.round(trimBefore * fps)} playbackRate={playbackRate} muted
            style={{ width: vw, height: vh, display: "block" }} />
          {masks.map((m, i) => <div key={i} style={{ position: "absolute", left: m.x * k, top: chromeH + m.y * k, width: m.w * k, height: m.h * k,
            background: m.color ?? "#ffffff" }} />)}
        </div>
        {callouts.map((c, i) => {
          const a = Math.round(c.at * fps), b = a + Math.round((c.dur ?? 2.5) * fps);
          if (f < a || f > b + 10) return null;
          const p = pop(f, fps, a);
          const out = 1 - ramp(f, b, 8);
          return (
            <div key={i} style={{ position: "absolute", left: winX + c.x * k, top: winY + chromeH + c.y * k,
              translate: "-50% -130%", scale: `${(0.6 + 0.4 * p) / S}`, transformOrigin: "50% 100%", opacity: Math.min(p, out),
              fontFamily: T.font, fontWeight: 700, fontSize: T.label + 6, color: "#fff", background: T.ink,
              padding: "12px 22px", borderRadius: 999, whiteSpace: "nowrap", boxShadow: `${T.OFF}px ${T.OFF}px 0 ${T.bright}` }}>
              {c.text}
            </div>
          );
        })}
      </AbsoluteFill>
    </AbsoluteFill>
  );
};
