#!/usr/bin/env python3
"""The film as data: writes video/film/film.json from the storyboard below, the live captures, the facts and the
voice timeline. Nothing numeric is typed here: numbers come from data/facts.json, data/live.json and
narration/timeline.json.

  python3 video/make_film.py --skeleton   scene ids, types and minimum lengths only (before vo_timeline.py)
  python3 video/make_film.py              the full film.json (after vo_timeline.py wrote narration/timeline.json)

Also prepares media in film/public/: edited product takes (segments, jump cuts and labelled speed-ups, events
remapped), and the owner's clips (or stock fallbacks) normalised to 1920x1080 30 fps BT.709.
"""
from __future__ import annotations

import json
import re
import subprocess
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
FILM = HERE / "film"
PUB = FILM / "public"
CAP = HERE / "captures"
FACTS = json.loads((HERE / "data" / "facts.json").read_text())
LIVE = json.loads((HERE / "data" / "live.json").read_text())
TL_PATH = HERE / "narration" / "timeline.json"
TL = json.loads(TL_PATH.read_text()) if TL_PATH.exists() else None
SKELETON = "--skeleton" in sys.argv
_brand = (HERE.parent / "packages" / "core" / "src" / "brand.ts").read_text()
PRODUCT = re.search(r"PRODUCT_NAME = .*?\|\| '([^']+)'", _brand).group(1)
SITE = "sightline.prashantthakur.dev"

# ---------------------------------------------------------------- media prep

def run(cmd: list[str]) -> None:
    subprocess.run(cmd, check=True)


def dur_of(p: Path) -> float:
    return float(subprocess.run(["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", str(p)],
                                capture_output=True, text=True, check=True).stdout.strip())


def edit_take(name: str, src: str, segs: list[list[float]]) -> tuple[str, str, list[dict]]:
    """Cut a capture into segments [a, b, speed]; returns (public path, events path, speed marks in output seconds)."""
    inp = CAP / f"{src}.mp4"
    out = PUB / "captures" / f"{name}.mp4"
    evo = PUB / "captures" / f"{name}.events.json"
    out.parent.mkdir(parents=True, exist_ok=True)
    key = json.dumps([src, segs, inp.stat().st_mtime])
    stamp = out.with_suffix(".key")
    marks, t = [], 0.0
    for a, b, sp in segs:
        if sp > 1.01:
            marks.append({"at": round(t, 2), "until": round(t + (b - a) / sp, 2), "text": f"Sped up {sp:g}x"})
        elif sp == 0:
            pass
        t += (b - a) / sp if sp else 0
    if not (out.exists() and stamp.exists() and stamp.read_text() == key):
        parts, fl = [], []
        for i, (a, b, sp) in enumerate(segs):
            fl.append(f"[0:v]trim={a}:{b},setpts=(PTS-STARTPTS)/{sp},fps=30[v{i}]")
            parts.append(f"[v{i}]")
        fl.append(f"{''.join(parts)}concat=n={len(segs)}:v=1:a=0,format=yuv420p,setparams=colorspace=bt709:color_primaries=bt709:color_trc=bt709[o]")
        tmp = out.with_name(out.stem + ".part.mp4")
        run(["ffmpeg", "-v", "error", "-y", "-i", str(inp), "-filter_complex", ";".join(fl), "-map", "[o]", "-c:v", "libx264",
             "-crf", "16", "-preset", "veryfast", "-g", "15", "-movflags", "+faststart", str(tmp)])
        tmp.rename(out)
        stamp.write_text(key)
    # remap events into the edited timeline
    ev = json.loads((CAP / f"{src}.events.json").read_text())
    rem, t = [], 0.0
    for a, b, sp in segs:
        for e in ev["events"]:
            if a <= e["t"] < b and e.get("box"):
                rem.append({**e, "t": round(t + (e["t"] - a) / sp, 3)})
        t += (b - a) / sp
    evo.write_text(json.dumps({**ev, "events": rem}, indent=1))
    return f"captures/{name}.mp4", f"captures/{name}.events.json", marks


