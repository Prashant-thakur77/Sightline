"""Simulated retakes for SightBench: ONE extra photo per pair, of the same delivered item.

    uv run python -m sightbench.retake --split dev|test [--workers 2] [--check 3]

The check asks for one of three extra shots when it is not sure (services/vision fusion.RETAKES).
SightBench has one photo of each delivered item, so the retakes are SIMULATED: rendered with the
same generator as the pair, deterministically, from seed_for(SEED, "retake", kind, pair id).

- The item is drawn again from the pair's own seed, so it is the same item with the same damage
  (same spot, same size) as in the pair's photo. ``--check N`` re-renders the first N pairs' original
  photos this way and fails unless the bytes are identical.
- ``light`` ("near a window or under a bright light"): a new photo of the item in day light
  (sample_light("day")), on a new surface, at a new angle and distance.
- ``paper`` ("a sheet of plain white paper next to the item"): a new photo under the pair's OWN
  light (same colour temperature, exposure and camera), on a new surface, with an A4-shaped sheet of
  white paper partly under the item, and the item a little smaller in the frame so the paper shows.
- ``tag`` ("a close photo of the size tag, flat"): the size tag again under the pair's OWN light,
  filling more of the frame (80-92% of the width instead of 42-86%), turned at most 8 degrees
  (instead of 35) and not bent. Mugs have no tag and get no tag retake.

The light is never made better than the pair's own except in the ``light`` retake, which is what
that shot asks for. Images go to evals/data/raw/sightbench/retakes/ (git-ignored); the manifest
manifests/retake-<split>.json lists every image with its sha256. Everything is synthetic.
"""

from __future__ import annotations

import argparse
import json
import math
import os
import sys
import time
from concurrent.futures import ProcessPoolExecutor
from pathlib import Path
from typing import Any

import cv2
import numpy as np

from . import render
from .catalog import Product, build_catalog
from .common import MANIFEST_DIR, RAW_DIR, load_manifest, rel, sha256_bytes, verify_freeze
from .generate import SEED, plan_split, seed_for, split_products
from .render import OUT_H, OUT_W, S, U

RETAKE_DIR = RAW_DIR / "retakes"
KINDS = ("light", "paper", "tag")
PAPER = "#f3f2ee"

_PRODUCTS: dict[str, Product] = {}


def _init(products: list[dict[str, Any]]) -> None:
    for d in products:
        p = Product(**d)
        _PRODUCTS[p.id] = p


def plans_by_id() -> dict[str, dict[str, Any]]:
    """The generator's pair plans (product, colour, size, damage), without rendering anything."""
    rng = np.random.default_rng(SEED)
    products = build_catalog(SEED)
    split = split_products(products, rng)
    n_dev = round(0.3 * 600)
    plans = {"dev": plan_split(split["dev"], n_dev, rng), "test": plan_split(split["test"], 600 - n_dev, rng)}
    out: dict[str, dict[str, Any]] = {}
    n = 0
    for name in ("dev", "test"):
        for sp in plans[name]:
            n += 1
            dv = sp["delivered"]
            out[f"sb{n:04d}"] = {"product": dv["product"].id, "colour": dv["colour"], "size": dv["size"], "damage": dv["damage"], "lighting": sp["lighting"]}
    return out


def _item(job: dict[str, Any]) -> tuple[render.Canvas, np.random.Generator]:
    """The pair's item exactly as in its photo, and the pair's RNG positioned after the drawing."""
    rng = np.random.default_rng(seed_for(SEED, "pair", job["id"]))
    q = _PRODUCTS[job["product"]]
    cv, _ = render.draw_item(q, job["colour"], rng, job["damage"])
    return cv, rng


def original_item_bytes(job: dict[str, Any]) -> bytes:
    """The pair's original item photo, re-rendered (for the --check reproduction test)."""
    cv, rng = _item(job)
    light = render.sample_light(job["lighting"], rng)
    data, _ = render.render_delivered(cv, light, rng)
    return data


def original_label_bytes(job: dict[str, Any]) -> bytes:
    """The pair's original tag photo, re-rendered (for the --check reproduction test)."""
    cv, rng = _item(job)
    light = render.sample_light(job["lighting"], rng)
    render.render_delivered(cv, light, rng)
    data, _ = render.render_label(_PRODUCTS[job["product"]], job["colour"], job["size"], light, rng)
    return data


