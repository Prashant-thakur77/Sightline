"""Procedural renderer for SightBench.

Listing images are clean studio renders of a product. Delivered photos are phone-like renders of
the same (or a different) product lying on a bed cover, table or floor: perspective, rotation,
uneven light at one of three levels (day, lamp, dim), a colour temperature that the simulated
camera only partly corrects, defocus and motion blur, sensor noise, phone denoising and JPEG
compression. Size-tag photos put a woven or printed tag on the item's fabric under the same light.

Everything is drawn from a seeded numpy Generator, so the same seed gives the same pixels with the
pinned library versions and the same system fonts. These are synthetic renders, not photographs.
"""

from __future__ import annotations

import io
import math
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import cv2
import numpy as np
from PIL import Image, ImageDraw, ImageFont

from .catalog import COLOURS, EU_LETTER, WORD_LETTER, Product, shoe_eu, shoe_uk

S = 1024  # item design canvas
SS = 2  # supersampling for anti-aliased edges
OUT_W, OUT_H = 1080, 1440  # delivered photos (portrait, like a phone)
LISTING_SIDE = 1024

# Fonts from common Linux font packages (fonts-dejavu, fonts-liberation, fonts-freefont-ttf, fonts-lato).
FONT_FILES = (
    "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
    "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
    "/usr/share/fonts/truetype/dejavu/DejaVuSerif-Bold.ttf",
    "/usr/share/fonts/truetype/dejavu/DejaVuSansCondensed-Bold.ttf",
    "/usr/share/fonts/truetype/liberation/LiberationSans-Bold.ttf",
    "/usr/share/fonts/truetype/liberation/LiberationSans-Regular.ttf",
    "/usr/share/fonts/truetype/liberation/LiberationSerif-Bold.ttf",
    "/usr/share/fonts/truetype/liberation/LiberationSansNarrow-Bold.ttf",
    "/usr/share/fonts/truetype/liberation/LiberationMono-Bold.ttf",
    "/usr/share/fonts/truetype/freefont/FreeSansBold.ttf",
    "/usr/share/fonts/truetype/freefont/FreeSerif.ttf",
    "/usr/share/fonts/truetype/lato/Lato-Black.ttf",
    "/usr/share/fonts/truetype/lato/Lato-Regular.ttf",
    "/usr/share/fonts/truetype/lato/Lato-Light.ttf",
)

# ------------------------------------------------------------------------------------------------
# Colour helpers
# ------------------------------------------------------------------------------------------------

_M = np.array([[0.4124564, 0.3575761, 0.1804375], [0.2126729, 0.7151522, 0.0721750], [0.0193339, 0.1191920, 0.9503041]])
_WHITE = np.array([0.95047, 1.0, 1.08883])


def srgb_to_linear(c: Any) -> np.ndarray:
    c = np.asarray(c, np.float32)
    return np.where(c <= 0.04045, c / 12.92, ((c + 0.055) / 1.055) ** 2.4).astype(np.float32)


def linear_to_srgb(c: np.ndarray) -> np.ndarray:
    c = np.clip(c, 0.0, 1.0)
    return np.where(c <= 0.0031308, c * 12.92, 1.055 * np.power(c, 1 / 2.4) - 0.055).astype(np.float32)


def hex_lin(h: str) -> np.ndarray:
    h = h.lstrip("#")
    return srgb_to_linear(np.array([int(h[i : i + 2], 16) for i in (0, 2, 4)], np.float32) / 255.0)


def _lin_to_lab(lin: np.ndarray) -> np.ndarray:
    xyz = (_M @ np.asarray(lin, np.float64)) / _WHITE
    f = np.where(xyz > 0.008856, np.cbrt(xyz), 7.787 * xyz + 16 / 116)
    return np.array([116 * f[1] - 16, 500 * (f[0] - f[1]), 200 * (f[1] - f[2])])


def _lab_to_lin(lab: np.ndarray) -> np.ndarray:
    fy = (lab[0] + 16) / 116
    f = np.array([fy + lab[1] / 500, fy, fy - lab[2] / 200])
    xyz = np.where(f**3 > 0.008856, f**3, (f - 16 / 116) / 7.787) * _WHITE
    return np.clip(np.linalg.solve(_M, xyz), 0.0, 1.0).astype(np.float32)


def dye(product: Product, colour: str) -> np.ndarray:
    """The product's dye for a colour name, as linear RGB, with its per-product Lab offset."""
    base = hex_lin(COLOURS[colour])
    off = product.dye_offsets.get(colour, [0.0, 0.0, 0.0])
    return _lab_to_lin(_lin_to_lab(base) + np.array(off))


def luminance(lin: np.ndarray) -> np.ndarray:
    return lin[..., 0] * 0.2126 + lin[..., 1] * 0.7152 + lin[..., 2] * 0.0722


def cct_rgb(kelvin: float) -> np.ndarray:
    """Linear-sRGB colour of a Planckian illuminant (Kang et al. 2002 locus), green normalised to 1."""
    t = float(np.clip(kelvin, 1700, 24000))
    if t <= 4000:
        x = -0.2661239e9 / t**3 - 0.2343589e6 / t**2 + 0.8776956e3 / t + 0.179910
    else:
        x = -3.0258469e9 / t**3 + 2.1070379e6 / t**2 + 0.2226347e3 / t + 0.240390
    if t <= 2222:
        y = -1.1063814 * x**3 - 1.34811020 * x**2 + 2.18555832 * x - 0.20219683
    elif t <= 4000:
        y = -0.9549476 * x**3 - 1.37418593 * x**2 + 2.09137015 * x - 0.16748867
    else:
        y = 3.0817580 * x**3 - 5.87338670 * x**2 + 3.75112997 * x - 0.37001483
    xyz = np.array([x / y, 1.0, (1 - x - y) / y])
    rgb = np.linalg.solve(_M, xyz)
    rgb = np.clip(rgb, 1e-3, None)
    return (rgb / rgb[1]).astype(np.float32)


# ------------------------------------------------------------------------------------------------
# Noise and geometry helpers
# ------------------------------------------------------------------------------------------------


def smooth_noise(rng: np.random.Generator, h: int, w: int, scale: float) -> np.ndarray:
    sh, sw = max(2, int(h / scale) + 3), max(2, int(w / scale) + 3)
    small = rng.standard_normal((sh, sw)).astype(np.float32)
    big = cv2.resize(small, (w, h), interpolation=cv2.INTER_CUBIC)
    sd = float(big.std()) or 1.0
    return big / sd


def qbez(p0: tuple[float, float], p1: tuple[float, float], p2: tuple[float, float], n: int = 18) -> list[tuple[float, float]]:
    t = np.linspace(0, 1, n)
    pts = (1 - t)[:, None] ** 2 * np.array(p0) + 2 * ((1 - t) * t)[:, None] * np.array(p1) + (t**2)[:, None] * np.array(p2)
    return [tuple(map(float, p)) for p in pts]


def mirror(pts: list[tuple[float, float]]) -> list[tuple[float, float]]:
    return [(S - x, y) for x, y in pts]


def U(rng: np.random.Generator, a: float, b: float) -> float:
    return float(rng.uniform(a, b))


# ------------------------------------------------------------------------------------------------
# Item canvas
# ------------------------------------------------------------------------------------------------


