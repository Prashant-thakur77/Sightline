import { loadFont as fraunces } from "@remotion/google-fonts/Fraunces";
import { loadFont as atkinson } from "@remotion/google-fonts/AtkinsonHyperlegibleNext";
import { loadFont as atkMono } from "@remotion/google-fonts/AtkinsonHyperlegibleMono";
import { film } from "./film";

// Sightline's own type: Fraunces for display, Atkinson Hyperlegible Next for everything else (apps/web layout.tsx).
const display = fraunces("normal", { weights: ["600", "700"], subsets: ["latin"] });
const sans = atkinson("normal", { weights: ["400", "500", "700"], subsets: ["latin"] });
const mono = atkMono("normal", { weights: ["400", "700"], subsets: ["latin"] });

// Ice & cobalt tokens from apps/web/src/app/globals.css and components/art/art.css.
export const C = {
  paper: "#f3f6fb", paper2: "#e8eef9", surface: "#ffffff", ink: "#0d1530", muted: "#3b4565", hairline: "#d3daea",
  accent: "#1a33d6", bright: "#2442ff", sky: "#dce6ff", warm: "#ffe3d6",
  match: "#08572f", mismatch: "#a01b12", unsure: "#6b4300",
};

export const T = {
  ...film.theme,
  ...C,
  bg: C.paper, fg: C.ink, good: C.match, bad: C.mismatch,
  font: sans.fontFamily,
  display: display.fontFamily,
  monoFont: mono.fontFamily,
  h1: 112, h2: 76, h3: 52, body: 40, small: 30, label: 26,
  safeX: 96, safeY: 84,
  OFF: 5, // the offset: fills sit 5 px off the ink line (scaled with the drawing)
};