def _paper_scene(cv: render.Canvas, p: dict[str, Any], rng: np.random.Generator) -> bytes:
    """render.render_delivered with a sheet of white paper on the surface and the item a bit smaller."""
    h, w = OUT_H, OUT_W
    bg_alb, bg_shade, _ = render.background(rng, h, w)
    # A4 sheet (210 x 297 mm), long side about 45% of the frame height, partly under the item.
    ph = 0.45 * h
    pw = ph * 210 / 297
    px = w * U(rng, 0.2, 0.8)
    py = h * (U(rng, 0.12, 0.25) if rng.random() < 0.5 else U(rng, 0.75, 0.88))
    box = cv2.boxPoints(((px, py), (pw, ph), U(rng, -25, 25))).astype(np.int32)
    sheet = np.zeros((h, w), np.uint8)
    cv2.fillConvexPoly(sheet, box, 255, lineType=cv2.LINE_AA)
    sm = sheet.astype(np.float32)[..., None] / 255.0
    bg_alb = bg_alb * (1 - sm) + render.hex_lin(PAPER) * sm
    bg_shade = bg_shade * (1 - sm[..., 0]) + sm[..., 0] * (1 + 0.01 * render.smooth_noise(rng, h, w, 40))
    scale = U(rng, 0.55, 0.72) * w / S
    theta = U(rng, -30, 30)
    cx = w / 2 + U(rng, -0.07, 0.07) * w
    cy = h / 2 + (0.12 if py < h / 2 else -0.12) * h
    alpha, albedo, relief, gloss = render._place(cv, h, w, scale, theta, cx, cy)
    if cv.garment:
        relief = relief * (1 + 0.12 * render.smooth_noise(rng, h, w, 0.12 * w))
    a = p["light_dir"]
    off = 0.012 * w
    m = np.float32([[1, 0, -off * math.cos(a)], [0, 1, -off * math.sin(a) + off * 0.5]])
    shadow = cv2.GaussianBlur(cv2.warpAffine(alpha, m, (w, h)), (0, 0), 0.018 * w)
    bg_shade = bg_shade * (1 - U(rng, 0.25, 0.45) * shadow)
    comp_alb = albedo + (1 - alpha)[..., None] * bg_alb
    shade = alpha * relief + (1 - alpha) * bg_shade
    e = render.light_field(p, h, w)
    illum = render.cct_rgb(p["cct"])
    rad = comp_alb * (shade * e)[..., None] * illum + (gloss * p["spec"] * e)[..., None] * illum
    rad, _ = render._perspective(rad.astype(np.float32), rng, 0.05, U(rng, 1.03, 1.1))
    return render.jpeg_bytes(render.camera(rad, p, rng), p["jpeg"])


def _close_tag(job: dict[str, Any], rng: np.random.Generator) -> bytes:
    """The pair's own size tag (same design, text and fabric), photographed closer and flatter.

    The pair's RNG is replayed through its item photo and the start of render.render_label, so the
    tag is the one in the pair's tag photo. Only its placement and the camera noise use the retake's
    RNG: the tag fills 80-92% of the width, is turned at most 8 degrees and is not bent.
    """
    h, w = OUT_H, OUT_W
    q = _PRODUCTS[job["product"]]
    cv, pair_rng = _item(job)
    light = render.sample_light(job["lighting"], pair_rng)
    render.render_delivered(cv, light, pair_rng)
    if q.type == "shoe":
        lining = str(pair_rng.choice(render.LININGS))
        fab = np.empty((h, w, 3), np.float32)
        fab[:] = render.hex_lin(lining)
        fshade = render.garment_texture("mesh", pair_rng, U(pair_rng, 2.0, 3.0), h, w)
        shoe_bg: str | None = lining
    else:
        fab = np.empty((h, w, 3), np.float32)
        fab[:] = render.dye(q, job["colour"])
        kind = {"sweater": q.features.get("knit", "plain"), "tee": "jersey", "hoodie": "fleece"}[q.type]
        fshade = render.garment_texture("plain" if kind == "cable" else kind, pair_rng, U(pair_rng, 2.2, 3.4), h, w)
        shoe_bg = None
    fshade = fshade * (1 + 0.1 * render.smooth_noise(pair_rng, h, w, 0.2 * w))
    tag_alb, tag_alpha, meta = render._draw_tag(q, job["size"], pair_rng, shoe_bg)
    th_, tw_ = tag_alpha.shape
    frac = U(rng, 0.8, 0.92)
    scale = min(frac * w / tw_, 0.92 * h / th_)
    theta = U(rng, -8, 8)
    cx, cy = w / 2 + U(rng, -0.03, 0.03) * w, h / 2 + U(rng, -0.03, 0.03) * h
    a = cv2.getRotationMatrix2D((tw_ / 2, th_ / 2), theta, scale)
    a[0, 2] += cx - tw_ / 2
    a[1, 2] += cy - th_ / 2
    ta = cv2.warpAffine(tag_alpha, a, (w, h), flags=cv2.INTER_LINEAR, borderValue=0)
    talb = cv2.warpAffine(tag_alb, a, (w, h), flags=cv2.INTER_LINEAR, borderValue=(0, 0, 0))
    tshade = 1 + 0.04 * render.smooth_noise(rng, h, w, 0.25 * w) if meta["style"] == "tag" else fshade
    comp = talb * ta[..., None] + fab * (1 - ta)[..., None]
    shade = ta * tshade + (1 - ta) * fshade
    e = render.light_field(light, h, w)
    illum = render.cct_rgb(light["cct"])
    rad = comp * (shade * e)[..., None] * illum
    rad, _ = render._perspective(rad.astype(np.float32), rng, 0.03, U(rng, 1.02, 1.05))
    return render.jpeg_bytes(render.camera(rad, light, rng), light["jpeg"])


