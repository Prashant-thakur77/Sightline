import React, { useMemo } from "react";
import { AbsoluteFill, useCurrentFrame, useVideoConfig } from "remotion";
import { ThreeCanvas } from "@remotion/three";
import { useThree } from "@react-three/fiber";
import { RoundedBox } from "@react-three/drei";
import * as THREE from "three";
import { T } from "../theme";
import { Chip, Paper } from "../components/Ink";
import { INOUT, OUT, interp, pop, ramp } from "../lib/anim";

/** The hold made physical. A paper plane with Maya's side and the store's side; the money is a cobalt block resting
 *  in the middle, held by an ink clasp (PayPal's authorization). At `voidAt` the clasp opens and the block slides home
 *  to Maya's side. Labels are words, never colour alone. A diagram, labelled as one. */
export const Hold3D: React.FC<{ dur: number; amount: string; voidAt: number; authId?: string }> = ({ dur, amount, voidAt, authId }) => {
  const f = useCurrentFrame();
  const { fps, width: W, height: H } = useVideoConfig();
  const v = Math.round(voidAt * fps);
  const cam = useMemo(() => new THREE.PerspectiveCamera(30, W / H, 0.1, 100), [W, H]);
  const camPos = (fr: number) => {
    const t = Math.min(1, fr / Math.max(1, dur));
    const a = THREE.MathUtils.degToRad(-14 + 22 * INOUT(t));
    const r = 12.5 - 1.6 * OUT(t);
    return new THREE.Vector3(Math.sin(a) * r, 5.6 - 0.8 * t, Math.cos(a) * r);
  };
  const cp = camPos(f);
  cam.position.copy(cp); cam.lookAt(0, 0, 0); cam.updateMatrixWorld(); cam.updateProjectionMatrix();
  const proj = (x: number, y: number, z: number) => { const q = new THREE.Vector3(x, y, z).project(cam); return [(q.x + 1) / 2 * W, (1 - q.y) / 2 * H]; };
  const slide = interp(f, [v + 10, v + Math.round(fps * 1.1)], [0, 1], OUT);
  const blockX = -3.4 * slide;
  const [mx, my] = proj(-3.4, -0.2, 1.6);
  const [sx, sy] = proj(3.4, -0.2, 1.6);
  const [bx, by] = proj(blockX, 1.2, 0);
  const label = (x: number, y: number, text: string, sub: string, a: number) => (
    <div style={{ position: "absolute", left: x, top: y, translate: "-50% 0", textAlign: "center", opacity: ramp(f, a, 12), fontFamily: T.font }}>
      <div style={{ fontFamily: T.display, fontWeight: 700, fontSize: 46, color: T.ink }}>{text}</div>
      <div style={{ fontSize: 28, color: T.muted }}>{sub}</div>
    </div>
  );
  const held = f < v + 10;
  return (
    <AbsoluteFill>
      <Paper />
      <ThreeCanvas width={W} height={H} camera={{ fov: 30, position: [cp.x, cp.y, cp.z], near: 0.1, far: 100 }}>
        <World f={f} fps={fps} dur={dur} v={v} blockX={blockX} camPos={camPos} />
      </ThreeCanvas>
      {label(mx, my + 40, "Maya", "her PayPal account", 8)}
      {label(sx, sy + 40, "Demo Store", "paid only after the check", 14)}
      <div style={{ position: "absolute", left: bx, top: by - 120, translate: "-50% 0", fontFamily: T.display, fontWeight: 700, fontSize: 64,
        color: T.ink, opacity: ramp(f, 6, 10), scale: `${0.9 + 0.1 * pop(f, fps, 6)}` }}>{amount}</div>
      <div style={{ position: "absolute", left: "50%", top: 150, translate: "-50% 0", fontFamily: T.font, fontWeight: 700, fontSize: 34,
        color: "#fff", background: held ? T.accent : T.match, padding: "12px 28px", borderRadius: 999, whiteSpace: "nowrap",
        boxShadow: `${T.OFF}px ${T.OFF}px 0 ${T.ink}`, opacity: ramp(f, 4, 10) }}>
        {held ? "▣ On hold: PayPal authorized it, nothing captured" : "✓ Voided: the hold is released, nothing was charged"}
      </div>
      {authId && <div style={{ position: "absolute", left: "50%", bottom: 130, translate: "-50% 0", fontFamily: T.monoFont, fontSize: 28,
        color: T.ink, background: T.surface, border: `2px solid ${T.ink}`, borderRadius: 10, padding: "8px 18px",
        opacity: ramp(f, v, 12), whiteSpace: "nowrap" }}>{authId}</div>}
      <Chip text="Diagram of the real PayPal states from this order" at={0} until={dur} tone="warm" />
    </AbsoluteFill>
  );
};

