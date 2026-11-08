"""Colour module.

Pipeline for one image: white balance (white-paper reference when one is visible, otherwise
gray world on the background), sRGB -> linear -> XYZ (D65) -> CIELAB on the masked item pixels,
deterministic k-means (k=3), dominant cluster. The delivered item's dominant colour is compared
with the listing images' dominant colour (primary signal) and with the Lab region of the listing's
colour name (secondary signal) using CIEDE2000.

The module abstains (finding ``unknown``) when the light is too dim or too strongly tinted.
"""

from __future__ import annotations

from collections.abc import Sequence
from dataclasses import asdict, dataclass, field
from typing import Any

import cv2
import numpy as np

from .background import distance_from_background, fit_background, to_lab

# D65 reference white, Y normalised to 1.
D65_WHITE = np.array([0.95047, 1.0, 1.08883])

# Linear sRGB -> XYZ (D65), IEC 61966-2-1.
_RGB_TO_XYZ = np.array(
    [
        [0.4124564, 0.3575761, 0.1804375],
        [0.2126729, 0.7151522, 0.0721750],
        [0.0193339, 0.1191920, 0.9503041],
    ]
)
_XYZ_TO_RGB = np.linalg.inv(_RGB_TO_XYZ)

_EPS = (6.0 / 29.0) ** 3
_KAPPA = 3.0 * (6.0 / 29.0) ** 2


# --------------------------------------------------------------------------------------------
# Colour space conversion
# --------------------------------------------------------------------------------------------


def _as_unit_float(rgb: np.ndarray) -> np.ndarray:
    arr = np.asarray(rgb)
    if arr.dtype == np.uint8:
        return arr.astype(np.float64) / 255.0
    return arr.astype(np.float64)


def srgb_to_linear(rgb: np.ndarray) -> np.ndarray:
    """sRGB (uint8, or float in 0..1) -> linear RGB in 0..1."""
    c = _as_unit_float(rgb)
    return np.where(c <= 0.04045, c / 12.92, ((c + 0.055) / 1.055) ** 2.4)


def linear_to_srgb(linear: np.ndarray) -> np.ndarray:
    """Linear RGB in 0..1 -> sRGB float in 0..1 (clipped)."""
    c = np.clip(np.asarray(linear, dtype=np.float64), 0.0, 1.0)
    return np.where(c <= 0.0031308, c * 12.92, 1.055 * np.power(c, 1.0 / 2.4) - 0.055)


def linear_to_xyz(linear: np.ndarray) -> np.ndarray:
    return np.asarray(linear, dtype=np.float64) @ _RGB_TO_XYZ.T


def xyz_to_linear(xyz: np.ndarray) -> np.ndarray:
    return np.asarray(xyz, dtype=np.float64) @ _XYZ_TO_RGB.T


def xyz_to_lab(xyz: np.ndarray) -> np.ndarray:
    t = np.asarray(xyz, dtype=np.float64) / D65_WHITE
    f = np.where(t > _EPS, np.cbrt(t), t / _KAPPA + 4.0 / 29.0)
    lab = np.empty_like(f)
    lab[..., 0] = 116.0 * f[..., 1] - 16.0
    lab[..., 1] = 500.0 * (f[..., 0] - f[..., 1])
    lab[..., 2] = 200.0 * (f[..., 1] - f[..., 2])
    return lab


def lab_to_xyz(lab: np.ndarray) -> np.ndarray:
    lab = np.asarray(lab, dtype=np.float64)
    fy = (lab[..., 0] + 16.0) / 116.0
    fx = fy + lab[..., 1] / 500.0
    fz = fy - lab[..., 2] / 200.0
    f = np.stack([fx, fy, fz], axis=-1)
    t = np.where(f > 6.0 / 29.0, f**3, _KAPPA * (f - 4.0 / 29.0))
    return t * D65_WHITE


def linear_to_lab(linear: np.ndarray) -> np.ndarray:
    return xyz_to_lab(linear_to_xyz(linear))


