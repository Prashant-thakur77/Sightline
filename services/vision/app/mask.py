"""Item mask: which pixels belong to the item.

Default: GrabCut (OpenCV) seeded from a centre rectangle and a smooth background model (a quadratic
Lab surface fitted to the image border, see ``background.py``). Border pixels that fit the model are
definite background; pixels inside the centre rectangle that differ from it are probable foreground. No model weights, ~100 ms on CPU.

Optional: rembg with the small u2netp model, when installed (``uv sync --extra rembg``) and enabled
with ``VISION_MASK_METHOD=rembg``. The same function masks delivered photos and listing images.
"""

from __future__ import annotations

import logging
import os
from dataclasses import dataclass
from typing import Any

import cv2
import numpy as np

from .background import distance_from_background, fit_background, to_lab
from .config import thresholds

log = logging.getLogger(__name__)


@dataclass
class MaskResult:
    mask: np.ndarray  # bool, same height and width as the input
    method: str  # "grabcut" | "threshold" | "centre" | "rembg"
    fraction: float
    reliable: bool

    def to_dict(self) -> dict[str, Any]:
        return {"method": self.method, "fraction": round(self.fraction, 4), "reliable": self.reliable}


def _border(h: int, w: int, frac: float) -> np.ndarray:
    b = max(2, int(round(min(h, w) * frac)))
    m = np.zeros((h, w), bool)
    m[:b, :] = m[-b:, :] = True
    m[:, :b] = m[:, -b:] = True
    return m


def _clean(fg: np.ndarray) -> np.ndarray:
    """Open, keep components that touch the central area (or the largest), fill holes."""
    m = cv2.morphologyEx(fg.astype(np.uint8), cv2.MORPH_OPEN, np.ones((3, 3), np.uint8))
    n, labels, stats, _ = cv2.connectedComponentsWithStats(m, connectivity=8)
    if n <= 1:
        return m > 0
    h, w = fg.shape
    centre = np.zeros_like(m, dtype=bool)
    centre[int(h * 0.3) : int(h * 0.7), int(w * 0.3) : int(w * 0.7)] = True
    areas = stats[1:, cv2.CC_STAT_AREA]
    largest = 1 + int(np.argmax(areas))
    keep = {largest}
    min_area = 0.02 * m.size
    for i in range(1, n):
        if areas[i - 1] >= min_area and (labels[centre] == i).any():
            keep.add(i)
    kept = np.isin(labels, list(keep))
    contours, _ = cv2.findContours(kept.astype(np.uint8), cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    filled = np.zeros(m.shape, np.uint8)
    cv2.drawContours(filled, contours, -1, 1, thickness=cv2.FILLED)
    return filled > 0


def _centre_ellipse(h: int, w: int) -> np.ndarray:
    m = np.zeros((h, w), np.uint8)
    cv2.ellipse(m, (w // 2, h // 2), (int(w * 0.3), int(h * 0.3)), 0, 0, 360, 1, thickness=-1)
    return m > 0


def _grabcut(small: np.ndarray, th: dict[str, Any]) -> tuple[np.ndarray, np.ndarray]:
    """Return (grabcut_fg, threshold_fg) on the downscaled image."""
    h, w = small.shape[:2]
    lab = to_lab(small)
    border = _border(h, w, th["border_fraction"])
    background = fit_background(lab, border, reject_de=th["background_delta_e"])
    differs = distance_from_background(lab, background) > th["background_delta_e"]
    threshold_fg = _clean(differs)

    gc = np.full((h, w), cv2.GC_PR_BGD, np.uint8)
    frac = th["centre_rect_fraction"]
    y0, x0 = int(h * (1 - frac) / 2), int(w * (1 - frac) / 2)
    rect = np.zeros((h, w), bool)
    rect[y0 : h - y0, x0 : w - x0] = True
    gc[rect & differs] = cv2.GC_PR_FGD
    gc[border & ~differs] = cv2.GC_BGD
    if not (gc == cv2.GC_PR_FGD).any():
        gc[_centre_ellipse(h, w)] = cv2.GC_PR_FGD
    if not (gc == cv2.GC_BGD).any():
        gc[border] = cv2.GC_PR_BGD
    bgd = np.zeros((1, 65), np.float64)
    fgd = np.zeros((1, 65), np.float64)
    try:
        cv2.grabCut(np.ascontiguousarray(small[..., ::-1]), gc, None, bgd, fgd, int(th["iterations"]), cv2.GC_INIT_WITH_MASK)
    except cv2.error as exc:  # degenerate seeds (e.g. a single-colour frame)
        log.debug("grabcut failed: %s", exc)
        return np.zeros((h, w), bool), threshold_fg
    fg = (gc == cv2.GC_FGD) | (gc == cv2.GC_PR_FGD)
    return _clean(fg), threshold_fg


_rembg_session: Any = None


def _rembg(rgb: np.ndarray) -> np.ndarray | None:
    global _rembg_session
    try:
        from rembg import new_session, remove  # type: ignore[import-not-found]
    except ImportError:
        return None
    if _rembg_session is None:
        _rembg_session = new_session("u2netp")
    out = remove(rgb, session=_rembg_session, only_mask=True)
    return np.asarray(out) > 127


def item_mask(rgb: np.ndarray, th: dict[str, Any] | None = None, method: str | None = None) -> MaskResult:
    """Segment the item in an RGB uint8 image."""
    th = th or thresholds()["mask"]
    method = (method or os.environ.get("VISION_MASK_METHOD") or "grabcut").lower()
    h, w = rgb.shape[:2]
    lo, hi = th["min_fraction"], th["max_fraction"]

    if method == "rembg":
        m = _rembg(rgb)
        if m is not None and lo <= m.mean() <= hi:
            return MaskResult(mask=m, method="rembg", fraction=float(m.mean()), reliable=True)

    scale = min(1.0, th["max_side"] / max(h, w))
    small = rgb if scale >= 1.0 else cv2.resize(rgb, (max(1, round(w * scale)), max(1, round(h * scale))), interpolation=cv2.INTER_AREA)
    gc_fg, thr_fg = _grabcut(small, th)

    chosen, name, reliable = None, "centre", False
    if lo <= gc_fg.mean() <= hi:
        chosen, name, reliable = gc_fg, "grabcut", True
    elif lo <= thr_fg.mean() <= hi:
        chosen, name, reliable = thr_fg, "threshold", True
    if chosen is None:
        chosen = _centre_ellipse(*small.shape[:2])
    if chosen.shape != (h, w):
        chosen = cv2.resize(chosen.astype(np.uint8), (w, h), interpolation=cv2.INTER_NEAREST) > 0
    return MaskResult(mask=chosen, method=name, fraction=float(chosen.mean()), reliable=reliable)