@dataclass
class Canvas:
    alpha: np.ndarray = field(default_factory=lambda: np.zeros((S, S), np.float32))
    albedo: np.ndarray = field(default_factory=lambda: np.zeros((S, S, 3), np.float32))  # premultiplied by alpha
    relief: np.ndarray = field(default_factory=lambda: np.ones((S, S), np.float32))
    gloss: np.ndarray = field(default_factory=lambda: np.zeros((S, S), np.float32))
    regions: dict[str, np.ndarray] = field(default_factory=dict)
    garment: bool = False

    @staticmethod
    def mask(draw: Any) -> np.ndarray:
        m = np.zeros((S * SS, S * SS), np.uint8)
        draw(m, SS)
        return cv2.resize(m, (S, S), interpolation=cv2.INTER_AREA).astype(np.float32) / 255.0

    def paint(self, m: np.ndarray, colour: np.ndarray, relief: Any = 1.0, gloss: float = 0.0, name: str | None = None) -> np.ndarray:
        c = np.asarray(colour, np.float32)
        self.albedo = self.albedo * (1 - m[..., None]) + c * m[..., None]
        self.alpha = self.alpha + m * (1 - self.alpha)
        self.relief = self.relief * (1 - m) + np.asarray(relief, np.float32) * m
        self.gloss = self.gloss * (1 - m) + gloss * m
        if name:
            self.regions[name] = np.maximum(self.regions.get(name, np.zeros_like(m)), m)
        return m

    def poly(self, pts: list[tuple[float, float]], colour: np.ndarray, relief: Any = 1.0, gloss: float = 0.0, name: str | None = None) -> np.ndarray:
        arr = np.asarray(pts, np.float64)

        def draw(m: np.ndarray, k: int) -> None:
            cv2.fillPoly(m, [np.round(arr * k).astype(np.int32)], 255)

        return self.paint(self.mask(draw), colour, relief, gloss, name)

    def stroke(self, pts: list[tuple[float, float]], width: float, colour: np.ndarray, relief: Any = 1.0, gloss: float = 0.0, closed: bool = False) -> np.ndarray:
        arr = np.asarray(pts, np.float64)

        def draw(m: np.ndarray, k: int) -> None:
            cv2.polylines(m, [np.round(arr * k).astype(np.int32)], closed, 255, thickness=max(1, int(round(width * k))), lineType=cv2.LINE_8)

        return self.paint(self.mask(draw), colour, relief, gloss)

    def ellipse(self, centre: tuple[float, float], axes: tuple[float, float], angle: float, colour: np.ndarray, relief: Any = 1.0, gloss: float = 0.0, name: str | None = None) -> np.ndarray:
        def draw(m: np.ndarray, k: int) -> None:
            cv2.ellipse(m, (int(centre[0] * k), int(centre[1] * k)), (int(axes[0] * k), int(axes[1] * k)), angle, 0, 360, 255, -1)

        return self.paint(self.mask(draw), colour, relief, gloss, name)

    def tint(self, m: np.ndarray, colour: np.ndarray, strength: float, relief: float | None = None) -> None:
        """Blend the albedo inside m towards colour (keeps alpha)."""
        k = (m * strength)[..., None]
        self.albedo = self.albedo * (1 - k) + np.asarray(colour, np.float32) * self.alpha[..., None] * k
        if relief is not None:
            self.relief = self.relief * (1 - m * strength) + relief * m * strength


def garment_texture(kind: str, rng: np.random.Generator, period: float = 1.0, h: int = S, w: int = S) -> np.ndarray:
    y, x = np.mgrid[0:h, 0:w].astype(np.float32)
    fine = 1 + 0.02 * smooth_noise(rng, h, w, 2.5 * period)
    if kind in ("plain", "cable"):
        t = 1 + 0.06 * np.sin(2 * np.pi * x / (9 * period) + 1.6 * np.sign(np.sin(2 * np.pi * y / (12 * period))))
    elif kind == "rib":
        t = 1 + 0.09 * np.tanh(2.5 * np.sin(2 * np.pi * x / (14 * period)))
    elif kind == "jersey":
        t = 1 + 0.018 * np.sin(2 * np.pi * x / (4 * period))
    elif kind == "fleece":
        t = 1 + 0.035 * smooth_noise(rng, h, w, 4 * period)
    elif kind == "mesh":
        t = 1 + 0.06 * np.sin(2 * np.pi * x / (10 * period)) * np.sin(2 * np.pi * y / (10 * period))
    else:
        t = np.ones((h, w), np.float32)
    t = t * fine
    if kind == "cable" and h == S:
        for c in (432, 512, 592):
            phase = 16 * np.sin(2 * np.pi * y / 84)
            d = np.minimum(np.abs(x - c - phase), np.abs(x - c + phase))
            rope = 1 + 0.12 * np.exp(-((d / 9) ** 2)) - 0.14 * np.exp(-(((d - 12) / 3) ** 2))
            band = (np.abs(x - c) < 30) & (y > 300) & (y < 820)
            t = np.where(band, t * rope, t)
    return t.astype(np.float32)


RIB = None


def _rib() -> np.ndarray:
    global RIB
    if RIB is None:
        y, x = np.mgrid[0:S, 0:S].astype(np.float32)
        RIB = (0.9 + 0.1 * np.tanh(3 * np.sin(2 * np.pi * x / 10))).astype(np.float32)
    return RIB


# ------------------------------------------------------------------------------------------------
# Items
# ------------------------------------------------------------------------------------------------


def _band(p: tuple[float, float], q: tuple[float, float], depth: float) -> list[tuple[float, float]]:
    """A cuff or hem band hanging off edge p-q, depth px outward (perpendicular, away from the garment)."""
    dx, dy = q[0] - p[0], q[1] - p[1]
    n = math.hypot(dx, dy)
    nx, ny = dy / n, -dx / n  # perpendicular
    if ny < 0:  # point downward/outward
        nx, ny = -nx, -ny
    return [p, q, (q[0] + nx * depth, q[1] + ny * depth), (p[0] + nx * depth, p[1] + ny * depth)]


def draw_sweater(cv: Canvas, p: Product, d: np.ndarray, contrast: np.ndarray, rng: np.random.Generator) -> None:
    f = p.features
    tex = garment_texture("cable" if f["knit"] == "cable" else f["knit"], rng)
    trim = contrast if f["extra"] == "contrast hem" else d
    left = [(338, 282), (262, 318), (150, 742), (244, 778), (338, 486)]
    for sl in (left, mirror(left)):
        cv.poly(sl, d, relief=tex, name="garment")
    body = [(338, 282), (432, 240), *qbez((432, 240), (512, 292), (592, 240)), (686, 282), (690, 830), (334, 830)]
    cv.poly(body, d, relief=tex, name="body")
    cv.poly([(334, 826), (690, 826), (690, 866), (334, 866)], trim, relief=_rib() * 0.95)
    for a, b in (((150, 742), (244, 778)), ((S - 150, 742), (S - 244, 778))):
        cv.poly(_band(a, b, 32), trim, relief=_rib() * 0.93)
    if f["neck"] == "crew":
        cv.poly([*qbez((432, 240), (512, 292), (592, 240)), (592, 240), (432, 240)], d, relief=0.74)
        cv.stroke(qbez((432, 240), (512, 296), (592, 240)), 20, d, relief=_rib() * 0.9)
    elif f["neck"] == "v":
        cv.poly([(432, 240), (512, 392), (592, 240)], d, relief=0.72)
        cv.stroke([(432, 240), (512, 396), (592, 240)], 20, d, relief=_rib() * 0.9)
    else:
        cv.poly([(436, 252), (440, 168), (584, 168), (588, 252)], d, relief=_rib() * 0.96)
        cv.stroke([(440, 206), (584, 206)], 6, d, relief=0.78)
    if f["extra"] == "elbow patches":
        for cx, ang in ((206, 77), (S - 206, -77)):
            cv.ellipse((cx, 590), (44, 26), ang, contrast, relief=0.97)
    cv.garment = True