def srgb_to_lab(rgb: np.ndarray) -> np.ndarray:
    """sRGB (uint8 or float 0..1, shape (..., 3)) -> CIELAB (D65)."""
    return linear_to_lab(srgb_to_linear(rgb))


def lab_to_srgb(lab: np.ndarray) -> np.ndarray:
    """CIELAB -> sRGB float in 0..1 (out-of-gamut values clipped)."""
    return linear_to_srgb(xyz_to_linear(lab_to_xyz(lab)))


def hex_to_rgb(hex_code: str) -> tuple[int, int, int]:
    h = hex_code.lstrip("#")
    return int(h[0:2], 16), int(h[2:4], 16), int(h[4:6], 16)


def hex_to_lab(hex_code: str) -> np.ndarray:
    return srgb_to_lab(np.array(hex_to_rgb(hex_code), dtype=np.uint8))


# --------------------------------------------------------------------------------------------
# CIEDE2000
# --------------------------------------------------------------------------------------------


def ciede2000(
    lab1: np.ndarray | Sequence[float],
    lab2: np.ndarray | Sequence[float],
    kL: float = 1.0,
    kC: float = 1.0,
    kH: float = 1.0,
) -> np.ndarray | float:
    """CIEDE2000 colour difference. Vectorised over (..., 3)."""
    a = np.asarray(lab1, dtype=np.float64)
    b = np.asarray(lab2, dtype=np.float64)
    L1, a1, b1 = a[..., 0], a[..., 1], a[..., 2]
    L2, a2, b2 = b[..., 0], b[..., 1], b[..., 2]

    C1 = np.hypot(a1, b1)
    C2 = np.hypot(a2, b2)
    C_bar = (C1 + C2) / 2.0
    C_bar7 = C_bar**7
    G = 0.5 * (1.0 - np.sqrt(C_bar7 / (C_bar7 + 25.0**7)))
    a1p = (1.0 + G) * a1
    a2p = (1.0 + G) * a2
    C1p = np.hypot(a1p, b1)
    C2p = np.hypot(a2p, b2)

    h1p = np.degrees(np.arctan2(b1, a1p)) % 360.0
    h2p = np.degrees(np.arctan2(b2, a2p)) % 360.0
    h1p = np.where((a1p == 0) & (b1 == 0), 0.0, h1p)
    h2p = np.where((a2p == 0) & (b2 == 0), 0.0, h2p)

    dLp = L2 - L1
    dCp = C2p - C1p
    prod = C1p * C2p
    dh = h2p - h1p
    dh = np.where(dh > 180.0, dh - 360.0, dh)
    dh = np.where(dh < -180.0, dh + 360.0, dh)
    dhp = np.where(prod == 0, 0.0, dh)
    dHp = 2.0 * np.sqrt(prod) * np.sin(np.radians(dhp) / 2.0)

    Lbp = (L1 + L2) / 2.0
    Cbp = (C1p + C2p) / 2.0
    hsum = h1p + h2p
    habs = np.abs(h1p - h2p)
    hbp = np.where(
        prod == 0,
        hsum,
        np.where(habs <= 180.0, hsum / 2.0, np.where(hsum < 360.0, (hsum + 360.0) / 2.0, (hsum - 360.0) / 2.0)),
    )

    T = (
        1.0
        - 0.17 * np.cos(np.radians(hbp - 30.0))
        + 0.24 * np.cos(np.radians(2.0 * hbp))
        + 0.32 * np.cos(np.radians(3.0 * hbp + 6.0))
        - 0.20 * np.cos(np.radians(4.0 * hbp - 63.0))
    )
    d_theta = 30.0 * np.exp(-(((hbp - 275.0) / 25.0) ** 2))
    Cbp7 = Cbp**7
    Rc = 2.0 * np.sqrt(Cbp7 / (Cbp7 + 25.0**7))
    Sl = 1.0 + (0.015 * (Lbp - 50.0) ** 2) / np.sqrt(20.0 + (Lbp - 50.0) ** 2)
    Sc = 1.0 + 0.045 * Cbp
    Sh = 1.0 + 0.015 * Cbp * T
    Rt = -np.sin(np.radians(2.0 * d_theta)) * Rc

    tl = dLp / (kL * Sl)
    tc = dCp / (kC * Sc)
    th = dHp / (kH * Sh)
    de = np.sqrt(np.maximum(tl**2 + tc**2 + th**2 + Rt * tc * th, 0.0))
    if de.ndim == 0:
        return float(de)
    return de


