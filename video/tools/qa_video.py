#!/usr/bin/env python3
"""Check a rendered video before anyone else sees it.

  python qa_video.py final.mp4 [--limit 180] [--scenes film.json] [--sheet qa/] [--vo vo_full.wav]
  --vo: find gaps with no voice on the voice track itself (silence detection on the mix never fires under music)

Reports: duration vs limit, resolution/fps/codec, integrated loudness + true peak,
black frames, frozen stretches, silent stretches (dead air), and writes a contact sheet
(one frame every few seconds + one at each scene midpoint) so you can LOOK at it.
Exit code 1 on hard failures.
"""
import json, os, re, subprocess, sys


def sh(cmd):
    return subprocess.run(cmd, capture_output=True, text=True)


def main():
    if len(sys.argv) < 2:
        sys.exit(__doc__)
    f = sys.argv[1]
    opt = lambda k, d: sys.argv[sys.argv.index(k) + 1] if k in sys.argv else d
    limit = float(opt("--limit", 0))
    sheet = opt("--sheet", "qa")
    fails, warns = [], []

    p = json.loads(sh(["ffprobe", "-v", "error", "-show_streams", "-show_format", "-of", "json", f]).stdout)
    v = next(s for s in p["streams"] if s["codec_type"] == "video")
    a = next((s for s in p["streams"] if s["codec_type"] == "audio"), None)
    D = float(p["format"]["duration"])
    fps = eval(v["r_frame_rate"])
    print(f"{f}: {D:.1f}s  {v['width']}x{v['height']} @ {fps:.2f}fps  {v['codec_name']}/{v.get('pix_fmt')}  "
          f"audio {a['codec_name'] if a else 'NONE'}")
    if v["height"] < 1080:
        warns.append(f"height {v['height']} < 1080: small text will blur on YouTube")
    if v.get("pix_fmt") != "yuv420p":
        warns.append("pix_fmt not yuv420p: some players show black")
    if not a:
        fails.append("no audio stream")
    if limit:
        over = D - limit
        if over > 0:
            warns.append(f"{over:.0f}s over the {limit:.0f}s guidance; fine only if the extra time earns its keep "
                         f"(judges may stop at the limit - the core demo + proof must land before it)")

    if a:
        st = sh(["ffmpeg", "-hide_banner", "-i", f, "-af", "ebur128=peak=true", "-f", "null", "-"]).stderr
        I = re.findall(r"I:\s+(-?[\d.]+) LUFS", st)
        TP = re.findall(r"Peak:\s+(-?[\d.]+) dBFS", st)
        if I:
            i = float(I[-1]); tp = float(TP[-1]) if TP else 0
            print(f"loudness {i:.1f} LUFS, true peak {tp:.1f} dBTP")
            if not -16 <= i <= -12:
                warns.append(f"loudness {i:.1f} LUFS, aim -14")
            if tp > -1.0:
                fails.append(f"true peak {tp:.1f} dBTP: aim -1.5 or lower (AAC overshoots)")
        src = opt("--vo", f)
        sil = sh(["ffmpeg", "-hide_banner", "-i", src, "-af", "silencedetect=n=-40dB:d=2.5", "-f", "null", "-"]).stderr
        for s, e in zip(re.findall(r"silence_start: ([\d.]+)", sil), re.findall(r"silence_end: ([\d.]+)", sil)):
            warns.append(f"no voice {float(s):.1f}-{float(e):.1f}s (rule: a voice is almost always speaking)")

    vf = sh(["ffmpeg", "-hide_banner", "-i", f, "-vf", "blackdetect=d=0.4:pix_th=0.06,freezedetect=n=0.003:d=2.5",
             "-an", "-f", "null", "-"]).stderr
    for s, e in re.findall(r"black_start:([\d.]+) black_end:([\d.]+)", vf):
        if float(s) > 0.2 and float(e) < D - 0.5:
            warns.append(f"black {float(s):.1f}-{float(e):.1f}s")
    for s in re.findall(r"freeze_start: ([\d.]+)", vf):
        warns.append(f"static picture from {float(s):.1f}s (2.5 s+ with no motion: add a drift, a push or a cut)")

    os.makedirs(sheet, exist_ok=True)
    for old in os.listdir(sheet):
        if old.startswith("t") and old.endswith(".jpg"):
            os.remove(os.path.join(sheet, old))
    times = [t for t in range(1, int(D), max(3, int(D // 40)))]
    if "--scenes" in sys.argv:
        sc = json.load(open(opt("--scenes", "")))
        t = 0
        for s in sc.get("scenes", sc):
            times.append(t + s["duration"] / 2); t += s["duration"]
    stamps = sorted(set(round(x, 1) for x in times))
    for k, t in enumerate(stamps):
        sh(["ffmpeg", "-y", "-v", "error", "-ss", str(t), "-i", f, "-frames:v", "1", "-q:v", "3",
            os.path.join(sheet, f"t{int(t * 10):05d}.jpg")])
    sh(["ffmpeg", "-y", "-v", "error", "-pattern_type", "glob", "-i", os.path.join(sheet, "t*.jpg"),
        "-vf", f"scale=480:-1,tile=5x{max(1, -(-len(stamps) // 5))}:padding=4", "-frames:v", "1", os.path.join(sheet, "contact_sheet.jpg")])
    print(f"frames + contact sheet in {sheet}/ - open and look at them")

    for w in warns:
        print("WARN ", w)
    for x in fails:
        print("FAIL ", x)
    sys.exit(1 if fails else 0)


if __name__ == "__main__":
    main()
