#!/usr/bin/env python3
"""The film's own score, composed and synthesised here in numpy: no samples, no SoundFont, nothing licensed, nothing
a recording could match (Content ID cannot claim it).

One theme, ~88 bpm, D major / B minor:
  felt piano  soft-hammer additive piano: the "Is this it?" motif (a rising four-note question, B D F# A, left open)
  marimba     a muted pulse that enters with the product (the register snap into the name) and carries the demo
  pad         a warm string pad that swells under the recap and resolves on the end card
  bass        soft sine bass on the chord roots from the turn on
Arc from the real scene starts (narration/timeline.json): a soft pad with a sparse piano under the story -> marimba and bass enter on the
name -> steady under the product -> one bar thinned to almost nothing before the verdict -> light under the 3D -> build
through the proof -> lift for the recap -> the motif answered (resolved to D) over the close and end card.

  python3 video/music.py [--out PATH]
"""
from __future__ import annotations

import json
import sys
import wave
from pathlib import Path

import numpy as np

SR = 48000
HERE = Path(__file__).resolve().parent
OUT = Path(sys.argv[sys.argv.index("--out") + 1]) if "--out" in sys.argv else HERE / "audio" / "music.wav"
BPM = 88
BEAT = 60 / BPM
BAR = 4 * BEAT
rng = np.random.default_rng(13)


def midi(n: float) -> float:
    return 440.0 * 2 ** ((n - 69) / 12)


# ---------------------------------------------------------------- instruments (mono float arrays)

def piano(n: int, dur: float = 3.5, vel: float = 0.6) -> np.ndarray:
    f0 = midi(n)
    L = int(dur * SR)
    t = np.arange(L) / SR
    y = np.zeros(L)
    B = 0.0004
    for k in range(1, 12):
        fk = f0 * k * np.sqrt(1 + B * k * k)
        if fk > 9000:
            break
        amp = (vel ** (0.6 + 0.25 * k)) / k ** 1.1          # soft hammer: high partials grow with velocity only
        dec = (2.6 + 3.5 * (f0 < 200)) / (1 + 0.35 * k)
        y += amp * np.exp(-t / dec) * np.sin(2 * np.pi * fk * t + rng.uniform(0, 6.28))
    att = np.minimum(1, t / 0.006)
    y *= att * (0.9 + 0.1 * np.exp(-t / 0.08))
    # felt: a little low-passed thump at the start
    y += 0.08 * vel * np.exp(-t / 0.03) * np.sin(2 * np.pi * f0 * 0.5 * t)
    return y * 0.35


def marimba(n: int, vel: float = 0.5) -> np.ndarray:
    f0 = midi(n)
    L = int(0.9 * SR)
    t = np.arange(L) / SR
    y = np.sin(2 * np.pi * f0 * t) * np.exp(-t / 0.32)
    y += 0.35 * np.sin(2 * np.pi * f0 * 3.93 * t) * np.exp(-t / 0.06)
    y += 0.12 * np.sin(2 * np.pi * f0 * 9.2 * t) * np.exp(-t / 0.02)
    y *= np.minimum(1, t / 0.002)
    return y * vel * 0.32


def pad(notes: list[int], dur: float, vel: float = 0.5) -> np.ndarray:
    L = int(dur * SR)
    t = np.arange(L) / SR
    y = np.zeros(L)
    for n in notes:
        for det in (-0.07, 0.0, 0.08):
            f = midi(n + det)
            vib = 1 + 0.0025 * np.sin(2 * np.pi * 5.1 * t + n)
            ph = 2 * np.pi * np.cumsum(f * vib) / SR
            y += np.sin(ph) + 0.33 * np.sin(2 * ph) + 0.15 * np.sin(3 * ph)
    env = np.minimum(1, t / 1.2) * np.minimum(1, (dur - t) / 1.0).clip(0, 1)
    return y * env * vel * 0.045


def bass(n: int, dur: float, vel: float = 0.5) -> np.ndarray:
    f = midi(n)
    L = int(dur * SR)
    t = np.arange(L) / SR
    y = np.sin(2 * np.pi * f * t) + 0.25 * np.sin(4 * np.pi * f * t)
    env = np.minimum(1, t / 0.02) * np.exp(-t / 1.8) * np.minimum(1, (dur - t) / 0.08).clip(0, 1)
    return y * env * vel * 0.22


# ---------------------------------------------------------------- the score

def sections() -> tuple[dict, float]:
    tl = HERE / "narration" / "timeline.json"
    if tl.exists():
        j = json.loads(tl.read_text())
        st = {s["id"]: s["start"] for s in j["scenes"]}
        total = j["duration"]
    else:
        sm = json.loads((HERE / "sound_map.json").read_text())
        st = {b["id"]: b["t"] for b in sm["beats"]}
        total = sm["duration"]
    film = HERE / "film" / "film.json"
    if film.exists():  # the timeline lacks scenes with no voice; film.json has every duration
        t, st2 = 0.0, {}
        for s in json.loads(film.read_text())["scenes"]:
            st2[s["id"]] = t
            t += s["duration"]
        st, total = st2, t
    return st, total