def owner_clip(cid: str) -> tuple[str | None, str]:
    """The owner's clip, else a stock fallback, else None (placeholder). Normalised once into public/footage."""
    for folder, kind in ((HERE / "footage" / "owner", "owner"), (HERE / "footage" / "stock", "stock")):
        srcs = sorted(folder.glob(f"{cid}.*"))
        if srcs:
            src = srcs[0]
            out = PUB / "footage" / f"{cid}.mp4"
            out.parent.mkdir(parents=True, exist_ok=True)
            if not out.exists() or out.stat().st_mtime < src.stat().st_mtime:
                run(["ffmpeg", "-v", "error", "-y", "-i", str(src), "-an", "-vf",
                     "scale=1920:1080:force_original_aspect_ratio=increase,crop=1920:1080,fps=30,format=yuv420p,"
                     "setparams=colorspace=bt709:color_primaries=bt709:color_trc=bt709",
                     "-c:v", "libx264", "-crf", "16", "-preset", "veryfast", "-movflags", "+faststart", str(out)])
            return f"footage/{cid}.mp4", kind
    return None, "placeholder"


# ---------------------------------------------------------------- the story, as scenes

def scene_dur(sid: str, default: float) -> float:
    if TL:
        for s in TL["scenes"]:
            if s["id"] == sid:
                return s["duration"]
    return default


MAX_RATE = 1.4


def fit(segs: list[list[float]], d: float) -> tuple[list[list[float]], float]:
    """Make the take fill the scene: up to MAX_RATE faster (labelled), and beyond that cut from the start of the take
    so the result the voice names is always on screen. Never slower than 1x (the last frame holds instead)."""
    total = sum((b - a) / sp for a, b, sp in segs)
    rate = max(1.0, min(MAX_RATE, total / max(0.1, d)))
    excess = total - d * rate
    segs = [list(x) for x in segs]
    while excess > 0.05 and segs:
        a, b, sp = segs[0]
        span = (b - a) / sp
        if span <= excess + 0.5:
            excess -= span
            segs.pop(0)
        else:
            segs[0][0] = a + excess * sp
            excess = 0
    return segs, round(rate, 3)


fa, br, col = FACTS["false_alarms"], FACTS["breaches"], FACTS["colour_caught"]
amount = re.search(r"\$\d+\.\d{2}", LIVE["held"]).group(0)
auth = LIVE.get("voided", "")
auth_id = re.search(r"Authorization (\w+)", auth).group(1) if auth else None

clips = {}
ACTIONS = {"O1": ("parcel", "a parcel at the door, a hand lifts it"), "O2": ("parcel", "fingers peel the tape, open the flaps"),
           "O3": ("tag", "hands find the size tag on the sweater"), "O4": ("phone", "the phone held over the sweater"),
           "O5": ("phone", "a hand on the phone, listening"), "O6": ("closed", "hands fold the sweater back into the box")}
for cid, (drawing, action) in ACTIONS.items():
    src, kind = (None, "placeholder") if SKELETON else owner_clip(cid)
    clips[cid] = {"id": cid, "src": src, "kind": kind, "drawing": drawing, "action": action}


def clip(cid: str, d: float, push: str = "in", trim: float = 0.0) -> dict:
    c = clips[cid]
    out = {"id": cid, "dur": d, "drawing": c["drawing"], "action": c["action"], "push": push, "trimBefore": trim}
    if c["src"]:
        out["src"] = c["src"]
    return out


LIVE_CHIP = {"text": "Live site · PayPal sandbox", "tone": "ink"}
S: list[dict] = []


def add(sid: str, typ: str, d: float, **kw) -> dict:
    s = {"id": sid, "type": typ, "duration": scene_dur(sid, d), **kw}
    S.append(s)
    return s


