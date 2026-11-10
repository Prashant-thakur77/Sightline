"""Damage module: tears, stains, broken parts and missing pieces.

The vision model answers each kind explicitly (``clearly`` / ``possibly`` / ``no`` /
``cannot_tell``). Damage that is clearly visible is a ``sure`` disagreement; possible damage is
``fairly_sure`` and on its own leads to "unsure" with a request for a closer photo. No damage seen
is ``fairly_sure`` agreement: one photo cannot prove there is no damage anywhere.

Quote-or-unsure (checked here in code, see ``citation.py``): damage counts only when the read names
the spot on the item (``where``) and what is visible there (``sees``). Damage without that citation,
or described together with a harmless explanation ("a stain, or just shadow"), counts as
``cannot_tell``. Reads made before citations were asked for (no ``sees`` field) are scored
by the older rule.
"""

from __future__ import annotations

from collections.abc import Sequence
from typing import Any

from .citation import damage_citation_ok
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
    uncited: list[str] = []
    for kind in DAMAGE_KINDS:
        raw = data.get(kind) if isinstance(data.get(kind), dict) else {}
        seen = str(raw.get("seen", "cannot_tell")).strip().lower()
        seen = seen if seen in _SEEN else "cannot_tell"
        f = {"seen": seen, "where": str(raw.get("where") or "").strip()}
        if "sees" in raw:
            f["sees"] = str(raw.get("sees") or "").strip()
            if seen in ("clearly", "possibly") and not damage_citation_ok(f["where"], f["sees"]):
                # Damage the read cannot point to counts as "can't tell", never as damage.
                uncited.append(kind)
                f = {**f, "seen": "cannot_tell", "said": seen}
        findings[kind] = f
    out["findings"] = findings
    if uncited:
        out["uncited"] = uncited
    out["notes"] = str(data.get("notes") or "")

    clear = [k for k, f in findings.items() if f["seen"] == "clearly"]
    possible = [k for k, f in findings.items() if f["seen"] == "possibly"]
    unknown = [k for k, f in findings.items() if f["seen"] == "cannot_tell"]
    out["found"] = [{"kind": k, "seen": findings[k]["seen"], "where": findings[k]["where"]} for k in clear + possible]
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
