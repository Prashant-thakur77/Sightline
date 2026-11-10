#!/usr/bin/env python3
"""Word-timed captions from the FINAL voice track, spelled the way the script writes them.

  python captions.py vo.wav script.txt [--out captions] [--offset 0]

Transcribes vo.wav with faster-whisper (word timestamps), maps the script's own words onto those times with
difflib (so "2:14", "97%", product names keep their real spelling), then writes:
  captions/captions.json   Remotion Caption[] ({text,startMs,endMs,timestampMs,confidence}) for <Captions>
  captions/film.srt        upload to YouTube (switchable, translatable)
  captions/karaoke.ass     burn-in style: 2-7 word phrases, no box (BorderStyle=1), active word in accent
script.txt: the caption text of every line in order (one line per narration line).
Burn in OR upload the .srt, never both (two overlapping caption sets on YouTube CC).
"""
import difflib, json, os, re, sys


def norm(w):
    return re.sub(r"[^a-z0-9%]", "", w.lower())


def align(script_words, asr_words):
    a = [norm(w) for w in script_words]
    b = [norm(w["word"]) for w in asr_words]
    sm = difflib.SequenceMatcher(None, a, b, autojunk=False)
    out = [None] * len(script_words)
    for tag, i1, i2, j1, j2 in sm.get_opcodes():
        if tag == "equal":
            for k in range(i2 - i1):
                out[i1 + k] = (asr_words[j1 + k]["start"], asr_words[j1 + k]["end"])
        elif j2 > j1:  # replaced/respelled span: spread its time evenly
            s, e = asr_words[j1]["start"], asr_words[j2 - 1]["end"]
            n = i2 - i1
            for k in range(n):
                out[i1 + k] = (s + (e - s) * k / n, s + (e - s) * (k + 1) / n)
    # fill gaps (script words Whisper never heard) from neighbours
    for i, v in enumerate(out):
        if v is None:
            prev = next((out[j][1] for j in range(i - 1, -1, -1) if out[j]), 0)
            nxt = next((out[j][0] for j in range(i + 1, len(out)) if out[j]), prev + 0.3)
            out[i] = (prev, max(prev + 0.05, min(nxt, prev + 0.3)))
    return out


def phrases(words, times, max_words=6, max_chars=34):
    cur, res = [], []
    for w, t in zip(words, times):
        cur.append((w, t))
        txt = " ".join(x for x, _ in cur)
        if len(cur) >= max_words or len(txt) >= max_chars or re.search(r"[.?!,:;]$", w):
            if len(cur) == 1 and res and not re.search(r"[.?!]$", res[-1][-1][0]):
                res[-1].append(cur[0])
            else:
                res.append(cur)
            cur = []
    if cur:
        res.append(cur)
    return res


def ts(t, srt=True):
    h, m, s = int(t // 3600), int(t % 3600 // 60), t % 60
    return f"{h:02d}:{m:02d}:{s:06.3f}".replace(".", ",") if srt else f"{h}:{m:02d}:{s:05.2f}"


def main():
    if len(sys.argv) < 3:
        sys.exit(__doc__)
    vo, script = sys.argv[1], sys.argv[2]
    out = sys.argv[sys.argv.index("--out") + 1] if "--out" in sys.argv else "captions"
    offset = float(sys.argv[sys.argv.index("--offset") + 1]) if "--offset" in sys.argv else 0
    accent = sys.argv[sys.argv.index("--accent") + 1] if "--accent" in sys.argv else "D4EA5E"  # BBGGRR for ASS
    os.makedirs(out, exist_ok=True)
    from faster_whisper import WhisperModel
    try:
        import torch
        dev = "cuda" if torch.cuda.is_available() else "cpu"
    except ImportError:
        dev = "cpu"
    m = WhisperModel("small.en", device=dev, compute_type="float16" if dev == "cuda" else "int8")
    segs, _ = m.transcribe(vo, language="en", word_timestamps=True, beam_size=5)
    asr = [{"word": w.word.strip(), "start": w.start + offset, "end": w.end + offset} for s in segs for w in s.words]
    sw = open(script).read().split()
    times = align(sw, asr)
    caps = [{"text": (" " if i else "") + w, "startMs": round(t[0] * 1000), "endMs": round(t[1] * 1000),
             "timestampMs": round((t[0] + t[1]) * 500), "confidence": 1} for i, (w, t) in enumerate(zip(sw, times))]
    json.dump(caps, open(os.path.join(out, "captions.json"), "w"))
    ph = phrases(sw, times)
    with open(os.path.join(out, "film.srt"), "w") as f:
        for k, p in enumerate(ph, 1):
            f.write(f"{k}\n{ts(p[0][1][0])} --> {ts(p[-1][1][1] + 0.15)}\n{' '.join(w for w, _ in p)}\n\n")
    hdr = ("[Script Info]\nScriptType: v4.00+\nPlayResX: 1920\nPlayResY: 1080\n\n[V4+ Styles]\n"
           "Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, "
           "ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding\n"
           f"Style: Cap,Inter,64,&H00{accent},&H00FFFFFF,&H66000000,&H80000000,-1,0,0,0,100,100,0,0,1,3,2,2,120,120,110,1\n\n"
           "[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n")
    with open(os.path.join(out, "karaoke.ass"), "w") as f:
        f.write(hdr)
        for p in ph:
            body = "".join(f"{{\\k{max(1, round((t[1] - t[0]) * 100))}}}{w} " for w, t in p)
            f.write(f"Dialogue: 0,{ts(p[0][1][0], False)},{ts(p[-1][1][1] + 0.15, False)},Cap,,0,0,0,,{body.strip()}\n")
    print(f"{len(sw)} words, {len(ph)} phrases -> {out}/captions.json, film.srt, karaoke.ass")


if __name__ == "__main__":
    main()