def draw_tee(cv: Canvas, p: Product, d: np.ndarray, contrast: np.ndarray, rng: np.random.Generator) -> None:
    f = p.features
    tex = garment_texture("jersey", rng)
    trim = contrast if f["trim"] == "ringer" else d
    if f["sleeves"] == "long":
        left = [(346, 282), (266, 318), (168, 756), (252, 786), (346, 470)]
        cuff = ((168, 756), (252, 786))
    else:
        left = [(346, 282), (236, 330), (182, 452), (276, 490), (346, 420)]
        cuff = ((182, 452), (276, 490))
    for sl in (left, mirror(left)):
        cv.poly(sl, d, relief=tex, name="garment")
    for a, b in (cuff, ((S - cuff[0][0], cuff[0][1]), (S - cuff[1][0], cuff[1][1]))):
        cv.poly(_band(a, b, 14), trim, relief=0.94)
    body = [(346, 282), (440, 244), *qbez((440, 244), (512, 290), (584, 244)), (678, 282), (680, 842), (344, 842)]
    cv.poly(body, d, relief=tex, name="body")
    cv.stroke([(344, 836), (680, 836)], 5, d, relief=0.86)
    if f["neck"] == "v":
        cv.poly([(440, 244), (512, 352), (584, 244)], d, relief=0.72)
        cv.stroke([(440, 244), (512, 356), (584, 244)], 13, trim, relief=0.95)
    else:
        cv.poly([*qbez((440, 244), (512, 290), (584, 244)), (440, 244)], d, relief=0.74)
        cv.stroke(qbez((440, 244), (512, 294), (584, 244)), 13, trim, relief=0.95)
    if f["pocket"] == "yes":
        cv.stroke([(398, 332), (474, 332), (474, 418), (398, 418)], 4, d, relief=0.8, closed=True)
        cv.stroke([(398, 340), (474, 340)], 3, d, relief=0.86)
    if f["print"] == "block":
        cv.poly([(456, 360), (568, 360), (568, 444), (456, 444)], contrast, relief=0.98)
        cv.ellipse((512, 402), (26, 26), 0, d, relief=0.98)
    cv.garment = True


def draw_hoodie(cv: Canvas, p: Product, d: np.ndarray, contrast: np.ndarray, rng: np.random.Generator) -> None:
    f = p.features
    tex = garment_texture("fleece", rng)
    cv.poly([(420, 262), (402, 170), (440, 108), (512, 92), (584, 108), (622, 170), (604, 262)], d, relief=tex * 0.95, name="garment")
    cv.ellipse((512, 186), (62, 58), 0, d, relief=0.55)
    left = [(330, 286), (250, 322), (140, 748), (238, 784), (330, 492)]
    for sl in (left, mirror(left)):
        cv.poly(sl, d, relief=tex, name="garment")
    for a, b in (((140, 748), (238, 784)), ((S - 140, 748), (S - 238, 784))):
        cv.poly(_band(a, b, 36), d, relief=_rib() * 0.92)
    cv.poly([(330, 286), (430, 252), (594, 252), (694, 286), (698, 828), (326, 828)], d, relief=tex, name="body")
    cv.poly([(326, 824), (698, 824), (698, 868), (326, 868)], d, relief=_rib() * 0.92)
    if f["pocket"] == "kangaroo":
        cv.stroke([(372, 800), (404, 640), (620, 640), (652, 800)], 5, d, relief=0.78)
    if f["front"] == "zip":
        grey = hex_lin("#8a8a88")
        cv.stroke([(512, 262), (512, 862)], 7, grey, relief=1.0, gloss=0.4)
        cv.poly([(504, 300), (520, 300), (520, 340), (504, 340)], grey, gloss=0.5)
    strings = hex_lin("#efefea") if f["strings"] == "white" else d
    cv.stroke([(488, 262), (478, 420)], 7, strings, relief=0.97)
    cv.stroke([(536, 262), (546, 420)], 7, strings, relief=0.97)
    cv.garment = True


def draw_mug(cv: Canvas, p: Product, d: np.ndarray, contrast: np.ndarray, rng: np.random.Generator) -> None:
    f = p.features
    geo = {
        "straight": (340, 660, 340, 660, 330, 800),
        "tapered": (320, 680, 372, 628, 330, 800),
        "tall": (372, 628, 372, 628, 250, 820),
        "squat": (306, 694, 306, 694, 430, 780),
    }[f["shape"]]
    tl, tr, bl, br, y0, y1 = geo
    cx = (tl + tr) / 2
    half = (tr - tl) / 2
    ymid = (y0 + y1) / 2
    hx = max(tr, br) - 12
    hh = (y1 - y0) * 0.30
    if f["handle"] == "round":

        def draw_handle(m: np.ndarray, k: int) -> None:
            cv2.ellipse(m, (int(hx * k), int(ymid * k)), (int(100 * k), int(hh * k)), 0, -90, 90, 255, int(34 * k))

    else:

        def draw_handle(m: np.ndarray, k: int) -> None:
            pts = np.array([[hx, ymid - hh], [hx + 86, ymid - hh], [hx + 86, ymid + hh], [hx, ymid + hh]]) * k
            cv2.polylines(m, [pts.astype(np.int32)], False, 255, int(32 * k))

    cv.paint(Canvas.mask(draw_handle), d, relief=0.9, gloss=0.25)
    yy, xx = np.mgrid[0:S, 0:S].astype(np.float32)
    u = np.clip((xx - cx) / half, -1, 1)
    cyl = (0.6 + 0.45 * np.sqrt(np.clip(1 - u**2, 0, 1))).astype(np.float32)
    r = 26
    body = [(tl, y0), (tr, y0), (br, y1 - r), *qbez((br, y1 - r), (br, y1), (br - r, y1), 6), (bl + r, y1), *qbez((bl + r, y1), (bl, y1), (bl, y1 - r), 6)]
    cv.poly(body, d, relief=cyl, gloss=0.0, name="body")
    if f["glaze"] == "speckled":
        dots = [(U(rng, tl + 12, tr - 12), U(rng, y0 + 30, y1 - 20), U(rng, 2, 4.5)) for _ in range(170)]

        def draw_dots(m: np.ndarray, k: int) -> None:
            for x, y, r in dots:
                cv2.circle(m, (int(x * k), int(y * k)), int(r * k), 255, -1)

        cv.tint(Canvas.mask(draw_dots) * cv.regions["body"], d * 0.45, 1.0)
    elif f["glaze"] == "dipped":
        ycut = y1 - 0.3 * (y1 - y0)
        clay_mask = (cv.regions["body"] * (yy > ycut + 8 * np.sin(xx / 23.0))).astype(np.float32)
        cv.tint(clay_mask, hex_lin("#cdb89a"), 1.0)
    hl = np.exp(-(((u + 0.45) / 0.07) ** 2)) * (cv.regions["body"])
    cv.gloss = np.maximum(cv.gloss, hl.astype(np.float32) * 0.9)
    inner = hex_lin("#efeee8") if (p.features["glaze"] != "plain" or rng.random() < 0.5) else d
    cv.ellipse((cx, y0), (half, 26), 0, d, relief=1.05)
    cv.ellipse((cx, y0 + 2), (half - 12, 18), 0, inner, relief=0.62)


