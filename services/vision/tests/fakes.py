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


REGIONS = {"neckline": "neckline at the top centre", "pattern": "front of the body", "logo_placement": "chest, left side"}


def identity_answer(
    same: str,
    mismatch: tuple[str, str, str] | None = None,
    product_type_item: str = "sweater",
    cited: bool = True,
    legacy: bool = False,
) -> dict[str, Any]:
    """A model answer in the current schema (``cited=False`` leaves every region empty).

    ``legacy`` gives the answer shape from before citations were asked for.
    """
    attrs = [
        {"name": "neckline", "listing": "crew neck", "item": "round crew neckline", "match": "yes"},
        {"name": "pattern", "listing": "plain knit", "item": "plain knit body", "match": "yes"},
        {"name": "logo_placement", "listing": "none", "item": "no logo on the chest", "match": "yes"},
    ]
    if mismatch:
        name, listing_value, item_value = mismatch
        attrs = [a for a in attrs if a["name"] != name] + [{"name": name, "listing": listing_value, "item": item_value, "match": "no"}]
    answer: dict[str, Any] = {
        "same_product": same,
        "product_type_listing": "sweater",
        "product_type_item": product_type_item,
        "attributes": attrs,
        "notes": "",
    }
    if not legacy:
        for a in attrs:
            a["item_region"] = REGIONS.get(a["name"], "front of the body") if cited else ""
        answer["item_type_evidence"] = (
            {"region": "whole body and sleeves", "sees": f"a knitted {product_type_item}"} if cited else {"region": "", "sees": ""}
        )
    return answer


def damage_answer(**seen: tuple[str, ...]) -> dict[str, Any]:
    """``kind=(seen, where)`` or ``kind=(seen, where, sees)``; ``sees`` defaults to a concrete description."""
    out: dict[str, Any] = {k: {"seen": "no", "where": "", "sees": ""} for k in ("tears", "stains", "broken_parts", "missing_pieces")}
    for kind, value in seen.items():
        level, where = value[0], value[1]
        sees = value[2] if len(value) > 2 else (f"a dark mark at the {where}" if where else "")
        out[kind] = {"seen": level, "where": where, "sees": sees}
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
