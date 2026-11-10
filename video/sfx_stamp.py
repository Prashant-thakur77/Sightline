#!/usr/bin/env python3
"""The film's own sound for the register snap: a paper-stamp thud (low thump + a short paper rustle), synthesised.
  python3 video/sfx_stamp.py   -> video/audio/sfx/stamp.wav"""
import wave
from pathlib import Path
import numpy as np
SR = 48000
rng = np.random.default_rng(3)
t = np.arange(int(0.6 * SR)) / SR
f = 70 * np.exp(-t / 0.08) + 48                       # pitch drops: a soft thump
thump = np.sin(2 * np.pi * np.cumsum(f) / SR) * np.exp(-t / 0.09)
noise = rng.standard_normal(len(t))
# paper: band-limited noise, very short, with a second tiny flick
k = np.ones(9) / 9
paper = (noise - np.convolve(noise, k, "same")) * (np.exp(-t / 0.018) + 0.35 * np.exp(-np.maximum(0, t - 0.045) / 0.012) * (t > 0.045))
y = 0.9 * thump + 0.28 * paper
y = y / np.max(np.abs(y)) * 0.9
st = np.stack([y, np.roll(y, 24)], 1)
out = Path(__file__).resolve().parent / "audio" / "sfx" / "stamp.wav"
out.parent.mkdir(parents=True, exist_ok=True)
with wave.open(str(out), "wb") as w:
    w.setnchannels(2); w.setsampwidth(2); w.setframerate(SR)
    w.writeframes((st * 32767).astype(np.int16).tobytes())
print(out)
