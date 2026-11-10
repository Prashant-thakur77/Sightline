import React from "react";
import { AbsoluteFill, staticFile, useCurrentFrame, useVideoConfig } from "remotion";
import { Audio } from "@remotion/media";
import { linearTiming, TransitionSeries, type TransitionPresentation, type TransitionPresentationComponentProps } from "@remotion/transitions";
import { fade } from "@remotion/transitions/fade";
import { slide } from "@remotion/transitions/slide";
import { wipe } from "@remotion/transitions/wipe";
import { film, type Transition } from "./film";
import { INOUT } from "./lib/anim";
import { Captions } from "./components/Captions";
import { Chip, ModelPill, Paper } from "./components/Ink";
import { Screen } from "./scenes/Screen";
import { Arch3D } from "./scenes/Arch3D";
import { Story } from "./scenes/Story";
import { TagCut } from "./scenes/TagCut";
import { Hold3D } from "./scenes/Hold3D";
import { End, Pain, ProofCards, Recap, Register } from "./scenes/Cards";
import { Video } from "@remotion/media";

// Scene i always STARTS at the sum of the previous durations, so the voice placed by vo_timeline.py stays in sync:
// each sequence is lengthened by its outgoing transition, which overlaps the next scene's first frames.

type ZP = { kind: "zoom" | "blur" };
const Through: React.FC<TransitionPresentationComponentProps<ZP>> = ({ children, presentationProgress: p, presentationDirection, passedProps }) => {
  const entering = presentationDirection === "entering";
  const s = entering ? 0.92 + 0.08 * p : 1 + 0.12 * p;
  const o = entering ? p : 1 - p;
  const b = (entering ? 1 - p : p) * (passedProps.kind === "blur" ? 14 : 4);
  return <AbsoluteFill style={{ opacity: o, scale: `${passedProps.kind === "zoom" ? s : 1}`, filter: `blur(${b}px)` }}>{children}</AbsoluteFill>;
};
const through = (kind: ZP["kind"]): TransitionPresentation<ZP> => ({ component: Through, props: { kind } });
const tFrames = (t: Transition | undefined, fps: number) => (!t || t.type === "cut" ? 0 : Math.round((t.dur ?? 0.5) * fps));
const present = (t: Transition): TransitionPresentation<any> => {
  switch (t.type) {
    case "slide": return slide({ direction: t.dir ?? "from-right" });
    case "wipe": return wipe({ direction: t.dir ?? "from-left" });
    case "zoom": return through("zoom");
    case "blur": return through("blur");
    default: return fade();
  }
};

/** A still-ish frame of a real take for the recap montage. */
const Shot: React.FC<{ src: string; at: number }> = ({ src, at }) => {
  const { fps } = useVideoConfig();
  return <AbsoluteFill><Video src={staticFile(src)} trimBefore={Math.round(at * fps)} muted style={{ width: "100%", height: "100%" }} /></AbsoluteFill>;
};

const Body: React.FC<{ s: any; dur: number }> = ({ s, dur }) => {
  switch (s.type) {
    case "story": return <Story clips={s.clips} lines={s.lines} lower={s.lower} chips={s.storyChips} dur={dur} />;
    case "tagcut": return <TagCut {...s} dur={dur} />;
    case "pain": return <Pain stats={s.stats} source={s.source} dur={dur} />;
    case "register": return <Register {...s} dur={dur} />;
    case "screen": return <><Paper /><Screen {...s} dur={dur} /></>;
    case "hold3d": return <Hold3D {...s} dur={dur} />;
    case "arch3d": return <><Paper /><Arch3D {...s} dur={dur} /></>;
    case "proofcards": return <ProofCards cards={s.cards} kicker={s.kicker} dur={dur} />;
    case "recap": return <Recap lines={s.lines} table={s.table} tableAt={s.tableAt} dur={dur}
      shots={(s.shots as { src: string; at: number }[]).map((x, i) => <Shot key={i} src={x.src} at={x.at} />)} />;
    case "end": return <End {...s} dur={dur} />;
    default: return <Paper />;
  }
};

/** Chips (provenance) and the model pill, per scene, timed in seconds from the scene start. */
const Marks: React.FC<{ s: any; dur: number }> = ({ s, dur }) => {
  const { fps } = useVideoConfig();
  const fr = (x: number | undefined, d: number) => (x === undefined ? d : Math.round(x * fps));
  return (
    <>
      {(s.chips ?? []).map((c: any, i: number) => <Chip key={i} text={c.text} tone={c.tone ?? (i ? "warm" : "ink")} at={fr(c.at, 0)}
        until={fr(c.until, dur)} y={i === 0 ? 48 : 1080 - 104 - (i - 1) * 66} />)}
      {s.pill && <ModelPill model={s.pill.model} job={s.pill.job} at={fr(s.pill.at, 0)} until={fr(s.pill.until, dur)} />}
    </>
  );
};

/** Nothing static: a slow push under every flat scene (3D scenes move their own camera). */
const Drift: React.FC<{ on: boolean; dur: number; children: React.ReactNode }> = ({ on, dur, children }) => {
  const f = useCurrentFrame();
  if (!on) return <>{children}</>;
  const k = Math.min(1, f / Math.max(1, dur));
  return <AbsoluteFill style={{ scale: `${1 + 0.045 * k}`, translate: `${-8 * k}px ${-5 * k}px` }}>{children}</AbsoluteFill>;
};

export const Film: React.FC = () => {
  const { fps } = useVideoConfig();
  const items: React.ReactNode[] = [];
  film.scenes.forEach((s: any, i) => {
    const out = i < film.scenes.length - 1 ? tFrames(s.transition, fps) : 0;
    const dur = Math.round(s.duration * fps);
    items.push(
      <TransitionSeries.Sequence key={s.id} durationInFrames={dur + out} name={`${s.id} · ${s.type}`}>
        <AbsoluteFill style={{ backgroundColor: film.theme.bg }}>
          <Drift on={!["tagcut", "hold3d", "arch3d"].includes(s.type)} dur={dur}><Body s={s} dur={dur} /></Drift>
          <Marks s={s} dur={dur} />
        </AbsoluteFill>
      </TransitionSeries.Sequence>,
    );
    if (out > 0) items.push(<TransitionSeries.Transition key={`${s.id}-t`} presentation={present(s.transition!)}
      timing={linearTiming({ durationInFrames: out, easing: INOUT })} />);
  });
  return (
    <AbsoluteFill style={{ backgroundColor: film.theme.bg }}>
      <TransitionSeries>{items}</TransitionSeries>
      {film.captions && <Captions file={film.captions} />}
      {film.previewAudio && <Audio src={staticFile(film.previewAudio)} />}
    </AbsoluteFill>
  );
};

export const totalFrames = (fps: number) => film.scenes.reduce((a, s) => a + Math.round(s.duration * fps), 0);
