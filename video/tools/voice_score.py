#!/usr/bin/env python3
"""Score narrator auditions: duration, words per minute, pitch median and range (p10-p90 semitones), via librosa pyin.
  python voice_score.py narration/audition.json narration/audition/<voice> [...]"""
import json, sys, re
import numpy as np, librosa
lines = json.load(open(sys.argv[1]))
for d in sys.argv[2:]:
    rep = json.load(open(f"{d}/report.json"))
    tot_w = tot_s = 0; f0s = []
    for ln in lines:
        y, sr = librosa.load(f"{d}/{ln['id']}.wav", sr=16000)
        yt, _ = librosa.effects.trim(y, top_db=35)
        tot_s += len(yt) / sr; tot_w += len(re.findall(r"[A-Za-z0-9']+", ln.get("spoken", ln["caption"])))
        f0, v, _ = librosa.pyin(yt, fmin=70, fmax=500, sr=sr)
        f0s += list(f0[v & ~np.isnan(f0)])
    f0s = np.array(f0s); p10, p50, p90 = np.percentile(f0s, [10, 50, 90])
    print(f"{d.split('/')[-1]:24s} wpm {60*tot_w/tot_s:5.0f}  pitch {p50:4.0f} Hz  range {12*np.log2(p90/p10):4.1f} st  "
          + "  ".join(f"{k} {v['score']:.2f}" for k, v in rep.items()))
