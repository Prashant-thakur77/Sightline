"""Identity module: is the delivered item the same product and design as the listing?

The vision model compares explicit attributes (neckline, sleeves, pattern, logo placement, closure,
pockets, shape, material look) between the delivered photos and the listing images. A ``sure``
disagreement needs concrete evidence: at least one attribute that differs with both sides described,
or a different product type. A model "no" without evidence is only ``fairly_sure``.
"""

from __future__ import annotations

import re
from collections.abc import Sequence
from typing import Any

from .vlm import IDENTITY_ATTRIBUTES, ImagePart, VlmClient, VlmUnavailable

_YES_NO = ("yes", "no", "unclear")


def _norm_type(text: str) -> str:
    t = re.sub(r"[^a-z ]", " ", text.lower())
    t = re.sub(r"\s+", " ", t).strip()
    return t[:-1] if t.endswith("s") and not t.endswith("ss") else t


def _types_differ(a: str, b: str) -> bool:
    na, nb = _norm_type(a), _norm_type(b)
    if not na or not nb:
        return False
    # "crew neck sweater" vs "sweater" is the same type
    return not (na == nb or na.endswith(" " + nb) or nb.endswith(" " + na) or na.split()[-1] == nb.split()[-1])


def _attributes(raw: Any) -> list[dict[str, str]]:
    out: list[dict[str, str]] = []
    for a in raw if isinstance(raw, list) else []:
        if not isinstance(a, dict):
            continue
        name = str(a.get("name", "")).strip()
        match = str(a.get("match", "unclear")).strip().lower()
        out.append(
            {
                "name": name if name in IDENTITY_ATTRIBUTES else "other",
                "listing": str(a.get("listing", "")).strip(),
                "item": str(a.get("item", "")).strip(),
                "match": match if match in _YES_NO else "unclear",
            }
        )
    return out


def check_identity(
    vlm: VlmClient,
    item_images: Sequence[ImagePart],
    listing_images: Sequence[ImagePart],
    listing: dict[str, Any],
) -> dict[str, Any]:
    out: dict[str, Any] = {
        "finding": "unknown",
        "confidence": "not_sure",
        "same_product": None,
        "product_type_listing": None,
        "product_type_item": None,
        "attributes": [],
        "mismatches": [],
        "notes": "",
        "reason": None,
        "engine": vlm.name,
    }
    if not listing_images and not listing.get("title"):
        out["reason"] = "nothing_to_compare"
        return out
    if not item_images:
        out["reason"] = "no_item_photo"
        return out
    info = {"title": listing.get("title"), "attributes": listing.get("attributes") or {}}
    try:
        data = vlm.compare_identity(item_images, listing_images, info)
    except VlmUnavailable as exc:
        out["reason"] = "model_unavailable"
        out["error"] = str(exc)
        return out

    same = str(data.get("same_product", "unclear")).strip().lower()
    same = same if same in _YES_NO else "unclear"
    attrs = _attributes(data.get("attributes"))
    t_list = str(data.get("product_type_listing") or "").strip()
    t_item = str(data.get("product_type_item") or "").strip()
    mismatches = [a for a in attrs if a["match"] == "no" and a["listing"] and a["item"]]
    matches = [a for a in attrs if a["match"] == "yes"]
    type_differs = _types_differ(t_list, t_item)
    out.update(
        {
            "same_product": same,
            "product_type_listing": t_list or None,
            "product_type_item": t_item or None,
            "attributes": attrs,
            "mismatches": mismatches,
            "type_differs": type_differs,
            "notes": str(data.get("notes") or ""),
        }
    )
    if same == "no":
        out["finding"] = "disagree"
        out["confidence"] = "sure" if (mismatches or type_differs) else "fairly_sure"
        if not (mismatches or type_differs):
            out["reason"] = "no_specific_difference"
    elif same == "yes":
        if mismatches or type_differs:
            out["reason"] = "contradictory_answer"
        else:
            out["finding"] = "agree"
            out["confidence"] = "sure" if len(matches) >= 2 else "fairly_sure"
    else:
        out["reason"] = "unclear"
    return out
