import React from "react";
import { AbsoluteFill, Img, staticFile } from "remotion";
import { T } from "./theme";
import { Paper } from "./components/Ink";
import { Wordmark } from "./scenes/Cards";

/** YouTube/Devpost thumbnail: two real screens from the live site (the verdict, the hold), four big words in
 *  Fraunces, the wordmark. Readable at 320 px wide. thumb-a.jpg / thumb-b.jpg are frames grabbed by build.sh. */
export const Thumbnail: React.FC = () => (
  <AbsoluteFill>
    <Paper />
    <div style={{ position: "absolute", right: 40, top: 70, width: 700, rotate: "2deg" }}>
      <div style={{ position: "absolute", inset: 0, translate: "10px 10px", background: T.bright, borderRadius: 20 }} />
      <Img src={staticFile("thumb-a.jpg")} style={{ position: "relative", width: 700, borderRadius: 20, border: `4px solid ${T.ink}` }} />
    </div>
    <div style={{ position: "absolute", right: 300, top: 400, width: 520, rotate: "-3deg" }}>
      <div style={{ position: "absolute", inset: 0, translate: "10px 10px", background: T.warm, borderRadius: 16 }} />
      <Img src={staticFile("thumb-b.jpg")} style={{ position: "relative", width: 520, borderRadius: 16, border: `4px solid ${T.ink}` }} />
    </div>
    <div style={{ position: "absolute", left: 56, top: 64, width: 560 }}>
      <div style={{ scale: "0.5", transformOrigin: "0 0" }}><Wordmark at={-100} size={150} /></div>
    </div>
    <div style={{ position: "absolute", left: 56, bottom: 70, width: 600, fontFamily: T.display, fontWeight: 700, fontSize: 118,
      lineHeight: 0.98, color: T.ink, letterSpacing: -3 }}>
      Pay only <span style={{ color: T.accent }}>after</span> the check
    </div>
  </AbsoluteFill>
);
