#!/usr/bin/env python3
"""How far the music sits under the voice: rebuilds the ducked music stem exactly as mix.py does, then compares
voice RMS vs ducked-music RMS where the voice speaks, and music under the voice vs music in the gaps.
  python music_vs_voice.py mix.json"""
import json, subprocess, sys
import numpy as np
m = json.load(open(sys.argv[1])); D = m["duration"]; d = m.get("duck", {}); mu = m["music"][0]
def pcm(args):
    raw = subprocess.run(["ffmpeg", "-v", "error", *args, "-ac", "1", "-ar", "16000", "-f", "f32le", "-"], capture_output=True, check=True).stdout
    return np.frombuffer(raw, np.float32)
vo = pcm(["-i", m["vo"], "-af", f"highpass=f=80,acompressor=threshold=-20dB:ratio=3:attack=5:release=120,apad=whole_dur={D},atrim=0:{D}"])
graph = (f"[0:a]aformat=sample_rates=48000:channel_layouts=stereo,atrim=0:{D},volume={mu.get('gain_db',-6)}dB,apad=whole_dur={D}[mu];"
         f"[1:a]aformat=sample_rates=48000:channel_layouts=stereo,apad=whole_dur={D},atrim=0:{D}[k];"
         f"[mu][k]sidechaincompress=threshold={d.get('threshold',0.03)}:ratio={d.get('ratio',8)}:attack={d.get('attack',20)}:release={d.get('release',400)}:makeup=1[o]")
mus = pcm(["-i", mu["file"], "-i", m["vo"], "-filter_complex", graph, "-map", "[o]"])
n = min(len(vo), len(mus)); vo, mus = vo[:n], mus[:n]
w = 1600  # 100 ms windows
k = n // w
rv = np.sqrt((vo[:k*w].reshape(k, w) ** 2).mean(1) + 1e-12); rm = np.sqrt((mus[:k*w].reshape(k, w) ** 2).mean(1) + 1e-12)
speak = rv > 0.02
db = lambda x: 20 * np.log10(np.mean(x) + 1e-12)
print(f"voice over music while speaking: {db(rv[speak]) - db(rm[speak]):.1f} dB")
print(f"music in gaps vs under voice:   {db(rm[~speak]) - db(rm[speak]):+.1f} dB  (gaps {np.sum(~speak)/10:.1f} s)")