def draw_shoe(cv: Canvas, p: Product, d: np.ndarray, contrast: np.ndarray, rng: np.random.Generator) -> None:
    f = p.features
    tex = garment_texture("mesh" if f["style"] == "runner" else "jersey", rng)
    sole = {"white": "#f0efe9", "gum": "#b98a52", "black": "#1d1d1f"}[f["sole"]]
    if f["style"] == "high-top":
        upper = [(170, 640), (176, 330), *qbez((176, 330), (250, 296), (336, 328)), (430, 430), *qbez((430, 430), (548, 400), (652, 430)), (760, 500), *qbez((760, 500), (860, 540), (870, 640))]
    elif f["style"] == "slip-on":
        upper = [(170, 640), *qbez((170, 640), (176, 540), (290, 530)), (470, 520), *qbez((470, 520), (560, 470), (650, 470)), (760, 520), *qbez((760, 520), (860, 550), (870, 640))]
    elif f["style"] == "court":
        upper = [(170, 640), *qbez((170, 640), (176, 510), (300, 495)), (480, 480), *qbez((480, 480), (570, 420), (660, 440)), (770, 510), *qbez((770, 510), (856, 548), (866, 640))]
    else:
        upper = [(170, 640), *qbez((170, 640), (180, 520), (300, 500)), (470, 470), *qbez((470, 470), (560, 380), (650, 420)), (760, 500), *qbez((760, 500), (860, 540), (870, 640))]
    cv.poly(upper, d, relief=tex, gloss=0.25 if f["style"] in ("court", "high-top") else 0.08, name="body")
    sole_pts = [(160, 640), (880, 640), *qbez((880, 640), (884, 702), (820, 704)), (210, 704), *qbez((210, 704), (158, 702), (160, 640))]
    cv.poly(sole_pts, hex_lin(sole), relief=0.97, name="sole")
    cv.stroke([(168, 662), (872, 662)], 4, hex_lin(sole), relief=0.8)
    if f["stripe"] == "band":
        cv.poly([(330, 610), (430, 520), (480, 540), (390, 622)], contrast, relief=1.0)
    if f["style"] == "slip-on":
        cv.poly([(352, 528), (420, 522), (412, 610), (362, 614)], d, relief=0.62)
    else:
        lace = hex_lin("#f2f2ee") if rng.random() < 0.6 else d * 0.8
        top = {"runner": (500, 455), "court": (505, 470), "high-top": (360, 360)}[f["style"]]
        for i in range(5):
            x0, y0 = top[0] + i * 30, top[1] - i * 7 + (i * 14 if f["style"] == "high-top" else 0)
            cv.stroke([(x0, y0), (x0 + 30, y0 + 28)], 9, lace, relief=0.98)
    cv.ellipse((176, 560), (10, 34), 0, d * 0.7, relief=0.9)


DRAW = {"sweater": draw_sweater, "tee": draw_tee, "hoodie": draw_hoodie, "mug": draw_mug, "shoe": draw_shoe}

DAMAGE_KINDS = {
    "sweater": ("stain", "hole", "tear", "bleach"),
    "tee": ("stain", "hole", "tear", "bleach"),
    "hoodie": ("stain", "hole", "tear", "bleach"),
    "mug": ("chip", "crack"),
    "shoe": ("scuff", "sole split", "stain"),
}


def _blob(rng: np.random.Generator, cx: float, cy: float, r: float) -> np.ndarray:
    def draw(m: np.ndarray, k: int) -> None:
        for _ in range(int(rng.integers(3, 7))):
            ox, oy = rng.normal(0, r * 0.45, 2)
            cv2.ellipse(m, (int((cx + ox) * k), int((cy + oy) * k)), (int(U(rng, 0.35, 0.8) * r * k), int(U(rng, 0.3, 0.7) * r * k)), U(rng, 0, 180), 0, 360, 255, -1)

    m = Canvas.mask(draw)
    return cv2.GaussianBlur(m, (0, 0), 1.5)


def _pick_point(region: np.ndarray, rng: np.random.Generator, margin: int = 40) -> tuple[float, float]:
    inner = cv2.erode((region > 0.95).astype(np.uint8), np.ones((margin, margin), np.uint8))
    ys, xs = np.nonzero(inner)
    if len(xs) == 0:
        ys, xs = np.nonzero(region > 0.5)
    i = int(rng.integers(len(xs)))
    return float(xs[i]), float(ys[i])


def add_damage(cv: Canvas, p: Product, kind: str, d: np.ndarray, rng: np.random.Generator) -> dict[str, Any]:
    body = cv.regions.get("body", cv.alpha)
    dark_item = float(luminance(d)) < 0.08
    info: dict[str, Any] = {"kind": kind}
    if kind in ("stain", "bleach"):
        cx, cy = _pick_point(body, rng)
        r = U(rng, 28, 58)
        m = _blob(rng, cx, cy, r) * body
        if kind == "bleach" or (kind == "stain" and dark_item and rng.random() < 0.5):
            colour = np.clip(d * 0.35 + hex_lin("#b98a62") * 0.65, 0, 1)
            cv.tint(m, colour, U(rng, 0.65, 0.9))
        else:
            colour = d * np.array([0.55, 0.42, 0.25], np.float32) if not dark_item else hex_lin("#5a4a3a")
            cv.tint(m, colour, U(rng, 0.6, 0.85), relief=0.95)
        info.update(cx=cx, cy=cy, r=round(r, 1))
    elif kind == "hole":
        cx, cy = _pick_point(body, rng)
        r = U(rng, 16, 34)
        m = _blob(rng, cx, cy, r) * body
        ring = np.clip(cv2.GaussianBlur(m, (0, 0), 4) - m, 0, 1) * 2
        cv.tint(np.clip(ring, 0, 1), d * 1.25, 0.6)
        cv.tint(m, d * 0.12, 0.95, relief=0.5)
        info.update(cx=cx, cy=cy, r=round(r, 1))
    elif kind == "tear":
        cx, cy = _pick_point(body, rng, 60)
        n = int(rng.integers(5, 9))
        ang = U(rng, 0, math.pi)
        length = U(rng, 90, 170)
        pts = [(cx + (t - 0.5) * length * math.cos(ang) + rng.normal(0, 6), cy + (t - 0.5) * length * math.sin(ang) + rng.normal(0, 6)) for t in np.linspace(0, 1, n)]
        cv.stroke(pts, U(rng, 6, 12), d * 0.1, relief=0.5)
        info.update(cx=cx, cy=cy, length=round(length, 1))
    elif kind == "chip":
        ys, xs = np.nonzero(cv.regions["body"] > 0.5)
        top = ys.min()
        x = U(rng, xs.min() + 40, xs.max() - 40)
        notch = [(x - 26, top - 30), (x + 26, top - 30), (x + 18, top + 22), (x - 4, top + 34), (x - 20, top + 16)]
        nm = Canvas.mask(lambda m, k: cv2.fillPoly(m, [np.round(np.array(notch) * k).astype(np.int32)], 255))
        cv.alpha = cv.alpha * (1 - nm)
        cv.albedo = cv.albedo * (1 - nm[..., None])
        exposed = Canvas.mask(lambda m, k: cv2.ellipse(m, (int(x * k), int((top + 40) * k)), (int(30 * k), int(20 * k)), 0, 0, 360, 255, -1)) * cv.alpha
        cv.tint(exposed, hex_lin("#d9cbb3"), 0.9, relief=1.0)
        info.update(x=x)
    elif kind == "crack":
        ys, xs = np.nonzero(cv.regions["body"] > 0.5)
        x = U(rng, xs.min() + 50, xs.max() - 50)
        y = float(ys.min()) + 8
        pts = [(x, y)]
        for _ in range(int(rng.integers(6, 10))):
            x += rng.normal(0, 10)
            y += U(rng, 18, 30)
            pts.append((x, y))
        cv.stroke(pts, U(rng, 3, 5), hex_lin("#141414"), relief=0.5)
        info.update(x=pts[0][0])
    elif kind == "scuff":
        cx, cy = _pick_point(body, rng, 30)
        m = _blob(rng, cx, cy, U(rng, 30, 55)) * body
        grey = np.full(3, 0.35, np.float32)
        cv.tint(m * np.clip(1 + 0.4 * smooth_noise(rng, S, S, 3), 0, 1.4), grey, U(rng, 0.55, 0.8))
        info.update(cx=cx, cy=cy)
    elif kind == "sole split":
        x0 = U(rng, 560, 760)
        cv.poly([(x0, 636), (x0 + 120, 630), (x0 + 110, 652), (x0 + 6, 650)], hex_lin("#0e0e0e"), relief=0.4)
        info.update(x=x0)
    return info