def main() -> None:
    st, total = sections()
    L = int((total + 4) * SR)
    mix = {k: np.zeros(L) for k in ("piano", "marimba", "pad", "bass")}

    def put(track: str, x: np.ndarray, t: float, pan: float = 0.0) -> None:
        a = int(t * SR)
        if a >= L:
            return
        b = min(L, a + len(x))
        mix[track][a:b] += x[: b - a]

    # chord per bar: Bm G D A (story), D A Bm G (product), resolving to D at the end
    PROG_STORY = [(47, [59, 62, 66]), (43, [55, 59, 62]), (50, [57, 62, 66]), (45, [57, 61, 64])]
    PROG_PROD = [(50, [57, 62, 66]), (45, [57, 61, 64]), (47, [59, 62, 66]), (43, [55, 59, 62])]
    MOTIF = [71, 74, 78, 81]  # B D F# A: the question, left open

    turn = st.get("turn", 24.0)
    verdict = st.get("check", 70.0) + 4.5   # the verdict lands about here in the check scene
    hood = st.get("hoodreg", st.get("hood", 110.0))
    proof = st.get("proof", 130.0)
    recap = st.get("recap", 145.0)
    close = st.get("close", 155.0)
    end = st.get("end", 162.0)

    def energy(t: float) -> int:
        if t < turn: return 1
        if verdict - BAR <= t < verdict: return 0          # thinned bar before the verdict
        if t < hood: return 3
        if t < proof: return 2
        if t < recap: return 4
        if t < close: return 5
        return 1

    nbars = int(total / BAR) + 2
    for b in range(nbars):
        t0 = b * BAR
        e = energy(t0)
        prod = t0 >= turn
        root, chord = (PROG_PROD if prod else PROG_STORY)[b % 4]
        if t0 >= close:
            root, chord = (50, [57, 62, 66]) if b % 2 == 0 else (43, [55, 59, 62])
        # piano: the motif every other bar in the story; chord tones otherwise
        if e == 1 and t0 < turn:
            # the story: a soft warm pad under the voice, and one quiet piano note every other bar
            put("pad", pad(chord, BAR + 0.6, 0.32), t0)
            if b % 2 == 0:
                put("piano", piano(chord[1] + 12, 4.5, 0.2), t0 + BEAT)
        elif e >= 2:
            put("piano", piano(chord[1] + 12, 3.0, 0.32), t0)
            if e >= 3 and b % 2 == 0:
                put("piano", piano(MOTIF[b % 4] - 0, 2.2, 0.28), t0 + 2 * BEAT)
        elif e == 0:
            put("piano", piano(chord[0] + 12, 3.4, 0.22), t0)
        # marimba pulse from the turn on: eighths on chord tones, sparser when e is low
        if prod and e >= 2:
            pat = [0, 2, 1, 2, 0, 2, 1, 2] if e >= 3 else [0, None, 2, None, 1, None, 2, None]
            for k, idx in enumerate(pat):
                if idx is None:
                    continue
                vel = (0.5 if k % 2 == 0 else 0.33) * (1.15 if e >= 4 else 1.0)
                put("marimba", marimba(chord[idx] + 12, vel), t0 + k * BEAT / 2)
        # bass from the turn on
        if prod and e >= 2:
            put("bass", bass(root - 12, BAR * 0.95, 0.55 if e >= 4 else 0.42), t0)
        # pad: swell under proof, recap, close
        if e >= 4 or (t0 >= close):
            put("pad", pad(chord, BAR + 0.4, 0.75 if e >= 5 else 0.45), t0)
        if e == 2:
            put("pad", pad(chord, BAR + 0.4, 0.25), t0)

    # the answer to the motif on the close: B D F# then up to D (resolved), then the final D chord
    for i, n in enumerate([71, 74, 78, 86]):
        put("piano", piano(n, 4.5, 0.45), close + 0.5 + i * BEAT)
    for n in (50, 57, 62, 66, 69):
        put("piano", piano(n, 7.0, 0.38), end + 0.2)
    put("pad", pad([50, 57, 62, 66], 6.0, 0.6), end)

    gains = {"piano": 1.0, "marimba": 0.8, "pad": 1.0, "bass": 0.9}
    pans = {"piano": -0.12, "marimba": 0.18, "pad": 0.0, "bass": 0.0}
    left = sum(mix[k] * gains[k] * (1 - pans[k]) for k in mix)
    right = sum(mix[k] * gains[k] * (1 + pans[k]) for k in mix)
    # a little room: short feedback-free reverb by summed delays
    def room(x: np.ndarray) -> np.ndarray:
        y = x.copy()
        for d, g in ((0.029, 0.25), (0.047, 0.2), (0.071, 0.16), (0.113, 0.12), (0.157, 0.09), (0.211, 0.06)):
            n = int(d * SR)
            y[n:] += g * x[:-n]
        return y
    st_ = np.stack([room(left), room(right)], axis=1)
    n_total = int(total * SR)
    st_ = st_[: n_total + int(1.0 * SR)]
    fade = np.minimum(1, np.arange(len(st_)) / (1.5 * SR))[:, None]
    tail = np.clip((len(st_) - np.arange(len(st_))) / (3.0 * SR), 0, 1)[:, None]
    st_ *= fade * tail
    st_ /= np.max(np.abs(st_)) + 1e-9
    st_ *= 10 ** (-1 / 20)
    OUT.parent.mkdir(parents=True, exist_ok=True)
    with wave.open(str(OUT), "wb") as w:
        w.setnchannels(2); w.setsampwidth(2); w.setframerate(SR)
        w.writeframes((st_ * 32767).astype(np.int16).tobytes())
    print(f"music {len(st_) / SR:.1f}s -> {OUT} (turn {turn:.1f}s, verdict {verdict:.1f}s, recap {recap:.1f}s, end {end:.1f}s)")


if __name__ == "__main__":
    main()