const World: React.FC<{ f: number; fps: number; dur: number; v: number; blockX: number; camPos: (f: number) => THREE.Vector3 }>
  = ({ f, fps, v, blockX, camPos }) => {
  const { camera } = useThree();
  const cp = camPos(f);
  camera.position.copy(cp); camera.lookAt(0, 0, 0); camera.updateMatrixWorld();
  const open = interp(f, [v - 4, v + 12], [0, 1], OUT);
  const rise = ramp(f, 0, Math.round(fps * 0.7));
  const ink = useMemo(() => new THREE.Color(T.ink), []);
  const edge = (w: number, h: number, d: number) => useMemo(() => new THREE.EdgesGeometry(new THREE.BoxGeometry(w, h, d)), [w, h, d]);
  const plane = edge(10.5, 0.16, 4.6);
  const blockEdges = edge(1.9, 0.9, 1.3);
  const hum = 0.04 * Math.sin(f / 12);
  return (
    <>
      <ambientLight intensity={1.1} />
      <directionalLight position={[4, 9, 6]} intensity={1.6} />
      {/* the paper plane, ink edged, with its 5 px-style offset slab in sky under it */}
      <mesh position={[0.12, -0.42, 0.12]}><boxGeometry args={[10.5, 0.16, 4.6]} /><meshBasicMaterial color={T.sky} /></mesh>
      <mesh position={[0, -0.3, 0]}><boxGeometry args={[10.5, 0.16, 4.6]} /><meshStandardMaterial color={T.surface} roughness={0.9} /></mesh>
      <lineSegments geometry={plane} position={[0, -0.3, 0]}><lineBasicMaterial color={ink} /></lineSegments>
      {/* the two sides */}
      {[-3.4, 3.4].map((x, i) => (
        <mesh key={i} position={[x, -0.2, 0]} rotation={[-Math.PI / 2, 0, 0]}>
          <ringGeometry args={[1.25, 1.36, 64]} /><meshBasicMaterial color={T.ink} />
        </mesh>
      ))}
      {/* the money: a cobalt block with an ink outline and a peach offset */}
      <group position={[blockX, 0.25 + (1 - rise) * 1.5 + hum, 0]}>
        <RoundedBox args={[1.9, 0.9, 1.3]} radius={0.05}><meshStandardMaterial color={T.bright} roughness={0.5} /></RoundedBox>
        <lineSegments geometry={blockEdges}><lineBasicMaterial color={ink} /></lineSegments>
      </group>
      {/* the clasp (the authorization): two ink posts and a bar over the block; on void the bar lifts away and the
          posts sink into the paper */}
      {[-1, 1].map((sd) => (
        <mesh key={sd} visible={open < 0.95} position={[sd * 1.2, 0.35 + 0.6 * (1 - open), 0]} scale={[1, Math.max(0.01, 1 - open), 1]}>
          <boxGeometry args={[0.09, 1.3, 0.09]} /><meshStandardMaterial color={T.ink} />
        </mesh>
      ))}
      <mesh position={[0, 1.32 + 2.2 * open, 0]} rotation={[0, 0, 0.5 * open]} scale={[1, 1, 1]}>
        <boxGeometry args={[2.55, 0.1, 0.1]} /><meshStandardMaterial color={T.ink} transparent opacity={1 - open} />
      </mesh>
    </>
  );
};