def draw_item(p: Product, colour: str, rng: np.random.Generator, damage: str | None = None) -> tuple[Canvas, dict[str, Any] | None]:
    cv = Canvas()
    d = dye(p, colour)
    contrast = hex_lin(p.contrast)
    # A contrast trim the same as the dye would vanish: use cream or near-black instead.
    if float(np.abs(_lin_to_lab(contrast) - _lin_to_lab(d)).sum()) < 25:
        contrast = hex_lin("#1c1c1e") if float(luminance(d)) > 0.2 else hex_lin("#efe9dc")
    DRAW[p.type](cv, p, d, contrast, rng)
    info = add_damage(cv, p, damage, d, rng) if damage else None
    return cv, info


# ------------------------------------------------------------------------------------------------
# Backgrounds
# ------------------------------------------------------------------------------------------------

BED = ("#d9d2c5", "#c9ccd1", "#eeeeec", "#a9b8c9", "#b7c2a9", "#d8b8b8", "#5a5d63", "#3b4a5e", "#e4d6b8")
WOOD = {"wood light": "#c8a27a", "wood dark": "#5e4030", "white laminate": "#e9e7e2", "grey laminate": "#9ea0a3"}
TILE = ("#d8d0c2", "#bfc1c3", "#efede8", "#8f8a84")
CARPET = ("#8c8a86", "#b3a58f", "#4f5a6b")