# --------------------------------------------------------------------------------------------
# White balance and light quality
# --------------------------------------------------------------------------------------------


@dataclass
class WhiteBalance:
    gains: tuple[float, float, float]
    method: str  # "white_reference" | "gray_world" | "none"
    reference_used: bool
    cast_strength: float  # max |ln(gain)| after normalising the gains' geometric mean to 1
    exposure_gain: float

    def to_dict(self) -> dict[str, Any]:
        d = asdict(self)
        d["gains"] = [round(g, 4) for g in self.gains]
        d["cast_strength"] = round(self.cast_strength, 4)
        d["exposure_gain"] = round(self.exposure_gain, 4)
        return d


def _luma(rgb_unit: np.ndarray) -> np.ndarray:
    return rgb_unit[..., 0] * 0.2126 + rgb_unit[..., 1] * 0.7152 + rgb_unit[..., 2] * 0.0722


def _background(mask: np.ndarray, th: dict[str, Any]) -> np.ndarray:
    """Pixels safely away from the item."""
    pad = int(th.get("background_margin_px", 6))
    kernel = np.ones((2 * pad + 1, 2 * pad + 1), np.uint8)
    near_item = cv2.dilate(mask.astype(np.uint8), kernel) > 0
    return ~near_item


def _find_white_reference(rgb_u8: np.ndarray, bg: np.ndarray, th: dict[str, Any]) -> np.ndarray | None:
    """A sheet of white paper next to the item, if there is one.

    Accepted only when the region is genuinely near-white and neutral (high L*, low chroma), flat,
    compact (a sheet, not the background wrapped around the item), and clearly brighter than the rest
    of the background. A beige or grey bed cover that fills the background is not a reference.
    """
    if bg.sum() == 0:
        return None
    unit = rgb_u8.astype(np.float32) / 255.0
    vmax = unit.max(axis=-1)
    vmin = unit.min(axis=-1)
    sat = np.where(vmax > 0, (vmax - vmin) / np.maximum(vmax, 1e-6), 0.0)
    bright_floor = max(float(th["reference_min_value"]), float(np.percentile(vmax[bg], 99)) * 0.85)
    cand = bg & (vmax >= bright_floor) & (sat <= float(th["reference_max_saturation"])) & (vmax < 0.995)
    if cand.mean() < float(th["reference_min_area"]):
        return None
    n, labels, stats, _ = cv2.connectedComponentsWithStats(cand.astype(np.uint8), connectivity=8)
    if n <= 1:
        return None
    best = 1 + int(np.argmax(stats[1:, cv2.CC_STAT_AREA]))
    region = labels == best
    area = int(region.sum())
    if region.mean() < float(th["reference_min_area"]):
        return None
    # Not the dominant background: a sheet covers only part of it, and the rest is darker.
    rest = bg & ~region
    if area > float(th["reference_max_background_share"]) * bg.sum() or rest.sum() < 0.1 * bg.sum():
        return None
    lab = to_lab(rgb_u8)
    ref_lab = np.median(lab[region], axis=0)
    rest_l = float(np.median(lab[rest][:, 0]))
    if ref_lab[0] < float(th["reference_min_l"]) or ref_lab[0] < rest_l + float(th["reference_min_contrast_l"]):
        return None
    if float(np.hypot(ref_lab[1], ref_lab[2])) > float(th["reference_max_chroma"]):
        return None
    # Compact: a sheet of paper is close to its convex hull.
    contours, _ = cv2.findContours(region.astype(np.uint8), cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    hull_area = sum(cv2.contourArea(cv2.convexHull(c)) for c in contours)
    if hull_area <= 0 or area / hull_area < float(th["reference_min_solidity"]):
        return None
    # Flat: its chromaticity barely varies.
    chroma = unit[region] / np.maximum(unit[region].sum(axis=-1, keepdims=True), 1e-6)
    if float(chroma.std(axis=0).max()) > float(th["reference_max_chroma_std"]):
        return None
    return region


def estimate_white_balance(rgb_u8: np.ndarray, mask: np.ndarray, th: dict[str, Any]) -> WhiteBalance:
    """Estimate per-channel gains in linear RGB.

    White-paper reference when one is visible (see :func:`_find_white_reference`), otherwise gray
    world over the background (the item is excluded so a big navy sweater is not pulled to grey).
    Exposure is only normalised against a white reference, and never so far that the item clips.
    """
    linear = srgb_to_linear(rgb_u8)
    bg = _background(mask, th)
    ref = _find_white_reference(rgb_u8, bg, th)
    if ref is not None:
        means = linear[ref].mean(axis=0)
        method = "white_reference"
    else:
        region = bg if bg.mean() >= th["gray_world_min_background"] else np.ones(mask.shape, bool)
        means = linear[region].mean(axis=0)
        method = "gray_world"
    means = np.maximum(means, 1e-4)
    gm = float(np.exp(np.log(means).mean()))
    raw_gains = gm / means
    cast = float(np.abs(np.log(raw_gains)).max())
    max_gain = float(th["max_channel_gain"])
    gains = np.clip(raw_gains, 1.0 / max_gain, max_gain)
    exposure = 1.0
    if ref is not None:
        ref_y = float(_luma((means * gains)[None, :])[0])
        exposure = float(np.clip(th["reference_target_y"] / max(ref_y, 1e-4), th["exposure_gain_min"], th["exposure_gain_max"]))
        item = mask if mask.any() else np.ones(mask.shape, bool)
        peak = float(np.percentile((linear[item] * gains).max(axis=-1), 99))
        if peak > 0:
            exposure = min(exposure, 0.98 / peak)  # never push the item into clipping
    return WhiteBalance(
        gains=(float(gains[0]), float(gains[1]), float(gains[2])),
        method=method,
        reference_used=ref is not None,
        cast_strength=cast,
        exposure_gain=exposure,
    )


def apply_white_balance(linear: np.ndarray, wb: WhiteBalance) -> np.ndarray:
    gains = np.asarray(wb.gains) * wb.exposure_gain
    return np.clip(linear * gains, 0.0, 1.0)


@dataclass
class LightQuality:
    level: str  # "good" | "dim" | "poor"
    reasons: list[str]
    scene_luma: float
    bright_luma: float
    item_luma: float
    clipped_fraction: float

    def to_dict(self) -> dict[str, Any]:
        return {
            "level": self.level,
            "reasons": self.reasons,
            "scene_luma": round(self.scene_luma, 4),
            "bright_luma": round(self.bright_luma, 4),
            "item_luma": round(self.item_luma, 4),
            "clipped_fraction": round(self.clipped_fraction, 4),
        }


def assess_light(rgb_u8: np.ndarray, mask: np.ndarray, wb: WhiteBalance, th: dict[str, Any]) -> LightQuality:
    unit = rgb_u8.astype(np.float32) / 255.0
    luma = _luma(unit)
    scene = float(luma.mean())
    # In good light something in the frame (table, paper, label) is bright; in a dim room nothing is.
    bright = float(np.percentile(luma, 95))
    item_px = mask if mask.any() else np.ones(mask.shape, bool)
    item = float(luma[item_px].mean())
    clipped = float((unit[item_px].min(axis=-1) >= 0.98).mean())
    poor: list[str] = []
    dim: list[str] = []
    if scene < th["poor_scene_luma"] or bright < th["poor_bright_luma"]:
        poor.append("too_dark")
    elif bright < th["dim_bright_luma"]:
        dim.append("dim")
    if wb.cast_strength > th["cast_max"]:
        poor.append("heavy_cast")
    elif wb.cast_strength > th["cast_warn"]:
        dim.append("colour_cast")
    if clipped > th["glare_max_fraction"]:
        dim.append("glare")
    level = "poor" if poor else ("dim" if dim else "good")
    return LightQuality(level=level, reasons=poor + dim, scene_luma=scene, bright_luma=bright, item_luma=item, clipped_fraction=clipped)


# --------------------------------------------------------------------------------------------
# Dominant colour
# --------------------------------------------------------------------------------------------


def kmeans(points: np.ndarray, k: int = 3, seed: int = 0, iters: int = 25) -> tuple[np.ndarray, np.ndarray]:
    """Deterministic k-means with k-means++ seeding. Returns (centres, labels)."""
    pts = np.asarray(points, dtype=np.float64)
    n = len(pts)
    if n == 0:
        raise ValueError("no points")
    k = max(1, min(k, n))
    rng = np.random.default_rng(seed)
    centres = np.empty((k, pts.shape[1]))
    centres[0] = pts[rng.integers(n)]
    d2 = ((pts - centres[0]) ** 2).sum(axis=1)
    for i in range(1, k):
        total = d2.sum()
        if total <= 0:
            centres[i:] = centres[0]
            break
        idx = rng.choice(n, p=d2 / total)
        centres[i] = pts[idx]
        d2 = np.minimum(d2, ((pts - centres[i]) ** 2).sum(axis=1))
    labels = np.zeros(n, dtype=np.int64)
    for _ in range(iters):
        dist = ((pts[:, None, :] - centres[None, :, :]) ** 2).sum(axis=2)
        new_labels = dist.argmin(axis=1)
        for j in range(k):
            members = pts[new_labels == j]
            if len(members):
                centres[j] = members.mean(axis=0)
        if np.array_equal(new_labels, labels):
            break
        labels = new_labels
    labels = ((pts[:, None, :] - centres[None, :, :]) ** 2).sum(axis=2).argmin(axis=1)
    return centres, labels


@dataclass
class Dominant:
    lab: tuple[float, float, float]
    fraction: float
    clusters: list[dict[str, Any]] = field(default_factory=list)

    def to_dict(self) -> dict[str, Any]:
        return {
            "lab": [round(v, 2) for v in self.lab],
            "fraction": round(self.fraction, 4),
            "clusters": self.clusters,
        }


def dominant_colour(lab_pixels: np.ndarray, th: dict[str, Any], bg_dist: np.ndarray | None = None) -> Dominant:
    """k-means (k=3) in Lab; the largest cluster, merged with clusters within ``merge_de`` of it.

    ``bg_dist`` is each pixel's distance from the background model. Clusters that look like the
    background (mask leakage) are passed over in favour of the largest cluster that does not.
    """
    pts = np.asarray(lab_pixels, dtype=np.float64).reshape(-1, 3)
    dist = None if bg_dist is None else np.asarray(bg_dist, dtype=np.float64).reshape(-1)
    max_samples = int(th["max_samples"])
    if len(pts) > max_samples:
        rng = np.random.default_rng(int(th["seed"]))
        pick = rng.choice(len(pts), size=max_samples, replace=False)
        pts = pts[pick]
        dist = None if dist is None else dist[pick]
    centres, labels = kmeans(pts, k=int(th["k"]), seed=int(th["seed"]))
    counts = np.bincount(labels, minlength=len(centres)).astype(np.float64)
    order = [int(j) for j in np.argsort(-counts) if counts[j] > 0]
    like_bg = {j: False for j in order}
    if dist is not None:
        for j in order:
            like_bg[j] = float(np.median(dist[labels == j])) < float(th["background_exclude_de"])
    candidates = [j for j in order if not like_bg[j]] or order
    top = candidates[0]
    group = [j for j in candidates if j == top or ciede2000(centres[j], centres[top]) < th["merge_de"]]
    weights = counts[group]
    lab = (centres[group] * weights[:, None]).sum(axis=0) / weights.sum()
    clusters = [
        {
            "lab": [round(float(v), 2) for v in centres[j]],
            "fraction": round(float(counts[j] / counts.sum()), 4),
            "background_like": bool(like_bg[j]),
        }
        for j in order
    ]
    return Dominant(lab=(float(lab[0]), float(lab[1]), float(lab[2])), fraction=float(weights.sum() / counts.sum()), clusters=clusters)


@dataclass
class ImageColour:
    """Colour analysis of one image (delivered item or listing)."""

    dominant: Dominant
    white_balance: WhiteBalance
    light: LightQuality
    lab_samples: np.ndarray  # white-balanced Lab samples of the item, kept for pooling
    bg_dist: np.ndarray  # each sample's distance from the background model
    background_excluded: float = 0.0  # share of mask pixels dropped as background-like

    def to_dict(self) -> dict[str, Any]:
        return {
            "dominant": self.dominant.to_dict(),
            "white_balance": self.white_balance.to_dict(),
            "light": self.light.to_dict(),
            "reference_used": self.white_balance.reference_used,
            "background_excluded": round(self.background_excluded, 4),
        }


def item_lab_pixels(
    rgb_u8: np.ndarray, mask: np.ndarray, wb: WhiteBalance, th: dict[str, Any], bg_dist: np.ndarray | None = None
) -> tuple[np.ndarray, np.ndarray, float]:
    """White-balanced Lab values of the item's interior pixels.

    Edges, specular glints and pixels that look like the background (mask leakage) are dropped.
    Returns (lab, background distance per pixel, share of mask pixels dropped as background).
    """
    erode = int(th["erode_px"])
    m = mask.astype(np.uint8)
    if erode > 0:
        eroded = cv2.erode(m, np.ones((2 * erode + 1, 2 * erode + 1), np.uint8)) > 0
        if eroded.sum() >= max(50, 0.2 * m.sum()):
            m = eroded.astype(np.uint8)
    sel = m > 0
    if not sel.any():
        sel = np.ones(mask.shape, bool)
    dist = bg_dist if bg_dist is not None else np.full(mask.shape, np.inf, np.float32)
    excluded = 0.0
    not_bg = sel & (dist > float(th["background_exclude_de"]))
    if not_bg.sum() >= float(th["min_item_fraction_after_exclusion"]) * sel.sum():
        excluded = 1.0 - not_bg.sum() / sel.sum()
        sel = not_bg
    px = rgb_u8[sel]
    d = dist[sel]
    not_glint = px.min(axis=-1) < 250
    if not_glint.sum() >= 50:
        px, d = px[not_glint], d[not_glint]
    linear = apply_white_balance(srgb_to_linear(px), wb)
    return linear_to_lab(linear), d, float(excluded)


def analyse_image(rgb_u8: np.ndarray, mask: np.ndarray, th: dict[str, Any]) -> ImageColour:
    wb = estimate_white_balance(rgb_u8, mask, th)
    light = assess_light(rgb_u8, mask, wb, th)
    lab_raw = to_lab(rgb_u8)
    bg = _background(mask, th)
    if bg.sum() < 50:
        bg = ~mask
    background = fit_background(lab_raw, bg, reject_de=float(th["background_exclude_de"]))
    bg_dist = distance_from_background(lab_raw, background)
    lab, dist, excluded = item_lab_pixels(rgb_u8, mask, wb, th, bg_dist)
    dom = dominant_colour(lab, th, dist)
    return ImageColour(dominant=dom, white_balance=wb, light=light, lab_samples=lab, bg_dist=dist, background_excluded=excluded)


# --------------------------------------------------------------------------------------------
# Comparison
# --------------------------------------------------------------------------------------------

_CONF_ORDER = ["not_sure", "fairly_sure", "sure"]


def downgrade(confidence: str, steps: int = 1) -> str:
    idx = max(0, _CONF_ORDER.index(confidence) - steps)
    return _CONF_ORDER[idx]


def compare(
    delivered: ImageColour,
    listing: Sequence[ImageColour],
    listing_colour: str | None,
    th: dict[str, Any],
    mask_reliable: bool = True,
) -> dict[str, Any]:
    """Compare the delivered item's colour with the listing. Returns the module's raw output."""
    from . import colour_names

    kL = float(th["kL"])
    out: dict[str, Any] = {
        "delivered": delivered.to_dict(),
        "listing_images": [img.to_dict() for img in listing],
        "listing_lab": None,
        "delta_e": None,
        "delta_e_name": None,
        "expected_name": None,
        "named_agreement": None,
        "observed_name": None,
        "light_quality": delivered.light.level,
        "light_reasons": delivered.light.reasons,
        "reference_used": delivered.white_balance.reference_used,
        "finding": "unknown",
        "confidence": "not_sure",
        "abstain_reason": None,
    }
    d_lab = np.array(delivered.dominant.lab)
    observed = colour_names.nearest(d_lab)
    out["observed_name"] = observed.name

    expected = colour_names.lookup(listing_colour) if listing_colour else None
    if listing_colour:
        out["expected_name"] = expected.name if expected else listing_colour.strip().lower()

    if delivered.light.level == "poor":
        out["abstain_reason"] = "heavy_cast" if "heavy_cast" in delivered.light.reasons else "low_light"
        return out

    primary: str | None = None
    if listing:
        pooled = np.concatenate([img.lab_samples for img in listing], axis=0)
        pooled_dist = np.concatenate([img.bg_dist for img in listing], axis=0)
        l_dom = dominant_colour(pooled, th, pooled_dist)
        out["listing_lab"] = [round(v, 2) for v in l_dom.lab]
        de = float(ciede2000(d_lab, np.array(l_dom.lab), kL=kL))
        out["delta_e"] = round(de, 3)
        if de <= th["match_max_de"]:
            primary = "agree"
        elif de >= th["mismatch_min_de"]:
            primary = "disagree"
        else:
            primary = "unknown"

    secondary: str | None = None
    if expected is not None:
        de_name = float(ciede2000(d_lab, expected.lab, kL=kL))
        out["delta_e_name"] = round(de_name, 3)
        tol = colour_names.tolerance(expected.name, th)
        agree = de_name <= tol
        out["named_agreement"] = bool(agree)
        secondary = "agree" if agree else "disagree"

    de = out["delta_e"]
    if primary is None and secondary is None:
        out["abstain_reason"] = "nothing_to_compare"
        return out
    if primary in ("agree", "disagree") and secondary is not None and primary != secondary:
        finding, conf = "unknown", "not_sure"
        out["abstain_reason"] = "photo_and_name_disagree"
    elif primary == "disagree":
        if secondary == "disagree" or de >= th["strong_mismatch_de"]:
            finding, conf = "disagree", "sure"
        else:
            finding, conf = "disagree", "fairly_sure"
    elif primary == "agree":
        if secondary == "agree" or de <= th["strong_match_de"]:
            finding, conf = "agree", "sure"
        else:
            finding, conf = "agree", "fairly_sure"
    elif primary == "unknown":
        if secondary is None:
            finding, conf = "unknown", "not_sure"
            out["abstain_reason"] = "in_between"
        else:
            finding, conf = secondary, "fairly_sure"
    else:  # name only
        finding, conf = secondary, "fairly_sure"  # type: ignore[assignment]

    steps = 0
    if delivered.light.level == "dim":
        steps += 1
    if not mask_reliable:
        steps += 1
    out["finding"] = finding
    out["confidence"] = downgrade(conf, steps)
    return out
