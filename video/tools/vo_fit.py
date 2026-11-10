#!/usr/bin/env python3
"""Fit voiceover to picture.

Picture is cut first; the VO is written and generated to fit each scene window.

  budget  vo.json            -> word budget per scene, flags lines that won't fit
  fit     vo.json chunks/    -> measures <id>.wav / chunk_N.wav, speeds a line up by at most 8% (Rubber Band) to fit,
                                pads to the scene window, writes vo_fitted/ + report

vo.json:
{
  "wps": 2.4,                 # speaking rate for this voice (measure it once)
  "scenes": [
    {"id": "S1", "duration": 11.0, "lead_in": 0.3, "text": "..."},
    ...
  ]
}
"""
import json, os, re, subprocess, sys, shutil

TEMPO_MIN, TEMPO_MAX = 0.92, 1.08   # beyond this a stretch is audible; rewrite the line instead
TAIL = 0.35                          # breathing room after the last word


def words(t):
    return len(re.findall(r"[\w'’.-]+", t))


def dur(path):
    out = subprocess.run(["ffprobe", "-v", "error", "-show_entries", "format=duration",
                          "-of", "default=nk=1:nw=1", path], capture_output=True, text=True)
    return float(out.stdout.strip())


def budget(cfg):
    wps = cfg.get("wps", 2.4)
    bad = 0
    print(f"{'scene':8} {'win':>6} {'max':>4} {'have':>4}  status")
    for s in cfg["scenes"]:
        win = s["duration"] - s.get("lead_in", 0.3) - TAIL
        cap = int(win * wps)
        have = words(s.get("text", ""))
        status = "ok" if have <= cap else f"CUT {have - cap} words"
        if have and have < cap * 0.45:
            status = "thin (fine if the picture carries it)"
        bad += have > cap
        print(f"{s['id']:8} {s['duration']:6.1f} {cap:4d} {have:4d}  {status}")
    total = sum(words(s.get('text', '')) for s in cfg["scenes"])
    print(f"\ntotal words {total}  ≈ {total / wps:.0f}s of speech at {wps} wps")
    return bad


def fit(cfg, chunk_dir, out_dir="vo_fitted"):
    os.makedirs(out_dir, exist_ok=True)
    report, redo = [], []
    for i, s in enumerate(cfg["scenes"], 1):
        src = None
        for name in (f"{s['id']}.wav", f"chunk_{i}.wav", f"chunk_{s['id']}.wav"):
            p = os.path.join(chunk_dir, name)
            if os.path.exists(p):
                src = p
                break
        if not src:
            if s.get("text"):
                redo.append((s["id"], "missing wav"))
            continue
        lead = s.get("lead_in", 0.3)
        win = s["duration"] - lead - TAIL
        d = dur(src)
        tempo = 1.0
        if d > win:
            tempo = d / win
        elif d < win * 0.6:
            tempo = 1.0  # short is fine: silence after a line is natural
        if tempo > TEMPO_MAX or tempo < TEMPO_MIN:
            redo.append((s["id"], f"needs tempo {tempo:.2f}: shorten the line by ~{int((d - win) * cfg.get('wps', 2.4)) + 1} words or regenerate"))
            tempo = min(max(tempo, TEMPO_MIN), TEMPO_MAX)
        dst = os.path.join(out_dir, f"{s['id']}.wav")
        af = [f"adelay={int(lead * 1000)}:all=1"]
        if abs(tempo - 1) > 0.005:
            # rubberband keeps pitch and formants; fall back to atempo
            af.insert(0, f"rubberband=tempo={tempo:.4f}:formant=preserved" if has_filter("rubberband") else f"atempo={tempo:.4f}")
        af.append(f"apad=whole_dur={s['duration']}")
        af.append(f"atrim=0:{s['duration']}")
        subprocess.run(["ffmpeg", "-y", "-v", "error", "-i", src, "-af", ",".join(af),
                        "-ar", "48000", "-ac", "1", dst], check=True)
        report.append({"id": s["id"], "raw": round(d, 2), "window": round(win, 2), "tempo": round(tempo, 3)})
    json.dump({"scenes": report, "redo": redo}, open(os.path.join(out_dir, "fit_report.json"), "w"), indent=2)
    for r in report:
        print(f"{r['id']:8} raw {r['raw']:5.2f}s  window {r['window']:5.2f}s  tempo {r['tempo']}")
    if redo:
        print("\nREDO:")
        for sid, why in redo:
            print(f"  {sid}: {why}")
    # one continuous track for the mixer
    files = [os.path.join(out_dir, f"{s['id']}.wav") if os.path.exists(os.path.join(out_dir, f"{s['id']}.wav")) else None
             for s in cfg["scenes"]]
    lst = os.path.join(out_dir, "concat.txt")
    with open(lst, "w") as f:
        for s, p in zip(cfg["scenes"], files):
            if p is None:
                p = os.path.join(out_dir, f"{s['id']}_silence.wav")
                subprocess.run(["ffmpeg", "-y", "-v", "error", "-f", "lavfi", "-i", "anullsrc=r=48000:cl=mono",
                                "-t", str(s["duration"]), p], check=True)
            f.write(f"file '{os.path.abspath(p)}'\n")
    subprocess.run(["ffmpeg", "-y", "-v", "error", "-f", "concat", "-safe", "0", "-i", lst,
                    "-c", "pcm_s16le", os.path.join(out_dir, "vo_full.wav")], check=True)
    print(f"\nwrote {out_dir}/vo_full.wav")
    return len(redo)


_filters = None


def has_filter(name):
    global _filters
    if _filters is None:
        _filters = subprocess.run(["ffmpeg", "-hide_banner", "-filters"], capture_output=True, text=True).stdout
    return f" {name} " in _filters


if __name__ == "__main__":
    if len(sys.argv) < 3 or sys.argv[1] not in ("budget", "fit"):
        sys.exit(__doc__)
    cfg = json.load(open(sys.argv[2]))
    if sys.argv[1] == "budget":
        sys.exit(1 if budget(cfg) else 0)
    if not shutil.which("ffmpeg"):
        sys.exit("ffmpeg not found")
    sys.exit(1 if fit(cfg, sys.argv[3] if len(sys.argv) > 3 else "chunks") else 0)