def screen(sid: str, take: str, segs: list[list[float]], d: float, chips: list[dict] | None = None, pill: dict | None = None,
           url: str | None = None, **kw) -> dict:
    s = add(sid, "screen", d, **kw)
    if SKELETON:
        return s
    segs, rate = fit(segs, s["duration"])
    src, ev, marks = edit_take(sid, take, segs)
    s.update(src=src, events=ev, playbackRate=rate, chrome=True, url=url or SITE)
    live = dict(LIVE_CHIP)
    if rate > 1.05:
        live["text"] += f" · {rate:.1f}x speed"
    ch = [live] + (chips or [])
    for m in marks:
        sp = float(m["text"].split()[-1].rstrip("x")) * rate
        ch.append({"text": f"Waiting sped up {sp:.0f}x", "at": round(m["at"] / rate, 2), "until": round(m["until"] / rate + 0.6, 2), "tone": "warm"})
    s["chips"] = ch
    if pill:
        s["pill"] = pill
    return s


# 1. The moment: owner's footage (placeholders until it arrives)
o = add("open", "story", 5.5, transition={"type": "cut"})
dO = o["duration"]
o["clips"] = [clip("O1", dO * 0.5, "in"), clip("O2", dO * 0.5, "right")]
o["lower"] = {"name": "Maya", "role": "a persona: the person is invented, the problem is not", "at": 0.6, "until": dO}
o["storyChips"] = [] if all(clips[c]["kind"] == "owner" for c in ("O1", "O2", "O3")) else \
    ([{"text": "Stock footage", "at": 0, "until": dO}] if any(clips[c]["kind"] == "stock" for c in ("O1", "O2", "O3")) else [])

# 2. The match cut: the tag becomes the verdict
t = add("tagcut", "tagcut", 8.5, transition={"type": "cut"})
if not SKELETON:
    t.update(clip=clip("O3", t["duration"], "in", trim=0.0), tag={"x": 0.5, "y": 0.45}, ringAt=1.6, irisAt=2.6,
             src="captures/C7.mp4", at=33.4, box={"x": 50, "y": 300, "w": 1230, "h": 330},
             chips=[{"text": "Live site · PayPal sandbox", "at": 3.0, "until": t["duration"]},
                    {"text": "Demo parcel photos", "at": 3.0, "until": t["duration"]}])
    # the screen layer needs the live take in public/
    (PUB / "captures").mkdir(parents=True, exist_ok=True)
    run(["cp", "-u", str(CAP / "C7.mp4"), str(PUB / "captures" / "C7.mp4")])

# 3. The pain, sourced
add("pain", "pain", 11.0, transition={"type": "fade", "dur": 0.4},
    stats=[{"big": "1 in 2", "of": 2, "fill": 1, "text": "disabled shoppers who needed a return had problems doing it", "at": 1.6},
           {"big": "1 in 7", "of": 7, "fill": 1, "text": "could not use the retailer's return method", "at": 5.6}],
    source="Which? with RIDC, survey of disabled consumers in the UK, December 2022")

# 4. The turn: the register snap into the name
add("turn", "register", 5.0, transition={"type": "fade", "dur": 0.35}, drawing="tag", wordmark=True,
    title="pay only for what you actually got", emphasis=["actually", "got"], floodAt=1.0)

# 5. Shopping on the live site
screen("ask", "C1", [[6.8, 12.5, 1], [12.5, 17.8, 1]], 6.0, transition={"type": "fade", "dur": 0.3},
       zooms=[{"at": 2.2, "dur": 4.0, "box": {"x": 1340, "y": 690, "w": 550, "h": 360}, "scale": 2.1}],
       chips=[{"text": "Persona: Maya", "tone": "warm"}, {"text": "Typed here; she can also talk", "tone": "warm", "at": 0.3}])
screen("readback", "C2", [[1.6, 11.5, 1]], 6.0, chips=[{"text": "A template reads it, not the model", "tone": "warm", "at": 1.0}])
screen("refuse", "C3", [[2.4, 11.5, 1]], 5.0, chips=[{"text": "Not a yes: nothing is paid", "tone": "accent", "at": 3.0},
       {"text": "Screen reader voice: eSpeak NG", "tone": "warm", "at": 4.0}])
screen("confirm", "C4", [[2.2, 6.6, 1], [6.6, 10.6, 2], [10.6, 18.5, 1]], 9.5,
       pill={"model": "Claude Haiku 5.5", "job": "second confirmation key", "at": 1.2, "until": 5.2},
       chips=[{"text": "PayPal Orders v2 · AUTHORIZE", "tone": "accent", "at": 4.0}])