def render_job(job: dict[str, Any]) -> dict[str, Any]:
    out: dict[str, Any] = {"id": job["id"], "files": {}}
    for kind in KINDS:
        if kind == "tag" and not job["size"]:
            continue
        rng = np.random.default_rng(seed_for(SEED, "retake", kind, job["id"]))
        if kind == "light":
            cv, _ = _item(job)
            data, _ = render.render_delivered(cv, render.sample_light("day", rng), rng)
        elif kind == "paper":
            cv, _ = _item(job)
            data = _paper_scene(cv, job["light"], rng)
        else:
            data = _close_tag(job, rng)
        path = RETAKE_DIR / f"{job['id']}_{kind}.jpg"
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(data)
        out["files"][kind] = {"path": path, "sha256": sha256_bytes(data)}
    return out


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(prog="python -m sightbench.retake", description=__doc__.split("\n")[0])
    ap.add_argument("--split", choices=("dev", "test"), required=True)
    ap.add_argument("--workers", type=int, default=2)
    ap.add_argument("--check", type=int, default=3, help="Re-render this many original photos and require identical bytes.")
    ap.add_argument("--limit", type=int, help="Only the first N pairs (for a quick look).")
    args = ap.parse_args(argv)
    verify_freeze()
    manifest = load_manifest(args.split)
    plans = plans_by_id()
    products = build_catalog(SEED)
    _init([p.to_dict() for p in products])
    pairs = manifest["pairs"][: args.limit] if args.limit else manifest["pairs"]
    jobs = []
    for pair in pairs:
        plan = plans[pair["id"]]
        assert plan["product"] == pair["delivered"]["product_id"] and plan["colour"] == pair["delivered"]["colour"], pair["id"]
        light = {k: v for k, v in pair["render"]["light"].items()}
        jobs.append({"id": pair["id"], **plan, "light": light})
    for job, pair in list(zip(jobs, pairs, strict=True))[: args.check]:
        item_rel = pair["item"][0]
        expected = pair["sha256"][item_rel]
        got = sha256_bytes(original_item_bytes(job))
        if got != expected:
            raise SystemExit(f"retake: re-rendering {job['id']} did not reproduce its photo ({got[:12]} != {expected[:12]}); the item would differ.")
        if pair["label"] and sha256_bytes(original_label_bytes(job)) != pair["sha256"][pair["label"]]:
            raise SystemExit(f"retake: re-rendering {job['id']} did not reproduce its tag photo; the tag would differ.")
    print(f"retake: re-rendered {min(args.check, len(jobs))} pairs' original item and tag photos byte for byte", flush=True)
    target = MANIFEST_DIR / f"retake-{args.split}.json"
    if args.limit:
        target = RETAKE_DIR / f"retake-{args.split}-limit{args.limit}.json"
    started = time.time()
    rows: list[dict[str, Any]] = []
    with ProcessPoolExecutor(max_workers=args.workers, initializer=_init, initargs=([p.to_dict() for p in products],)) as pool:
        for i, r in enumerate(pool.map(render_job, jobs, chunksize=2), 1):
            files = {k: {"path": _rel_to(Path(v["path"]), target.parent), "sha256": v["sha256"]} for k, v in r["files"].items()}
            rows.append({"id": r["id"], "files": files})
            if i % 50 == 0:
                print(f"  {i}/{len(jobs)} in {time.time() - started:.0f} s", flush=True)
    out = {
        "name": f"sightbench-retake-{args.split}",
        "split": args.split,
        "synthetic": True,
        "simulated_retake": True,
        "seed": SEED,
        "generator": rel(Path(__file__)),
        "note": __doc__.split("\n\n", 2)[2].strip(),
        "paths": "Relative to this manifest file. Images live in evals/data/raw/sightbench/retakes/ (git-ignored); regenerate them with the generator.",
        "pairs": rows,
    }
    target.write_text(json.dumps(out, indent=2) + "\n", encoding="utf-8")
    print(f"retake: {len(rows)} pairs -> {rel(target) if not args.limit else target}")
    return 0


def _rel_to(path: Path, base: Path) -> str:
    return os.path.relpath(path, base).replace(os.sep, "/")


if __name__ == "__main__":
    sys.exit(main())
