#!/usr/bin/env python3
"""Map a music track so cuts, reveals and SFX can land on it.

  python beat_map.py track.mp3 [--out beats.json] [--fps 30]

Outputs bpm, beat times, bar starts (every 4 beats), "drops" (biggest energy rises),
"calm" stretches (good under dense narration), and an energy curve per second.
Uses librosa when installed, otherwise a numpy spectral-flux fallback (good enough for
cut timing on produced music; check by ear on the drop).
"""
import json, subprocess, sys
import numpy as np

SR = 22050


def load(path):
    raw = subprocess.run(["ffmpeg", "-v", "error", "-i", path, "-ac", "1", "-ar", str(SR), "-f", "f32le", "-"],
                         capture_output=True, check=True).stdout
    return np.frombuffer(raw, dtype=np.float32)


def flux(y, hop=512, n=2048):
    frames = 1 + (len(y) - n) // hop
    win = np.hanning(n).astype(np.float32)
    idx = np.arange(n)[None, :] + hop * np.arange(frames)[:, None]
    mag = np.abs(np.fft.rfft(y[idx] * win, axis=1))
    mag = np.log1p(10 * mag)
    d = np.diff(mag, axis=0)
    env = np.maximum(d, 0).sum(axis=1)
    env = np.concatenate([[0], env])
    env = (env - env.mean()) / (env.std() + 1e-9)
    return env, hop / SR


def tempo_and_beats(env, dt):
    ac = np.correlate(env, env, mode="full")[len(env) - 1:]
    lags = np.arange(len(ac)) * dt
    ok = (lags > 60 / 190) & (lags < 60 / 70)
    lag = int(np.argmax(np.where(ok, ac, -np.inf)))
    if not ok.any() or ac[lag] <= 0:          # no pulse (pads, drones): assume 120 bpm for the grid
        lag = int(round(0.5 / dt))
    period = max(1, lag)
    bpm = 60 / (period * dt)
    best, best_phase = -1e9, 0
    for ph in range(period):
        s = env[ph::period].sum()
        if s > best:
            best, best_phase = s, ph
    beats = []
    i = best_phase
    while i < len(env):
        lo, hi = max(0, i - 3), min(len(env), i + 4)
        j = lo + int(np.argmax(env[lo:hi]))
        beats.append(j * dt)
        i = j + period
    return float(bpm), beats


def main():
    if len(sys.argv) < 2:
        sys.exit(__doc__)
    path = sys.argv[1]
    out = sys.argv[sys.argv.index("--out") + 1] if "--out" in sys.argv else "beats.json"
    fps = int(sys.argv[sys.argv.index("--fps") + 1]) if "--fps" in sys.argv else 30
    y = load(path)
    dur = len(y) / SR
    try:
        import librosa
        bpm, bf = librosa.beat.beat_track(y=y, sr=SR)
        beats = librosa.frames_to_time(bf, sr=SR).tolist()
        bpm = float(np.atleast_1d(bpm)[0])
    except Exception:
        env, dt = flux(y)
        bpm, beats = tempo_and_beats(env, dt)

    # downbeat: the bar phase (of 4) where loudness changes most, i.e. where sections start
    def loud(t):
        a = int(t * SR)
        return float(np.sqrt(np.mean(y[a:a + SR // 4] ** 2) + 1e-12))
    phase = 0
    if len(beats) > 8:
        rises = [abs(20 * np.log10(loud(b) / loud(max(0, b - 0.25)))) for b in beats]
        phase = int(np.argmax([np.mean(rises[k::4]) for k in range(4)]))
    bar_starts = beats[phase::4]

    sec = int(dur)
    rms = np.array([np.sqrt(np.mean(y[i * SR:(i + 1) * SR] ** 2) + 1e-12) for i in range(sec)])
    db = 20 * np.log10(rms + 1e-9)
    smooth = np.convolve(db, np.ones(3) / 3, mode="same")
    rise = np.diff(smooth, prepend=smooth[0])
    drops = sorted([(float(rise[i]), i) for i in range(2, sec - 2)], reverse=True)
    picked = []
    for r, i in drops:
        if r < 3:
            break
        if all(abs(i - p) > 8 for p in picked):
            picked.append(i)
        if len(picked) == 4:
            break
    # snap each drop to the nearest beat
    def snap(t):
        return min(beats, key=lambda b: abs(b - t)) if beats else t
    drops_t = [round(float(snap(i)), 3) for i in sorted(picked)]
    quiet = smooth < (np.median(smooth) - 3)
    calm, start = [], None
    for i, q in enumerate(quiet):
        if q and start is None:
            start = i
        if (not q or i == sec - 1) and start is not None:
            if i - start >= 4:
                calm.append([start, i])
            start = None
    res = {
        "file": path, "duration": round(dur, 3), "bpm": round(bpm, 1),
        "beats": [round(b, 3) for b in beats],
        "bars": [round(b, 3) for b in bar_starts], "downbeat_phase": phase,
        "drops": drops_t, "calm": calm,
        "energy_db_per_sec": [round(float(x), 1) for x in smooth],
        "frames": {"fps": fps, "bars": [int(round(b * fps)) for b in bar_starts], "drops": [int(round(t * fps)) for t in drops_t]},
    }
    json.dump(res, open(out, "w"), indent=1)
    print(f"{path}: {dur:.1f}s  ~{bpm:.0f} bpm  {len(beats)} beats  drops at {drops_t}  calm {calm}")
    lo, hi = smooth.min(), smooth.max()
    bars = " ▁▂▃▄▅▆▇█"
    print("energy: " + "".join(bars[int((v - lo) / (hi - lo + 1e-9) * 8)] for v in smooth[::max(1, sec // 90)]))
    print(f"wrote {out}")


if __name__ == "__main__":
    main()