def background(rng: np.random.Generator, h: int, w: int) -> tuple[np.ndarray, np.ndarray, dict[str, Any]]:
    kind = str(rng.choice(["bed", "table", "floor"]))
    yy, xx = np.mgrid[0:h, 0:w].astype(np.float32)
    shade = np.ones((h, w), np.float32)
    desc: dict[str, Any] = {"surface": kind}
    if kind == "bed":
        base = str(rng.choice(BED))
        alb = np.empty((h, w, 3), np.float32)
        alb[:] = hex_lin(base)
        pat = str(rng.choice(["plain", "stripe", "check", "floral"], p=[0.6, 0.15, 0.1, 0.15]))
        second = hex_lin(str(rng.choice(BED)))
        if pat == "stripe":
            period = U(rng, 60, 160)
            m = (np.sin(2 * np.pi * xx / period) > 0.4).astype(np.float32)
            alb = alb * (1 - m[..., None] * 0.6) + second * m[..., None] * 0.6
        elif pat == "check":
            period = U(rng, 80, 180)
            m = ((np.sin(2 * np.pi * xx / period) > 0.5) | (np.sin(2 * np.pi * yy / period) > 0.5)).astype(np.float32)
            alb = alb * (1 - m[..., None] * 0.35) + second * m[..., None] * 0.35
        elif pat == "floral":
            m = np.zeros((h, w), np.uint8)
            for _ in range(int(rng.integers(60, 140))):
                cv2.circle(m, (int(rng.integers(w)), int(rng.integers(h))), int(rng.integers(8, 26)), 255, -1)
            mm = cv2.GaussianBlur(m.astype(np.float32) / 255, (0, 0), 1.2)
            alb = alb * (1 - mm[..., None] * 0.7) + second * mm[..., None] * 0.7
        shade *= 1 + 0.09 * smooth_noise(rng, h, w, 0.18 * w)
        for _ in range(int(rng.integers(2, 6))):
            a = U(rng, 0, math.pi)
            c = U(rng, -0.5, 0.5) * w
            dist = (xx - w / 2) * math.cos(a) + (yy - h / 2) * math.sin(a) - c
            shade *= 1 - 0.1 * np.exp(-((dist / U(rng, 5, 12)) ** 2)) + 0.05 * np.exp(-(((dist - 14) / 12) ** 2))
        shade *= 1 + 0.025 * np.sin(xx * 1.7) * np.sin(yy * 1.7)
        desc.update(colour=base, pattern=pat)
    elif kind == "table":
        name = str(rng.choice(list(WOOD)))
        alb = np.empty((h, w, 3), np.float32)
        alb[:] = hex_lin(WOOD[name])
        if name.startswith("wood"):
            vertical = rng.random() < 0.5
            a, b = (xx, yy) if vertical else (yy, xx)
            grain = np.sin(2 * np.pi * (a + 7 * smooth_noise(rng, h, w, 160)) / U(rng, 14, 30))
            alb *= (1 + 0.12 * grain + 0.06 * smooth_noise(rng, h, w, 40))[..., None]
            plank = U(rng, 220, 360)
            seam = np.exp(-(((a % plank) - 1.5) / 1.6) ** 2)
            shade *= 1 - 0.35 * seam
        else:
            alb *= (1 + 0.02 * smooth_noise(rng, h, w, 3))[..., None]
        desc.update(material=name)
    else:
        sub = str(rng.choice(["tiles", "planks", "carpet"]))
        alb = np.empty((h, w, 3), np.float32)
        if sub == "tiles":
            col = str(rng.choice(TILE))
            alb[:] = hex_lin(col)
            size = U(rng, 200, 330)
            tx, ty = (xx // size).astype(np.int32), (yy // size).astype(np.int32)
            var = rng.normal(1, 0.03, (int(h / size) + 2, int(w / size) + 2)).astype(np.float32)
            alb *= var[ty, tx][..., None]
            grout = np.minimum(np.abs((xx % size) - size / 2), np.abs((yy % size) - size / 2))
            gm = (grout > size / 2 - 3).astype(np.float32)
            alb = alb * (1 - gm[..., None] * 0.6) + hex_lin("#77736d") * gm[..., None] * 0.6
            desc.update(colour=col)
        elif sub == "planks":
            alb[:] = hex_lin(str(rng.choice(["#a87e57", "#7a5a40", "#c9b08e"])))
            grain = np.sin(2 * np.pi * (xx + 6 * smooth_noise(rng, h, w, 160)) / U(rng, 12, 24))
            alb *= (1 + 0.1 * grain)[..., None]
            seam = np.exp(-((((xx % U(rng, 160, 240)) - 1.5) / 1.5) ** 2))
            shade *= 1 - 0.4 * seam
        else:
            col = str(rng.choice(CARPET))
            alb[:] = hex_lin(col)
            alb *= (1 + 0.09 * smooth_noise(rng, h, w, 1.5) + 0.04 * smooth_noise(rng, h, w, 30))[..., None]
            desc.update(colour=col)
        desc.update(kind=sub)
    return np.clip(alb, 0, 1).astype(np.float32), shade.astype(np.float32), desc


# ------------------------------------------------------------------------------------------------
# Light and camera
# ------------------------------------------------------------------------------------------------


def sample_light(level: str, rng: np.random.Generator) -> dict[str, Any]:
    """Light and camera settings for one pair. The item photo and the tag photo share them."""
    if level == "day":
        p = dict(cct=U(rng, 5000, 7200), awb=U(rng, 0.9, 1.0), target=U(rng, 0.13, 0.22), shot=U(rng, 1e-4, 3e-4), read=U(rng, 1e-6, 4e-6),
                 defocus=U(rng, 0.0, 1.0), motion=U(rng, 0, 4) if rng.random() < 0.3 else 0.0, jpeg=int(rng.integers(80, 96)),
                 field="directional", grad=U(rng, 0.08, 0.3), sat=U(rng, 1.0, 1.15), contrast=U(rng, 0.1, 0.3), denoise=0.0, sharpen=U(rng, 0.2, 0.6),
                 wb_err=0.03, spec=0.25)
    elif level == "lamp":
        p = dict(cct=U(rng, 2600, 3400), awb=U(rng, 0.7, 0.92), target=U(rng, 0.07, 0.13), shot=U(rng, 5e-4, 1.2e-3), read=U(rng, 5e-6, 1.5e-5),
                 defocus=U(rng, 0.3, 1.6), motion=U(rng, 0, 7) if rng.random() < 0.4 else 0.0, jpeg=int(rng.integers(70, 93)),
                 field="radial", grad=U(rng, 0.7, 1.5), sat=U(rng, 0.95, 1.1), contrast=U(rng, 0.05, 0.25), denoise=U(rng, 0.3, 0.8), sharpen=U(rng, 0.1, 0.4),
                 wb_err=0.05, spec=0.4)
    elif level == "dim":
        warm = rng.random() < 0.7
        p = dict(cct=U(rng, 2300, 3200) if warm else U(rng, 6500, 9000), awb=U(rng, 0.55, 0.85), target=U(rng, 0.015, 0.04), shot=U(rng, 1.5e-3, 3.5e-3),
                 read=U(rng, 2e-5, 5e-5), defocus=U(rng, 0.6, 2.2), motion=U(rng, 2, 12) if rng.random() < 0.6 else 0.0, jpeg=int(rng.integers(60, 89)),
                 field="directional", grad=U(rng, 0.2, 0.55), sat=U(rng, 0.75, 0.95), contrast=U(rng, 0.0, 0.15), denoise=U(rng, 0.8, 1.6), sharpen=0.0,
                 wb_err=0.07, spec=0.3)
    else:
        raise ValueError(level)
    p["level"] = level
    p["wb_gain_err"] = [float(np.exp(rng.normal(0, p["wb_err"]))), 1.0, float(np.exp(rng.normal(0, p["wb_err"])))]
    p["light_dir"] = U(rng, 0, 2 * math.pi)
    p["lamp_pos"] = [U(rng, -0.2, 1.2), U(rng, -0.2, 0.6)]
    p["motion_angle"] = U(rng, 0, 180)
    p["vignette"] = U(rng, 0.05, 0.25)
    return p


def light_field(p: dict[str, Any], h: int, w: int) -> np.ndarray:
    yy, xx = np.mgrid[0:h, 0:w].astype(np.float32)
    if p["field"] == "radial":
        lx, ly = p["lamp_pos"][0] * w, p["lamp_pos"][1] * h
        r = p["grad"] * w
        e = 1.0 / (1.0 + ((xx - lx) ** 2 + (yy - ly) ** 2) / (r * r))
        return (e / e.max()).astype(np.float32)
    a = p["light_dir"]
    g = p["grad"]
    e = 1 + g * ((xx - w / 2) * math.cos(a) + (yy - h / 2) * math.sin(a)) / (w / 2)
    return np.clip(e, 0.35, None).astype(np.float32)


def _perspective(img: np.ndarray, rng: np.random.Generator, amount: float, zoom: float) -> tuple[np.ndarray, list[float]]:
    h, w = img.shape[:2]
    cx, cy = w / 2, h / 2
    src = []
    jit = []
    for x, y in ((0, 0), (w, 0), (w, h), (0, h)):
        jx, jy = rng.uniform(-amount, amount, 2) * w
        jit += [round(float(jx), 1), round(float(jy), 1)]
        src.append([cx + (x - cx) / zoom + jx, cy + (y - cy) / zoom + jy])
    dst = np.array([[0, 0], [w, 0], [w, h], [0, h]], np.float32)
    m = cv2.getPerspectiveTransform(dst, np.array(src, np.float32))
    out = cv2.warpPerspective(img, m, (w, h), flags=cv2.INTER_LINEAR | cv2.WARP_INVERSE_MAP, borderMode=cv2.BORDER_REFLECT)
    return out, jit


def _motion_kernel(length: float, angle: float) -> np.ndarray:
    n = max(3, int(round(length)) | 1)
    k = np.zeros((n, n), np.float32)
    c = n // 2
    dx, dy = math.cos(math.radians(angle)), math.sin(math.radians(angle))
    for t in np.linspace(-length / 2, length / 2, n * 2):
        k[int(round(c + t * dy)) % n, int(round(c + t * dx)) % n] = 1
    return k / k.sum()


def camera(radiance: np.ndarray, p: dict[str, Any], rng: np.random.Generator) -> np.ndarray:
    """Optics, sensor and phone image processing. Linear scene radiance in, sRGB uint8 out."""
    img = radiance
    if p["defocus"] > 0.05:
        img = cv2.GaussianBlur(img, (0, 0), p["defocus"])
    if p["motion"] > 1.5:
        img = cv2.filter2D(img, -1, _motion_kernel(p["motion"], p["motion_angle"]))
    h, w = img.shape[:2]
    yy, xx = np.mgrid[0:h, 0:w].astype(np.float32)
    r2 = ((xx - w / 2) / (w / 2)) ** 2 + ((yy - h / 2) / (h / 2)) ** 2
    img = img * (1 - p["vignette"] * r2 / 2)[..., None]
    illum = cct_rgb(p["cct"])
    gains = illum ** (-p["awb"]) * np.array(p["wb_gain_err"], np.float32)
    gains = gains / gains[1]
    y0 = max(float(luminance(img * gains).mean()), 1e-6)
    # Auto exposure aims at a mid-tone but only partly brightens a dark scene (phones keep some of the
    # darkness of a dark table or bed cover, and never push a bright scene past its target).
    exposure = p["target"] * min(1.0, (y0 / 0.25) ** 0.4) / y0
    raw = np.clip(img * exposure, 0, 1)
    sd = np.sqrt(p["shot"] * raw + p["read"]).astype(np.float32)
    raw = raw + rng.standard_normal(raw.shape, dtype=np.float32) * sd
    proc = np.clip(raw * gains, 0, 1)
    srgb = linear_to_srgb(proc)
    if p["denoise"] > 0:
        ycc = cv2.cvtColor(srgb, cv2.COLOR_RGB2YCrCb)
        ycc[..., 0] = cv2.GaussianBlur(ycc[..., 0], (0, 0), 0.6 * p["denoise"])
        ycc[..., 1:] = cv2.GaussianBlur(ycc[..., 1:], (0, 0), 2.2 * p["denoise"])
        srgb = cv2.cvtColor(ycc, cv2.COLOR_YCrCb2RGB)
    srgb = np.clip(srgb, 0, 1)
    smooth = srgb * srgb * (3 - 2 * srgb)
    srgb = srgb + p["contrast"] * (smooth - srgb)
    lum = luminance(srgb)[..., None]
    srgb = lum + p["sat"] * (srgb - lum)
    if p["sharpen"] > 0:
        srgb = srgb + p["sharpen"] * (srgb - cv2.GaussianBlur(srgb, (0, 0), 1.2))
    return (np.clip(srgb, 0, 1) * 255 + 0.5).astype(np.uint8)


def jpeg_bytes(rgb: np.ndarray, quality: int) -> bytes:
    buf = io.BytesIO()
    Image.fromarray(rgb, "RGB").save(buf, "JPEG", quality=int(quality), subsampling=2)
    return buf.getvalue()


def _place(cv: Canvas, h: int, w: int, scale: float, theta: float, cx: float, cy: float) -> tuple[np.ndarray, ...]:
    a = cv2.getRotationMatrix2D((S / 2, S / 2), theta, scale)
    a[0, 2] += cx - S / 2
    a[1, 2] += cy - S / 2
    alpha = cv2.warpAffine(cv.alpha, a, (w, h), flags=cv2.INTER_LINEAR, borderValue=0)
    albedo = cv2.warpAffine(cv.albedo, a, (w, h), flags=cv2.INTER_LINEAR, borderValue=(0, 0, 0))
    relief = cv2.warpAffine(cv.relief, a, (w, h), flags=cv2.INTER_LINEAR, borderValue=1)
    gloss = cv2.warpAffine(cv.gloss, a, (w, h), flags=cv2.INTER_LINEAR, borderValue=0)
    return alpha, albedo, relief, gloss


def render_delivered(cv: Canvas, p: dict[str, Any], rng: np.random.Generator) -> tuple[bytes, dict[str, Any]]:
    h, w = OUT_H, OUT_W
    bg_alb, bg_shade, bg_desc = background(rng, h, w)
    scale = U(rng, 0.7, 1.0) * w / S
    theta = U(rng, -30, 30)
    cx, cy = w / 2 + U(rng, -0.07, 0.07) * w, h / 2 + U(rng, -0.06, 0.06) * h
    alpha, albedo, relief, gloss = _place(cv, h, w, scale, theta, cx, cy)
    if cv.garment:
        fold = 1 + 0.12 * smooth_noise(rng, h, w, 0.12 * w)
        yy, xx = np.mgrid[0:h, 0:w].astype(np.float32)
        for _ in range(int(rng.integers(1, 4))):
            a = U(rng, 0, math.pi)
            dist = (xx - cx) * math.cos(a) + (yy - cy) * math.sin(a) - U(rng, -0.2, 0.2) * w
            fold *= 1 - 0.14 * np.exp(-((dist / U(rng, 4, 10)) ** 2)) + 0.06 * np.exp(-(((dist - 12) / 10) ** 2))
        relief = relief * fold
    a = p["light_dir"]
    off = 0.012 * w
    m = np.float32([[1, 0, -off * math.cos(a)], [0, 1, -off * math.sin(a) + off * 0.5]])
    shadow = cv2.GaussianBlur(cv2.warpAffine(alpha, m, (w, h)), (0, 0), 0.018 * w)
    bg_shade = bg_shade * (1 - U(rng, 0.25, 0.45) * shadow)
    comp_alb = albedo + (1 - alpha)[..., None] * bg_alb
    shade = alpha * relief + (1 - alpha) * bg_shade
    e = light_field(p, h, w)
    illum = cct_rgb(p["cct"])
    rad = comp_alb * (shade * e)[..., None] * illum + (gloss * p["spec"] * e)[..., None] * illum
    rad, jit = _perspective(rad.astype(np.float32), rng, 0.05, U(rng, 1.03, 1.1))
    rgb = camera(rad, p, rng)
    meta = {"background": bg_desc, "item_scale": round(scale * S / w, 3), "rotation_deg": round(theta, 1), "perspective_jitter_px": jit}
    return jpeg_bytes(rgb, p["jpeg"]), meta


def render_listing(cv: Canvas, rng: np.random.Generator) -> bytes:
    side = LISTING_SIDE
    bgc = hex_lin(str(rng.choice(["#f4f4f2", "#ffffff", "#eeeeea", "#f2efe9", "#e9ecef"])))
    alpha, albedo, relief, gloss = _place(cv, side, side, 0.86, 0.0, side / 2, side / 2 + 10)
    yy = np.mgrid[0:side, 0:side][0].astype(np.float32)
    e = (1.0 - 0.06 * yy / side).astype(np.float32)
    m = np.float32([[1, 0, 0], [0, 1, 14]])
    shadow = cv2.GaussianBlur(cv2.warpAffine(alpha, m, (side, side)), (0, 0), 14)
    bg_shade = 1 - 0.16 * shadow
    comp = albedo + (1 - alpha)[..., None] * bgc
    shade = alpha * relief + (1 - alpha) * bg_shade
    rad = comp * (shade * e)[..., None] + (gloss * 0.22)[..., None]
    rgb = (linear_to_srgb(rad) * 255 + 0.5).astype(np.uint8)
    return jpeg_bytes(rgb, 92)


# ------------------------------------------------------------------------------------------------
# Size tags
# ------------------------------------------------------------------------------------------------

TAG_STYLES = (("#f4f2ec", "#1b1b1b", 0.4), ("#ece4cf", "#222222", 0.2), ("#1c1c1c", "#e8e6e0", 0.25), ("#8d8f93", "#ffffff", 0.075), ("#1f2a44", "#d9c27a", 0.075))
LININGS = ("#3b3b3d", "#d9d9d5", "#2b3445", "#7d7f84")
ORIGINS = ("MADE IN PORTUGAL", "MADE IN INDIA", "MADE IN VIETNAM", "MADE IN TURKEY", "MADE IN BANGLADESH")
MATERIALS = ("100% COTTON", "80% WOOL 20% NYLON", "60% COTTON 40% POLYESTER", "100% MERINO WOOL", "95% COTTON 5% ELASTANE")


def size_text(p: Product, size: str, rng: np.random.Generator) -> tuple[list[str], str]:
    """The size line(s) printed on the tag, and the format used."""
    if p.type == "shoe":
        fmt = str(rng.choice(["US {us}", "US {us}  UK {uk}  EU {eu}", "SIZE {us}", "{us} US"]))
        text = fmt.format(us=size, uk=shoe_uk(size), eu=shoe_eu(size))
        return [text], fmt
    fmt = str(rng.choice(["{L}", "SIZE {L}", "TAILLE {L}", "{WORD}", "{L}/{EU}", "SIZE|{L}"]))
    text = fmt.format(L=size, WORD=WORD_LETTER[size], EU=EU_LETTER[size])
    return text.split("|"), fmt


def _font(path: str, px: int) -> ImageFont.FreeTypeFont:
    return ImageFont.truetype(path, max(8, int(px)))


def _draw_tag(p: Product, size: str, rng: np.random.Generator, shoe_bg: str | None) -> tuple[np.ndarray, np.ndarray, dict[str, Any]]:
    tall = rng.random() < 0.6
    tw, th = (int(900 * U(rng, 0.62, 0.85)), 900) if tall else (900, int(900 * U(rng, 0.5, 0.75)))
    if shoe_bg is not None and rng.random() < 0.5:
        bg_hex, ink = shoe_bg, ("#f2f2ee" if float(luminance(hex_lin(shoe_bg))) < 0.3 else "#1b1b1b")
        style = "printed on lining"
    else:
        probs = np.array([s[2] for s in TAG_STYLES])
        i = int(rng.choice(len(TAG_STYLES), p=probs / probs.sum()))
        bg_hex, ink = TAG_STYLES[i][0], TAG_STYLES[i][1]
        style = "tag"
    woven = style == "tag" and rng.random() < 0.6
    img = Image.new("RGB", (tw, th), bg_hex)
    draw = ImageDraw.Draw(img)
    size_lines, fmt = size_text(p, size, rng)
    size_font = str(rng.choice(FONT_FILES))
    text_font = str(rng.choice(FONT_FILES))
    lines: list[tuple[str, float, str]] = [(p.brand.upper(), U(rng, 0.06, 0.1), text_font)]
    size_rel = U(rng, 0.1, 0.34)
    for i, sl in enumerate(size_lines):
        lines.append((sl, size_rel * (0.45 if (len(size_lines) > 1 and i == 0) else 1.0), size_font))
    extras = [str(rng.choice(MATERIALS)), str(rng.choice(ORIGINS)), f"RN {int(rng.integers(10000, 99999))}", "MACHINE WASH 30°C", f"STYLE {int(rng.integers(1000, 9999))}-{int(rng.integers(10, 99))}"]
    rng.shuffle(extras)
    for e in extras[: int(rng.integers(1, 4))]:
        lines.append((e, U(rng, 0.045, 0.07), text_font))
    gap = 0.035 * th
    total = sum(r * th for _, r, _ in lines) + gap * (len(lines) - 1)
    fit = min(1.0, 0.84 * th / total)
    fonts = []
    for text, r, fpath in lines:
        px = r * th * fit
        f = _font(fpath, px)
        bw = draw.textbbox((0, 0), text, font=f)[2]
        if bw > 0.86 * tw:
            f = _font(fpath, px * 0.86 * tw / bw)
        fonts.append(f)
    heights = [draw.textbbox((0, 0), t, font=f)[3] - draw.textbbox((0, 0), t, font=f)[1] for (t, _, _), f in zip(lines, fonts, strict=True)]
    y = (th - (sum(heights) + gap * (len(lines) - 1))) / 2
    for (text, _, _), f, hgt in zip(lines, fonts, heights, strict=True):
        draw.text((tw / 2, y + hgt / 2), text, font=f, fill=ink, anchor="mm")
        y += hgt + gap
    if style == "tag" and rng.random() < 0.5:
        inset = int(0.04 * min(tw, th))
        for x in range(inset, tw - inset, 24):
            draw.line([(x, inset), (x + 12, inset)], fill=ink, width=3)
            draw.line([(x, th - inset), (x + 12, th - inset)], fill=ink, width=3)
    arr = np.asarray(img, np.float32) / 255.0
    if woven:
        arr = cv2.GaussianBlur(arr, (0, 0), U(rng, 1.0, 2.0))
        yy, xx = np.mgrid[0:th, 0:tw].astype(np.float32)
        weave = 1 + 0.07 * np.sin(xx * 2.1) * np.sin(yy * 2.1)
        arr = arr * weave[..., None]
    alb = srgb_to_linear(np.clip(arr, 0, 1))
    alpha = np.ones((th, tw), np.float32)
    if style == "printed on lining":
        alpha[:] = 0.0  # ink only: the tag background is the lining itself
        ink_mask = np.abs(arr - np.asarray(Image.new("RGB", (1, 1), bg_hex), np.float32)[0, 0] / 255.0).sum(axis=2)
        alpha = np.clip(ink_mask * 3, 0, 1).astype(np.float32)
    meta = {"style": style, "woven": woven, "tag_colour": bg_hex, "ink": ink, "size_format": fmt, "size_text": " / ".join(size_lines),
            "size_font": Path(size_font).name, "text_font": Path(text_font).name, "size_rel_height": round(size_rel * fit, 3), "tall": tall}
    return alb.astype(np.float32), alpha, meta


def render_label(p: Product, colour: str, size: str, light: dict[str, Any], rng: np.random.Generator) -> tuple[bytes, dict[str, Any]]:
    h, w = OUT_H, OUT_W
    if p.type == "shoe":
        lining = str(rng.choice(LININGS))
        fab = np.empty((h, w, 3), np.float32)
        fab[:] = hex_lin(lining)
        fshade = garment_texture("mesh", rng, U(rng, 2.0, 3.0), h, w)
        shoe_bg: str | None = lining
    else:
        fab = np.empty((h, w, 3), np.float32)
        fab[:] = dye(p, colour)
        kind = {"sweater": p.features.get("knit", "plain"), "tee": "jersey", "hoodie": "fleece"}[p.type]
        fshade = garment_texture("plain" if kind == "cable" else kind, rng, U(rng, 2.2, 3.4), h, w)
        shoe_bg = None
    fshade = fshade * (1 + 0.1 * smooth_noise(rng, h, w, 0.2 * w))
    tag_alb, tag_alpha, meta = _draw_tag(p, size, rng, shoe_bg)
    th_, tw_ = tag_alpha.shape
    amp = U(rng, 0, 8)
    if amp > 0.5:
        yy, xx = np.mgrid[0:th_, 0:tw_].astype(np.float32)
        lam = U(rng, 300, 700)
        mapy = (yy + amp * np.sin(2 * np.pi * xx / lam + U(rng, 0, 6))).astype(np.float32)
        tag_alb = cv2.remap(tag_alb, xx, mapy, cv2.INTER_LINEAR, borderMode=cv2.BORDER_REFLECT)
        tag_alpha = cv2.remap(tag_alpha, xx, mapy, cv2.INTER_LINEAR, borderMode=cv2.BORDER_CONSTANT, borderValue=0)
    frac = U(rng, 0.42, 0.72) if meta["tall"] else U(rng, 0.55, 0.86)
    scale = frac * w / tw_
    theta = U(rng, -35, 35)
    cx, cy = w / 2 + U(rng, -0.08, 0.08) * w, h / 2 + U(rng, -0.08, 0.08) * h
    a = cv2.getRotationMatrix2D((tw_ / 2, th_ / 2), theta, scale)
    a[0, 2] += cx - tw_ / 2
    a[1, 2] += cy - th_ / 2
    ta = cv2.warpAffine(tag_alpha, a, (w, h), flags=cv2.INTER_LINEAR, borderValue=0)
    talb = cv2.warpAffine(tag_alb, a, (w, h), flags=cv2.INTER_LINEAR, borderValue=(0, 0, 0))
    if meta["style"] == "tag":
        m = np.float32([[1, 0, 6], [0, 1, 8]])
        fshade = fshade * (1 - 0.3 * cv2.GaussianBlur(cv2.warpAffine(ta, m, (w, h)), (0, 0), 6))
        tshade = 1 + 0.04 * smooth_noise(rng, h, w, 0.25 * w)
    else:
        tshade = fshade
    comp = talb * ta[..., None] + fab * (1 - ta)[..., None]
    shade = ta * tshade + (1 - ta) * fshade
    e = light_field(light, h, w)
    illum = cct_rgb(light["cct"])
    rad = comp * (shade * e)[..., None] * illum
    rad, jit = _perspective(rad.astype(np.float32), rng, 0.07, U(rng, 1.03, 1.08))
    rgb = camera(rad, light, rng)
    meta.update(tag_width_fraction=round(frac, 3), rotation_deg=round(theta, 1), bend_px=round(amp, 1), perspective_jitter_px=jit)
    return jpeg_bytes(rgb, light["jpeg"]), meta
