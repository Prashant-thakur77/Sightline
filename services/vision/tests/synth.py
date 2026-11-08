"""Synthetic test images: a sweater-shaped item on a table, listing shots and size tags."""

from __future__ import annotations

import io

import cv2
import numpy as np
from PIL import Image, ImageDraw, ImageFont

NAVY = (30, 42, 78)
BLACK = (26, 26, 28)
RED = (176, 32, 40)
ROYAL_BLUE = (40, 70, 168)
TABLE = (228, 224, 216)
STUDIO_WHITE = (250, 250, 250)


def sweater_mask(h: int, w: int, scale: float = 1.0, centre: tuple[float, float] = (0.5, 0.52)) -> np.ndarray:
    """Boolean mask of a crew-neck sweater laid flat."""
    cx, cy = centre[0] * w, centre[1] * h
    u = min(h, w) * scale
    body_w, body_h = 0.42 * u, 0.56 * u
    x0, x1 = cx - body_w / 2, cx + body_w / 2
    y0, y1 = cy - body_h / 2, cy + body_h / 2
    m = np.zeros((h, w), np.uint8)
    body = np.array([[x0, y0 + 0.04 * u], [x0 + 0.1 * u, y0], [x1 - 0.1 * u, y0], [x1, y0 + 0.04 * u], [x1, y1], [x0, y1]])
    left = np.array([[x0, y0 + 0.04 * u], [x0 - 0.3 * u, y0 + 0.36 * u], [x0 - 0.22 * u, y0 + 0.44 * u], [x0, y0 + 0.22 * u]])
    right = np.array([[x1, y0 + 0.04 * u], [x1 + 0.3 * u, y0 + 0.36 * u], [x1 + 0.22 * u, y0 + 0.44 * u], [x1, y0 + 0.22 * u]])
    for poly in (body, left, right):
        cv2.fillPoly(m, [np.round(poly).astype(np.int32)], 1)
    cv2.ellipse(m, (int(cx), int(y0)), (int(0.08 * u), int(0.05 * u)), 0, 0, 360, 0, thickness=-1)
    return m > 0


def _knit(h: int, w: int, rng: np.random.Generator, strength: float = 0.12) -> np.ndarray:
    x = np.arange(w)[None, :]
    y = np.arange(h)[:, None]
    rib = np.sin(2 * np.pi * x / 8.0) * np.cos(2 * np.pi * y / 10.0)
    return 1.0 + strength * rib + rng.normal(0, 0.02, (h, w))


def render_scene(
    colour: tuple[int, int, int] = NAVY,
    bg: tuple[int, int, int] = TABLE,
    h: int = 480,
    w: int = 640,
    scale: float = 1.0,
    centre: tuple[float, float] = (0.5, 0.52),
    texture: bool = True,
    seed: int = 0,
) -> tuple[np.ndarray, np.ndarray]:
    """A phone-like photo of the sweater on a plain surface. Returns (rgb uint8, item mask)."""
    rng = np.random.default_rng(seed)
    mask = sweater_mask(h, w, scale, centre)
    yy, xx = np.mgrid[0:h, 0:w]
    vignette = 1.0 - 0.08 * (((xx - w / 2) / w) ** 2 + ((yy - h / 2) / h) ** 2)
    img = np.empty((h, w, 3), np.float64)
    img[:] = np.asarray(bg, np.float64)
    img *= vignette[..., None]
    item = np.asarray(colour, np.float64)[None, None, :] * (_knit(h, w, rng) if texture else 1.0)[..., None]
    img[mask] = item[mask]
    img += rng.normal(0, 1.2, img.shape)
    return np.clip(img, 0, 255).astype(np.uint8), mask


def add_paper(rgb: np.ndarray, box: tuple[float, float, float, float] = (0.75, 0.03, 0.98, 0.3), colour=(243, 243, 239)) -> np.ndarray:
    """A sheet of white paper laid next to the item (box as fractions x0, y0, x1, y1)."""
    h, w = rgb.shape[:2]
    out = rgb.copy()
    x0, y0, x1, y1 = int(box[0] * w), int(box[1] * h), int(box[2] * w), int(box[3] * h)
    noise = np.random.default_rng(5).normal(0, 1.0, (y1 - y0, x1 - x0, 3))
    out[y0:y1, x0:x1] = np.clip(np.asarray(colour, np.float64) + noise, 0, 255).astype(np.uint8)
    return out


