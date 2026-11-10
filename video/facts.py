#!/usr/bin/env python3
"""Every number the film shows or says, read from evals/results/*.json at build time. Nothing is typed by hand.

  python3 video/facts.py            -> video/data/facts.json (and prints it)

Each fact keeps the suite, the id, the run time and the git sha it came from, so the film's footnotes can cite them.
If a headline id disappears or changes shape, this script fails loudly instead of guessing.
"""
from __future__ import annotations

import json
import re
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent
RES = ROOT / "evals" / "results"


def suite(name: str) -> dict:
    return json.loads((RES / f"{name}.json").read_text())


def headline(name: str, hid: str) -> dict:
    s = suite(name)
    for h in s["headlines"]:
        if h["id"] == hid:
            return {**h, "suite": name, "ranAt": s["ranAt"], "gitSha": s["gitSha"]}
    sys.exit(f"facts.py: headline {name}/{hid} not found")


def k_of_n(text: str) -> tuple[int, int]:
    m = re.search(r"(\d+)\s+of\s+(\d+)", text)
    if not m:
        sys.exit(f"facts.py: no 'k of n' in {text!r}")
    return int(m.group(1)), int(m.group(2))


def pair(name: str, hid: str) -> dict:
    h = headline(name, hid)
    k, n = k_of_n(h["value"])
    base = h.get("baseline", "")
    bk = bn = None
    blabel = ""
    if base:
        mm = re.search(r"(\d+)\s+of\s+(\d+)", base)
        if mm:
            bk, bn = int(mm.group(1)), int(mm.group(2))
        blabel = base.split(":")[0].strip()
    return {"k": k, "n": n, "text": f"{k} of {n}", "baseline_k": bk, "baseline_n": bn, "baseline_label": blabel,
            "label": h["label"], "script": h["script"], "suite": name, "ranAt": h["ranAt"], "gitSha": h["gitSha"],
            "note": h.get("note", "")}


def main() -> None:
    f: dict = {}
    f["false_alarms"] = pair("sightbench", "false-alarms")              # ours vs CLIP
    f["mismatch_recall"] = pair("sightbench", "mismatch-recall")        # CLIP is higher: shown honestly
    f["abstain"] = pair("sightbench", "abstention")
    f["accuracy_answering"] = pair("sightbench", "accuracy-when-answering")
    f["breaches"] = pair("redteam-sandbox", "breaches-sightline-sandbox")  # counted from PayPal sandbox records; naive agent simulated
    f["false_confirms"] = pair("confirmation", "heldout-false-confirm")  # vs keyword match
    f["duplicates"] = pair("duplicates", "duplicate-scenarios")
    f["duplicates_before"] = pair("duplicates", "duplicate-scenarios-before-fix")
    f["store_policy"] = pair("store-agent", "policy-violations")
    f["store_invented"] = pair("store-agent", "invented-facts")
    f["barrier_tab"] = pair("barrier", "barrier-keyboard-blocked-incl-dialogs")
    # The honest negative: colour mismatches the camera check caught (per-type metric in the details).
    sb = suite("sightbench")
    col = sb["details"]["metrics"]["sightline"]["perType"]["colour"]["recall"]
    f["colour_caught"] = {"k": col["k"], "n": col["n"], "text": f"{col['k']} of {col['n']}",
                          "label": "Colour mismatches the camera check caught", "suite": "sightbench",
                          "script": "evals/sightbench/run.ts", "ranAt": sb["ranAt"], "gitSha": sb["gitSha"],
                          "note": "Synthetic renders, not real photos. It says 'not sure' on most of the rest."}
    sbd = sb["details"]["manifests"]["test"]
    f["sightbench_pairs"] = {"n": sbd["pairs"], "match": sbd["match"], "mismatch": sbd["mismatch"]}
    (HERE / "data").mkdir(exist_ok=True)
    out = HERE / "data" / "facts.json"
    out.write_text(json.dumps(f, indent=1))
    for key, v in f.items():
        if "text" in v:
            b = f" (baseline {v['baseline_label']}: {v['baseline_k']} of {v['baseline_n']})" if v.get("baseline_k") is not None else ""
            print(f"{key:20s} {v['text']}{b}  [{v['suite']} {v['ranAt'][:10]} {v['gitSha']}]")
    print(f"-> {out}")


if __name__ == "__main__":
    main()
