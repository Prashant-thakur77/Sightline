#!/usr/bin/env python3
"""Collect what the live site said during capture (amount on hold, the verdict, PayPal ids) into video/data/live.json.
  python3 video/live.py"""
import glob, json, os
HERE = os.path.dirname(os.path.abspath(__file__))
out = {}
for f in sorted(glob.glob(os.path.join(HERE, "captures", "*.events.json"))):
    d = json.load(open(f))
    for k, v in (d.get("texts") or {}).items():
        if v:
            out[k] = v
    out.setdefault("_recorded", {})[os.path.basename(f).split(".")[0]] = d.get("recordedAt")
os.makedirs(os.path.join(HERE, "data"), exist_ok=True)
json.dump(out, open(os.path.join(HERE, "data", "live.json"), "w"), indent=1)
print(json.dumps({k: (v[:120] if isinstance(v, str) else v) for k, v in out.items()}, indent=1))