def listing_image(colour: tuple[int, int, int] = NAVY, size: int = 600, seed: int = 1) -> np.ndarray:
    """A studio product shot: the sweater centred on a near-white background."""
    rng = np.random.default_rng(seed)
    mask = sweater_mask(size, size, 1.15, (0.5, 0.5))
    img = np.empty((size, size, 3), np.float64)
    img[:] = STUDIO_WHITE
    item = np.asarray(colour, np.float64)[None, None, :] * _knit(size, size, rng, 0.06)[..., None]
    img[mask] = item[mask]
    return np.clip(img, 0, 255).astype(np.uint8)


def _to_linear(rgb: np.ndarray) -> np.ndarray:
    c = rgb.astype(np.float64) / 255.0
    return np.where(c <= 0.04045, c / 12.92, ((c + 0.055) / 1.055) ** 2.4)


def _to_srgb(lin: np.ndarray) -> np.ndarray:
    c = np.clip(lin, 0, 1)
    s = np.where(c <= 0.0031308, c * 12.92, 1.055 * c ** (1 / 2.4) - 0.055)
    return np.clip(np.round(s * 255), 0, 255).astype(np.uint8)


def dim(rgb: np.ndarray, factor: float, seed: int = 3, noise: float = 0.004) -> np.ndarray:
    """Less light: scale linear intensity and add sensor noise."""
    rng = np.random.default_rng(seed)
    lin = _to_linear(rgb) * factor + rng.normal(0, noise, rgb.shape)
    return _to_srgb(lin)


def colour_cast(rgb: np.ndarray, gains: tuple[float, float, float]) -> np.ndarray:
    """Tinted light (e.g. warm bulb ~ (1.0, 0.85, 0.6)), applied in linear RGB."""
    return _to_srgb(_to_linear(rgb) * np.asarray(gains)[None, None, :])


def blur(rgb: np.ndarray, sigma: float) -> np.ndarray:
    return cv2.GaussianBlur(rgb, (0, 0), sigma)


def add_glare(rgb: np.ndarray, mask: np.ndarray, frac: float = 0.12) -> np.ndarray:
    """A blown-out specular patch on the item covering about ``frac`` of it."""
    out = rgb.copy()
    ys, xs = np.nonzero(mask)
    cy, cx = int(ys.mean()), int(xs.mean())
    r = int(np.sqrt(frac * mask.sum() / np.pi))
    spot = np.zeros(mask.shape, np.uint8)
    cv2.circle(spot, (cx, cy), r, 1, thickness=-1)
    out[(spot > 0) & mask] = 255
    return out


def render_tag(lines: list[str], sizes: list[int] | None = None, w: int = 360, h: int = 420, seed: int = 0) -> np.ndarray:
    """A woven size tag photographed close up."""
    img = Image.new("RGB", (w, h), (245, 243, 238))
    d = ImageDraw.Draw(img)
    y = 24
    for i, text in enumerate(lines):
        font = ImageFont.load_default(size=(sizes[i] if sizes else 40))
        x0, y0, x1, y1 = d.textbbox((0, 0), text, font=font)
        d.text(((w - (x1 - x0)) // 2, y), text, fill=(22, 22, 22), font=font)
        y += y1 + 28  # y1 includes the font's top offset, so lines never overlap
    arr = np.asarray(img).astype(np.float64)
    arr += np.random.default_rng(seed).normal(0, 1.0, arr.shape)
    return np.clip(arr, 0, 255).astype(np.uint8)


def to_jpeg(rgb: np.ndarray, quality: int = 92, exif: Image.Exif | None = None) -> bytes:
    buf = io.BytesIO()
    kwargs = {"exif": exif} if exif is not None else {}
    Image.fromarray(rgb).save(buf, format="JPEG", quality=quality, **kwargs)
    return buf.getvalue()


def to_png(rgb: np.ndarray) -> bytes:
    buf = io.BytesIO()
    Image.fromarray(rgb).save(buf, format="PNG")
    return buf.getvalue()


def exif_with_gps() -> Image.Exif:
    exif = Image.Exif()
    exif[0x0132] = "2026:11:01 10:15:00"  # DateTime
    exif[0x010F] = "PhoneMaker"  # Make
    exif[0x8825] = {1: "N", 2: (12.0, 58.0, 17.0), 3: "E", 4: (77.0, 35.0, 41.0)}
    return exif
