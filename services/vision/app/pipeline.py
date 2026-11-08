"""The /verify logic, shared by the API and the benchmark CLI.

Inputs are already sanitised (GPS stripped). Each module is timed and isolated: a failure in one
module turns into an ``unknown`` finding for that module instead of failing the whole check.
"""

from __future__ import annotations

import logging
import time
from collections.abc import Callable, Iterator
from concurrent.futures import ThreadPoolExecutor
from contextlib import contextmanager
from dataclasses import dataclass, field
from typing import Any

import numpy as np

from . import colour, damage, fusion, identity, label, mask, quality
from .config import Limits, thresholds
from .imageio import SanitizedImage, decode, encode_jpeg
from .label import OcrEngine, get_ocr_engine
from .vlm import ImagePart, VlmClient, get_vlm_client

log = logging.getLogger(__name__)

LABEL_MAX_SIDE = 1600
VLM_MAX_SIDE = 1024
COLOUR_MAX_SIDE = 512  # colour statistics do not need more pixels than this
MODULES = ("colour", "size", "identity", "damage")


@dataclass
class VerifyInputs:
    item_photos: list[SanitizedImage]
    label_photo: SanitizedImage | None = None
    damage_photo: SanitizedImage | None = None
    listing_images: list[SanitizedImage] = field(default_factory=list)
    listing: dict[str, Any] = field(default_factory=dict)


class Timer:
    def __init__(self) -> None:
        self.ms: dict[str, float] = {}

    @contextmanager
    def __call__(self, name: str) -> Iterator[None]:
        start = time.perf_counter()
        try:
            yield
        finally:
            self.ms[name] = round(self.ms.get(name, 0.0) + (time.perf_counter() - start) * 1000.0, 2)


def _failed(name: str, exc: BaseException) -> dict[str, Any]:
    log.exception("module %s failed", name, exc_info=exc)
    return {"finding": "unknown", "confidence": "not_sure", "reason": "error", "error": type(exc).__name__}


def _guard(name: str, fn: Callable[[], dict[str, Any]]) -> dict[str, Any]:
    try:
        return fn()
    except Exception as exc:  # noqa: BLE001 - isolate module failures
        return _failed(name, exc)


def _vlm_part(rgb: np.ndarray) -> ImagePart:
    small = quality.downscale(rgb, VLM_MAX_SIDE)
    return ImagePart(encode_jpeg(small, quality=88), "image/jpeg")


def run_verify(
    inputs: VerifyInputs,
    vlm: VlmClient | None = None,
    ocr: OcrEngine | None = None,
    th: dict[str, Any] | None = None,
    disabled: set[str] | frozenset[str] = frozenset(),
) -> dict[str, Any]:
    """Run the whole check. Returns ``{verdict, modules, timings_ms}``."""
    th = th or thresholds()
    vlm = vlm or get_vlm_client()
    ocr = ocr or get_ocr_engine()
    timer = Timer()
    start = time.perf_counter()
    listing = inputs.listing or {}

    with timer("decode"):
        items = [decode(p.data, Limits.verify_max_side) for p in inputs.item_photos]
        listing_rgbs = [decode(p.data, Limits.verify_max_side) for p in inputs.listing_images]
        label_rgb = decode(inputs.label_photo.data, LABEL_MAX_SIDE) if inputs.label_photo else None
        damage_rgb = decode(inputs.damage_photo.data, Limits.verify_max_side) if inputs.damage_photo else None

    with timer("quality"):
        q_results = [quality.assess(rgb, th["quality"]) for rgb in items]
        best = min(range(len(items)), key=lambda i: (not q_results[i].ok, -q_results[i].metrics["sharpness"]))
    chosen_quality = q_results[best].to_dict()

    modules: dict[str, Any] = {
        "photos": {
            "item": [p.meta() for p in inputs.item_photos],
            "label": inputs.label_photo.meta() if inputs.label_photo else None,
            "damage": inputs.damage_photo.meta() if inputs.damage_photo else None,
            "listing": [p.meta() for p in inputs.listing_images],
        },
        "quality": {**chosen_quality, "chosen_item_index": best, "all_items": [q.to_dict() for q in q_results]},
        "engines": {"vlm": vlm.name, "ocr": ocr.name, "thresholds": th.get("version")},
    }

    # Colour: mask the chosen item photo and every listing image with the same function.
    if "colour" not in disabled:

        def run_colour() -> dict[str, Any]:
            item_small = quality.downscale(items[best], COLOUR_MAX_SIDE)
            listing_small = [quality.downscale(rgb, COLOUR_MAX_SIDE) for rgb in listing_rgbs]
            with timer("mask"):
                item_mask = mask.item_mask(item_small, th["mask"])
                listing_masks = [mask.item_mask(rgb, th["mask"]) for rgb in listing_small]
            modules["mask"] = {"item": item_mask.to_dict(), "listing": [m.to_dict() for m in listing_masks]}
            with timer("colour"):
                delivered = colour.analyse_image(item_small, item_mask.mask, th["colour"])
                listed = [colour.analyse_image(rgb, m.mask, th["colour"]) for rgb, m in zip(listing_small, listing_masks, strict=True)]
                return colour.compare(delivered, listed, listing.get("colour"), th["colour"], mask_reliable=item_mask.reliable)

        modules["colour"] = _guard("colour", run_colour)

    item_parts = [_vlm_part(rgb) for rgb in items[: Limits.max_item_photos]]
    listing_parts = [_vlm_part(rgb) for rgb in listing_rgbs[: Limits.max_listing_images]]
    damage_parts = ([_vlm_part(damage_rgb)] if damage_rgb is not None else []) + item_parts

    def run_size() -> dict[str, Any]:
        with timer("size"):
            return label.check_size(label_rgb, listing.get("size"), vlm, ocr, th["label"])

    def run_identity() -> dict[str, Any]:
        with timer("identity"):
            return identity.check_identity(vlm, item_parts, listing_parts, listing)

    def run_damage() -> dict[str, Any]:
        with timer("damage"):
            return damage.check_damage(vlm, damage_parts, dedicated_photo=damage_rgb is not None)

    jobs = {"size": run_size, "identity": run_identity, "damage": run_damage}
    jobs = {k: v for k, v in jobs.items() if k not in disabled}
    if vlm.available and len(jobs) > 1:
        # The model calls are network-bound; run them side by side.
        with ThreadPoolExecutor(max_workers=len(jobs)) as pool:
            futures = {k: pool.submit(_guard, k, fn) for k, fn in jobs.items()}
            for k, fut in futures.items():
                modules[k] = fut.result()
    else:
        for k, fn in jobs.items():
            modules[k] = _guard(k, fn)

    with timer("fusion"):
        verdict = fusion.fuse(
            {
                "quality": chosen_quality,
                "colour": modules.get("colour"),
                "size": modules.get("size"),
                "identity": modules.get("identity"),
                "damage": modules.get("damage"),
            },
            listing,
            th["fusion"],
        )
    timer.ms["total"] = round((time.perf_counter() - start) * 1000.0, 2)
    return {"verdict": verdict, "modules": modules, "timings_ms": timer.ms}
