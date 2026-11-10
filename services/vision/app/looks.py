"""Second look: combine the first check with ONE extra photo taken because the check was not sure.

The extra photo is one of three kinds (see ``fusion.RETAKES``):

- ``tag``: a close photo of the size tag. Re-runs the size module (model read and OCR).
- ``light``: the whole item in better light. Re-runs colour, identity and damage.
- ``paper``: the whole item next to a sheet of white paper. Re-runs colour (white balance from the
  paper).

Each re-run module is combined with its first-look output, one module at a time:

- both looks disagree: still a disagreement, now with one signal per look (two looks before
  "sure"); for size, both looks must read the same size;
- one look agrees and the other disagrees: the photos contradict each other, so ``unknown``;
- one look disagrees and the other cannot tell: the one disagreement, still one look;
- both agree, or one agrees and the other cannot tell: agreement at the better confidence.

The verdict then comes from ``fusion.fuse`` with ``looks`` set to 2, so no further retake is
asked for.
"""

from __future__ import annotations

from typing import Any

from .fusion import CONF_RANK, RETAKE_MODULES, signals_of

RETAKE_KINDS = tuple(RETAKE_MODULES)


def _summary(m: dict[str, Any]) -> dict[str, Any]:
    return {"finding": m.get("finding", "unknown"), "confidence": m.get("confidence", "not_sure")}


def _better(a: dict[str, Any], b: dict[str, Any]) -> dict[str, Any]:
    """The look with the higher confidence; the second look on a tie (it was taken to settle it)."""
    return a if CONF_RANK.get(a.get("confidence", "not_sure"), 0) > CONF_RANK.get(b.get("confidence", "not_sure"), 0) else b


def _conflict(module: str, second: dict[str, Any]) -> dict[str, Any]:
    out = {**second, "finding": "unknown", "confidence": "not_sure", "reason": "looks_disagree"}
    if module == "colour":
        out["abstain_reason"] = "looks_disagree"
        out["observed_name"] = None
    return out


def combine_module(module: str, first: dict[str, Any], second: dict[str, Any]) -> dict[str, Any]:
    """One module's finding from two looks (see the module docstring)."""
    fa, fb = first.get("finding", "unknown"), second.get("finding", "unknown")
    looks = [_summary(first), _summary(second)]
    if fa == "disagree" and fb == "disagree":
        if module == "size" and first.get("observed") and second.get("observed") and first["observed"] != second["observed"]:
            out = _conflict(module, second)
        else:
            out = {**_better(first, second), "signals": signals_of(module, first) + signals_of(module, second)}
    elif {fa, fb} == {"agree", "disagree"}:
        out = _conflict(module, second)
    elif "disagree" in (fa, fb):
        out = dict(first if fa == "disagree" else second)
    elif fa == "agree" and fb == "agree":
        out = dict(_better(first, second))
    elif "agree" in (fa, fb):
        out = dict(first if fa == "agree" else second)
    else:
        out = dict(second)
    out["looks"] = looks
    return out


def combine_looks(first: dict[str, Any], second: dict[str, Any], kind: str) -> dict[str, Any]:
    """Module outputs for fusion from the first check's modules and the retake's modules."""
    if kind not in RETAKE_KINDS:
        raise ValueError(f"unknown retake kind {kind!r}")
    out = {k: v for k, v in first.items() if k in ("quality", "colour", "size", "identity", "damage")}
    for module in RETAKE_MODULES[kind]:
        a, b = first.get(module), second.get(module)
        if isinstance(a, dict) and isinstance(b, dict):
            out[module] = combine_module(module, a, b)
        elif isinstance(b, dict):
            out[module] = b
    if kind in ("light", "paper") and isinstance(second.get("quality"), dict):
        q1, q2 = first.get("quality") or {}, second["quality"]
        # The clearer of the two item photos speaks for photo quality.
        out["quality"] = q2 if (q2.get("code") == "OK" or q1.get("code") != "OK") else q1
    out["looks"] = 2
    return out
