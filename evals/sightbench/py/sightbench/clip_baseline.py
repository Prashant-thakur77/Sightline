"""CLIP ViT-B/32 baseline: cosine similarity between the listing image and the delivered photo.

    uv run --group clip python -m sightbench.clip_baseline [--device cuda|cpu] [--refit]

1. Checks the test manifest against its freeze record (stops if it changed).
2. DEV ONLY: embeds every dev pair and picks the threshold that maximises balanced accuracy
   (mean of mismatch recall and match specificity) on dev. Candidates are the midpoints between
   consecutive sorted dev scores; ties go to the median tied candidate. The threshold, the dev
   manifest hash and the dev metrics are written to evals/sightbench/clip-threshold.json. An existing
   threshold file is reused (never refitted on anything but dev) unless --refit is given.
3. TEST: embeds every test pair and applies the frozen dev threshold: score < threshold means
   "mismatch", otherwise "match". The baseline never abstains.

Scores for both splits go to evals/data/raw/sightbench/clip-scores.json for the TypeScript runner.
The baseline sees only images: it never sees the size tag photo or the listing text.
"""

from __future__ import annotations

import argparse
import json
import sys
import time
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

import numpy as np
from PIL import Image

from .common import CLIP_SCORES_PATH, CLIP_THRESHOLD_PATH, load_manifest, manifest_path, rel, resolve, sha256_file, verify_freeze

MODEL = "ViT-B-32"
PRETRAINED = "openai"


def _load_model(device: str) -> tuple[Any, Any, str]:
    import open_clip
    import torch

    if device == "auto":
        device = "cuda" if torch.cuda.is_available() else "cpu"
    model, _, preprocess = open_clip.create_model_and_transforms(MODEL, pretrained=PRETRAINED, device=device)
    model.eval()
    return model, preprocess, device


def _embed(model: Any, preprocess: Any, device: str, paths: list[Path], batch: int = 16) -> dict[Path, np.ndarray]:
    import torch

    out: dict[Path, np.ndarray] = {}
    for i in range(0, len(paths), batch):
        chunk = paths[i : i + batch]
        ims = torch.stack([preprocess(Image.open(p).convert("RGB")) for p in chunk]).to(device)
        with torch.no_grad():
            f = model.encode_image(ims)
            f = f / f.norm(dim=-1, keepdim=True)
        for p, v in zip(chunk, f.float().cpu().numpy(), strict=True):
            out[p] = v
    return out


def score_split(split: str, model: Any, preprocess: Any, device: str) -> tuple[list[dict[str, Any]], dict[str, float]]:
    m = load_manifest(split)
    mfile = manifest_path(split)
    pairs = m["pairs"]
    paths: list[Path] = []
    for p in pairs:
        for r in [*p["listing_images"], *p["item"]]:
            path = resolve(mfile, r)
            if path not in paths:
                paths.append(path)
    if device == "cuda":
        import torch

        torch.cuda.synchronize()
    t0 = time.perf_counter()
    emb = _embed(model, preprocess, device, paths)
    if device == "cuda":
        import torch

        torch.cuda.synchronize()
    elapsed = time.perf_counter() - t0
    rows = []
    for p in pairs:
        item = emb[resolve(mfile, p["item"][0])]
        sims = [float(np.dot(emb[resolve(mfile, li)], item)) for li in p["listing_images"]]
        rows.append({"id": p["id"], "split": split, "score": round(max(sims), 6), "expected": p["expected"]})
    timing = {"images": len(paths), "seconds": round(elapsed, 3), "ms_per_image": round(1000 * elapsed / len(paths), 2)}
    return rows, timing


