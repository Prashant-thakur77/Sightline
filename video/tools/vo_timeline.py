#!/usr/bin/env python3
"""Voice-first timeline: the chosen takes' real durations decide every scene's length.

  python vo_timeline.py narration.json narration/takes [--film video/film/film.json --write] [--out narration]

For each scene: lead-in, then each line's take followed by a pause set by how the line ends (varied a little so it
doesn't sound read-out), then a hold. Scene duration = max(voice time, the scene's "min" in film.json).
Writes (in --out):
  vo_full.wav     every take placed sample-exactly in one track (numpy, no adelay drift)
  timeline.json   line starts/ends and scene starts/durations, in seconds
  script.txt      the captions in order (input for captions.py)
With --write, updates each scene's "duration" in film.json (scenes without narration keep theirs).

Pauses (seconds after a line): "." 0.55-0.75, "?" 0.7-0.9, ":" 0.4-0.5, "," 0.25-0.3, otherwise 0.5. Lead-in 0.3,
hold 0.45 (scene "hold" overrides). Minimum scene lengths by type (arch3d 15 s, proof 5.5 s...) keep the picture
readable; if the voice is much shorter than that, write more narration (a voice is almost always speaking). A scene marked {"pauseBefore": 0.5} in narration gets a reveal pause before its
first line (use for the one or two biggest numbers only).
"""
import json, os, subprocess, sys
import numpy as np

SR = 48000
# a scene never gets shorter than its picture needs (override per scene with "min" in film.json)
TYPE_MIN = {"arch3d": 15, "proof": 5.5, "endcard": 4.5, "persona": 5, "diagram": 6, "code": 5, "device3d": 4,
            "kinetic": 2.5, "hero3d": 3, "screen": 3}


def load(path):
    raw = subprocess.run(["ffmpeg", "-v", "error", "-i", path, "-ac", "1", "-ar", str(SR), "-f", "f32le", "-"],
                         capture_output=True, check=True).stdout
    return np.frombuffer(raw, dtype=np.float32)


def gap(text, k):
    t = text.rstrip()
    lo, hi = (0.55, 0.75) if t.endswith(".") else (0.7, 0.9) if t.endswith("?") else (0.4, 0.5) if t.endswith(":") \
        else (0.25, 0.3) if t.endswith(",") else (0.5, 0.5)
    return lo + (hi - lo) * ((k * 0.618) % 1)   # deterministic variation


def main():
    if len(sys.argv) < 3:
        sys.exit(__doc__)
    opt = lambda key, d: sys.argv[sys.argv.index(key) + 1] if key in sys.argv else d
    lines = json.load(open(sys.argv[1]))
    takes = sys.argv[2]
    out = opt("--out", "narration")
    film_path = opt("--film", None)
    film = json.load(open(film_path)) if film_path else None
    os.makedirs(out, exist_ok=True)

    order = [s["id"] for s in film["scenes"]] if film else list(dict.fromkeys(l["scene"] for l in lines))
    by_scene = {sid: [l for l in lines if l["scene"] == sid] for sid in order}
    meta = {s["id"]: s for s in film["scenes"]} if film else {}
    t, k, placed, scenes = 0.0, 0, [], []
    for sid in order:
        start = t
        ls = by_scene.get(sid, [])
        sc = meta.get(sid, {})
        if not ls:
            d = float(sc.get("duration", 0))
            scenes.append({"id": sid, "start": round(start, 3), "duration": round(d, 3), "voice": False})
            t += d
            continue
        cur = start + float(sc.get("leadIn", 0.3))
        for l in ls:
            cur += float(l.get("pauseBefore", 0))
            wav = os.path.join(takes, f"{l['id']}.wav")
            if not os.path.exists(wav):
                sys.exit(f"missing take {wav}: run tts_takes.py first")
            x = load(wav)
            placed.append((cur, x, l))
            cur += len(x) / SR
            cur += gap(l.get("caption", l.get("spoken", "")), k)
            k += 1
        cur += float(sc.get("hold", 0.45)) - 0.5   # the last gap already gave ~0.5 s
        d = max(cur - start, float(sc.get("min", TYPE_MIN.get(sc.get("type"), 0))))
        d = round(d * 30) / 30                      # frame-exact at 30 fps
        scenes.append({"id": sid, "start": round(start, 3), "duration": round(d, 3), "voice": True})
        t = start + d

    total = t
    track = np.zeros(int(total * SR) + SR, dtype=np.float32)
    rows = []
    for at, x, l in placed:
        a = int(round(at * SR))
        track[a:a + len(x)] += x[: max(0, len(track) - a)]
        rows.append({"id": l["id"], "scene": l["scene"], "start": round(at, 3), "end": round(at + len(x) / SR, 3),
                     "caption": l.get("caption", "")})
    track = track[: int(total * SR)]
    import wave
    with wave.open(os.path.join(out, "vo_full.wav"), "wb") as w:
        w.setnchannels(1); w.setsampwidth(2); w.setframerate(SR)
        w.writeframes((np.clip(track, -1, 1) * 32767).astype(np.int16).tobytes())
    json.dump({"duration": round(total, 3), "scenes": scenes, "lines": rows}, open(os.path.join(out, "timeline.json"), "w"), indent=1)
    open(os.path.join(out, "script.txt"), "w").write("\n".join(r["caption"] for r in rows) + "\n")
    for s in scenes:
        print(f"{s['id']:8} start {s['start']:7.2f}  dur {s['duration']:6.2f}{'' if s['voice'] else '  (no voice: kept)'}")
    print(f"total {total:.2f}s -> {out}/vo_full.wav, timeline.json, script.txt")
    if film and "--write" in sys.argv:
        d = {s["id"]: s["duration"] for s in scenes}
        for s in film["scenes"]:
            s["duration"] = d.get(s["id"], s["duration"])
        json.dump(film, open(film_path, "w"), indent=2, ensure_ascii=False)
        print(f"updated durations in {film_path}")


if __name__ == "__main__":
    main()
