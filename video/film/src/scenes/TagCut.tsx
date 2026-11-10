import React from "react";
import { AbsoluteFill, staticFile, useCurrentFrame, useVideoConfig } from "remotion";
import { Video } from "@remotion/media";
import { T } from "../theme";
import { Chip, ModelPill } from "../components/Ink";
import { Drawing } from "../components/Drawings";
import { StoryClip, type Clip } from "./Story";
import { interp, OUT, ramp } from "../lib/anim";

/** The memorable shot: the real size tag in her fingers -> an ink ring draws round it -> the cobalt fill registers
 *  and floods -> an iris opens on the live verdict, pushed in on the verdict table where the size row says what the
 *  tag says. The story's object becomes the product's answer. */
export const TagCut: React.FC<{ dur: number; clip: Clip; tag: { x: number; y: number }; src: string; at: number; ringAt?: number; irisAt?: number;
  box: { x: number; y: number; w: number; h: number }; chips?: { text: string; at: number; until: number }[] }>
  = ({ dur, clip, tag, src, at, box, ringAt: ringS = 0.3, irisAt: irisS = 1.35 }) => {
  const f = useCurrentFrame();
  const { fps, width: W, height: H } = useVideoConfig();
  const ringAt = Math.round(fps * ringS), irisAt = Math.round(fps * irisS), floodAt = irisAt - Math.round(fps * 0.35);
  const tx = tag.x * W, ty = tag.y * H;
  const ring = ramp(f, ringAt, 16);
  const flood = interp(f, [floodAt, floodAt + 12], [0, Math.hypot(W, H)], OUT);
  const iris = interp(f, [irisAt, irisAt + 16], [0, Math.hypot(W, H)], OUT);
  // the verdict, placed so the box lands centred and big, then a slow pull back
  const s0 = Math.min((W * 0.86) / box.w, (H * 0.62) / box.h);
  const s = s0 * interp(f, [irisAt, dur], [1.08, 0.96]);
  const cx = box.x + box.w / 2, cy = box.y + box.h / 2;
  return (
    <AbsoluteFill style={{ background: T.ink }}>
      {f < irisAt + 16 && <StoryClip c={clip} dur={dur} />}
      {f < irisAt + 16 && (
        <svg width={W} height={H} style={{ position: "absolute", inset: 0 }}>
          <circle cx={tx} cy={ty} r={170} pathLength={1} fill="none" stroke={T.ink} strokeWidth={10} strokeLinecap="round"
            strokeDasharray={1} strokeDashoffset={1 - ring} />
          <circle cx={tx} cy={ty} r={170} pathLength={1} fill="none" stroke="#fff" strokeWidth={4} strokeLinecap="round"
            strokeDasharray={1} strokeDashoffset={1 - ring} />
          <circle cx={tx + T.OFF * 2} cy={ty + T.OFF * 2} r={flood} fill={T.bright} />
        </svg>
      )}
      {f >= irisAt && (
        <AbsoluteFill style={{ clipPath: `circle(${iris}px at ${tx}px ${ty}px)`, background: T.paper }}>
          <div style={{ position: "absolute", left: W / 2 - cx * s, top: H / 2 - cy * s, width: 1920 * s, height: 1080 * s }}>
            <Video src={staticFile(src)} trimBefore={Math.round(at * fps)} muted style={{ width: "100%", height: "100%" }} />
          </div>
          <AbsoluteFill style={{ boxShadow: `inset 0 0 0 3px ${T.ink}` }} />
        </AbsoluteFill>
      )}
      <ModelPill model="Claude Opus 5.5" job="reads the size tag" at={irisAt + 6} until={dur} />
    </AbsoluteFill>
  );
};