# 6. The check: the refusal moment
screen("check", "C7", [[13.6, 16.2, 1], [16.2, 27.2, 6], [27.2, 40.5, 1]], 12.0,
       pill={"model": "Claude Opus 5.5", "job": "reads the size tag", "at": 0.3},
       chips=[{"text": "Demo store control: wrong size sent on purpose", "tone": "warm"},
              {"text": "Two size-tag readers: Claude Opus 5.5 + OCR", "tone": "accent", "at": 0.3},
              {"text": "Screen reader voice: eSpeak NG", "tone": "warm", "at": 4.5}])

# 7. Money back, agent to agent
screen("moneyback", "C8", [[2.4, 3.8, 1], [3.8, 10.2, 6], [10.2, 14.4, 1], [18.6, 23.5, 1]], 8.0,
       pill={"model": "Claude Opus 5.5", "job": "case summary", "at": 1.0},
       chips=[{"text": "Ed25519-signed evidence pack", "tone": "warm", "at": 2.0}])
screen("store", "C9", [[0.4, 10.5, 1]], 7.0, pill={"model": "Claude Opus 5.5", "job": "store agent", "at": 0.2},
       chips=[{"text": "Code computes every amount", "tone": "warm", "at": 2.0}], url=f"{SITE}/merchant/disputes")
screen("decline", "C10", [[0.8, 14.5, 1]], 7.0, pill={"model": "Claude Opus 5.5", "job": "store agent's revised offer", "at": 4.5},
       chips=[{"text": "Accepting takes two presses", "tone": "warm", "at": 1.0}])
screen("released", "C11", [[36.0, 45.5, 1]], 4.5, chips=[{"text": "PayPal Payments v2 · void", "tone": "accent", "at": 0.6}],
       transition={"type": "fade", "dur": 0.35})
h = add("hold3d", "hold3d", 6.0, transition={"type": "fade", "dur": 0.35})
h.update(amount=amount, voidAt=round(h["duration"] * 0.42, 2), authId=f"Authorization {auth_id} · voided" if auth_id else None)

# 8. Under the hood (register snap, then the paper stack)
add("hoodreg", "register", 1.2, drawing="hold", kicker="Under the hood", ground="paper", floodAt=0.7, transition={"type": "cut"})
add("hood", "arch3d", 17.0, transition={"type": "fade", "dur": 0.35},
    title="Under the hood",
    layers=[{"id": "voice", "label": "Voice and shopping agent", "sub": "Claude Haiku 5.5 · lines checked against the listing"},
            {"id": "readback", "label": "Readback template", "sub": "fixed words, never model text"},
            {"id": "keys", "label": "Two keys", "sub": "her words + Claude Haiku 5.5 (agree or veto)"},
            {"id": "gate", "label": "Payment gate", "sub": "eight guards: amount, payee, duplicates"},
            {"id": "paypal", "label": "PayPal", "sub": "authorize · capture · void · Vault"},
            {"id": "check", "label": "Camera check", "sub": "Claude Opus 5.5 + OCR must agree"},
            {"id": "evidence", "label": "Evidence and store agent", "sub": "Ed25519 · Claude Opus 5.5 within policy"}],
    satellites=[{"id": "channel3", "label": "Channel3"}, {"id": "aws", "label": "AWS"}, {"id": "bryntum", "label": "Bryntum"}],
    cueWords={"voice": "Underneath", "readback": "template", "keys": "keys", "gate": "gate", "paypal": "PayPal", "check": "voids", "evidence": "signed"},
    blockedAt="gate", blockedText="model text cannot move money")

