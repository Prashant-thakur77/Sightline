"""Curated colour names with CIELAB centres.

Each entry has a representative sRGB value of the colour as it appears on fabric (not the pure CSS
value: "black" fabric photographs as a very dark grey). Lab centres are computed from those values.
Tolerances (CIEDE2000) are read from ``thresholds.json`` -> ``colour.name_tolerance`` so they can be
fitted on the dev split without editing this table.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from functools import cache
from typing import Any

import numpy as np

from .colour import ciede2000, hex_to_lab


@dataclass(frozen=True)
class ColourName:
    name: str
    hex: str
    aliases: tuple[str, ...] = ()

    @property
    def lab(self) -> np.ndarray:
        return _lab_of(self.hex)


@cache
def _lab_of(hex_code: str) -> np.ndarray:
    lab = hex_to_lab(hex_code)
    lab.setflags(write=False)
    return lab


# name, representative sRGB, aliases
TABLE: tuple[ColourName, ...] = (
    # CSS basics
    ColourName("black", "#1E1E1E", ("jet black", "onyx")),
    ColourName("white", "#F4F4F2", ("optic white", "bright white", "pure white")),
    ColourName("grey", "#8C8C8C", ("mid grey", "medium grey")),
    ColourName("silver", "#C0C0C0"),
    ColourName("red", "#C0262D", ("true red", "cherry")),
    ColourName("maroon", "#6B1C23"),
    ColourName("yellow", "#F2D13A", ("lemon",)),
    ColourName("olive", "#6B6B2A", ("olive green",)),
    ColourName("lime", "#9ACD32", ("lime green",)),
    ColourName("green", "#2E8B3E", ("kelly green",)),
    ColourName("teal", "#1F7A7A"),
    ColourName("aqua", "#3FC6C6", ("cyan",)),
    ColourName("blue", "#2B5BB5", ("mid blue", "medium blue")),
    ColourName("navy", "#1F2A44", ("navy blue", "dark navy", "marine")),
    ColourName("purple", "#6A3D8F"),
    ColourName("fuchsia", "#C2307A", ("magenta",)),
    ColourName("orange", "#E8762B"),
    ColourName("pink", "#F2A7B8", ("light pink",)),
    ColourName("brown", "#6B4429"),
    ColourName("gold", "#C9A23A"),
    ColourName("beige", "#D8C8A8"),
    ColourName("ivory", "#F3EEDC"),
    ColourName("khaki", "#B5A27A"),
    ColourName("lavender", "#B9A9D6"),
    ColourName("coral", "#F0785F"),
    ColourName("salmon", "#F29682"),
    ColourName("turquoise", "#3BBFB3"),
    ColourName("indigo", "#3B3A7A"),
    ColourName("violet", "#8A4FBF"),
    ColourName("tan", "#C9A47A"),
    ColourName("chocolate", "#4E3022", ("dark brown",)),
    ColourName("crimson", "#B0182F"),
    ColourName("plum", "#6E3158"),
    # Fashion names
    ColourName("charcoal", "#3A3B3F", ("charcoal grey", "charcoal heather")),
    ColourName("burgundy", "#6D1A2E", ("oxblood",)),
    ColourName("wine", "#5E1F2D", ("merlot",)),
    ColourName("cream", "#EFE6CF"),
    ColourName("taupe", "#8B7D6E"),
    ColourName("mustard", "#C9A227", ("mustard yellow",)),
    ColourName("forest green", "#2F4F35", ("bottle green", "dark green", "hunter green")),
    ColourName("royal blue", "#2846A8"),
    ColourName("heather grey", "#A3A3A3", ("grey heather", "grey marl", "marl grey")),
    ColourName("light grey", "#C8C8C8", ("pale grey",)),
    ColourName("dark grey", "#555555"),
    ColourName("sky blue", "#8EC1E6"),
    ColourName("light blue", "#A9C8E8", ("pale blue",)),
    ColourName("baby blue", "#B8D6F0", ("powder blue",)),
    ColourName("denim", "#4A6584", ("denim blue",)),
    ColourName("mint", "#A8E0C5", ("mint green",)),
    ColourName("sage", "#9CAF88", ("sage green",)),
    ColourName("emerald", "#1E8A5A", ("emerald green",)),
    ColourName("rust", "#A8462B"),
    ColourName("camel", "#B98B55"),
    ColourName("chestnut", "#7A3E2A"),
    ColourName("off white", "#EEEBE3", ("off-white", "chalk")),
    ColourName("ecru", "#E3DAC4"),
    ColourName("oatmeal", "#D9CDB4", ("oat",)),
    ColourName("stone", "#BDB4A4"),
    ColourName("sand", "#D6C3A0"),
    ColourName("blush", "#E8B9B2", ("blush pink",)),
    ColourName("rose", "#D0697F"),
    ColourName("hot pink", "#E3418B"),
    ColourName("lilac", "#C3A6D3"),
    ColourName("mauve", "#A8798F"),
    ColourName("peach", "#F5BFA0"),
    ColourName("terracotta", "#C0613F"),
    ColourName("army green", "#4B5320", ("military green",)),
    ColourName("slate", "#5B6770", ("slate grey",)),
    ColourName("steel blue", "#4A6E94"),
    ColourName("cobalt", "#1F4BB0", ("cobalt blue",)),
    ColourName("midnight blue", "#1C2240", ("midnight",)),
)

_BY_KEY: dict[str, ColourName] = {}
for _entry in TABLE:
    _BY_KEY[_entry.name] = _entry
    for _alias in _entry.aliases:
        _BY_KEY[_alias] = _entry

_SPLIT = re.compile(r"\s*(?:/|&|\+|\band\b|,|\bwith\b)\s*")


def normalise(text: str) -> str:
    t = text.strip().lower()
    t = re.sub(r"^(colou?r)\s*[:\-]?\s*", "", t)
    t = t.replace("gray", "grey").replace("-", " ").replace("_", " ")
    t = re.sub(r"[^a-z /&+,]", " ", t)
    return re.sub(r"\s+", " ", t).strip()


def lookup(text: str | None) -> ColourName | None:
    """Map a listing colour name to a table entry, or ``None`` when it is not recognised.

    Multi-colour names ("navy/white stripe") use the first colour.
    """
    if not text:
        return None
    t = normalise(text)
    if not t:
        return None
    if t in _BY_KEY:
        return _BY_KEY[t]
    first = _SPLIT.split(t)[0].strip()
    if first in _BY_KEY:
        return _BY_KEY[first]
    words = first.split()
    # Longest trailing phrase first ("midnight navy" -> "navy"), then leading ("navy stripe" -> "navy").
    for size in range(len(words) - 1, 0, -1):
        tail = " ".join(words[-size:])
        if tail in _BY_KEY:
            return _BY_KEY[tail]
    for size in range(len(words) - 1, 0, -1):
        head = " ".join(words[:size])
        if head in _BY_KEY:
            return _BY_KEY[head]
    return None


def nearest(lab: np.ndarray) -> ColourName:
    """Closest named colour by CIEDE2000 (kL = 1: lightness matters when naming)."""
    centres = np.stack([e.lab for e in TABLE])
    de = ciede2000(np.broadcast_to(np.asarray(lab, dtype=np.float64), centres.shape), centres)
    return TABLE[int(np.argmin(de))]


def tolerance(name: str, colour_th: dict[str, Any]) -> float:
    per_name: dict[str, float] = colour_th.get("name_tolerance", {})
    return float(per_name.get(name, colour_th["name_tolerance_default"]))
