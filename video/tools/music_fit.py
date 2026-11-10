#!/usr/bin/env python3
"""Which track fits this film, and where in the track should the film start?

  python music_fit.py sound_map.json beats_a.json beats_b.json ...

sound_map.json is the film's intended energy, written from the storyboard:
  {"duration": 184, "beats": [{"t": 0, "energy": 1, "name": "moment"}, {"t": 36, "energy": 3, "name": "turn"},
                              {"t": 150, "energy": 5, "name": "recap"}, {"t": 170, "energy": 2, "name": "close"}],
   "hits": {"turn": 36.0, "recap": 150.0}}
energy 1-5 holds until the next beat. beats_*.json come from beat_map.py.

For each track: tries every bar-aligned start offset (and loop-free fits only), scores the correlation between the
film's energy and the track's loudness, and reports the best offset, where the track's drops land relative to the
film's hits, and the bars to cut if the track is shorter than the film. Then pick by ear among the top two.
"""
import json, sys
import numpy as np


def film_curve(m):
    D = int(m["duration"])
    c = np.zeros(D)
    beats = sorted(m["beats"], key=lambda b: b["t"])
    for i, b in enumerate(beats):
        end = beats[i + 1]["t"] if i + 1 < len(beats) else D
        c[int(b["t"]):int(end)] = b["energy"]
    return (c - c.mean()) / (c.std() + 1e-9)


def main():
    if len(sys.argv) < 3:
        sys.exit(__doc__)
    m = json.load(open(sys.argv[1]))
    fc = film_curve(m)
    D = len(fc)
    rows = []
    for path in sys.argv[2:]:
        b = json.load(open(path))
        e = np.array(b["energy_db_per_sec"], dtype=float)
        bars = [x for x in b.get("bars", [0])] or [0]
        best = (-9, 0)
        for off in bars:
            o = int(off)
            seg = e[o:o + D]
            if len(seg) < D * 0.6:
                continue
            f = fc[:len(seg)]
            s = (seg - seg.mean()) / (seg.std() + 1e-9)
            r = float(np.dot(f, s) / len(seg))
            if r > best[0]:
                best = (r, off)
        r, off = best
        if r == -9:
            print(f"{path}\n  too short: {len(e)}s for a {D}s film (needs >= 60% before any repeat); skip it or plan a bar repeat")
            continue
        short = max(0, D - (len(e) - int(off)))
        drops = [round(d - off, 1) for d in b.get("drops", []) if 0 <= d - off <= D]
        hits = m.get("hits", {})
        near = {k: min(drops, key=lambda d: abs(d - v)) if drops else None for k, v in hits.items()}
        rows.append((r, path, off, short, drops, near, b.get("bpm")))
    rows.sort(reverse=True)
    for r, path, off, short, drops, near, bpm in rows:
        print(f"{path}\n  fit {r:+.2f}  start the track at {off:.2f}s  bpm {bpm}  drops at film {drops}")
        for k, d in near.items():
            if d is not None:
                print(f"  hit '{k}' at {m['hits'][k]}s, nearest drop {d}s ({d - m['hits'][k]:+.1f}s: move the cut or edit bars)")
        if short:
            print(f"  track is {short:.0f}s short: repeat a mid section on bar boundaries BEFORE its outro, never loop the fade")
    print("\nfit > +0.4 usually works; < 0.2 means the track's arc fights the story. Confirm by ear on the turn and the recap.")


if __name__ == "__main__":
    main()
