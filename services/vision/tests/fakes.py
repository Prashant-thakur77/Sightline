"""Fake vision model and OCR engines for tests (no network)."""

from __future__ import annotations

from collections.abc import Sequence
from typing import Any

import numpy as np

from app.label import OcrLine
from app.vlm import ImagePart, VlmUnavailable


class FakeVlm:
    """Returns canned answers and records what it was asked."""

    name = "fake"
    available = True

    def __init__(
        self,
        label: dict[str, Any] | None = None,
        identity: dict[str, Any] | None = None,
        damage: dict[str, Any] | None = None,
        fail: bool = False,
    ) -> None:
        self.label = label if label is not None else label_answer("M")
        self.identity = identity if identity is not None else identity_answer("yes")
        self.damage = damage if damage is not None else damage_answer()
        self.fail = fail
        self.calls: list[tuple[str, int]] = []

    def read_label(self, image: ImagePart) -> dict[str, Any]:
        self.calls.append(("label", 1))
        if self.fail:
            raise VlmUnavailable("fake failure")
        return self.label

    def compare_identity(self, item: Sequence[ImagePart], listing: Sequence[ImagePart], listing_info: dict[str, Any]) -> dict[str, Any]:
        self.calls.append(("identity", len(item) + len(listing)))
        if self.fail:
            raise VlmUnavailable("fake failure")
        return self.identity

    def check_damage(self, images: Sequence[ImagePart]) -> dict[str, Any]:
        self.calls.append(("damage", len(images)))
        if self.fail:
            raise VlmUnavailable("fake failure")
        return self.damage


def label_answer(size: str, box: list[float] | None = None) -> dict[str, Any]:
    boxes = [{"label": "size", "box": box}] if box else []
    return {"size": size, "brand": "Harbor", "material": "100% cotton", "raw_text": f"HARBOR\n{size}\n100% COTTON", "boxes": boxes}


def identity_answer(same: str, mismatch: tuple[str, str, str] | None = None, product_type_item: str = "sweater") -> dict[str, Any]:
    attrs = [
        {"name": "neckline", "listing": "crew neck", "item": "crew neck", "match": "yes"},
        {"name": "pattern", "listing": "plain knit", "item": "plain knit", "match": "yes"},
        {"name": "logo_placement", "listing": "none", "item": "none", "match": "yes"},
    ]
    if mismatch:
        name, listing_value, item_value = mismatch
        attrs = [a for a in attrs if a["name"] != name] + [{"name": name, "listing": listing_value, "item": item_value, "match": "no"}]
    return {
        "same_product": same,
        "product_type_listing": "sweater",
        "product_type_item": product_type_item,
        "attributes": attrs,
        "notes": "",
    }


def damage_answer(**seen: tuple[str, str]) -> dict[str, Any]:
    out: dict[str, Any] = {k: {"seen": "no", "where": ""} for k in ("tears", "stains", "broken_parts", "missing_pieces")}
    for kind, (level, where) in seen.items():
        out[kind] = {"seen": level, "where": where}
    out["notes"] = ""
    return out


class FakeOcr:
    """OCR that returns fixed lines."""

    name = "fake-ocr"
    available = True

    def __init__(self, lines: list[tuple[str, float, tuple[float, float, float, float]]] | None = None, line: str | None = None):
        self.lines = [OcrLine(t, s, b) for t, s, b in (lines or [])]
        self.line = line
        self.read_calls = 0

    def read(self, rgb: np.ndarray) -> list[OcrLine]:
        self.read_calls += 1
        return list(self.lines)

    def read_line(self, rgb: np.ndarray) -> OcrLine | None:
        return OcrLine(self.line, 0.95, (0, 0, 1, 1)) if self.line else None
