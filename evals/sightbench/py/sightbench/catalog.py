"""The synthetic product catalogue: colours, products and sizes.

Every product is fictional. Colours are named the way a listing would name them; the hex is the
dye as it would look on the product under neutral light (each product gets its own small Lab
offset, so two "navy" products are not the same pixel value).
"""

from __future__ import annotations

import itertools
from dataclasses import asdict, dataclass, field
from typing import Any

import numpy as np

COLOURS: dict[str, str] = {
    "navy": "#1f2a44",
    "black": "#16171a",
    "charcoal": "#3a3d42",
    "heather grey": "#9b9da0",
    "white": "#f3f3ef",
    "cream": "#ece3cc",
    "burgundy": "#6d1a2e",
    "maroon": "#6a2024",
    "olive": "#66663a",
    "forest green": "#2d4b31",
    "royal blue": "#2f4fb5",
    "teal": "#1f7a7a",
    "red": "#b8242c",
    "mustard": "#c9a227",
    "sky blue": "#8ec1e6",
    "rust": "#a8462b",
    "blush": "#e8b9b2",
    "sand": "#d6c3a0",
}

# Pairs a buyer could confuse, and the reason SightBench exists.
NEAR_PAIRS: tuple[tuple[str, str], ...] = (
    ("navy", "black"),
    ("charcoal", "black"),
    ("cream", "white"),
    ("burgundy", "maroon"),
    ("olive", "forest green"),
)
OTHER_NEAR = NEAR_PAIRS[1:]
FAR_COLOURS = ("royal blue", "teal", "red", "mustard", "sky blue", "rust", "blush", "sand", "heather grey")

LETTER_SIZES = ("XS", "S", "M", "L", "XL", "XXL")
LISTING_LETTERS = ("S", "M", "L", "XL")
SHOE_SIZES = ("7", "7.5", "8", "8.5", "9", "9.5", "10", "10.5", "11", "11.5", "12")
LISTING_SHOES = ("8", "8.5", "9", "9.5", "10", "10.5", "11")

BRANDS = {
    "sweater": ("Harbor & Co", "Northloom", "Ashgrove", "Tidewater"),
    "tee": ("Mill Street", "Fieldnote", "Coastline", "Harbor & Co"),
    "hoodie": ("Kestrel", "Fieldnote", "Northloom"),
    "mug": ("Lumen Clay", "Kiln & Ash", "Hearth"),
    "shoe": ("Stride Lab", "Kestrel", "Paceline"),
}

FEATURES: dict[str, dict[str, tuple[str, ...]]] = {
    "sweater": {"neck": ("crew", "v", "turtle"), "knit": ("plain", "cable", "rib"), "extra": ("none", "elbow patches", "contrast hem")},
    "tee": {"neck": ("crew", "v"), "sleeves": ("short", "long"), "pocket": ("no", "yes"), "trim": ("none", "ringer"), "print": ("none", "block")},
    "hoodie": {"front": ("pullover", "zip"), "pocket": ("kangaroo", "none"), "strings": ("white", "self")},
    "mug": {"shape": ("straight", "tapered", "tall", "squat"), "handle": ("round", "square"), "glaze": ("plain", "speckled", "dipped")},
    "shoe": {"style": ("runner", "high-top", "slip-on", "court"), "sole": ("white", "gum", "black"), "stripe": ("none", "band")},
}

COUNTS = {"sweater": 16, "tee": 14, "hoodie": 8, "mug": 10, "shoe": 12}

CONTRASTS = ("#efe9dc", "#f4f4f0", "#1c1c1e", "#b48a4a", "#7a2a2a")


@dataclass
class Product:
    id: str
    type: str
    name: str
    brand: str
    features: dict[str, str]
    colours: list[str]
    sizes: list[str]
    contrast: str
    dye_offsets: dict[str, list[float]] = field(default_factory=dict)

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)

    @property
    def has_size(self) -> bool:
        return bool(self.sizes)

    def attributes(self) -> dict[str, str]:
        attrs = {"type": self.type, "brand": self.brand}
        attrs.update({k: v for k, v in self.features.items() if v not in ("none", "no")})
        return attrs


