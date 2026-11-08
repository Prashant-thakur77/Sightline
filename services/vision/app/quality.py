"""Quality gate for live framing hints (about 1 frame per second) and for captured photos.

Kept deliberately simple so the browser can mirror it with the same maths on a 320 px frame:

- mean and 99th-percentile luminance (Rec. 709 luma of the sRGB values),
- sharpness as the variance of the Laplacian, measured over the item's bounding box,
- specular glare: share of clipped near-white pixels on the item,
- item coverage from a background model: a smooth (quadratic) Lab surface fitted to the frame border,
  so light fall-off across a bed or table is not mistaken for the item; pixels far from it are the item. If almost nothing in the centre differs from the border, the item fills the
  frame (or nothing is there) and stepping back is the useful hint,
- exposure clipping (share of crushed blacks and blown highlights).

Codes are checked in order TOO_DARK, BLURRY, GLARE, TOO_FAR, TOO_CLOSE; the first one that fails is
the spoken hint, and all failing codes are listed in ``issues``.
"""

from __future__ import annotations

import time
from dataclasses import dataclass, field
from typing import Any

import cv2
import numpy as np

from .background import distance_from_background, fit_background, to_lab
from .config import Limits, thresholds

GUIDANCE: dict[str, str] = {
    "TOO_DARK": "Too dark. Can you turn on a light?",
    "BLURRY": "Hold still for a moment.",
    "GLARE": "There's a glare. Tilt the phone a little.",
    "TOO_FAR": "Move the phone closer.",
    "TOO_CLOSE": "Move the phone back a little.",
    "OK": "Hold still, capturing.",
}

ORDER = ("TOO_DARK", "BLURRY", "GLARE", "TOO_FAR", "TOO_CLOSE")


@dataclass
class QualityResult:
    code: str
    guidance: str
    issues: list[str]
    metrics: dict[str, float]
    elapsed_ms: float = 0.0
    foreground: np.ndarray | None = field(default=None, repr=False)

    @property
    def ok(self) -> bool:
        return self.code == "OK"

    def to_dict(self) -> dict[str, Any]:
        return {
            "code": self.code,
            "guidance": self.guidance,
            "issues": self.issues,
            "metrics": {k: round(v, 4) for k, v in self.metrics.items()},
            "elapsed_ms": round(self.elapsed_ms, 2),
        }


def downscale(rgb: np.ndarray, max_side: int = Limits.quality_max_side) -> np.ndarray:
    h, w = rgb.shape[:2]
    scale = max_side / max(h, w)
    if scale >= 1.0:
        return rgb
    return cv2.resize(rgb, (max(1, round(w * scale)), max(1, round(h * scale))), interpolation=cv2.INTER_AREA)


def _border_mask(h: int, w: int, frac: float) -> np.ndarray:
    b = max(2, int(round(min(h, w) * frac)))
    m = np.zeros((h, w), bool)
    m[:b, :] = m[-b:, :] = True
    m[:, :b] = m[:, -b:] = True
    return m


def _box(h: int, w: int, frac: float) -> tuple[slice, slice]:
    """Centred box covering ``frac`` of each dimension."""
    y0 = int(h * (1 - frac) / 2)
    x0 = int(w * (1 - frac) / 2)
    return slice(y0, max(y0 + 1, h - y0)), slice(x0, max(x0 + 1, w - x0))


