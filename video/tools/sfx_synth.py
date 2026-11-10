#!/usr/bin/env python3
"""Synthesise a small, original SFX kit (nothing licensed, nothing Content-ID-able) and build the
film's whole effects track as ONE wav in numpy (never 30 delayed inputs to one ffmpeg amix).

  python sfx_synth.py kit [audio/sfx]                 -> whoosh, whoosh_heavy, click, tick, riser, hit, ping, chime, shimmer, flash
  python sfx_synth.py track cues.json sfx_track.wav   -> one 48 kHz stereo track, every hit placed so its PEAK lands on the cue

cues.json: {"duration": 182.4, "cues": [{"t": 11.8, "sfx": "whoosh", "db": -10}, {"t": 64.0, "sfx": "riser", "db": -12, "align": "end"}]}
  align: "peak" (default; transient on the frame), "start", or "end" (risers: finish exactly on t).
Levels: every effect 6-12 dB under the voice; one sound per meaningful event, not per animation.
Library files (Kenney CC0, Freesound CC0, Sonniss) can sit in the same folder and be cued by file stem.
"""
import json, os, sys, wave
import numpy as np

SR = 48000
rng = np.random.default_rng(7)


def norm(x, peak=0.9):
    m = np.max(np.abs(x)) + 1e-9
    return x / m * peak


def env(n, a, d, curve=2.0):
    t = np.arange(n) / SR
    e = np.minimum(1, t / max(a, 1e-4)) * np.exp(-np.maximum(0, t - a) * curve / max(d, 1e-4))
    return e


def bandnoise(n, f_lo, f_hi):
    x = rng.standard_normal(n)
    X = np.fft.rfft(x)
    f = np.fft.rfftfreq(n, 1 / SR)
    X[(f < f_lo) | (f > f_hi)] = 0
    return np.fft.irfft(X, n)


def sweep_noise(dur, f0, f1, f2):
    """pink-ish noise through a band that sweeps f0 -> f1 -> f0' (the classic whoosh)."""
    n = int(dur * SR)
    win, hop = 4096, 1024                      # Hann overlap-add: no zipper between blocks
    out = np.zeros(n + win)
    w = np.hanning(win)
    for i in range(0, n, hop):
        p = i / n
        fc = f0 + (f1 - f0) * np.sin(np.pi * p) if f2 is None else (f0 + (f1 - f0) * (p / 0.6) if p < 0.6 else f1 + (f2 - f1) * ((p - 0.6) / 0.4))
        out[i:i + win] += bandnoise(win, fc * 0.6, fc * 1.6) * w
    out = out[:n]
    shape = np.sin(np.pi * np.linspace(0, 1, n)) ** 1.5
    return out * shape


def kit():
    k = {}
    k["whoosh"] = norm(sweep_noise(0.6, 300, 3600, None)) * 0.8
    k["whoosh_heavy"] = norm(sweep_noise(1.0, 120, 2200, None) + 0.4 * np.sin(2 * np.pi * 50 * np.arange(int(SR)) / SR) * np.hanning(int(SR)))
    n = int(0.03 * SR); t = np.arange(n) / SR
    k["click"] = norm(np.sin(2 * np.pi * 2200 * t) * np.exp(-t * 160) + 0.3 * bandnoise(n, 2000, 9000) * np.exp(-t * 300)) * 0.7
    n = int(0.05 * SR); t = np.arange(n) / SR
    k["tick"] = norm(np.sin(2 * np.pi * 3400 * t) * np.exp(-t * 120)) * 0.5
    n = int(1.5 * SR); t = np.arange(n) / SR
    riser = 0.25 * np.sin(2 * np.pi * (200 * t + 300 * t * t)) + 0.5 * bandnoise(n, 2000, 12000) * (t / t[-1]) ** 2
    k["riser"] = norm(riser * (np.exp(3 * t / t[-1]) - 1) / (np.e ** 3 - 1))
    n = int(0.9 * SR); t = np.arange(n) / SR
    k["hit"] = norm(np.sin(2 * np.pi * (55 + 80 * np.exp(-30 * t)) * t) * np.exp(-6 * t) + 0.15 * bandnoise(n, 60, 3000) * np.exp(-25 * t))
    n = int(1.2 * SR); t = np.arange(n) / SR
    k["ping"] = norm(sum(np.sin(2 * np.pi * f * t) * a for f, a in ((1318.5, 1), (2637, 0.25))) * np.exp(-4 * t)) * 0.6
    n = int(1.8 * SR); t = np.arange(n) / SR
    k["chime"] = norm(sum(np.sin(2 * np.pi * f * t) * np.exp(-3 * t) * (t > d) for f, d in ((880, 0), (1108.7, 0.09), (1318.5, 0.18)))) * 0.6
    n = int(2.0 * SR); t = np.arange(n) / SR
    k["shimmer"] = norm(bandnoise(n, 5000, 14000) * np.sin(np.pi * t / t[-1]) ** 2 * (0.6 + 0.4 * np.sin(2 * np.pi * 7 * t)))
    n = int(0.12 * SR); t = np.arange(n) / SR
    k["flash"] = norm(bandnoise(n, 3000, 16000) * np.exp(-t * 40)) * 0.5   # the 2-frame white flash
    return k


def write(path, x):
    x = np.clip(x, -1, 1)
    if x.ndim == 1:
        x = np.stack([x, x], 1)
    with wave.open(path, "wb") as w:
        w.setnchannels(2); w.setsampwidth(2); w.setframerate(SR)
        w.writeframes((x * 32767).astype(np.int16).tobytes())


def read(path):
    import subprocess
    raw = subprocess.run(["ffmpeg", "-v", "error", "-i", path, "-ac", "2", "-ar", str(SR), "-f", "f32le", "-"],
                         capture_output=True, check=True).stdout
    return np.frombuffer(raw, dtype=np.float32).reshape(-1, 2).astype(np.float64)


def main():
    if len(sys.argv) < 2 or sys.argv[1] not in ("kit", "track"):
        sys.exit(__doc__)
    if sys.argv[1] == "kit":
        d = sys.argv[2] if len(sys.argv) > 2 else "audio/sfx"
        os.makedirs(d, exist_ok=True)
        for name, x in kit().items():
            write(os.path.join(d, f"{name}.wav"), x)
        print(f"kit -> {d}/ ({', '.join(kit().keys())})")
        return
    cues = json.load(open(sys.argv[2]))
    out = sys.argv[3]
    lib = cues.get("dir", "audio/sfx")
    D = float(cues["duration"])
    track = np.zeros((int(D * SR) + SR, 2))
    cache = {}
    for c in cues["cues"]:
        name = c["sfx"]
        if name not in cache:
            p = next((os.path.join(lib, name + e) for e in (".wav", ".mp3", ".ogg", ".flac") if os.path.exists(os.path.join(lib, name + e))), None)
            if not p:
                sys.exit(f"missing sfx '{name}' in {lib}")
            cache[name] = read(p)
        x = cache[name] * 10 ** (c.get("db", -10) / 20)
        mono = np.abs(x).sum(1)
        align = c.get("align", "peak")
        off = int(np.argmax(mono)) if align == "peak" else (len(x) if align == "end" else 0)
        start = int(c["t"] * SR) - off
        a, b = max(0, start), min(len(track), start + len(x))
        if b > a:
            track[a:b] += x[a - start:b - start]
    track = track[: int(D * SR)]
    peak = np.max(np.abs(track))
    if peak > 0.98:
        track *= 0.98 / peak
    write(out, track)
    print(f"{len(cues['cues'])} cues -> {out} ({D:.1f}s)")


if __name__ == "__main__":
    main()