def _title(ptype: str, brand: str, f: dict[str, str]) -> str:
    if ptype == "sweater":
        neck = {"crew": "crew-neck", "v": "V-neck", "turtle": "turtleneck"}[f["neck"]]
        knit = {"plain": "", "cable": "cable-knit ", "rib": "rib-knit "}[f["knit"]]
        extra = {"none": "", "elbow patches": " with elbow patches", "contrast hem": " with contrast hem"}[f["extra"]]
        return f"{brand} {knit}{neck} sweater{extra}"
    if ptype == "tee":
        parts = ["long-sleeve" if f["sleeves"] == "long" else "", "ringer" if f["trim"] == "ringer" else "", "pocket" if f["pocket"] == "yes" else ""]
        neck = "V-neck" if f["neck"] == "v" else "crew-neck"
        lead = " ".join(p for p in parts if p)
        tail = " with chest print" if f["print"] == "block" else ""
        return f"{brand} {lead + ' ' if lead else ''}{neck} T-shirt{tail}"
    if ptype == "hoodie":
        kind = "zip hoodie" if f["front"] == "zip" else "pullover hoodie"
        pocket = "" if f["pocket"] == "kangaroo" else " without pocket"
        return f"{brand} {kind}{pocket}"
    if ptype == "mug":
        glaze = {"plain": "", "speckled": "speckled ", "dipped": "dipped "}[f["glaze"]]
        return f"{brand} {glaze}{f['shape']} mug, {f['handle']} handle"
    if ptype == "shoe":
        sole = {"white": "white sole", "gum": "gum sole", "black": "black sole"}[f["sole"]]
        stripe = " with side band" if f["stripe"] == "band" else ""
        return f"{brand} {f['style']} sneaker, {sole}{stripe}"
    raise ValueError(ptype)


def _colours_for(ptype: str, rng: np.random.Generator) -> list[str]:
    cols = ["navy", "black"]
    others = list(OTHER_NEAR)
    if ptype == "mug":
        others = [("cream", "white"), ("charcoal", "black"), ("olive", "forest green")]
    rng.shuffle(others)
    for a, b in others[: 1 + int(rng.random() < 0.5)]:
        for c in (a, b):
            if c not in cols:
                cols.append(c)
    far = list(FAR_COLOURS)
    rng.shuffle(far)
    cols += far[:2]
    return cols


def _dye_offsets(colours: list[str], rng: np.random.Generator) -> dict[str, list[float]]:
    """Per-product Lab offset per colour (dL, da, db), a few units: dye lots differ."""
    return {c: [round(float(v), 2) for v in (rng.uniform(-2.0, 2.0), rng.uniform(-1.5, 1.5), rng.uniform(-1.5, 1.5))] for c in colours}


def build_catalog(seed: int) -> list[Product]:
    rng = np.random.default_rng(seed)
    products: list[Product] = []
    n = 0
    for ptype, count in COUNTS.items():
        feats = FEATURES[ptype]
        keys = list(feats)
        combos = list(itertools.product(*(feats[k] for k in keys)))
        order = rng.permutation(len(combos))
        brands = BRANDS[ptype]
        for i in range(count):
            combo = combos[int(order[i % len(combos)])]
            f = dict(zip(keys, combo, strict=True))
            brand = brands[i % len(brands)]
            n += 1
            cols = _colours_for(ptype, rng)
            sizes = list(LETTER_SIZES) if ptype in ("sweater", "tee", "hoodie") else (list(SHOE_SIZES) if ptype == "shoe" else [])
            slug = ptype
            products.append(
                Product(
                    id=f"p{n:02d}-{slug}",
                    type=ptype,
                    name=_title(ptype, brand, f),
                    brand=brand,
                    features=f,
                    colours=cols,
                    sizes=sizes,
                    contrast=CONTRASTS[int(rng.integers(len(CONTRASTS)))],
                    dye_offsets=_dye_offsets(sorted(set(COLOURS)), rng),
                )
            )
    return products


def shoe_eu(us: str) -> str:
    v = float(us) + 33.0
    return f"{v:g}"


def shoe_uk(us: str) -> str:
    v = float(us) - 1.0
    return f"{v:g}"


EU_LETTER = {"XS": "34", "S": "36", "M": "38", "L": "40", "XL": "42", "XXL": "44"}
WORD_LETTER = {"XS": "X-SMALL", "S": "SMALL", "M": "MEDIUM", "L": "LARGE", "XL": "X-LARGE", "XXL": "XX-LARGE"}


def listing_size(product: Product, size: str | None) -> str | None:
    if not size:
        return None
    return f"US {size}" if product.type == "shoe" else size