# 9. Proof (numbers from facts.json)
add("proof", "proofcards", 12.0, transition={"type": "slide", "dir": "from-bottom", "dur": 0.4}, kicker="Measured, with baselines",
    cards=[{"at": 0.3, "title": "False alarms on matching items", "stamp": f"{fa['k']} vs {fa['baseline_k']}",
            "rows": [{"label": "CLIP image matching", "k": fa["baseline_k"], "n": fa["baseline_n"]},
                     {"label": PRODUCT, "k": fa["k"], "n": fa["n"], "ours": True}],
            "foot": f"Frozen test split of {FACTS['sightbench_pairs']['n']} synthetic photo pairs, thresholds fitted on dev only. evals/sightbench"},
           {"at": 5.4, "title": "Payment breaches, trick listings (simulated)", "stamp": f"{br['k']} vs {br['baseline_k']}",
            "rows": [{"label": "Naive agent", "k": br["baseline_k"], "n": br["baseline_n"]},
                     {"label": PRODUCT, "k": br["k"], "n": br["n"], "ours": True}],
            "foot": "Simulated ledger, no PayPal calls. evals/redteam"}])
add("proofneg", "proofcards", 6.0, transition={"type": "cut"}, kicker="Where it is weak",
    cards=[{"at": 0.3, "title": "Colour mismatches caught", "stamp": "Weak: it says not sure instead", "stampTone": "bad",
            "rows": [{"label": PRODUCT, "k": col["k"], "n": col["n"], "ours": True, "tone": "bad"}],
            "foot": "Same frozen test split. Navy against charcoal in dim light is hard; the app says not sure and offers a helper."}])

# 10. Recap + model-to-job table
add("recap", "recap", 8.0, transition={"type": "fade", "dur": 0.3}, riserInto=True,
    lines=[{"text": "Pay after the check.", "at": 0.1}, {"text": "Not sure, instead of a guess.", "at": 1.5},
           {"text": "Money back from the store's own agent.", "at": 2.9}],
    tableAt=4.6,
    table=[{"model": "Claude Haiku 5.5", "job": "shopping agent; second confirmation key (agree or veto only)"},
           {"model": "Claude Opus 5.5", "job": "size-tag and product reads, case summary, store agent"},
           {"model": "Fixed code", "job": "readback template, eight-guard payment gate, every amount"},
           {"model": "PayPal sandbox", "job": "Orders v2 authorize, Payments capture and void, Vault, webhooks"}],
    shots=[{"src": "captures/confirm.mp4", "at": 7.0}, {"src": "captures/check.mp4", "at": 9.0}, {"src": "captures/store.mp4", "at": 4.0},
           {"src": "captures/released.mp4", "at": 2.0}, {"src": "captures/schedule.mp4", "at": 4.0}])

# 11. Close
c = add("close", "story", 7.0, transition={"type": "fade", "dur": 0.5})
c["clips"] = [clip("O6", c["duration"], "in")]
add("end", "end", 5.0, tagline="Pay only for what you actually got.", url=f"{SITE}/judge",
    repo="github.com/Prashant-thakur77/Sightline · MIT",
    notes="PayPal sandbox · Maya is a persona · not yet tested with blind users")

# minimum picture time per scene (vo_timeline.py keeps max(voice, min))
MINS = {"open": 5.0, "tagcut": 7.5, "pain": 10.0, "turn": 4.5, "ask": 5.0, "readback": 5.0, "refuse": 4.5, "confirm": 7.5,
        "check": 9.0, "moneyback": 6.5, "store": 6.0, "decline": 6.0, "released": 4.0, "hold3d": 4.5,
        "hood": 15.0, "proof": 10.5, "proofneg": 5.5, "recap": 9.0, "close": 6.0}
for sc in S:
    if sc["id"] in MINS:
        sc["min"] = MINS[sc["id"]]

# one sound per meaningful event (cues_from_film.py adds transitions, clicks and the arch3d ticks)
SFX = {
    "tagcut": [{"at": 1.0, "sfx": "stamp", "db": -9}],
    "turn": [{"at": 1.0, "sfx": "stamp", "db": -8}],
    "refuse": [{"at": 3.0, "sfx": "tick", "db": -14}, {"at": 3.08, "sfx": "hit", "db": -15}],
    "confirm": [{"at": 4.0, "sfx": "ping", "db": -16}],
    "hold3d": [{"at": round(next(x for x in S if x["id"] == "hold3d")["voidAt"], 2), "sfx": "chime", "db": -14}],
    "hoodreg": [{"at": 0.7, "sfx": "stamp", "db": -9}],
    "end": [{"at": 0.3, "sfx": "chime", "db": -14}],
}
for sc in S:
    if sc["type"] == "proofcards":
        for card in sc["cards"]:
            SFX.setdefault(sc["id"], []).append({"at": round(card["at"] + (10 + len(card["rows"]) * 21 + 8) / 30, 2), "sfx": "hit", "db": -11})
    if sc["type"] == "recap":
        for ln in sc["lines"]:
            SFX.setdefault(sc["id"], []).append({"at": ln["at"] + 0.1, "sfx": "flash", "db": -18})
