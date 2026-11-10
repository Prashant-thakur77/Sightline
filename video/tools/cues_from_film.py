#!/usr/bin/env python3
"""Derive every SFX cue (and the arch3d word cues) from film.json, so sounds land on the frames things happen.

  python cues_from_film.py video/film/film.json [--captions video/film/public/captions.json] [--write] [--out video/sfx_cues.json]

Reads the same timing rules the template components use:
  transitions        soft whoosh peaking mid-transition (heavy whoosh for zoom/blur)
  screen events      a click on every logged click (events.json from capture.mjs, in public/)
  proof              low hit on the frame the delta badge pops
  arch3d             soft tick as each slab rises; tick + hit when the danger packet is blocked; chime on "approved"
  endcard            hit as the name lands
  scene "riserInto"  a riser ending exactly on that scene's first frame (the recap, the biggest reveal)
  scene "sfx"        extra cues relative to the scene start: [{"at": 1.2, "sfx": "ping", "db": -12}]
With --captions, arch3d scenes that have "cueWords": {"layerId": "word"} get "cues" filled with the second (from the
scene start) that the word is spoken; --write saves them into film.json. Output feeds sfx_synth.py track.
"""
import json, os, re, sys

FPS_DEFAULT = 30


def main():
    if len(sys.argv) < 2:
        sys.exit(__doc__)
    opt = lambda k, d: sys.argv[sys.argv.index(k) + 1] if k in sys.argv else d
    fp = sys.argv[1]
    film = json.load(open(fp))
    fps = film.get("fps", FPS_DEFAULT)
    pub = os.path.join(os.path.dirname(fp), "public")
    caps = json.load(open(opt("--captions", ""))) if "--captions" in sys.argv else None
    out = opt("--out", "sfx_cues.json")
    R = lambda x: round(x)
    cues, t0 = [], 0.0
    scenes = film["scenes"]
    for i, s in enumerate(scenes):
        d = float(s["duration"])
        f0 = R(t0 * fps)
        if s.get("riserInto"):
            cues.append({"t": round(t0, 3), "sfx": "riser", "db": -12, "align": "end"})
        tr = s.get("transition") or {}
        if i < len(scenes) - 1 and tr.get("type", "cut") != "cut":
            td = tr.get("dur", 0.5)
            cues.append({"t": round(t0 + d + td / 2, 3), "sfx": "whoosh_heavy" if tr["type"] in ("zoom", "blur") else "whoosh", "db": -14})
        typ = s["type"]
        if typ == "screen" and s.get("events"):
            p = os.path.join(pub, s["events"])
            if os.path.exists(p):
                rate, trim = s.get("playbackRate", 1), s.get("trimBefore", 0)
                for e in json.load(open(p)).get("events", []):
                    at = (e["t"] - trim) / rate
                    if e["type"] == "click" and 0 <= at < d:
                        cues.append({"t": round(t0 + at, 3), "sfx": "click", "db": -16})
        if typ == "proof":
            n = len(s["rows"])
            badge = 12 + n * R(fps * 0.45) + R(fps * 0.5)
            cues.append({"t": round((f0 + badge) / fps, 3), "sfx": "hit", "db": -10})
        if typ == "arch3d":
            layers = s["layers"]
            if caps and s.get("cueWords"):
                found = {}
                for lid, word in s["cueWords"].items():
                    for c in caps:
                        ts = c["startMs"] / 1000
                        if t0 <= ts < t0 + d and re.search(word, c["text"], re.I):
                            found[lid] = round(ts - t0, 2)
                            break
                s["cues"] = {**s.get("cues", {}), **found}
                print(f"{s['id']}: cues from words {found}")
            n = len(layers)
            rise = [R((s.get("cues", {}).get(l["id"], 0.5 + k * (d * 0.45) / n)) * fps) for k, l in enumerate(layers)]
            for r in rise:
                cues.append({"t": round((f0 + r) / fps, 3), "sfx": "tick", "db": -20})
            done = rise[-1] + R(fps * 0.6)
            ids = [l["id"] for l in layers]
            if s.get("blockedAt") in ids:
                stop = done + R(fps * 1.2) + R(fps * 0.45) * (ids.index(s["blockedAt"]) + 1)
                cues += [{"t": round((f0 + stop) / fps, 3), "sfx": "tick", "db": -14}, {"t": round((f0 + stop) / fps + 0.08, 3), "sfx": "hit", "db": -12}]
            if s.get("humanAt") in ids:
                pulse = done + R(fps * 0.45) * (ids.index(s["humanAt"]) + 1)
                cues.append({"t": round((f0 + pulse) / fps, 3), "sfx": "chime", "db": -16})
        if typ == "endcard":
            cues.append({"t": round(t0 + 4 / fps + 0.25, 3), "sfx": "hit", "db": -12})
        for c in s.get("sfx", []):
            cues.append({"t": round(t0 + c["at"], 3), "sfx": c["sfx"], "db": c.get("db", -12), "align": c.get("align", "peak")})
        t0 += d
    cues.sort(key=lambda c: c["t"])
    json.dump({"duration": round(t0, 3), "dir": "audio/sfx", "cues": cues}, open(out, "w"), indent=1)
    print(f"{len(cues)} cues over {t0:.1f}s -> {out}")
    if "--write" in sys.argv:
        json.dump(film, open(fp, "w"), indent=2, ensure_ascii=False)
        print(f"wrote arch3d cues into {fp}")


if __name__ == "__main__":
    main()
