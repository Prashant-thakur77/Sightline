"""Smooth background model.

Phone photos of an item on a bed or table rarely have a flat background: light falls off from a
lamp or window, so the surface is brighter in one place than another. A single "border colour"
then mistakes the bright patch for the item. Instead each Lab channel of the background is modelled
as a quadratic surface in x and y (enough for a light fall-off), fitted to sample pixels with a few
rounds of outlier rejection so an item touching the frame edge does not bend the fit.
"""

from __future__ import annotations

import cv2
import numpy as np


def to_lab(rgb_u8: np.ndarray) -> np.ndarray:
    """sRGB uint8 -> CIELAB float32 (OpenCV, D65), fast enough for per-frame use."""
    return cv2.cvtColor(rgb_u8.astype(np.float32) / 255.0, cv2.COLOR_RGB2Lab)


def _features(h: int, w: int) -> np.ndarray:
    yy, xx = np.mgrid[0:h, 0:w].astype(np.float32)
    x = xx / max(1, w - 1) - 0.5
    y = yy / max(1, h - 1) - 0.5
    return np.stack([np.ones_like(x), x, y, x * x, y * y, x * y], axis=-1)


def border_mask(h: int, w: int, frac: float) -> np.ndarray:
    b = max(2, int(round(min(h, w) * frac)))
    m = np.zeros((h, w), bool)
    m[:b, :] = m[-b:, :] = True
    m[:, :b] = m[:, -b:] = True
    return m


def fit_background(lab: np.ndarray, sample: np.ndarray, reject_de: float = 12.0, rounds: int = 3, max_samples: int = 6000) -> np.ndarray:
    """Fitted background Lab for every pixel (H x W x 3), from the pixels where ``sample`` is true."""
    h, w = lab.shape[:2]
    feats = _features(h, w)
    idx = np.flatnonzero(sample.ravel())
    if len(idx) < 12:
        return np.broadcast_to(np.median(lab.reshape(-1, 3), axis=0), lab.shape).astype(np.float32)
    if len(idx) > max_samples:
        idx = idx[np.linspace(0, len(idx) - 1, max_samples).astype(np.int64)]
    f = feats.reshape(-1, 6)[idx].astype(np.float64)
    v = lab.reshape(-1, 3)[idx].astype(np.float64)
    keep = np.ones(len(idx), bool)
    coef = np.zeros((6, 3))
    for _ in range(rounds):
        coef, *_ = np.linalg.lstsq(f[keep], v[keep], rcond=None)
        resid = np.linalg.norm(f @ coef - v, axis=1)
        new_keep = resid < reject_de
        if new_keep.sum() < 0.5 * len(idx):
            # The item covers much of the sample: keep the half that fits best.
            new_keep = resid <= np.median(resid)
        if np.array_equal(new_keep, keep):
            break
        keep = new_keep
    return (feats @ coef.astype(np.float32)).astype(np.float32)


def distance_from_background(lab: np.ndarray, background: np.ndarray) -> np.ndarray:
    """Euclidean Lab distance (delta E 1976) of each pixel from the background model."""
    return np.linalg.norm(lab - background, axis=-1)
