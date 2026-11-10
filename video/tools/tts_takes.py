#!/usr/bin/env python3
"""Narrator takes with local Chatterbox: N seeds per line, keep the take Whisper hears best, cache by hash.

  python tts_takes.py narration.json [--only S1,S4] [--seeds 3] [--ref refs/narrator.wav] [--out narration/takes]
  (omit --ref for Chatterbox's built-in voice; to keep one voice across films, save a good take as refs/narrator.wav)

narration.json (one entry per line; caption keeps real spelling, spoken is respelled for the voice):
  [{"scene": "S1", "id": "s1a", "caption": "It's 2:14 am.", "spoken": "It's two fourteen in the morning.",
    "exaggeration": 0.6, "cfg": 0.3}, ...]

Model: original Chatterbox (`chatterbox-tts`, MIT; the repo was archived Aug 2026 but works) because it takes
exaggeration/cfg_weight. Chatterbox Turbo ignores both and uses tags like [chuckle] instead (--turbo).
Install once in an isolated venv:  python3 -m venv ~/.venvs/tts && ~/.venvs/tts/bin/pip install chatterbox-tts faster-whisper
Writes <out>/<id>.wav (the chosen take) and <out>/report.json (word match per take). Lines below 0.95 are listed
for rephrasing: if a word keeps coming out wrong ("carer" -> "gutter"), change the word, don't add seeds.
"""
import hashlib, json, os, re, sys, difflib

SR_OUT = 24000


_ONES = "zero one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen seventeen eighteen nineteen".split()
_TENS = "_ _ twenty thirty forty fifty sixty seventy eighty ninety".split()


def _num(n):
    if n < 20: return _ONES[n]
    if n < 100: return _TENS[n // 10] + ("" if n % 10 == 0 else " " + _ONES[n % 10])
    if n < 1000: return _ONES[n // 100] + " hundred" + ("" if n % 100 == 0 else " and " + _num(n % 100))
    return str(n)


def words(t):
    # spelling-neutral: British/US spellings, digits vs words, hyphens ("8-guard" == "eight guard")
    t = t.lower().replace("%", " percent").replace("colour", "color").replace("-", " ")
    t = re.sub(r"\$(\d+)\.(\d\d)", lambda m: f"{_num(int(m.group(1)))} dollars {_num(int(m.group(2)))}", t)
    t = re.sub(r"\d+", lambda m: " " + _num(int(m.group(0))) + " ", t)
    return [w for w in re.findall(r"[a-z']+", t) if w not in ("and",)]


def match(a, b):
    return difflib.SequenceMatcher(None, words(a), words(b)).ratio()


def main():
    if len(sys.argv) < 2:
        sys.exit(__doc__)
    opt = lambda k, d: sys.argv[sys.argv.index(k) + 1] if k in sys.argv else d
    lines = json.load(open(sys.argv[1]))
    only = set(opt("--only", "").split(",")) - {""}
    seeds = int(opt("--seeds", 3))
    ref = opt("--ref", None)
    out = opt("--out", "narration/takes")
    turbo = "--turbo" in sys.argv
    os.makedirs(os.path.join(out, "cache"), exist_ok=True)

    import torch, torchaudio
    dev = "cuda" if torch.cuda.is_available() else "cpu"
    if turbo:
        from chatterbox.tts_turbo import ChatterboxTurboTTS as M
    else:
        from chatterbox.tts import ChatterboxTTS as M
    tts = M.from_pretrained(device=dev)
    from faster_whisper import WhisperModel
    asr = WhisperModel("small.en", device=dev, compute_type="float16" if dev == "cuda" else "int8")
    refsig = open(ref, "rb").read()[:4096].hex() if ref else "builtin"

    report = json.load(open(os.path.join(out, "report.json"))) if os.path.exists(os.path.join(out, "report.json")) else {}
    weak = []
    for ln in lines:
        if only and ln["scene"] not in only and ln["id"] not in only:
            continue
        if ln.get("file"):  # a recorded or separately synthesised line (e.g. the screen reader): copied as is
            os.system(f"ffmpeg -v error -y -i '{ln['file']}' -ar {SR_OUT} -ac 1 '{os.path.join(out, ln['id'] + '.wav')}'")
            continue
        spoken = ln.get("spoken", ln["caption"])
        ex, cfg, temp = ln.get("exaggeration", 0.6), ln.get("cfg", 0.4), ln.get("temperature", 0.7)
        best = None
        for seed in range(seeds):
            key = hashlib.sha1(json.dumps([spoken, seed, ex, cfg, temp, turbo, refsig]).encode()).hexdigest()[:16]
            path = os.path.join(out, "cache", f"{ln['id']}_{key}.wav")
            if not os.path.exists(path):
                torch.manual_seed(seed)
                kw = {"audio_prompt_path": ref} if ref else {}
                if not turbo:
                    kw.update(exaggeration=ex, cfg_weight=cfg, temperature=temp)
                wav = tts.generate(spoken, **kw)
                torchaudio.save(path, wav.cpu(), tts.sr)
            segs, _ = asr.transcribe(path, language="en", beam_size=5)
            heard = " ".join(s.text for s in segs)
            # score against both spellings: "A W S" is spoken, Whisper writes "AWS"
            score = max(match(spoken, heard), match(ln["caption"], heard))
            if not best or score > best[0]:
                best = (score, path, heard)
        os.system(f"ffmpeg -v error -y -i '{best[1]}' -ar {SR_OUT} -ac 1 '{os.path.join(out, ln['id'] + '.wav')}'")
        report[ln["id"]] = {"score": round(best[0], 3), "heard": best[2], "take": best[1]}
        print(f"{ln['id']:8} {best[0]:.3f}  {best[2][:80]}")
        if best[0] < 0.95:
            weak.append(ln["id"])
    json.dump(report, open(os.path.join(out, "report.json"), "w"), indent=1)
    if weak:
        print("\nbelow 0.95, rephrase or respell:", ", ".join(weak))


if __name__ == "__main__":
    main()