def fit_threshold(rows: list[dict[str, Any]]) -> tuple[float, dict[str, Any]]:
    s = np.array([r["score"] for r in rows])
    y = np.array([r["expected"] == "mismatch" for r in rows])
    u = np.unique(s)
    cands = np.concatenate([[u[0] - 1e-6], (u[:-1] + u[1:]) / 2, [u[-1] + 1e-6]])
    best, tied = -1.0, []
    for t in cands:
        pred = s < t
        rec = float((pred & y).sum() / max(1, y.sum()))
        spec = float((~pred & ~y).sum() / max(1, (~y).sum()))
        ba = (rec + spec) / 2
        if ba > best + 1e-12:
            best, tied = ba, [float(t)]
        elif abs(ba - best) <= 1e-12:
            tied.append(float(t))
    t = tied[len(tied) // 2]
    pred = s < t
    stats = {
        "balanced_accuracy": round(best, 4),
        "mismatch_recall": f"{int((pred & y).sum())} of {int(y.sum())}",
        "false_alarms": f"{int((pred & ~y).sum())} of {int((~y).sum())}",
        "tied_candidates": len(tied),
    }
    return round(t, 6), stats


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(prog="python -m sightbench.clip_baseline", description=__doc__.split("\n")[0])
    ap.add_argument("--device", default="auto", choices=["auto", "cuda", "cpu"])
    ap.add_argument("--refit", action="store_true", help="Refit the threshold on dev even if clip-threshold.json exists.")
    args = ap.parse_args(argv)

    freeze = verify_freeze()
    model, preprocess, device = _load_model(args.device)
    print(f"clip: {MODEL}/{PRETRAINED} on {device}", flush=True)

    dev_sha = sha256_file(manifest_path("dev"))
    dev_rows, dev_timing = score_split("dev", model, preprocess, device)
    if CLIP_THRESHOLD_PATH.exists() and not args.refit:
        fitted = json.loads(CLIP_THRESHOLD_PATH.read_text(encoding="utf-8"))
        if fitted.get("dev_manifest_sha256") != dev_sha:
            raise SystemExit("clip-threshold.json was fitted on a different dev manifest; rerun with --refit.")
        threshold = float(fitted["threshold"])
        print(f"clip: reusing dev-fitted threshold {threshold}")
    else:
        threshold, dev_stats = fit_threshold(dev_rows)
        fitted = {
            "model": MODEL,
            "pretrained": PRETRAINED,
            "threshold": threshold,
            "decision": "mismatch when cosine(listing image, delivered photo) < threshold, else match; never abstains",
            "fitted_on": "dev",
            "dev_manifest": rel(manifest_path("dev")),
            "dev_manifest_sha256": dev_sha,
            "rule": "maximise balanced accuracy on dev over midpoints of sorted dev scores; ties -> median tied candidate",
            "dev": {"pairs": len(dev_rows), **dev_stats},
            "fitted_at": datetime.now(UTC).isoformat(timespec="seconds"),
            "test_manifest_sha256_at_fit": freeze["sha256"],
        }
        CLIP_THRESHOLD_PATH.write_text(json.dumps(fitted, indent=2) + "\n", encoding="utf-8")
        print(f"clip: fitted threshold {threshold} on dev ({dev_stats})", flush=True)

    # Test is scored only after the threshold is fixed.
    test_rows, test_timing = score_split("test", model, preprocess, device)
    for r in dev_rows + test_rows:
        r["decision"] = "mismatch" if r["score"] < threshold else "match"
    out = {
        "model": MODEL,
        "pretrained": PRETRAINED,
        "device": device,
        "threshold": threshold,
        "threshold_file": rel(CLIP_THRESHOLD_PATH),
        "test_manifest_sha256": freeze["sha256"],
        "generated_at": datetime.now(UTC).isoformat(timespec="seconds"),
        "timing": {"dev": dev_timing, "test": test_timing},
        "pairs": dev_rows + test_rows,
    }
    CLIP_SCORES_PATH.parent.mkdir(parents=True, exist_ok=True)
    CLIP_SCORES_PATH.write_text(json.dumps(out, indent=2) + "\n", encoding="utf-8")
    t = [r for r in test_rows]
    rec = sum(r["decision"] == "mismatch" for r in t if r["expected"] == "mismatch")
    fa = sum(r["decision"] == "mismatch" for r in t if r["expected"] == "match")
    print(f"clip: test mismatch recall {rec}/{sum(r['expected'] == 'mismatch' for r in t)}, false alarms {fa}/{sum(r['expected'] == 'match' for r in t)} -> {rel(CLIP_SCORES_PATH)}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
