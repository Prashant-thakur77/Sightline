#!/usr/bin/env python3
"""Measure the final film the way the winner films were measured, and print it beside their median.

  python bench.py final.mp4 film/film.json narration/vo_full.wav film/public/captions/captions.json mix.json

Cuts: ffmpeg scene detection (> 0.3) plus every scene boundary from film.json (similar UI shots under-count).
Static: longest stretch where the mean frame difference stays under a small threshold (sampled at 5 fps).
"""
import json, re, subprocess, sys
import numpy as np

mp4, film_p, vo_p, caps_p, mix_p = sys.argv[1:6]
film = json.load(open(film_p))
caps = json.load(open(caps_p))
starts, t = {}, 0.0
for s in film["scenes"]:
    starts[s["id"]] = t
    t += s["duration"]
D = t

# product first: the iris opens on the live verdict in the match cut
tc = next(s for s in film["scenes"] if s["id"] == "tagcut")
product_first = starts["tagcut"] + tc.get("irisAt", 1.35)
pr = next(s for s in film["scenes"] if s["id"] == "proof")
c0 = pr["cards"][0]
proof_lands = starts["proof"] + c0["at"] + (10 + len(c0["rows"]) * 21 + 8) / 30

# wpm over speech and over the whole film
words = len(caps)
# speaking time = first word to last word, minus silences over 2 s (the winners were measured the same way)
ts = sorted((c["startMs"] / 1000, c["endMs"] / 1000) for c in caps)
speech = ts[-1][1] - ts[0][0] - sum(max(0, b[0] - a[1]) for a, b in zip(ts, ts[1:]) if b[0] - a[1] > 2.0)
y = subprocess.run(["ffmpeg", "-v", "error", "-i", vo_p, "-ac", "1", "-ar", "16000", "-f", "f32le", "-"], capture_output=True).stdout
vo = np.frombuffer(y, np.float32)
import librosa
f0, v, _ = librosa.pyin(vo[: 16000 * 180], fmin=70, fmax=500, sr=16000, frame_length=1024)
f0 = f0[v & ~np.isnan(f0)]
p10, p50, p90 = np.percentile(f0, [10, 50, 90])

# loudness
st = subprocess.run(["ffmpeg", "-hide_banner", "-i", mp4, "-af", "ebur128=peak=true", "-f", "null", "-"], capture_output=True, text=True).stderr
lufs = float(re.findall(r"I:\s+(-?[\d.]+) LUFS", st)[-1])

# cuts: scene detect + scene boundaries
sd = subprocess.run(["ffmpeg", "-hide_banner", "-i", mp4, "-vf", "select='gt(scene,0.3)',showinfo", "-f", "null", "-"],
                    capture_output=True, text=True).stderr
det = [float(x) for x in re.findall(r"pts_time:([\d.]+)", sd)]
bounds = list(starts.values())[1:]
cuts = sorted(set([round(x, 1) for x in det + bounds]))
q = [sum(1 for c in cuts if D * i / 4 <= c < D * (i + 1) / 4) / (D / 4 / 60) for i in range(4)]

# static: mean abs diff between frames at 5 fps, 160x90 grey
raw = subprocess.run(["ffmpeg", "-v", "error", "-i", mp4, "-vf", "fps=5,scale=160:90,format=gray", "-f", "rawvideo", "-"], capture_output=True).stdout
fr = np.frombuffer(raw, np.uint8).reshape(-1, 90, 160).astype(np.float32)
diff = np.abs(np.diff(fr, axis=0)).mean(axis=(1, 2))
still = diff < 0.15
longest, run, at, best_at = 0, 0, 0, 0
for i, sflag in enumerate(still):
    run = run + 1 if sflag else 0
    if run > longest:
        longest, best_at = run, i - run + 1
longest_s = longest / 5

mv = subprocess.run([sys.executable, __file__.replace("bench.py", "music_vs_voice.py"), mix_p], capture_output=True, text=True).stdout

rows = [
    ("Length", f"{D // 60:.0f}:{D % 60:04.1f}", "2:52"),
    ("Product working on screen (s)", f"{product_first:.1f}", "< 10"),
    ("Proof number lands (s)", f"{proof_lands:.1f}", "-"),
    ("Words per minute (speech / whole film)", f"{60 * words / speech:.0f} / {60 * words / D:.0f}", "147 (voiced films)"),
    ("Voice pitch median, range p10-p90", f"{p50:.0f} Hz, {12 * np.log2(p90 / p10):.1f} st", ">= 9 st"),
    ("Integrated loudness (LUFS)", f"{lufs:.1f}", "-16.4 (3 of 14 near -14)"),
    ("Music under voice / gap lift", mv.strip().replace("\n", " | "), "mostly not ducked"),
    ("Longest static hold (s)", f"{longest_s:.1f} at {best_at / 5:.1f}s", "19-35 s worst cases"),
    ("Cuts per minute by quarter", " / ".join(f"{x:.0f}" for x in q), "-"),
]
for a, b, c in rows:
    print(f"{a:42s} {b:60s} winners: {c}")
