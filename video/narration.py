#!/usr/bin/env python3
"""The narration as data. Numbers come from video/data/facts.json (evals) and video/data/live.json (what the live site
said during capture); nothing numeric is typed here. Captions keep the real spelling ("$36.72", "4 of 210"); the spoken
text spells numbers out for the voice.

  python3 video/narration.py         -> video/narration.json
"""
from __future__ import annotations

import json
import re
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
# PRODUCT_NAME from @sightline/core (packages/core/src/brand.ts): never typed into the film's copy.
_brand = (HERE.parent / "packages" / "core" / "src" / "brand.ts").read_text()
NAME = re.search(r"PRODUCT_NAME = .*?\|\| '([^']+)'", _brand).group(1)
F = json.loads((HERE / "data" / "facts.json").read_text())
LIVE = json.loads((HERE / "data" / "live.json").read_text()) if (HERE / "data" / "live.json").exists() else {}

ONES = "zero one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen " \
       "seventeen eighteen nineteen".split()
TENS = "_ _ twenty thirty forty fifty sixty seventy eighty ninety".split()


def words(n: int) -> str:
    if n < 20:
        return ONES[n]
    if n < 100:
        return TENS[n // 10] + ("" if n % 10 == 0 else "-" + ONES[n % 10])
    if n < 1000:
        rest = n % 100
        return ONES[n // 100] + " hundred" + ("" if rest == 0 else " and " + words(rest))
    th = n // 1000
    rest = n % 1000
    return words(th) + " thousand" + ("" if rest == 0 else (" and " if rest < 100 else " ") + words(rest))


def dollars(text: str) -> tuple[str, str]:
    """'$36.72' -> ('$36.72', 'thirty-six dollars seventy-two')."""
    m = re.search(r"\$(\d+)\.(\d{2})", text)
    if not m:
        sys.exit(f"narration.py: no amount in {text!r}")
    d, c = int(m.group(1)), int(m.group(2))
    return m.group(0), f"{words(d)} dollars" + (f" {words(c)}" if c else "")


held_text = LIVE.get("held") or "$36.72 is on hold"  # replaced by the capture's own text once C4 has run
AMT, AMT_SAID = dollars(held_text)

fa, br, col = F["false_alarms"], F["breaches"], F["colour_caught"]
fc = F["false_confirms"]

# Verdict from the capture: the live check is either sure ("doesn't match") or "fairly sure" (it says not sure).
verdict = (LIVE.get("verdict") or "").lower()
sure = ("doesn't match" in verdict or "does not match" in verdict) and "not completely sure" not in verdict

L: list[dict] = []


def line(scene: str, lid: str, caption: str, spoken: str | None = None, **kw) -> None:
    d = {"scene": scene, "id": lid, "caption": caption}
    if spoken:
        d["spoken"] = spoken
    d.update(kw)
    L.append(d)


STORY = {"exaggeration": 0.5, "cfg": 0.3}
PRODUCT = {"exaggeration": 0.55, "cfg": 0.38}
RECAP = {"exaggeration": 0.75, "cfg": 0.32}

# 1. The moment (owner's footage)
line("open", "o1", "A parcel arrives for Maya. She paid for a navy sweater, size medium.", **STORY)
line("tagcut", "o2", "Is this it? She can't see the colour, and the size tag is a bump of fabric.", **STORY)
# 2. The size tag becomes the verdict (product on screen)
line("tagcut", "o3", "So her phone checks it, and tells her in words.", **STORY)
# 3. The pain, with the sourced scale
line("pain", "p1", "Blind shoppers can already buy online. What breaks is after the parcel arrives.", **STORY)
line("pain", "p2", "One in two disabled shoppers who needed a return had problems. One in seven couldn't use the store's return method.", **STORY)
# 4. The turn
line("turn", "t1", f"This is {NAME}. Shop by voice, and pay only for what you actually got.", **PRODUCT)
# 5. Shopping, on the live site
line("ask", "s1", "Maya is a persona. This panel shows what her screen reader says.", **PRODUCT)
line("readback", "s2", "Before money moves, a template, not the model, reads back exactly what she'll pay.", **PRODUCT)
line("refuse", "s3", "She says, yeah, probably fine. That isn't a yes, so nothing is paid.", **PRODUCT)
# the screen reader itself, in eSpeak NG (sr_voice.py), reading the app's real announcement
SR = json.loads((HERE / "narration" / "sr" / "lines.json").read_text()) if (HERE / "narration" / "sr" / "lines.json").exists() else {}
if SR:
    line("refuse", "sr_refuse", SR["sr_refuse"], file="narration/sr/sr_refuse.wav")
line("confirm", "s4", "Confirm purchase. Claude Haiku checks her words again, on its own.", **PRODUCT)
line("confirm", "s5", f"PayPal authorizes {AMT} and holds it until the check.",
     f"PayPal authorizes {AMT_SAID}, and holds it until the check.", **PRODUCT)
# 6. The check: the refusal moment
line("check", "c1", "Claude Opus reads the size tag. A second reader must agree before it's sure.", **PRODUCT)
if SR:
    line("check", "sr_check", SR["sr_check"], file="narration/sr/sr_check.wav")
if sure:
    line("check", "c2", "Size L, not M. It says so in words, and how sure it is.", **PRODUCT)
else:
    line("check", "c2", "Size L, not M. Charcoal, not navy. It won't guess: it says how sure it is.", **PRODUCT)
# 7. Money back, agent to agent
line("moneyback", "m1", "She says it's wrong. Her agent signs an evidence pack, and reads her a summary first.", **PRODUCT)
line("store", "m2", "The store's own agent checks the signature, and offers a replacement inside the store's policy.", **PRODUCT)
line("decline", "m3", "Maya wants her money back, so she declines. The revised offer: release the hold.", **PRODUCT)
line("released", "m4", "PayPal voids the authorization, and the hold is released.", **PRODUCT)
line("hold3d", "m5", "Nothing was captured. The money never left her account.", **STORY)
# 8. Under the hood
line("hood", "u1", "Underneath: a template readback, two keys, and an eight-guard payment gate.", **PRODUCT)
line("hood", "u2", "Model text alone can never move money.", **PRODUCT)
line("hood", "u3", "PayPal authorizes, captures or voids, and every step is signed and chained.", **PRODUCT)
# 9. Proof (numbers from facts.json)
line("proof", "pr1",
     f"{fa['k']} false alarms on {fa['n']} matching items. Image matching with CLIP: {fa['baseline_k']}.",
     f"{words(fa['k']).capitalize()} false alarms on {words(fa['n'])} matching items. Image matching with clip: {words(fa['baseline_k'])}.",
     pauseBefore=0.3, **PRODUCT)
line("proof", "pr2",
     f"{br['k'] if br['k'] else 'Zero'} payment breaches across {br['n']} trick listings. A naive agent: {br['baseline_k']}.",
     f"{words(br['k']).capitalize()} payment breaches across {words(br['n'])} trick listings. A naive agent: {words(br['baseline_k'])}.",
     **PRODUCT)
line("proofneg", "pr3",
     f"And it's weak on colour: it caught {col['k']} of {col['n']} colour mismatches. On most of the rest, it says not sure.",
     f"And it's weak on colour. It caught {words(col['k'])} of {words(col['n'])} colour mismatches. On most of the rest, it says not sure.",
     **PRODUCT)
# 10. Recap
line("recap", "r1", "Pay after the check. Not sure, instead of a guess. Money back from the store's own agent.", **RECAP)
# 11. Close
line("close", "cl1", f"Maya did the hard part herself. {NAME} makes sure she only pays for what she got.", **STORY)

(HERE / "narration.json").write_text(json.dumps(L, indent=1, ensure_ascii=False))
n = sum(len(re.findall(r"[A-Za-z0-9$.']+", x.get("spoken", x["caption"]))) for x in L)
print(f"{len(L)} lines, {n} spoken words -> {HERE / 'narration.json'} (amount {AMT}, verdict {'sure' if sure else 'not sure'})")