def _fill_holes(mask: np.ndarray) -> np.ndarray:
    contours, _ = cv2.findContours(mask.astype(np.uint8), cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    filled = np.zeros(mask.shape, np.uint8)
    cv2.drawContours(filled, contours, -1, 1, thickness=cv2.FILLED)
    return filled > 0


def foreground_estimate(rgb: np.ndarray, th: dict[str, Any]) -> tuple[np.ndarray, dict[str, float]]:
    """Fast item mask from a border colour model. Returns (mask, metrics)."""
    h, w = rgb.shape[:2]
    lab = to_lab(rgb)
    border = _border_mask(h, w, th["border_fraction"])
    # Smooth model of the surface (handles light fall-off), fitted to the frame border.
    background = fit_background(lab, border, reject_de=th["background_delta_e"])
    cy, cx = _box(h, w, th["centre_fraction"])
    centre_colour = np.median(lab[cy, cx].reshape(-1, 3), axis=0)
    centre_vs_border = float(np.linalg.norm(centre_colour - np.median(background[cy, cx].reshape(-1, 3), axis=0)))
    dist = distance_from_background(lab, background)
    differs = dist > th["background_delta_e"]
    centre_item = float(differs[cy, cx].mean())
    # If the frame edge is mostly the same colour as the centre, the item fills the frame.
    border_median = np.median(lab[border], axis=0)
    centre_like_border = float((np.linalg.norm(lab[cy, cx] - border_median, axis=-1) > th["background_delta_e"]).mean())
    if centre_item >= th["centre_min_item_fraction"] and centre_like_border >= th["centre_min_item_fraction"]:
        fg = cv2.morphologyEx(differs.astype(np.uint8), cv2.MORPH_OPEN, np.ones((3, 3), np.uint8)) > 0
        fg = _fill_holes(fg)
        coverage = float(fg.mean())
        edge_touch = float(fg[border].mean())
        fills_frame = 0.0
    else:
        # The centre looks like the border: either the item fills the whole frame, or nothing is
        # there. Either way, stepping back is the useful hint.
        dist = np.linalg.norm(lab - centre_colour, axis=-1)
        fg = dist <= th["background_delta_e"]
        coverage = float(fg.mean())
        edge_touch = 1.0
        fills_frame = 1.0
    return fg, {
        "coverage": coverage,
        "edge_touch": edge_touch,
        "centre_vs_border": centre_vs_border,
        "centre_item": centre_item,
        "fills_frame": fills_frame,
    }


def assess(rgb: np.ndarray, th: dict[str, Any] | None = None) -> QualityResult:
    """Assess one frame. ``rgb`` is an RGB uint8 array; it is downscaled to 320 px first."""
    start = time.perf_counter()
    th = th or thresholds()["quality"]
    small = downscale(rgb)
    h, w = small.shape[:2]
    unit = small.astype(np.float32) / 255.0
    luma = unit[..., 0] * 0.2126 + unit[..., 1] * 0.7152 + unit[..., 2] * 0.0722
    mean_luma = float(luma.mean())
    p99_luma = float(np.percentile(luma, 99))
    clip_low = float((luma < 0.03).mean())
    min_channel = small.min(axis=-1)
    clipped = min_channel >= int(th["glare_min_channel"])
    clip_high = float(clipped.mean())

    fg, fg_metrics = foreground_estimate(small, th)
    coverage = fg_metrics["coverage"]

    gray = cv2.cvtColor(small, cv2.COLOR_RGB2GRAY)
    lap = cv2.Laplacian(gray, cv2.CV_64F)
    if 0.01 < coverage < 0.95 and fg.any() and not fg_metrics["fills_frame"]:
        ys, xs = np.nonzero(fg)
        pad_y, pad_x = max(2, int(0.05 * h)), max(2, int(0.05 * w))
        y0, y1 = max(0, ys.min() - pad_y), min(h, ys.max() + pad_y + 1)
        x0, x1 = max(0, xs.min() - pad_x), min(w, xs.max() + pad_x + 1)
        sharpness = float(lap[y0:y1, x0:x1].var())
    else:
        sharpness = float(lap.var())

    if fg.any() and not fg_metrics["fills_frame"] and coverage >= 0.01:
        glare = float(clipped[fg].mean())
    else:
        gy, gx = _box(h, w, th["glare_region_fraction"])
        glare = float(clipped[gy, gx].mean())

    issues: list[str] = []
    if mean_luma < th["dark_mean_luma"] or p99_luma < th["dark_p99_luma"] or clip_low > th["clip_low_max"]:
        issues.append("TOO_DARK")
    if sharpness < th["blur_min_laplacian_var"]:
        issues.append("BLURRY")
    if glare > th["glare_max_ratio"] or clip_high > th["clip_high_max"]:
        issues.append("GLARE")
    if not fg_metrics["fills_frame"] and coverage < th["min_coverage"]:
        issues.append("TOO_FAR")
    if fg_metrics["fills_frame"] or coverage > th["max_coverage"] or fg_metrics["edge_touch"] > th["max_edge_touch"]:
        issues.append("TOO_CLOSE")
    issues = [c for c in ORDER if c in issues]
    code = issues[0] if issues else "OK"
    metrics = {
        "mean_luma": mean_luma,
        "p99_luma": p99_luma,
        "sharpness": sharpness,
        "glare_ratio": glare,
        "clip_low": clip_low,
        "clip_high": clip_high,
        **fg_metrics,
    }
    return QualityResult(
        code=code,
        guidance=GUIDANCE[code],
        issues=issues,
        metrics=metrics,
        elapsed_ms=(time.perf_counter() - start) * 1000.0,
        foreground=fg,
    )
