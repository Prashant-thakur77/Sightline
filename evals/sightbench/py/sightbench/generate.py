"""Generate SightBench: products, the dev/test split, pairs with ground truth, images, manifests and
the test freeze record.

    uv run python -m sightbench.generate                 # build everything (refuses to change a frozen test set)
    uv run python -m sightbench.generate --preview DIR   # a few pairs from a different seed, for eyeballing

Order of work, so nothing is tuned before the freeze:
1. Build the catalogue (seeded) and split it by product id: 30% of each product type to dev, the
   rest to test. A product and every product it is swapped with live in one split only.
2. Plan pairs inside each split: 50% match, 50% mismatch, mismatches stratified by type (colour,
   size, model, damage) and every stratum spread evenly over the three light levels.
3. Render every image, hash it, write manifests/{dev,test}.json and then manifests/test.freeze.json
   with the sha256 of the test manifest. Re-running reproduces the same bytes; if the test manifest
   would change, the generator stops instead of overwriting the freeze.

All images are synthetic renders (see render.py), not photographs.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import sys
import time
from concurrent.futures import ProcessPoolExecutor
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

import numpy as np

from . import render
from .catalog import (
    COLOURS,
    LETTER_SIZES,
    LISTING_LETTERS,
    LISTING_SHOES,
    NEAR_PAIRS,
    OTHER_NEAR,
    SHOE_SIZES,
    Product,
    build_catalog,
    listing_size,
)
from .common import FREEZE_PATH, MANIFEST_DIR, PY_DIR, RAW_DIR, manifest_path, rel, sha256_bytes, sha256_file

SEED = 20261109
N_PAIRS = 600
DEV_FRACTION = 0.3
LIGHTS = ("day", "lamp", "dim")
MISMATCH_TYPES = ("colour", "size", "model", "damage")
SYNTHETIC_NOTE = (
    "SYNTHETIC: every image is a procedural render (render.py), not a photograph. Listing images are clean product renders; "
    "delivered photos are phone-like renders with perspective, rotation, uneven light, colour casts, blur, noise and JPEG artefacts."
)


def seed_for(*parts: Any) -> int:
    return int(hashlib.sha256("|".join(map(str, parts)).encode()).hexdigest()[:15], 16)


class Cycler:
    """Cycles through items in a shuffled order, reshuffling every pass, so use is balanced."""

    def __init__(self, items: list[Any], rng: np.random.Generator) -> None:
        self.items = list(items)
        self.rng = rng
        self.queue: list[Any] = []

    def next(self) -> Any:
        if not self.queue:
            self.queue = [self.items[i] for i in self.rng.permutation(len(self.items))]
        return self.queue.pop()


def _lab(c: str) -> np.ndarray:
    return render._lin_to_lab(render.hex_lin(COLOURS[c]))


def split_products(products: list[Product], rng: np.random.Generator) -> dict[str, list[Product]]:
    out: dict[str, list[Product]] = {"dev": [], "test": []}
    for ptype in sorted({p.type for p in products}):
        group = [p for p in products if p.type == ptype]
        order = rng.permutation(len(group))
        k = round(DEV_FRACTION * len(group))
        out["dev"] += [group[i] for i in order[:k]]
        out["test"] += [group[i] for i in order[k:]]
    return out


def _listing_size(p: Product, rng: np.random.Generator) -> str | None:
    if p.type == "shoe":
        return str(rng.choice(LISTING_SHOES))
    if p.sizes:
        return str(rng.choice(LISTING_LETTERS))
    return None


def _counts(n: int, k: int) -> list[int]:
    return [n // k + (1 if i < n % k else 0) for i in range(k)]


def plan_split(products: list[Product], n_pairs: int, rng: np.random.Generator) -> list[dict[str, Any]]:
    n_match = n_pairs // 2
    per_type = dict(zip(MISMATCH_TYPES, _counts(n_pairs - n_match, len(MISMATCH_TYPES)), strict=True))
    specs: list[dict[str, Any]] = []

    def add(stratum: str, p: Product, colour: str, size: str | None, delivered: dict[str, Any], mtype: str | None, subtype: str | None) -> None:
        specs.append({"stratum": stratum, "product": p, "colour": colour, "size": size, "delivered": delivered, "mismatch_type": mtype, "mismatch_subtype": subtype})

    every = Cycler(products, rng)
    for _ in range(n_match):
        p = every.next()
        c = str(rng.choice(p.colours))
        s = _listing_size(p, rng)
        add("match", p, c, s, {"product": p, "colour": c, "size": s, "damage": None}, None, None)

    # Colour: navy vs black is oversampled on purpose (40%), other near pairs 30%, clearly different colours 30%.
    n_col = per_type["colour"]
    n_nb = round(0.4 * n_col)
    n_near = round(0.3 * n_col)
    n_far = n_col - n_nb - n_near
    for _ in range(n_nb):
        p = every.next()
        a, b = ("navy", "black") if rng.random() < 0.5 else ("black", "navy")
        s = _listing_size(p, rng)
        add("colour:navy-black", p, a, s, {"product": p, "colour": b, "size": s, "damage": None}, "colour", "near: navy/black")
    for _ in range(n_near):
        p = every.next()
        pairs = [pr for pr in OTHER_NEAR if pr[0] in p.colours and pr[1] in p.colours]
        a, b = pairs[int(rng.integers(len(pairs)))]
        if rng.random() < 0.5:
            a, b = b, a
        s = _listing_size(p, rng)
        add("colour:near", p, a, s, {"product": p, "colour": b, "size": s, "damage": None}, "colour", f"near: {'/'.join(sorted((a, b)))}")
    near = {frozenset(pr) for pr in NEAR_PAIRS}
    for _ in range(n_far):
        p = every.next()
        options = [(a, b) for a in p.colours for b in p.colours if a != b and frozenset((a, b)) not in near and float(np.linalg.norm(_lab(a) - _lab(b))) > 25]
        a, b = options[int(rng.integers(len(options)))]
        s = _listing_size(p, rng)
        add("colour:far", p, a, s, {"product": p, "colour": b, "size": s, "damage": None}, "colour", "far")

    sized = Cycler([p for p in products if p.sizes], rng)
    for _ in range(per_type["size"]):
        p = sized.next()
        s = _listing_size(p, rng)
        assert s is not None
        if p.type == "shoe":
            i = SHOE_SIZES.index(s)
            step = int(rng.choice([-2, -1, 1, 2]))
            d = SHOE_SIZES[min(len(SHOE_SIZES) - 1, max(0, i + step))]
            sub = f"shoe {'+' if step > 0 else '-'}{abs(step) * 0.5:g}"
        else:
            i = LETTER_SIZES.index(s)
            d = LETTER_SIZES[i + int(rng.choice([-1, 1]))]
            sub = "letter, next size"
        c = str(rng.choice(p.colours))
        add("size", p, c, s, {"product": p, "colour": c, "size": d, "damage": None}, "size", sub)

    n_model = per_type["model"]
    n_other = round(n_model / 3)
    by_type: dict[str, list[Product]] = {}
    for p in products:
        by_type.setdefault(p.type, []).append(p)
    garments = [p for p in products if p.type in ("sweater", "tee", "hoodie")]
    siblings = Cycler([p for p in products if len(by_type[p.type]) > 1], rng)
    for _ in range(n_model - n_other):
        p = siblings.next()
        q = [x for x in by_type[p.type] if x.id != p.id][int(rng.integers(len(by_type[p.type]) - 1))]
        c = str(rng.choice(p.colours))
        s = _listing_size(p, rng)
        add("model:same-type", p, c, s, {"product": q, "colour": c, "size": s, "damage": None}, "model", "same type, different model")
    g = Cycler(garments, rng)
    for _ in range(n_other):
        p = g.next()
        others = [x for x in garments if x.type != p.type]
        q = others[int(rng.integers(len(others)))]
        c = str(rng.choice(p.colours))
        s = _listing_size(p, rng)
        add("model:other-type", p, c, s, {"product": q, "colour": c, "size": s, "damage": None}, "model", "different product type")

    for _ in range(per_type["damage"]):
        p = every.next()
        kinds = render.DAMAGE_KINDS[p.type]
        k = str(kinds[int(rng.integers(len(kinds)))])
        c = str(rng.choice(p.colours))
        s = _listing_size(p, rng)
        add("damage", p, c, s, {"product": p, "colour": c, "size": s, "damage": k}, "damage", k)

    # Spread every stratum evenly over the three light levels.
    strata: dict[str, list[dict[str, Any]]] = {}
    for sp in specs:
        strata.setdefault(sp["stratum"], []).append(sp)
    for group in strata.values():
        order = rng.permutation(len(group))
        offset = int(rng.integers(3))
        for j, i in enumerate(order):
            group[int(i)]["lighting"] = LIGHTS[(j + offset) % 3]
    return [specs[int(i)] for i in rng.permutation(len(specs))]


# ------------------------------------------------------------------------------------------------
# Rendering (worker processes)
# ------------------------------------------------------------------------------------------------

_PRODUCTS: dict[str, Product] = {}


def _init(products: list[dict[str, Any]]) -> None:
    for d in products:
        p = Product(**d)
        _PRODUCTS[p.id] = p


def _write(path: Path, data: bytes) -> str:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(data)
    return sha256_bytes(data)


def render_listing_job(job: dict[str, Any]) -> dict[str, Any]:
    p = _PRODUCTS[job["product_id"]]
    rng = np.random.default_rng(seed_for(job["seed"], "listing", p.id, job["colour"]))
    cv, _ = render.draw_item(p, job["colour"], rng)
    data = render.render_listing(cv, rng)
    return {"path": job["path"], "sha256": _write(Path(job["path"]), data)}


def render_pair_job(job: dict[str, Any]) -> dict[str, Any]:
    rng = np.random.default_rng(seed_for(job["seed"], "pair", job["id"]))
    q = _PRODUCTS[job["delivered_product"]]
    cv, damage_info = render.draw_item(q, job["delivered_colour"], rng, job["damage"])
    light = render.sample_light(job["lighting"], rng)
    item, scene = render.render_delivered(cv, light, rng)
    out: dict[str, Any] = {"id": job["id"], "item_sha256": _write(Path(job["item_path"]), item), "scene": scene, "damage_info": damage_info}
    if job.get("label_path"):
        label, tag = render.render_label(q, job["delivered_colour"], job["delivered_size"], light, rng)
        out["label_sha256"] = _write(Path(job["label_path"]), label)
        out["tag"] = tag
    out["light"] = {k: (round(v, 5) if isinstance(v, float) else v) for k, v in light.items() if k not in ("wb_err",)}
    out["light"]["wb_gain_err"] = [round(v, 4) for v in light["wb_gain_err"]]
    out["light"]["lamp_pos"] = [round(v, 3) for v in light["lamp_pos"]]
    return out


# ------------------------------------------------------------------------------------------------
# Build
# ------------------------------------------------------------------------------------------------


def _relm(path: Path) -> str:
    return os.path.relpath(path, MANIFEST_DIR).replace(os.sep, "/")


def generator_hash() -> str:
    h = hashlib.sha256()
    for name in ("catalog.py", "render.py", "generate.py"):
        h.update((PY_DIR / "sightbench" / name).read_bytes())
    return h.hexdigest()


def build(seed: int, n_pairs: int, out_dir: Path, workers: int, ids_prefix: str = "sb") -> dict[str, Any]:
    rng = np.random.default_rng(seed)
    products = build_catalog(seed)
    split = split_products(products, rng)
    n_dev = round(DEV_FRACTION * n_pairs)
    plans = {"dev": plan_split(split["dev"], n_dev, rng), "test": plan_split(split["test"], n_pairs - n_dev, rng)}

    listing_jobs: dict[tuple[str, str], dict[str, Any]] = {}
    pair_jobs: list[dict[str, Any]] = []
    n = 0
    for name in ("dev", "test"):
        for sp in plans[name]:
            n += 1
            pid = f"{ids_prefix}{n:04d}"
            sp["id"] = pid
            sp["split"] = name
            p: Product = sp["product"]
            key = (p.id, sp["colour"])
            if key not in listing_jobs:
                listing_jobs[key] = {"product_id": p.id, "colour": sp["colour"], "seed": seed, "path": str(out_dir / "listing" / f"{p.id}_{sp['colour'].replace(' ', '-')}.jpg")}
            dv = sp["delivered"]
            pair_jobs.append(
                {
                    "id": pid,
                    "seed": seed,
                    "delivered_product": dv["product"].id,
                    "delivered_colour": dv["colour"],
                    "delivered_size": dv["size"],
                    "damage": dv["damage"],
                    "lighting": sp["lighting"],
                    "item_path": str(out_dir / "pairs" / f"{pid}_item.jpg"),
                    "label_path": str(out_dir / "pairs" / f"{pid}_label.jpg") if dv["size"] else None,
                }
            )

    started = time.time()
    with ProcessPoolExecutor(max_workers=workers, initializer=_init, initargs=([p.to_dict() for p in products],)) as pool:
        listing_res = {r["path"]: r["sha256"] for r in pool.map(render_listing_job, listing_jobs.values(), chunksize=4)}
        print(f"  {len(listing_res)} listing images in {time.time() - started:.0f} s", flush=True)
        pair_res: dict[str, dict[str, Any]] = {}
        for i, r in enumerate(pool.map(render_pair_job, pair_jobs, chunksize=2), 1):
            pair_res[r["id"]] = r
            if i % 50 == 0:
                print(f"  {i}/{len(pair_jobs)} pairs in {time.time() - started:.0f} s", flush=True)
    jobs_by_id = {j["id"]: j for j in pair_jobs}
    return {"products": products, "split": split, "plans": plans, "listing_jobs": listing_jobs, "listing_res": listing_res, "pair_res": pair_res, "jobs": jobs_by_id, "seed": seed}


def manifest(name: str, b: dict[str, Any]) -> dict[str, Any]:
    pairs = []
    for sp in b["plans"][name]:
        p: Product = sp["product"]
        dv = sp["delivered"]
        job = b["jobs"][sp["id"]]
        res = b["pair_res"][sp["id"]]
        lpath = Path(b["listing_jobs"][(p.id, sp["colour"])]["path"])
        item_path = Path(job["item_path"])
        hashes = {_relm(lpath): b["listing_res"][str(lpath)], _relm(item_path): res["item_sha256"]}
        label_rel = None
        if job["label_path"]:
            label_rel = _relm(Path(job["label_path"]))
            hashes[label_rel] = res["label_sha256"]
        pairs.append(
            {
                "id": sp["id"],
                "product_id": p.id,
                "product_type": p.type,
                "item": [_relm(item_path)],
                "label": label_rel,
                "damage": None,
                "listing_images": [_relm(lpath)],
                "listing": {"title": p.name, "colour": sp["colour"], "size": listing_size(p, sp["size"]), "attributes": p.attributes()},
                "expected": "match" if sp["mismatch_type"] is None else "mismatch",
                "mismatch_type": sp["mismatch_type"],
                "mismatch_subtype": sp["mismatch_subtype"],
                "lighting": sp["lighting"],
                "delivered": {
                    "product_id": dv["product"].id,
                    "colour": dv["colour"],
                    "size": listing_size(dv["product"], dv["size"]),
                    "damage": res.get("damage_info"),
                },
                "render": {"scene": res["scene"], "light": res["light"], **({"tag": res["tag"]} if "tag" in res else {})},
                "sha256": hashes,
            }
        )
    products = sorted({sp["product"].id for sp in b["plans"][name]} | {sp["delivered"]["product"].id for sp in b["plans"][name]})
    catalog = [p.to_dict() for p in b["products"] if p.id in products]
    for c in catalog:
        c.pop("dye_offsets", None)
    return {
        "name": f"sightbench-{name}",
        "split": name,
        "synthetic": True,
        "note": SYNTHETIC_NOTE,
        "seed": b["seed"],
        "generator": "evals/sightbench/py/sightbench/generate.py",
        "paths": "Relative to this manifest file. Images live in evals/data/raw/sightbench/ (git-ignored); regenerate them with the generator.",
        "fonts": [Path(f).name for f in render.FONT_FILES],
        "counts": _counts_summary(pairs),
        "products": catalog,
        "pairs": pairs,
    }


def _counts_summary(pairs: list[dict[str, Any]]) -> dict[str, Any]:
    out: dict[str, Any] = {"pairs": len(pairs), "match": 0, "mismatch": 0, "by_type": {}, "by_lighting": {}}
    for p in pairs:
        out[p["expected"]] += 1
        if p["mismatch_type"]:
            out["by_type"][p["mismatch_type"]] = out["by_type"].get(p["mismatch_type"], 0) + 1
        out["by_lighting"][p["lighting"]] = out["by_lighting"].get(p["lighting"], 0) + 1
    out["by_type"] = dict(sorted(out["by_type"].items()))
    out["by_lighting"] = dict(sorted(out["by_lighting"].items()))
    return out


def dumps(obj: Any) -> bytes:
    return (json.dumps(obj, indent=2, ensure_ascii=False) + "\n").encode("utf-8")


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(prog="python -m sightbench.generate", description=__doc__.split("\n")[0])
    ap.add_argument("--workers", type=int, default=3, help="Render processes (default 3; the dev laptop has little free RAM).")
    ap.add_argument("--preview", type=Path, help="Render a few pairs from a different seed into this directory; no manifests.")
    ap.add_argument("--n", type=int, default=24, help="Pairs for --preview.")
    ap.add_argument("--refreeze", action="store_true", help="Allow a new test freeze. Only for a deliberate, documented rebuild.")
    args = ap.parse_args(argv)

    if args.preview:
        b = build(SEED + 1, args.n, args.preview, args.workers, ids_prefix="pv")
        rows = []
        for name in ("dev", "test"):
            for sp in b["plans"][name]:
                rows.append({"id": sp["id"], "product": sp["product"].name, "listing": [sp["colour"], sp["size"]], "delivered": [sp["delivered"]["product"].name, sp["delivered"]["colour"], sp["delivered"]["size"], sp["delivered"]["damage"]], "type": sp["mismatch_type"], "light": sp["lighting"], "params": {k: b["pair_res"][sp["id"]]["light"].get(k) for k in ("cct", "awb", "target", "wb_gain_err")}})
        (args.preview / "preview.json").write_bytes(dumps(rows))
        print(f"preview: {len(rows)} pairs -> {args.preview}")
        return 0

    print(f"generate: seed {SEED}, {N_PAIRS} pairs -> {rel(RAW_DIR)}", flush=True)
    b = build(SEED, N_PAIRS, RAW_DIR, args.workers)
    dev, test = manifest("dev", b), manifest("test", b)
    dev_ids = {p["product_id"] for p in dev["pairs"]} | {p["delivered"]["product_id"] for p in dev["pairs"]}
    test_ids = {p["product_id"] for p in test["pairs"]} | {p["delivered"]["product_id"] for p in test["pairs"]}
    if dev_ids & test_ids:
        raise SystemExit(f"Split leak: {sorted(dev_ids & test_ids)}")
    test_bytes, dev_bytes = dumps(test), dumps(dev)
    test_sha = sha256_bytes(test_bytes)
    MANIFEST_DIR.mkdir(parents=True, exist_ok=True)
    if FREEZE_PATH.exists() and not args.refreeze:
        frozen = json.loads(FREEZE_PATH.read_text(encoding="utf-8"))
        if frozen["sha256"] != test_sha:
            raise SystemExit(
                f"The regenerated test manifest ({test_sha}) differs from the frozen one ({frozen['sha256']}). "
                "Nothing was overwritten. The images on disk may now differ from the manifest; check library versions and fonts."
            )
        manifest_path("dev").write_bytes(dev_bytes)
        manifest_path("test").write_bytes(test_bytes)
        print(f"generate: reproduced the frozen test set exactly ({test_sha[:12]})")
        return 0
    manifest_path("dev").write_bytes(dev_bytes)
    manifest_path("test").write_bytes(test_bytes)
    assert sha256_file(manifest_path("test")) == test_sha
    freeze = {
        "manifest": rel(manifest_path("test")),
        "sha256": test_sha,
        "frozen_at": datetime.now(UTC).isoformat(timespec="seconds"),
        "rule": "Frozen before any system was run or tuned. Never tune on it. check-splits.mjs fails if this hash changes.",
        "seed": SEED,
        "pairs": test["counts"]["pairs"],
        "products": len({p["product_id"] for p in test["pairs"]} | {p["delivered"]["product_id"] for p in test["pairs"]}),
        "dev_manifest": rel(manifest_path("dev")),
        "dev_sha256": sha256_bytes(dev_bytes),
        "generator_sha256": generator_hash(),
        "synthetic": True,
    }
    FREEZE_PATH.write_bytes(dumps(freeze))
    print(f"generate: dev {dev['counts']['pairs']} pairs ({len(dev_ids)} products), test {test['counts']['pairs']} pairs ({len(test_ids)} products)")
    print(f"generate: froze test manifest sha256 {test_sha}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
