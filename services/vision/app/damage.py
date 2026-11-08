"""Damage module: tears, stains, broken parts and missing pieces.

The vision model answers each kind explicitly (``clearly`` / ``possibly`` / ``no`` /
``cannot_tell``). Damage that is clearly visible is a ``sure`` disagreement; possible damage is
``fairly_sure`` and on its own leads to "unsure" with a request for a closer photo. No damage seen
is ``fairly_sure`` agreement: one photo cannot prove there is no damage anywhere.
"""

from __future__ import annotations

from collections.abc import Sequence
from typing import Any

from .vlm import DAMAGE_KINDS, ImagePart, VlmClient, VlmUnavailable

_SEEN = ("clearly", "possibly", "no", "cannot_tell")

# Singular nouns used in spoken sentences.
KIND_NOUNS = {"tears": "a tear", "stains": "a stain", "broken_parts": "a broken part", "missing_pieces": "a missing piece"}


def check_damage(vlm: VlmClient, images: Sequence[ImagePart], dedicated_photo: bool) -> dict[str, Any]:
    out: dict[str, Any] = {
        "finding": "unknown",
        "confidence": "not_sure",
        "findings": {},
        "found": [],
        "notes": "",
        "dedicated_photo": dedicated_photo,
        "reason": None,
        "engine": vlm.name,
    }
    if not images:
        out["reason"] = "no_photo"
        return out
    try:
        data = vlm.check_damage(images)
    except VlmUnavailable as exc:
        out["reason"] = "model_unavailable"
        out["error"] = str(exc)
        return out

    findings: dict[str, dict[str, str]] = {}
    for kind in DAMAGE_KINDS:
        raw = data.get(kind) if isinstance(data.get(kind), dict) else {}
        seen = str(raw.get("seen", "cannot_tell")).strip().lower()
        findings[kind] = {"seen": seen if seen in _SEEN else "cannot_tell", "where": str(raw.get("where") or "").strip()}
    out["findings"] = findings
    out["notes"] = str(data.get("notes") or "")

    clear = [k for k, f in findings.items() if f["seen"] == "clearly"]
    possible = [k for k, f in findings.items() if f["seen"] == "possibly"]
    unknown = [k for k, f in findings.items() if f["seen"] == "cannot_tell"]
    out["found"] = [{"kind": k, **findings[k]} for k in clear + possible]
    if clear:
        out["finding"], out["confidence"] = "disagree", "sure"
    elif possible:
        out["finding"], out["confidence"] = "disagree", "fairly_sure"
        out["reason"] = "possible_damage"
    elif unknown:
        out["reason"] = "not_visible"
    else:
        out["finding"], out["confidence"] = "agree", "fairly_sure"
    return out