for sc in S:
    if sc["id"] in SFX:
        sc["sfx"] = SFX[sc["id"]]

film = {"title": PRODUCT, "product": PRODUCT, "fps": 30, "width": 1920, "height": 1080,
        "theme": {"bg": "#f3f6fb", "surface": "#ffffff", "fg": "#0d1530", "muted": "#3b4565", "accent": "#1a33d6",
                  "accent2": "#2442ff", "good": "#08572f", "bad": "#a01b12", "display": "Inter", "mono": "JetBrainsMono"},
        "scenes": S}
if (PUB / "master.wav").exists() and "--preview-audio" in sys.argv:
    film["previewAudio"] = "master.wav"
if not SKELETON:
    cj = PUB / "captions" / "captions.json"
    # arch3d slab cues: the second each layer's word is spoken (cues_from_film.py does the same from cueWords)
    if cj.exists() and TL:
        words = json.loads(cj.read_text())
        hood = next(s for s in S if s["id"] == "hood")
        st = next(s["start"] for s in TL["scenes"] if s["id"] == "hood")
        cues = {}
        for lid, w in hood["cueWords"].items():
            hit = next((x for x in words if st <= x["startMs"] / 1000 < st + hood["duration"]
                        and re.sub(r"[^a-z]", "", x["text"].lower()).startswith(w.lower())), None)
            if hit:
                cues[lid] = round(hit["startMs"] / 1000 - st, 2)
        hood["cues"] = cues
        # the match cut: the ring draws as she says "tag", the iris opens on the verdict a beat later
        tc = next(s for s in S if s["id"] == "tagcut")
        ts = next(s["start"] for s in TL["scenes"] if s["id"] == "tagcut")
        tagw = next((x for x in words if ts <= x["startMs"] / 1000 < ts + tc["duration"] and x["text"].strip().lower().startswith("tag")), None)
        if tagw:
            tc["ringAt"] = round(tagw["startMs"] / 1000 - ts - 0.2, 2)
            tc["irisAt"] = round(tc["ringAt"] + 0.7, 2)
            for ch in tc.get("chips", []):
                ch["at"] = tc["irisAt"]
            tc["sfx"] = [{"at": round(tc["irisAt"] - 0.35, 2), "sfx": "stamp", "db": -9}]
        # recap: each kinetic line lands on its first spoken word; the table follows the last word
        rc = next(s for s in S if s["id"] == "recap")
        rs = next(s["start"] for s in TL["scenes"] if s["id"] == "recap")
        inw = [x for x in words if rs <= x["startMs"] / 1000 < rs + rc["duration"]]
        firsts = {"Pay": None, "Not": None, "Money": None}
        for x in inw:
            w = x["text"].strip().strip(".,")
            if w in firsts and firsts[w] is None:
                firsts[w] = x["startMs"] / 1000 - rs
        for ln, key in zip(rc["lines"], ("Pay", "Not", "Money")):
            if firsts[key] is not None:
                ln["at"] = round(max(0, firsts[key] - 0.15), 2)
        if inw:
            rc["tableAt"] = round(inw[-1]["endMs"] / 1000 - rs + 0.35, 2)
(FILM / "film.json").write_text(json.dumps(film, indent=1, ensure_ascii=False))
tot = sum(s["duration"] for s in S)
print(f"{len(S)} scenes, {tot:.1f}s -> {FILM / 'film.json'}{' (skeleton)' if SKELETON else ''}")
print("owner clips:", {k: v["kind"] for k, v in clips.items()})
