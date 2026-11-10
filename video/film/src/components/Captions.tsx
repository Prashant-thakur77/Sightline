import React, { useEffect, useMemo, useState } from "react";
import { AbsoluteFill, continueRender, delayRender, staticFile, useCurrentFrame, useVideoConfig } from "remotion";
import { createTikTokStyleCaptions, type Caption } from "@remotion/captions";
import { T } from "../theme";

/** Burned-in captions from public/<file> (Caption[] JSON, made by scripts/captions.py from the final VO).
 *  Short pages, the spoken word lights up with a small pop. No box: outline + soft shadow. Sits above the bottom safe area; never covers the product's own text. */
export const Captions: React.FC<{ file: string }> = ({ file }) => {
  const f = useCurrentFrame();
  const { fps } = useVideoConfig();
  const [caps, setCaps] = useState<Caption[] | null>(null);
  const [h] = useState(() => delayRender("captions"));
  useEffect(() => {
    fetch(staticFile(file)).then((r) => r.json()).then((c) => { setCaps(c); continueRender(h); }).catch(() => continueRender(h));
  }, [file, h]);
  const pages = useMemo(() => (caps ? createTikTokStyleCaptions({ captions: caps, combineTokensWithinMilliseconds: 900 }).pages : []), [caps]);
  const ms = (f / fps) * 1000;
  const page = pages.find((p) => ms >= p.startMs && ms < p.startMs + p.durationMs);
  if (!page) return null;
  return (
    <AbsoluteFill style={{ justifyContent: "flex-end", alignItems: "center", paddingBottom: 96, pointerEvents: "none" }}>
      <div style={{ maxWidth: 1400, textAlign: "center", fontFamily: T.font, fontWeight: 700, fontSize: 54, lineHeight: 1.25,
        whiteSpace: "pre-wrap", WebkitTextStroke: "2.5px rgba(0,0,0,.6)", paintOrder: "stroke fill",
        textShadow: "0 3px 10px rgba(0,0,0,.55)" }}>
        {page.tokens.map((t, i) => (
          <span key={i} style={{ display: "inline-block", whiteSpace: "pre", color: ms >= t.fromMs && ms < t.toMs ? T.accent : T.fg,
            scale: ms >= t.fromMs && ms < t.toMs ? "1.08" : "1" }}>{t.text}</span>
        ))}
      </div>
    </AbsoluteFill>
  );
};
